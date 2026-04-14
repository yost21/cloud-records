import { useState, useEffect, useCallback } from "react";
import type { TrackInfo } from "../lib/types";
import type { Comment, Reply } from "../lib/types";
import type { PlayerState } from "../hooks/usePlayer";
import { getCoverArtUrl, getComments, addComment, deleteCommentApi, getReplies } from "../lib/agent";
import { shareTrack } from "../lib/share";
import Waveform from "./Waveform";

interface Props {
  track       : TrackInfo | null;
  tracks      : TrackInfo[];
  state       : PlayerState;
  isAdmin     : boolean;
  onToggle    : () => void;
  onNext      : () => void;
  onPrev      : () => void;
  onSeek      : (fraction: number) => void;
  onVolume    : (v: number) => void;
  onShuffle   : () => void;
  onRepeat    : () => void;
  onRemoveFromQueue : (position: number) => void;
  onClearQueue: () => void;
  audioUrl    : string | null;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}


function timeAgo(ns: bigint): string {
  const seconds = Math.floor((Date.now() - Number(ns) / 1_000_000) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function Player({
  track, tracks, state, isAdmin, onToggle, onNext, onPrev, onSeek, onVolume, onShuffle, onRepeat, onRemoveFromQueue, onClearQueue, audioUrl,
}: Props) {
  const { isPlaying, isLoading, loadProgress, progress, duration, volume, shuffle, repeat } = state;
  const elapsed = progress * duration;
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [showShareToast, setShowShareToast] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);

  // Comments
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentReplies, setCommentReplies] = useState<Map<string, Reply[]>>(new Map());
  const [commentAuthor, setCommentAuthor] = useState(() => localStorage.getItem("cr-name") || "");
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);

  const loadComments = useCallback(async (trackId: string) => {
    try {
      const c = await getComments(trackId);
      setComments(c);
      // Load replies for each comment
      const rm = new Map<string, Reply[]>();
      await Promise.all(c.map(async (comment) => {
        const r = await getReplies(comment.id);
        if (r.length > 0) rm.set(comment.id, r);
      }));
      setCommentReplies(rm);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    setComments([]);
    if (track?.id) loadComments(track.id);
  }, [track?.id, loadComments]);

  const handlePostComment = async () => {
    if (!track || !commentText.trim()) return;
    setPosting(true);
    try {
      if (commentAuthor) localStorage.setItem("cr-name", commentAuthor);
      await addComment(track.id, commentAuthor, commentText.trim());
      setCommentText("");
      await loadComments(track.id);
    } catch (e) { console.error(e); }
    setPosting(false);
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!track) return;
    try {
      await deleteCommentApi(track.id, commentId);
      await loadComments(track.id);
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    setCoverUrl(null);
    if (track?.coverArtType) {
      getCoverArtUrl(track.id, track.coverArtType).then(url => setCoverUrl(url));
    }
  }, [track?.id]);

  const handleShare = () => {
    shareTrack(track);
    setShowShareToast(true);
    setTimeout(() => setShowShareToast(false), 1500);
  };

  return (
    <div className={`player-area${mobileExpanded ? " mobile-expanded" : ""}`}>
    {/* Mobile mini-bar — fixed bottom, tap to expand */}
    <div
      className="mini-bar"
      role="button"
      tabIndex={0}
      onClick={() => { if (track) setMobileExpanded(true); }}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && track) setMobileExpanded(true); }}
      aria-label="Expand player"
    >
      <div className="mini-progress" style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }} />
      <div className="mini-art">
        {coverUrl ? (
          <img src={coverUrl} alt="" />
        ) : (
          <span className="mini-art-ph">♪</span>
        )}
      </div>
      <div className="mini-meta">
        <span className="mini-title">{track ? track.name : "Select a track"}</span>
        <span className="mini-artist">{track ? (track.artist || "Unknown Artist") : "Tap a song to play"}</span>
      </div>
      <button
        className="mini-play"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
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
    </div>

    {/* Sheet collapse button (mobile expanded only) */}
    {mobileExpanded && (
      <button
        className="sheet-close"
        onClick={() => setMobileExpanded(false)}
        aria-label="Collapse player"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    )}

    <div className="player">
      {/* Now playing info */}
      <div className="now-playing">
        <div className="album-art">
          {coverUrl ? (
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
          {isLoading && (
            <div className="art-loading-overlay">
              <div className="art-spinner" />
              <div className="art-load-progress">
                <div
                  className="art-load-progress-fill"
                  style={{ width: `${Math.round(loadProgress * 100)}%` }}
                />
              </div>
              <div className="art-load-label">Loading {Math.round(loadProgress * 100)}%</div>
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
              <button className="np-share-btn" onClick={handleShare} title="Share track">
                {showShareToast ? "Copied!" : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
                  </svg>
                )}
              </button>
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
        {/* Waveform visualization */}
        {audioUrl && !isLoading && (
          <Waveform
            audioUrl={audioUrl}
            progress={progress}
            onSeek={onSeek}
            isPlaying={isPlaying}
          />
        )}

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
            aria-label="Seek position"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          />
          <span className="time-label">{formatTime(duration)}</span>
        </div>

        {/* Transport buttons */}
        <div className="transport">
          <button
            className={`ctrl-btn ctrl-sm shuffle-btn${shuffle ? " active" : ""}`}
            onClick={onShuffle}
            aria-label="Shuffle"
            title={shuffle ? "Shuffle on" : "Shuffle off"}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
            </svg>
          </button>

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

          <button
            className={`ctrl-btn ctrl-sm repeat-btn${repeat !== "off" ? " active" : ""}`}
            onClick={onRepeat}
            aria-label="Repeat"
            title={repeat === "off" ? "Repeat off" : repeat === "all" ? "Repeat all" : "Repeat one"}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
            </svg>
            {repeat === "one" && <span className="repeat-badge">1</span>}
          </button>
        </div>

        {/* Volume + Share */}
        <div className="bottom-controls">
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
              aria-label="Volume"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(volume * 100)}
            />
          </div>
          {track && (
            <button className="transport-share-btn" onClick={handleShare} title="Share track">
              {showShareToast ? "Copied!" : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>

      </div>

      {/* Queue display */}
      {state.queue.length > 0 && (
        <div className="queue-section">
          <div className="queue-header">
            <span className="queue-title">Queue ({state.queue.length})</span>
            <button className="queue-clear" onClick={onClearQueue}>Clear</button>
          </div>
          <ul className="queue-list">
            {state.queue.map((idx, pos) => {
              const qTrack = tracks[idx];
              if (!qTrack) return null;
              return (
                <li key={`${qTrack.id}-${pos}`} className="queue-item">
                  <span className="queue-pos">{pos + 1}</span>
                  <span className="queue-name">{qTrack.name}</span>
                  <span className="queue-artist">{qTrack.artist}</span>
                  <button className="queue-remove" onClick={() => onRemoveFromQueue(pos)} title="Remove">&times;</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Comments toggle — between player and comments panel */}
      {track && (
        <div className="comments-toggle-bar">
          <button className={`comments-toggle${showComments ? " open" : ""}`} onClick={() => setShowComments(s => !s)}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
            Comments {comments.length > 0 && `(${comments.length})`}
          </button>
        </div>
      )}

      {/* Comments panel — scrollable, separate from fixed transport */}
      {track && showComments && (
        <div className="comments-panel">
          <div className="comments-section">
            <div className="comments-list">
              {comments.length === 0 && (
                <div className="comments-empty">Be the first to leave a comment</div>
              )}
              {comments.map(c => {
                const reps = commentReplies.get(c.id) || [];
                return (
                  <div key={c.id} className="comment-item">
                    <div className="comment-top">
                      <span className="comment-author">{c.author}</span>
                      <span className="comment-time">{timeAgo(c.createdAt)}</span>
                      {isAdmin && (
                        <button className="comment-delete" onClick={() => handleDeleteComment(c.id)} title="Delete">
                          &times;
                        </button>
                      )}
                    </div>
                    <div className="comment-text">{c.text}</div>
                    {reps.length > 0 && (
                      <div className="comment-replies">
                        {reps.map(r => (
                          <div key={r.id} className="comment-reply">
                            <span className="comment-reply-author">{r.author}</span>
                            <span className="comment-reply-text">{r.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="comment-form">
              <input
                id="comment-author"
                className="comment-name"
                type="text"
                placeholder="Your name"
                value={commentAuthor}
                onChange={e => setCommentAuthor(e.target.value)}
              />
              <label htmlFor="comment-author" className="sr-only">Your name</label>
              <div className="comment-input-row">
                <label htmlFor="comment-text" className="sr-only">Leave a comment</label>
                <input
                  id="comment-text"
                  className="comment-input"
                  type="text"
                  placeholder="Leave a comment..."
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handlePostComment()}
                  maxLength={500}
                />
                <button
                  className="comment-submit"
                  onClick={handlePostComment}
                  disabled={posting || !commentText.trim()}
                >
                  {posting ? "..." : "Post"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
