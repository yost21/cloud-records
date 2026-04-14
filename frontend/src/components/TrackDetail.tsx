import { useEffect, useState } from "react";
import type { TrackInfo, Comment } from "../lib/types";
import {
  getPlayLog,
  getPlayCount,
  getComments,
  deleteCommentApi,
  getCoverArtUrl,
} from "../lib/agent";

interface Props {
  track   : TrackInfo;
  onClose : () => void;
}

function timeAgo(ns: bigint | number): string {
  const ms = typeof ns === "bigint" ? Number(ns) / 1_000_000 : ns / 1_000_000;
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatDate(ns: bigint): string {
  return new Date(Number(ns) / 1_000_000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

interface DayBucket {
  date  : string;
  label : string;
  count : number;
}

function bucketByDay(timestampsNs: bigint[], days: number): DayBucket[] {
  const now = new Date();
  const buckets: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    buckets.push({
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      count: 0,
    });
  }
  for (const ts of timestampsNs) {
    const ms = Number(ts) / 1_000_000;
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    const key = date.toISOString().slice(0, 10);
    const bucket = buckets.find(b => b.date === key);
    if (bucket) bucket.count++;
  }
  return buckets;
}

export default function TrackDetail({ track, onClose }: Props) {
  const [playCount, setPlayCount] = useState<bigint>(0n);
  const [playLog, setPlayLog] = useState<bigint[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getPlayCount(track.id),
      getPlayLog(track.id),
      getComments(track.id),
      track.coverArtType ? getCoverArtUrl(track.id, track.coverArtType) : Promise.resolve(null),
    ]).then(([count, log, c, url]) => {
      setPlayCount(count as bigint);
      setPlayLog(log as bigint[]);
      setComments(c as Comment[]);
      setCoverUrl(url as string | null);
    }).finally(() => setLoading(false));
  }, [track.id]);

  const handleDeleteComment = async (commentId: string) => {
    if (!confirm("Delete this comment?")) return;
    try {
      await deleteCommentApi(track.id, commentId);
      setComments(prev => prev.filter(c => c.id !== commentId));
    } catch (e) { console.error(e); }
  };

  const buckets = bucketByDay(playLog, 30);
  const maxBucket = Math.max(1, ...buckets.map(b => b.count));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal track-detail-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="td-header">
          <div className="td-cover">
            {coverUrl ? (
              <img src={coverUrl} alt={track.name} />
            ) : (
              <div className="td-cover-placeholder">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4">
                  <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" />
                </svg>
              </div>
            )}
          </div>
          <div className="td-meta">
            <div className="td-name">{track.name}</div>
            <div className="td-artist">{track.artist || "Unknown Artist"}</div>
            {track.album && <div className="td-album">{track.album}</div>}
            <div className="td-tags">
              {track.featured && <span className="td-tag td-tag-featured">★ Featured</span>}
              <span className="td-tag">{formatBytes(Number(track.size))}</span>
              <span className="td-tag">{Number(track.totalChunks)} chunks</span>
              <span className="td-tag">{formatDate(track.createdAt)}</span>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="dash-loading">Loading...</div>
        ) : (
          <>
            <div className="td-stats">
              <div className="td-stat">
                <div className="td-stat-value">{Number(playCount).toLocaleString()}</div>
                <div className="td-stat-label">Total Plays</div>
              </div>
              <div className="td-stat">
                <div className="td-stat-value">{playLog.length}</div>
                <div className="td-stat-label">Logged (last {200})</div>
              </div>
              <div className="td-stat">
                <div className="td-stat-value">{comments.length}</div>
                <div className="td-stat-label">Comments</div>
              </div>
            </div>

            <div className="td-section">
              <h3>Activity (last 30 days)</h3>
              {playLog.length === 0 ? (
                <p className="dash-empty">No plays logged yet.</p>
              ) : (
                <div className="td-chart">
                  {buckets.map((b, i) => (
                    <div key={i} className="td-chart-col" title={`${b.label}: ${b.count} plays`}>
                      <div
                        className="td-chart-bar"
                        style={{ height: `${(b.count / maxBucket) * 100}%` }}
                      />
                    </div>
                  ))}
                </div>
              )}
              {playLog.length > 0 && (
                <div className="td-chart-axis">
                  <span>{buckets[0].label}</span>
                  <span>{buckets[buckets.length - 1].label}</span>
                </div>
              )}
            </div>

            <div className="td-section">
              <h3>Comments ({comments.length})</h3>
              {comments.length === 0 ? (
                <p className="dash-empty">No comments yet.</p>
              ) : (
                <div className="dash-comment-list">
                  {comments.map(c => (
                    <div key={c.id} className="dash-comment">
                      <div className="dash-comment-meta">
                        <span className="dash-comment-author">{c.author}</span>
                        <span className="dash-comment-time">{timeAgo(c.createdAt)}</span>
                        <button
                          className="dash-comment-delete"
                          onClick={() => handleDeleteComment(c.id)}
                          title="Delete"
                        >
                          &times;
                        </button>
                      </div>
                      <div className="dash-comment-text">{c.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
