import { useState, useEffect } from "react";
import type { TrackInfo } from "../lib/types";
import type { PlayerState } from "../hooks/usePlayer";
import { getCoverArtUrl } from "../lib/agent";

interface Props {
  track       : TrackInfo | null;
  state       : PlayerState;
  onToggle    : () => void;
  onNext      : () => void;
  onPrev      : () => void;
  onSeek      : (fraction: number) => void;
  onVolume    : (v: number) => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function Player({
  track, state, onToggle, onNext, onPrev, onSeek, onVolume,
}: Props) {
  const { isPlaying, isLoading, progress, duration, volume } = state;
  const elapsed = progress * duration;
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    setCoverUrl(null);
    if (track?.coverArtType) {
      getCoverArtUrl(track.id, track.coverArtType).then(url => setCoverUrl(url));
    }
  }, [track?.id]);

  return (
    <div className="player">
      {/* Now playing info */}
      <div className="now-playing">
        <div className="album-art">
          {isLoading ? (
            <div className="art-spinner" />
          ) : coverUrl ? (
            <img src={coverUrl} alt="Album art" className="art-image" />
          ) : (
            <div className="art-placeholder">
              <svg width="64" height="64" viewBox="0 0 32 24" fill="currentColor" opacity="0.18">
                <rect x="4" y="4" width="2" height="2"/><rect x="6" y="2" width="2" height="2"/>
                <rect x="8" y="2" width="4" height="2"/><rect x="12" y="4" width="2" height="2"/>
                <rect x="2" y="6" width="2" height="2"/><rect x="14" y="6" width="2" height="2"/>
                <rect x="2" y="8" width="14" height="2"/><rect x="4" y="10" width="10" height="2"/>
                <rect x="18" y="6" width="2" height="2"/><rect x="20" y="4" width="2" height="2"/>
                <rect x="22" y="4" width="4" height="2"/><rect x="26" y="6" width="2" height="2"/>
                <rect x="16" y="8" width="14" height="2"/><rect x="18" y="10" width="10" height="2"/>
              </svg>
            </div>
          )}
        </div>
        <div className="track-info">
          {track ? (
            <>
              <div className="np-label">Now Playing</div>
              <div className="np-title">{track.name}</div>
              <div className="np-artist">{track.artist || "Unknown Artist"}</div>
              {track.album && <div className="np-album">{track.album}</div>}
            </>
          ) : (
            <>
              <div className="np-label">&mdash;</div>
              <div className="np-title idle">Select a track</div>
            </>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="controls-wrap">
        {/* Progress bar */}
        <div className="progress-row">
          <span className="time-label">{formatTime(elapsed)}</span>
          <input
            type="range"
            className="progress-bar"
            min={0}
            max={1}
            step={0.001}
            value={progress}
            disabled={!track || isLoading}
            style={{ "--val": progress } as React.CSSProperties}
            onChange={e => onSeek(Number(e.target.value))}
          />
          <span className="time-label">{formatTime(duration)}</span>
        </div>

        {/* Transport buttons */}
        <div className="transport">
          <button
            className="ctrl-btn"
            onClick={onPrev}
            disabled={!track}
            aria-label="Previous"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6L20 18V6z" />
            </svg>
          </button>

          <button
            className="ctrl-btn play-btn"
            onClick={onToggle}
            disabled={!track || isLoading}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isLoading ? (
              <span className="btn-spinner" />
            ) : isPlaying ? (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <button
            className="ctrl-btn"
            onClick={onNext}
            disabled={!track}
            aria-label="Next"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zm2.5-6L14 6h2v12h-2l-5.5-6z" />
            </svg>
          </button>
        </div>

        {/* Volume */}
        <div className="volume-row">
          <svg className="vol-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
          </svg>
          <input
            type="range"
            className="volume-bar"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            style={{ "--val": volume } as React.CSSProperties}
            onChange={e => onVolume(Number(e.target.value))}
          />
        </div>
      </div>
    </div>
  );
}
