import { useEffect, useState, useCallback } from "react";
import type { Stats, CommentWithContext, GuestbookEntry, TrackInfo } from "../lib/types";
import {
  getStats,
  getAllComments,
  getGuestbookEntries,
  deleteCommentApi,
  deleteGuestbookEntryApi,
  getActor,
  setFeatured,
  updateTrack,
  deleteTrack as deleteTrackApi,
  replyToComment as replyToCommentApi,
  getAllReplies,
} from "../lib/agent";
import type { Reply } from "../lib/types";
import TrackDetail from "./TrackDetail";

interface Props {
  onClose : () => void;
}

type Tab = "overview" | "tracks" | "comments" | "guestbook";

function timeAgo(ns: bigint): string {
  const seconds = Math.floor((Date.now() - Number(ns) / 1_000_000) / 1000);
  if (seconds < 60) return "just now";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function Dashboard({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<Stats | null>(null);
  const [comments, setComments] = useState<CommentWithContext[]>([]);
  const [guestbook, setGuestbook] = useState<GuestbookEntry[]>([]);
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [playCountsMap, setPlayCountsMap] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [detailTrack, setDetailTrack] = useState<TrackInfo | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; artist: string; album: string }>({ name: "", artist: "", album: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [repliesMap, setRepliesMap] = useState<Map<string, Reply[]>>(new Map());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sendingReply, setSendingReply] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const actor = await getActor();
      const [s, c, g, t, pc, rp] = await Promise.all([
        getStats(),
        getAllComments().catch(() => [] as CommentWithContext[]),
        getGuestbookEntries(),
        actor.listTracks(),
        actor.getAllPlayCounts(),
        getAllReplies().catch(() => [] as Array<[string, Reply[]]>),
      ]);
      setStats(s as Stats);
      setComments(c as CommentWithContext[]);
      setGuestbook([...g].reverse());
      setTracks([...t].sort((a, b) => Number(a.order) - Number(b.order)));
      const map = new Map<string, number>();
      for (const [id, count] of pc) map.set(id, Number(count));
      setPlayCountsMap(map);
      const rm = new Map<string, Reply[]>();
      for (const [commentId, arr] of (rp as Array<[string, Reply[]]>)) rm.set(commentId, arr);
      setRepliesMap(rm);
    } catch (e) {
      console.error("Dashboard load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const openTrackDetail = useCallback((trackId: string) => {
    const t = tracks.find(t => t.id === trackId);
    if (t) setDetailTrack(t);
  }, [tracks]);

  const handleToggleFeatured = useCallback(async (e: React.MouseEvent, track: TrackInfo) => {
    e.stopPropagation();
    try {
      await setFeatured(track.id, !track.featured);
      // Optimistic update
      setTracks(prev => prev.map(t => t.id === track.id ? { ...t, featured: !t.featured } : t));
    } catch (err) {
      console.error("Featured toggle failed:", err);
    }
  }, []);

  const handleStartEdit = useCallback((e: React.MouseEvent, track: TrackInfo) => {
    e.stopPropagation();
    setEditingId(track.id);
    setEditForm({ name: track.name, artist: track.artist, album: track.album });
  }, []);

  const handleCancelEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
  }, []);

  const handleSaveEdit = useCallback(async (e: React.MouseEvent, track: TrackInfo) => {
    e.stopPropagation();
    setSavingEdit(true);
    try {
      await updateTrack(track.id, editForm.name, editForm.artist, editForm.album, 0);
      setTracks(prev => prev.map(t => t.id === track.id
        ? { ...t, name: editForm.name, artist: editForm.artist, album: editForm.album }
        : t));
      setEditingId(null);
    } catch (err) {
      console.error("Edit save failed:", err);
    } finally {
      setSavingEdit(false);
    }
  }, [editForm]);

  const handleDeleteTrack = useCallback(async (e: React.MouseEvent, trackId: string) => {
    e.stopPropagation();
    if (confirmDeleteId === trackId) {
      try {
        await deleteTrackApi(trackId);
        setTracks(prev => prev.filter(t => t.id !== trackId));
        setConfirmDeleteId(null);
      } catch (err) {
        console.error("Delete failed:", err);
      }
    } else {
      setConfirmDeleteId(trackId);
      setTimeout(() => setConfirmDeleteId(prev => prev === trackId ? null : prev), 3000);
    }
  }, [confirmDeleteId]);

  useEffect(() => { load(); }, [load]);

  const handleReply = async (commentId: string) => {
    if (!replyText.trim()) return;
    setSendingReply(true);
    try {
      await replyToCommentApi(commentId, replyText.trim());
      setReplyText("");
      setReplyingTo(null);
      await load();
    } catch (e) { console.error(e); }
    setSendingReply(false);
  };

  const handleDeleteComment = async (trackId: string, commentId: string) => {
    if (!confirm("Delete this comment?")) return;
    try {
      await deleteCommentApi(trackId, commentId);
      await load();
    } catch (e) { console.error(e); }
  };

  const handleDeleteGuestbook = async (entryId: string) => {
    if (!confirm("Delete this guestbook entry?")) return;
    try {
      await deleteGuestbookEntryApi(entryId);
      await load();
    } catch (e) { console.error(e); }
  };

  const filteredComments = comments.filter(c => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return c.text.toLowerCase().includes(q) ||
      c.author.toLowerCase().includes(q) ||
      c.trackName.toLowerCase().includes(q);
  });

  const filteredGuestbook = guestbook.filter(g => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return g.text.toLowerCase().includes(q) || g.author.toLowerCase().includes(q);
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dashboard-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="dashboard-header">
          <h2>Admin Dashboard</h2>
          <div className="dashboard-tabs">
            <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
              Overview
            </button>
            <button className={tab === "tracks" ? "active" : ""} onClick={() => setTab("tracks")}>
              Tracks {stats ? `(${stats.totalTracks})` : ""}
            </button>
            <button className={tab === "comments" ? "active" : ""} onClick={() => setTab("comments")}>
              Comments {stats ? `(${stats.totalComments})` : ""}
            </button>
            <button className={tab === "guestbook" ? "active" : ""} onClick={() => setTab("guestbook")}>
              Guestbook {stats ? `(${stats.totalGuestbook})` : ""}
            </button>
          </div>
        </div>

        {loading && <div className="dash-loading">Loading...</div>}

        {!loading && tab === "overview" && stats && (
          <div className="dash-overview">
            <div className="stat-grid">
              <div className="stat-card">
                <div className="stat-value">{Number(stats.totalTracks)}</div>
                <div className="stat-label">Tracks</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{Number(stats.totalPlays).toLocaleString()}</div>
                <div className="stat-label">Total Plays</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{Number(stats.uniqueListeners)}</div>
                <div className="stat-label">Unique Listeners</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{Number(stats.totalComments)}</div>
                <div className="stat-label">Comments</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{Number(stats.totalGuestbook)}</div>
                <div className="stat-label">Guestbook</div>
              </div>
            </div>

            <div className="dash-section">
              <h3>Top Played</h3>
              {stats.topPlayed.length === 0 || stats.topPlayed.every(t => t.plays === 0n) ? (
                <p className="dash-empty">No plays recorded yet.</p>
              ) : (
                <ol className="top-played-list">
                  {stats.topPlayed.filter(t => t.plays > 0n).map((t) => (
                    <li
                      key={t.trackId}
                      onClick={() => openTrackDetail(t.trackId)}
                      style={{ cursor: "pointer" }}
                    >
                      <span className="tp-name">{t.name}</span>
                      <span className="tp-artist">{t.artist}</span>
                      <span className="tp-plays">{Number(t.plays).toLocaleString()} plays</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}

        {!loading && tab === "tracks" && (
          <div className="dash-tracks">
            <input
              type="text"
              className="dash-search"
              placeholder="Search tracks by name, artist, or album..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            <div className="dash-track-list">
              {tracks
                .filter(t => {
                  if (!filter) return true;
                  const q = filter.toLowerCase();
                  return t.name.toLowerCase().includes(q) ||
                    (t.artist || "").toLowerCase().includes(q) ||
                    (t.album || "").toLowerCase().includes(q);
                })
                .map(t => {
                  const plays = playCountsMap.get(t.id) ?? 0;
                  const isEditing = editingId === t.id;
                  const isConfirmingDelete = confirmDeleteId === t.id;
                  return (
                    <div
                      key={t.id}
                      className={`dash-track-row${t.featured ? " is-featured" : ""}${isEditing ? " is-editing" : ""}`}
                      onClick={() => !isEditing && setDetailTrack(t)}
                    >
                      <button
                        className={`dtr-feature-btn${t.featured ? " active" : ""}`}
                        onClick={(e) => handleToggleFeatured(e, t)}
                        title={t.featured ? "Unfeature" : "Feature"}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24"
                          fill={t.featured ? "currentColor" : "none"}
                          stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      </button>
                      {isEditing ? (
                        <div className="dtr-edit" onClick={e => e.stopPropagation()}>
                          <input
                            className="dtr-edit-input"
                            value={editForm.name}
                            placeholder="Track name"
                            onChange={e => setEditForm({...editForm, name: e.target.value})}
                            autoFocus
                          />
                          <div className="dtr-edit-row">
                            <input
                              className="dtr-edit-input"
                              value={editForm.artist}
                              placeholder="Artist"
                              onChange={e => setEditForm({...editForm, artist: e.target.value})}
                            />
                            <input
                              className="dtr-edit-input"
                              value={editForm.album}
                              placeholder="Album"
                              onChange={e => setEditForm({...editForm, album: e.target.value})}
                            />
                          </div>
                          <div className="dtr-edit-actions">
                            <button
                              className="dtr-btn dtr-btn-save"
                              onClick={(e) => handleSaveEdit(e, t)}
                              disabled={savingEdit}
                            >
                              {savingEdit ? "..." : "Save"}
                            </button>
                            <button className="dtr-btn dtr-btn-cancel" onClick={handleCancelEdit}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="dtr-meta">
                            <span className="dtr-name">{t.name}</span>
                            <span className="dtr-artist">{t.artist || "Unknown"}{t.album ? ` · ${t.album}` : ""}</span>
                          </div>
                          <span className="dtr-plays">{plays.toLocaleString()} plays</span>
                          <div className="dtr-actions">
                            <button
                              className="dtr-action-btn"
                              onClick={(e) => handleStartEdit(e, t)}
                              title="Edit"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                              </svg>
                            </button>
                            <button
                              className={`dtr-action-btn dtr-delete-btn${isConfirmingDelete ? " confirming" : ""}`}
                              onClick={(e) => handleDeleteTrack(e, t.id)}
                              title={isConfirmingDelete ? "Click again to confirm" : "Delete"}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14" />
                              </svg>
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {!loading && tab === "comments" && (
          <div className="dash-comments">
            <input
              type="text"
              className="dash-search"
              placeholder="Search comments by text, author, or track..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {filteredComments.length === 0 ? (
              <p className="dash-empty">{comments.length === 0 ? "No comments yet." : "No matches."}</p>
            ) : (
              <div className="dash-comment-list">
                {filteredComments.map(c => {
                  const commentReplies = repliesMap.get(c.id) || [];
                  const isReplying = replyingTo === c.id;
                  return (
                    <div key={c.id} className="dash-comment">
                      <div className="dash-comment-meta">
                        <span className="dash-comment-author">{c.author}</span>
                        <span className="dash-comment-track">on {c.trackName}</span>
                        <span className="dash-comment-time">{timeAgo(c.createdAt)}</span>
                        <button
                          className="dash-reply-btn"
                          onClick={() => { setReplyingTo(isReplying ? null : c.id); setReplyText(""); }}
                          title="Reply"
                        >
                          ↩
                        </button>
                        <button
                          className="dash-comment-delete"
                          onClick={() => handleDeleteComment(c.trackId, c.id)}
                          title="Delete"
                        >
                          &times;
                        </button>
                      </div>
                      <div className="dash-comment-text">{c.text}</div>
                      {commentReplies.length > 0 && (
                        <div className="dash-replies">
                          {commentReplies.map(r => (
                            <div key={r.id} className="dash-reply">
                              <span className="dash-reply-author">{r.author}</span>
                              <span className="dash-reply-time">{timeAgo(r.createdAt)}</span>
                              <div className="dash-reply-text">{r.text}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {isReplying && (
                        <div className="dash-reply-form">
                          <input
                            className="dash-reply-input"
                            placeholder="Write a reply..."
                            value={replyText}
                            onChange={e => setReplyText(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && handleReply(c.id)}
                            autoFocus
                          />
                          <button
                            className="dtr-btn dtr-btn-save"
                            onClick={() => handleReply(c.id)}
                            disabled={sendingReply || !replyText.trim()}
                          >
                            {sendingReply ? "..." : "Reply"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {!loading && tab === "guestbook" && (
          <div className="dash-guestbook">
            <input
              type="text"
              className="dash-search"
              placeholder="Search guestbook..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {filteredGuestbook.length === 0 ? (
              <p className="dash-empty">{guestbook.length === 0 ? "No entries yet." : "No matches."}</p>
            ) : (
              <div className="dash-comment-list">
                {filteredGuestbook.map(g => (
                  <div key={g.id} className="dash-comment">
                    <div className="dash-comment-meta">
                      <span className="dash-comment-author">{g.author}</span>
                      <span className="dash-comment-time">{timeAgo(g.createdAt)}</span>
                      <button
                        className="dash-comment-delete"
                        onClick={() => handleDeleteGuestbook(g.id)}
                        title="Delete"
                      >
                        &times;
                      </button>
                    </div>
                    <div className="dash-comment-text">{g.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {detailTrack && (
        <TrackDetail track={detailTrack} onClose={() => setDetailTrack(null)} />
      )}
    </div>
  );
}
