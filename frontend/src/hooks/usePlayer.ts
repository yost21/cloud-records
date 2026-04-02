import { useRef, useState, useCallback, useEffect } from "react";
import type { TrackInfo } from "../lib/types";
import { buildAudioUrl } from "../lib/agent";

export interface PlayerState {
  currentIndex : number | null;
  isPlaying    : boolean;
  isLoading    : boolean;
  progress     : number; // 0–1
  duration     : number; // seconds
  volume       : number; // 0–1
}

export function usePlayer(tracks: TrackInfo[]) {
  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const blobUrls = useRef<Map<string, string>>(new Map());

  const [state, setState] = useState<PlayerState>({
    currentIndex : null,
    isPlaying    : false,
    isLoading    : false,
    progress     : 0,
    duration     : 0,
    volume       : 0.8,
  });

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

    const onEnded = () => {
      setState(s => {
        if (s.currentIndex !== null && s.currentIndex < tracks.length - 1) {
          return { ...s, currentIndex: s.currentIndex + 1 };
        }
        return { ...s, isPlaying: false, progress: 0 };
      });
    };

    const onPlay  = () => setState(s => ({ ...s, isPlaying: true  }));
    const onPause = () => setState(s => ({ ...s, isPlaying: false }));

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended",      onEnded);
    audio.addEventListener("play",       onPlay);
    audio.addEventListener("pause",      onPause);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended",      onEnded);
      audio.removeEventListener("play",       onPlay);
      audio.removeEventListener("pause",      onPause);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks.length]);

  // Load audio whenever currentIndex changes
  useEffect(() => {
    const { currentIndex } = state;
    if (currentIndex === null) return;
    const track = tracks[currentIndex];
    if (!track) return;

    const cachedUrl = blobUrls.current.get(track.id);
    if (cachedUrl) {
      audioRef.current.src = cachedUrl;
      audioRef.current.play().catch(console.warn);
      return;
    }

    setState(s => ({ ...s, isLoading: true }));
    buildAudioUrl(track.id, Number(track.totalChunks), track.mimeType)
      .then(url => {
        blobUrls.current.set(track.id, url);
        audioRef.current.src = url;
        return audioRef.current.play();
      })
      .catch(console.error)
      .finally(() => setState(s => ({ ...s, isLoading: false })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentIndex]);

  const play = useCallback((index: number) => {
    if (index === state.currentIndex) {
      audioRef.current.play().catch(console.warn);
    } else {
      setState(s => ({ ...s, currentIndex: index, progress: 0, duration: 0 }));
    }
  }, [state.currentIndex]);

  const pause = useCallback(() => {
    audioRef.current.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (state.isPlaying) {
      audioRef.current.pause();
    } else if (state.currentIndex !== null) {
      audioRef.current.play().catch(console.warn);
    }
  }, [state.isPlaying, state.currentIndex]);

  const skipNext = useCallback(() => {
    setState(s => {
      if (s.currentIndex === null) return { ...s, currentIndex: 0 };
      const next = s.currentIndex + 1;
      return next < tracks.length ? { ...s, currentIndex: next } : s;
    });
  }, [tracks.length]);

  const skipPrev = useCallback(() => {
    setState(s => {
      // If more than 3 seconds in, restart current track
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

  return {
    state,
    play,
    pause,
    togglePlay,
    skipNext,
    skipPrev,
    seek,
    setVolume,
    currentTrack : state.currentIndex !== null ? tracks[state.currentIndex] : null,
  };
}
