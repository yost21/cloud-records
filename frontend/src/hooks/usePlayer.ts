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

export function usePlayer(tracks: TrackInfo[]) {
  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const blobUrls = useRef<Map<string, string>>(new Map());
  const hasRestoredRef = useRef(false);
  const resumeTimeRef = useRef<number | null>(null);
  // Track which trackIds have already been counted this session
  const playRecordedRef = useRef<Set<string>>(new Set());
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
          let rand: number;
          do { rand = Math.floor(Math.random() * tracks.length); } while (rand === s.currentIndex);
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

    // Pause cleanly before changing src so any pending play() promise from
    // the previous track resolves with a benign AbortError instead of
    // leaving the audio element in a half-loaded state.
    audio.pause();

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
      // If resuming from saved position, seek and stay paused
      if (resumeTimeRef.current !== null) {
        const t = resumeTimeRef.current;
        resumeTimeRef.current = null;
        audio.currentTime = t;
        // Don't auto-play on resume — let user press play
        return;
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

    return () => { cancelled = true; };
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

  const play = useCallback((index: number) => {
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
  }, []);

  const pause = useCallback(() => {
    audioRef.current.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (state.isPlaying) {
      audioRef.current.pause();
    } else if (state.currentIndex !== null) {
      audioRef.current.play().catch((err) => {
        if (err?.name === "AbortError") return;
        console.warn("Playback failed:", err);
        setState(s => ({ ...s, isPlaying: false }));
      });
    }
  }, [state.isPlaying, state.currentIndex]);

  const skipNext = useCallback(() => {
    setState(s => {
      if (s.currentIndex === null) return { ...s, currentIndex: 0 };
      if (s.shuffle && tracks.length > 1) {
        let rand: number;
        do { rand = Math.floor(Math.random() * tracks.length); } while (rand === s.currentIndex);
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
