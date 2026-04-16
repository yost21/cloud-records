import { useRef, useState, useCallback, useEffect } from "react";
import type { TrackInfo } from "../lib/types";
import { buildAudioUrl, recordPlay, getCoverArtUrl } from "../lib/agent";

export interface PlayerState {
  currentIndex : number | null;
  isPlaying    : boolean;
  isLoading    : boolean;
  loadProgress : number; // 0–1, only meaningful when isLoading is true
  progress     : number; // 0–1
  duration     : number; // seconds
  volume       : number; // 0–1
  shuffle      : boolean;
  repeat       : "off" | "all" | "one";
  queue        : number[]; // indices into tracks array, play in order
}

// Real silent WAV (~0.1s of actual silent samples) preloaded on mount.
// Mobile WebKit refuses to credit user activation for 0-byte data URIs —
// the silent unlock has to be a real, decodable audio file with samples.
const SILENCE_URL = "/silence.wav";

function createPreloadedAudio(): HTMLAudioElement {
  const a = new Audio();
  a.preload = "auto";
  a.src = SILENCE_URL;
  a.load();
  return a;
}

// Module-level singleton — useRef(initialValue) evaluates the argument on
// every render, so we'd otherwise create a new HTMLAudioElement and kick
// off a fresh /silence.wav fetch on every state change. One element per
// page is enough.
let _sharedAudio: HTMLAudioElement | null = null;
function getSharedAudio(): HTMLAudioElement {
  if (_sharedAudio === null) {
    _sharedAudio = createPreloadedAudio();
  }
  return _sharedAudio;
}

export function usePlayer(tracks: TrackInfo[]) {
  const audioRef = useRef<HTMLAudioElement>(getSharedAudio());
  const blobUrls = useRef<Map<string, string>>(new Map());
  const hasRestoredRef = useRef(false);
  const resumeTimeRef = useRef<number | null>(null);
  // Track which trackIds have already been counted this session
  const playRecordedRef = useRef<Set<string>>(new Set());
  // Recent shuffle history — prevents the random picker from replaying a
  // track the listener just heard. Window size scales with library size so
  // small libraries don't starve. Newest index at the end.
  const shuffleHistoryRef = useRef<number[]>([]);

  // Pick a random index that isn't in recent history. If every index is in
  // history (tiny library), fall back to excluding just the current track.
  const pickShuffleIndex = (currentIndex: number | null): number => {
    if (tracks.length <= 1) return 0;
    // Keep at most half the library in history, capped at 10. That means a
    // 4-track library excludes the last 2 plays; a 35-track library the
    // last 10.
    const maxHistory = Math.min(10, Math.max(1, Math.floor(tracks.length / 2)));
    const history = shuffleHistoryRef.current;
    const excluded = new Set<number>(history);
    if (currentIndex !== null) excluded.add(currentIndex);

    const candidates: number[] = [];
    for (let i = 0; i < tracks.length; i++) {
      if (!excluded.has(i)) candidates.push(i);
    }
    // Library smaller than history window — relax to just "not the current track"
    const pool = candidates.length > 0
      ? candidates
      : Array.from({ length: tracks.length }, (_, i) => i).filter(i => i !== currentIndex);

    const pick = pool[Math.floor(Math.random() * pool.length)];
    history.push(pick);
    while (history.length > maxHistory) history.shift();
    return pick;
  };
  // Chrome mobile blocks audio.play() fired from async callbacks after the
  // user gesture has expired. We "unlock" the audio element once, during
  // the first click, by playing a silent data URI synchronously — after
  // that, Chrome treats the element as user-activated and subsequent
  // programmatic play() calls (fired after chunk fetch) are permitted.
  const unlockedRef = useRef(false);
  const isUnlockingRef = useRef(false);
  // When set, the next load-effect run will set the audio src and seek but
  // skip the autoplay call. Used by selectTrack(), which pre-selects a
  // track on app mount without trying to autoplay (mobile would block it
  // and corrupt the player's internal "unlocked" state).
  const suppressAutoPlayRef = useRef(false);
  const [loadGeneration, setLoadGeneration] = useState(0);

  const [state, setState] = useState<PlayerState>(() => ({
    currentIndex : null,
    isPlaying    : false,
    isLoading    : false,
    loadProgress : 0,
    progress     : 0,
    duration     : 0,
    volume       : 0.8,
    shuffle      : localStorage.getItem("cr-shuffle") === "true",
    repeat       : (localStorage.getItem("cr-repeat") as PlayerState["repeat"]) || "off",
    queue        : [],
  }));

  // Wire up audio element event listeners once
  useEffect(() => {
    const audio = audioRef.current;
    audio.volume = state.volume;

    const onTimeUpdate = () =>
      setState(s => ({
        ...s,
        progress : audio.duration ? audio.currentTime / audio.duration : 0,
        duration : audio.duration || 0,
      }));

    const onError = () => {
      // Audio element failed to load or decode — surface it and reset state
      // so the UI doesn't lie about playback. Common causes: corrupt blob,
      // wrong MIME type, interrupted load.
      console.warn("Audio element error:", audio.error?.code, audio.error?.message);
      setState(s => ({ ...s, isPlaying: false, isLoading: false }));
    };

    const onEnded = () => {
      // Guard: the silent unlock WAV fires 'ended' immediately on some
      // browsers. Ignore it so we don't advance to the next track.
      if (isUnlockingRef.current) {
        isUnlockingRef.current = false;
        return;
      }
      setState(s => {
        // Repeat one: loop the same track
        if (s.repeat === "one") {
          audio.currentTime = 0;
          audio.play().catch(console.warn);
          return s;
        }

        // Queue takes priority — play next queued track
        if (s.queue.length > 0) {
          const [nextIdx, ...rest] = s.queue;
          return { ...s, currentIndex: nextIdx, queue: rest, progress: 0, duration: 0 };
        }

        const atEnd = s.currentIndex !== null && s.currentIndex >= tracks.length - 1;

        // Shuffle mode
        if (s.shuffle && tracks.length > 1) {
          if (atEnd && s.repeat === "off") {
            return { ...s, isPlaying: false, progress: 0 };
          }
          const rand = pickShuffleIndex(s.currentIndex);
          return { ...s, currentIndex: rand, progress: 0, duration: 0 };
        }

        // Sequential: advance or wrap/stop
        if (s.currentIndex !== null && s.currentIndex < tracks.length - 1) {
          return { ...s, currentIndex: s.currentIndex + 1, progress: 0, duration: 0 };
        }
        if (s.repeat === "all" && tracks.length > 0) {
          return { ...s, currentIndex: 0, progress: 0, duration: 0 };
        }
        return { ...s, isPlaying: false, progress: 0 };
      });
    };

    const onPlay  = () => {
      setState(s => {
        // Record play once per track per session, on first actual playback
        if (s.currentIndex !== null) {
          const t = tracks[s.currentIndex];
          if (t && !playRecordedRef.current.has(t.id)) {
            playRecordedRef.current.add(t.id);
            recordPlay(t.id).catch(() => {});  // fire and forget
          }
        }
        return { ...s, isPlaying: true };
      });
    };
    const onPause = () => setState(s => ({ ...s, isPlaying: false }));

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended",      onEnded);
    audio.addEventListener("play",       onPlay);
    audio.addEventListener("pause",      onPause);
    audio.addEventListener("error",      onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended",      onEnded);
      audio.removeEventListener("play",       onPlay);
      audio.removeEventListener("pause",      onPause);
      audio.removeEventListener("error",      onError);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks.length]);

  // Load audio whenever currentIndex changes
  useEffect(() => {
    const { currentIndex } = state;
    if (currentIndex === null) return;
    const track = tracks[currentIndex];
    if (!track) return;

    // Cancellation flag — if the effect re-runs (user picks a different track)
    // before this one's async work finishes, the cleanup function flips this
    // and the stale .then() / .catch() callbacks bail out instead of
    // overwriting state for the new track.
    let cancelled = false;
    const audio = audioRef.current;

    // NOTE: do NOT call audio.pause() here. Pausing aborts the synchronous
    // unlock play() (silence.wav) that ran in the click handler before iOS
    // WebKit can register user activation, leaving the element blocked for
    // any subsequent programmatic play(). Setting audio.src below will
    // implicitly pause/reset the element via the HTML resource selection
    // algorithm, which is enough.

    const safePlay = () => {
      if (cancelled) return;
      audio.play().catch((err) => {
        // AbortError is expected when src changes mid-play — ignore it.
        // Other errors mean playback genuinely failed; reset isPlaying so
        // the UI doesn't show pause icon while no audio is playing.
        if (err?.name === "AbortError") return;
        if (cancelled) return;
        console.warn("Playback failed:", err);
        setState(s => ({ ...s, isPlaying: false }));
      });
    };

    const startPlayback = () => {
      if (cancelled) return;

      // ALWAYS consume both flags up-front so they can't leak across loads.
      // Previously, if both were set (restore effect + deepLink effect both
      // fire on mount), the resume path would return early without clearing
      // suppress, leaving the next user-initiated track load silently
      // blocked from auto-playing.
      const resumeTime = resumeTimeRef.current;
      const suppress = suppressAutoPlayRef.current;
      resumeTimeRef.current = null;
      suppressAutoPlayRef.current = false;

      if (resumeTime !== null) {
        audio.currentTime = resumeTime;
        return; // restored — user must press play
      }
      if (suppress) {
        return; // pre-selected without playing
      }
      safePlay();
    };

    const cachedUrl = blobUrls.current.get(track.id);
    if (cachedUrl) {
      audio.src = cachedUrl;
      audio.load();
      startPlayback();
      return () => { cancelled = true; };
    }

    setState(s => ({ ...s, isLoading: true, loadProgress: 0 }));
    buildAudioUrl(track.id, Number(track.totalChunks), track.mimeType, (p) => {
      if (cancelled) return;
      setState(s => ({ ...s, loadProgress: p.total > 0 ? p.loaded / p.total : 0 }));
    })
      .then(url => {
        if (cancelled) {
          // Stale resolve — don't touch the audio element or state.
          // Revoke the orphaned blob URL so it doesn't leak memory.
          URL.revokeObjectURL(url);
          return;
        }
        blobUrls.current.set(track.id, url);
        audio.src = url;
        audio.load();
        setState(s => ({ ...s, isLoading: false, loadProgress: 1 }));
        startPlayback();
      })
      .catch(err => {
        if (cancelled) return;
        console.error("Failed to load track:", err);
        setState(s => ({ ...s, isLoading: false, loadProgress: 0 }));
      });

    return () => {
      cancelled = true;
      // Clear any pending resume seek so it doesn't leak into the next
      // track's load. Without this, skipping tracks before the restored
      // load completes would seek the new track to the saved position.
      resumeTimeRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentIndex, loadGeneration]);

  // Revoke all blob URLs on unmount to avoid memory leaks
  useEffect(() => {
    const urls = blobUrls.current;
    return () => {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  // Restore playback position from localStorage (once, after tracks load)
  useEffect(() => {
    if (hasRestoredRef.current || tracks.length === 0) return;
    hasRestoredRef.current = true;
    try {
      const saved = localStorage.getItem("cr-resume");
      if (!saved) return;
      const { index, time } = JSON.parse(saved);
      if (typeof index === "number" && index >= 0 && index < tracks.length) {
        resumeTimeRef.current = time || 0;
        setState(s => ({ ...s, currentIndex: index }));
      }
    } catch { /* ignore corrupt data */ }
  }, [tracks.length]);

  // Preload next track while current one plays — eliminates loading gap between tracks
  useEffect(() => {
    const { currentIndex, queue, shuffle, isPlaying } = state;
    if (currentIndex === null || !isPlaying || tracks.length < 2) return;

    // Determine what the next track will be
    let nextIndex: number | null = null;
    if (queue.length > 0) {
      nextIndex = queue[0];
    } else if (!shuffle && currentIndex < tracks.length - 1) {
      nextIndex = currentIndex + 1;
    } else if (!shuffle && state.repeat === "all") {
      nextIndex = 0;
    }
    // Skip preload for shuffle — we can't predict the random index

    if (nextIndex === null) return;
    const nextTrack = tracks[nextIndex];
    if (!nextTrack || blobUrls.current.has(nextTrack.id)) return;

    // Silently fetch in background — no progress UI, no state changes
    buildAudioUrl(nextTrack.id, Number(nextTrack.totalChunks), nextTrack.mimeType)
      .then(url => {
        // Only cache if not already present (another effect may have loaded it)
        if (!blobUrls.current.has(nextTrack.id)) {
          blobUrls.current.set(nextTrack.id, url);
        } else {
          URL.revokeObjectURL(url);
        }
      })
      .catch(() => {}); // Silent fail — worst case, it loads normally when played
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentIndex, state.isPlaying, state.queue.length, tracks.length]);

  // Save playback position periodically
  useEffect(() => {
    const interval = setInterval(() => {
      if (state.currentIndex !== null && audioRef.current.currentTime > 0) {
        localStorage.setItem("cr-resume", JSON.stringify({
          index: state.currentIndex,
          time: audioRef.current.currentTime,
        }));
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [state.currentIndex]);

  // Update browser tab title
  useEffect(() => {
    const track = state.currentIndex !== null ? tracks[state.currentIndex] : null;
    if (track && state.isPlaying) {
      document.title = `\u25B6 ${track.name} \u2014 Cloud Records`;
    } else {
      document.title = "Cloud Records \u2014 On-Chain Music";
    }
  }, [state.currentIndex, state.isPlaying, tracks]);

  const unlockAudio = useCallback(() => {
    if (unlockedRef.current) return;
    isUnlockingRef.current = true;

    const audio = audioRef.current;
    // 1) HTMLAudioElement unlock — must be sync inside the user gesture.
    //    Only flip unlockedRef after the play() ACTUALLY succeeds. A failed
    //    unlock (e.g. called from a non-gesture context) must NOT mark the
    //    player as unlocked, or the next real user click won't retry it.
    audio.play()
      .then(() => { unlockedRef.current = true; })
      .catch(() => {});

    // 2) AudioContext unlock — the canonical iOS approach. Resuming the
    //    context inside a gesture unlocks the page's audio system; this is
    //    the most reliable unlock mechanism for WebKit. We play one sample
    //    of silence through it to commit the unlock.
    try {
      const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        const buffer = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(0);
        if (ctx.state === "suspended") {
          ctx.resume().catch(() => {});
        }
      }
    } catch {
      /* ignore — AudioContext unlock is best-effort */
    }
  }, []);

  // Pre-select a track without attempting to play it. Use for mount-time
  // defaults / deep links — calling play() on mount is blocked on mobile
  // and breaks the unlock state machine for later user clicks.
  const selectTrack = useCallback((index: number) => {
    suppressAutoPlayRef.current = true;
    setLoadGeneration(g => g + 1);
    setState(s => ({ ...s, currentIndex: index, progress: 0, duration: 0 }));
  }, []);

  const play = useCallback((index: number) => {
    unlockAudio();
    setState(s => {
      if (index === s.currentIndex) {
        // Same track — just resume playback, don't change state
        audioRef.current.play().catch((err) => {
          if (err?.name !== "AbortError") console.warn("Playback failed:", err);
        });
        return s;
      }
      // New track — update index, which triggers audio load effect
      setLoadGeneration(g => g + 1);
      return { ...s, currentIndex: index, progress: 0, duration: 0 };
    });
  }, [unlockAudio]);

  const pause = useCallback(() => {
    audioRef.current.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (state.isPlaying) {
      audioRef.current.pause();
      return;
    }
    // Always unlock first — togglePlay is often the user's first interaction
    // (e.g., resuming a restored session) so the audio element may not be
    // user-activated yet.
    unlockAudio();
    if (state.currentIndex !== null) {
      audioRef.current.play().catch((err) => {
        if (err?.name === "AbortError") return;
        console.warn("Playback failed:", err);
        setState(s => ({ ...s, isPlaying: false }));
      });
    }
  }, [state.isPlaying, state.currentIndex, unlockAudio]);

  const skipNext = useCallback(() => {
    setState(s => {
      if (s.currentIndex === null) return { ...s, currentIndex: 0 };
      if (s.shuffle && tracks.length > 1) {
        const rand = pickShuffleIndex(s.currentIndex);
        return { ...s, currentIndex: rand };
      }
      const next = s.currentIndex + 1;
      if (next < tracks.length) return { ...s, currentIndex: next };
      if (s.repeat === "all") return { ...s, currentIndex: 0 };
      return s;
    });
  }, [tracks.length]);

  const skipPrev = useCallback(() => {
    setState(s => {
      if (audioRef.current.currentTime > 3) {
        audioRef.current.currentTime = 0;
        return s;
      }
      if (s.currentIndex === null) return s;
      const prev = s.currentIndex - 1;
      return prev >= 0 ? { ...s, currentIndex: prev } : s;
    });
  }, []);

  const seek = useCallback((fraction: number) => {
    const audio = audioRef.current;
    if (audio.duration) {
      audio.currentTime = fraction * audio.duration;
    }
  }, []);

  const setVolume = useCallback((v: number) => {
    audioRef.current.volume = v;
    setState(s => ({ ...s, volume: v }));
  }, []);

  const toggleShuffle = useCallback(() => {
    setState(s => {
      const next = !s.shuffle;
      localStorage.setItem("cr-shuffle", String(next));
      return { ...s, shuffle: next };
    });
  }, []);

  const cycleRepeat = useCallback(() => {
    setState(s => {
      const order: PlayerState["repeat"][] = ["off", "all", "one"];
      const next = order[(order.indexOf(s.repeat) + 1) % 3];
      localStorage.setItem("cr-repeat", next);
      return { ...s, repeat: next };
    });
  }, []);

  // Media Session API — lock screen / notification controls
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const track = state.currentIndex !== null ? tracks[state.currentIndex] : null;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artist || "Cloud Records",
      album: track.album || "Cloud Records",
    });
    if (track.coverArtType) {
      getCoverArtUrl(track.id, track.coverArtType).then(url => {
        if (url && navigator.mediaSession.metadata) {
          navigator.mediaSession.metadata.artwork = [
            { src: url, sizes: "256x256", type: track.coverArtType || "image/png" },
          ];
        }
      });
    }
  }, [state.currentIndex, tracks]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play",         () => { audioRef.current.play().catch(() => {}); });
    ms.setActionHandler("pause",        () => { audioRef.current.pause(); });
    ms.setActionHandler("previoustrack", () => { skipPrev(); });
    ms.setActionHandler("nexttrack",     () => { skipNext(); });
    ms.setActionHandler("seekto",       (d) => { if (d.seekTime != null) audioRef.current.currentTime = d.seekTime; });
    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("previoustrack", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("seekto", null);
    };
  }, [skipNext, skipPrev]);

  const playNext = useCallback((index: number) => {
    setState(s => ({ ...s, queue: [index, ...s.queue] }));
  }, []);

  const addToQueue = useCallback((index: number) => {
    setState(s => ({ ...s, queue: [...s.queue, index] }));
  }, []);

  const removeFromQueue = useCallback((queuePosition: number) => {
    setState(s => ({
      ...s,
      queue: s.queue.filter((_, i) => i !== queuePosition),
    }));
  }, []);

  const clearQueue = useCallback(() => {
    setState(s => ({ ...s, queue: [] }));
  }, []);

  return {
    state,
    play,
    selectTrack,
    pause,
    togglePlay,
    skipNext,
    skipPrev,
    seek,
    setVolume,
    toggleShuffle,
    cycleRepeat,
    playNext,
    addToQueue,
    removeFromQueue,
    clearQueue,
    currentTrack : state.currentIndex !== null ? tracks[state.currentIndex] : null,
    currentAudioUrl : state.currentIndex !== null
      ? blobUrls.current.get(tracks[state.currentIndex]?.id) ?? null
      : null,
  };
}
