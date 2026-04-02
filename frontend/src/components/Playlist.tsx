import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { TrackInfo } from "../lib/types";
import { getCoverArtUrl, deleteTrack as deleteTrackApi, updateTrack as updateTrackApi } from "../lib/agent";

interface Props {
  tracks       : TrackInfo[];
  currentIndex : number | null;
  isPlaying    : boolean;
  isAdmin      : boolean;
  onSelect     : (index: number) => void;
  onDelete     : (trackId: string) => void;
  onReorder    : (fromIndex: number, toIndex: number) => void;
  onTrackUpdated: () => void;
}

type ViewMode = "albums" | "all";

interface AlbumGroup {
  album: string;
  tracks: { track: TrackInfo; globalIndex: number }[];
}

interface EditState {
  trackId: string;
  name: string;
  artist: string;
  album: string;
}

export default function Playlist({ tracks, currentIndex, isPlaying, isAdmin, onSelect, onDelete, onReorder, onTrackUpdated }: Props) {
  const [coverUrls, setCoverUrls] = useState<Map<string, string>>(new Map());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("albums");
  const [collapsedAlbums, setCollapsedAlbums] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [albumDragIndex, setAlbumDragIndex] = useState<number | null>(null);
  const [albumDropIndex, setAlbumDropIndex] = useState<number | null>(null);
  const [albumOrder, setAlbumOrder] = useState<string[]>([]);
  const dragCounter = useRef(0);
  const albumDragCounter = useRef(0);

  const startEdit = useCallback((track: TrackInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing({ trackId: track.id, name: track.name, artist: track.artist, album: track.album });
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await updateTrackApi(editing.trackId, editing.name, editing.artist, editing.album, 0);
      setEditing(null);
      onTrackUpdated();
    } catch (err) {
      console.error("Update failed:", err);
    } finally {
      setSaving(false);
    }
  }, [editing, onTrackUpdated]);

  const cancelEdit = useCallback(() => setEditing(null), []);

  useEffect(() => {
    tracks.forEach(track => {
      if (track.coverArtType && !coverUrls.has(track.id)) {
        getCoverArtUrl(track.id, track.coverArtType).then(url => {
          if (url) setCoverUrls(prev => new Map(prev).set(track.id, url));
        });
      }
    });
  }, [tracks]);

  const albumGroups = useMemo<AlbumGroup[]>(() => {
    const map = new Map<string, { track: TrackInfo; globalIndex: number }[]>();
    tracks.forEach((track, i) => {
      const album = track.album || "Uncategorized";
      if (!map.has(album)) map.set(album, []);
      map.get(album)!.push({ track, globalIndex: i });
    });
    return Array.from(map.entries()).map(([album, tracks]) => ({ album, tracks }));
  }, [tracks]);

  const isOriginal = (album: string) => {
    const lower = album.toLowerCase();
    if (lower.includes("cover")) return false; // "Piano Covers" is a cover
    return lower.includes("original");
  };

  const sortedAlbumGroups = useMemo(() => {
    if (albumOrder.length === 0) return albumGroups;
    const orderMap = new Map(albumOrder.map((name, i) => [name, i]));
    return [...albumGroups].sort((a, b) => {
      const ai = orderMap.get(a.album) ?? 999;
      const bi = orderMap.get(b.album) ?? 999;
      return ai - bi;
    });
  }, [albumGroups, albumOrder]);

  const originalGroups = useMemo(() => sortedAlbumGroups.filter(g => isOriginal(g.album)), [sortedAlbumGroups]);
  const coverGroups = useMemo(() => sortedAlbumGroups.filter(g => !isOriginal(g.album)), [sortedAlbumGroups]);

  const toggleAlbum = useCallback((album: string) => {
    setCollapsedAlbums(prev => {
      const next = new Set(prev);
      if (next.has(album)) next.delete(album);
      else next.add(album);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async (e: React.MouseEvent, trackId: string) => {
    e.stopPropagation();
    if (confirmDelete === trackId) {
      try { await deleteTrackApi(trackId); onDelete(trackId); }
      catch (err) { console.error("Delete failed:", err); }
      setConfirmDelete(null);
    } else {
      setConfirmDelete(trackId);
      setTimeout(() => setConfirmDelete(null), 3000);
    }
  }, [confirmDelete, onDelete]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    requestAnimationFrame(() => (e.currentTarget as HTMLElement).classList.add("dragging"));
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null); setDropIndex(null); dragCounter.current = 0;
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault(); dragCounter.current++; setDropIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current <= 0) { setDropIndex(null); dragCounter.current = 0; }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = dragIndex;
    setDragIndex(null); setDropIndex(null); dragCounter.current = 0;
    if (fromIndex !== null && fromIndex !== toIndex) onReorder(fromIndex, toIndex);
  }, [dragIndex, onReorder]);

  const renderTrackItem = (track: TrackInfo, globalIndex: number) => {
    const active = globalIndex === currentIndex;
    const artUrl = coverUrls.get(track.id);
    const isDragging = globalIndex === dragIndex;
    const isDropTarget = globalIndex === dropIndex && globalIndex !== dragIndex;

    return (
      <li
        key={track.id}
        className={`track-item${active ? " active" : ""}${isDragging ? " dragging" : ""}${isDropTarget ? " drop-target" : ""}`}
        onClick={() => onSelect(globalIndex)}
        draggable
        onDragStart={(e) => handleDragStart(e, globalIndex)}
        onDragEnd={handleDragEnd}
        onDragEnter={(e) => handleDragEnter(e, globalIndex)}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={(e) => handleDrop(e, globalIndex)}
      >
        <div className="drag-handle" onMouseDown={(e) => e.stopPropagation()}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <circle cx="3.5" cy="2" r="1.2"/><circle cx="8.5" cy="2" r="1.2"/>
            <circle cx="3.5" cy="6" r="1.2"/><circle cx="8.5" cy="6" r="1.2"/>
            <circle cx="3.5" cy="10" r="1.2"/><circle cx="8.5" cy="10" r="1.2"/>
          </svg>
        </div>
        <div className="track-thumb">
          {artUrl ? (
            <img src={artUrl} alt="" className="thumb-img" />
          ) : active && isPlaying ? (
            <span className="bars"><span /><span /><span /></span>
          ) : (
            <span className="idx">{globalIndex + 1}</span>
          )}
        </div>
        {editing?.trackId === track.id ? (
          <div className="track-edit" onClick={e => e.stopPropagation()}>
            <input className="edit-input edit-name" value={editing.name} placeholder="Track name"
              onChange={e => setEditing({...editing, name: e.target.value})} autoFocus />
            <div className="edit-row">
              <input className="edit-input edit-artist" value={editing.artist} placeholder="Artist"
                onChange={e => setEditing({...editing, artist: e.target.value})} />
              <input className="edit-input edit-album" value={editing.album} placeholder="Album"
                onChange={e => setEditing({...editing, album: e.target.value})} />
            </div>
            <div className="edit-actions">
              <button className="edit-save" onClick={saveEdit} disabled={saving}>{saving ? "..." : "Save"}</button>
              <button className="edit-cancel" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="track-meta">
              <span className="track-name">{track.name}</span>
              {viewMode === "all" && (
                <span className="track-artist">
                  {track.artist || "Unknown Artist"}
                  {track.album ? ` \u00B7 ${track.album}` : ""}
                </span>
              )}
              {viewMode === "albums" && (
                <span className="track-artist">{track.artist || "Unknown Artist"}</span>
              )}
            </div>
            <div className="track-actions">
              {isAdmin && (
                <button className="track-action-btn" onClick={(e) => startEdit(track, e)} title="Edit">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </button>
              )}
              {isAdmin && (
                <button
                  className={`track-action-btn ${confirmDelete === track.id ? "confirm" : ""}`}
                  onClick={(e) => handleDelete(e, track.id)}
                  title={confirmDelete === track.id ? "Confirm delete" : "Delete"}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14" />
                  </svg>
                </button>
              )}
            </div>
          </>
        )}
      </li>
    );
  };

  const renderAlbumGroup = (group: AlbumGroup, listIndex: number) => {
    const isCollapsed = collapsedAlbums.has(group.album);
    const firstArt = group.tracks.find(t => coverUrls.has(t.track.id));
    const albumArt = firstArt ? coverUrls.get(firstArt.track.id) : null;
    const isActiveAlbum = group.tracks.some(t => t.globalIndex === currentIndex);
    const isDraggingAlbum = listIndex === albumDragIndex;
    const isAlbumDropTarget = listIndex === albumDropIndex && listIndex !== albumDragIndex;

    return (
      <div
        key={group.album}
        className={`album-group${isActiveAlbum ? " active-album" : ""}${isDraggingAlbum ? " album-dragging" : ""}${isAlbumDropTarget ? " album-drop-target" : ""}`}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          setAlbumDragIndex(listIndex);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/album", String(listIndex));
        }}
        onDragEnd={() => { setAlbumDragIndex(null); setAlbumDropIndex(null); albumDragCounter.current = 0; }}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("text/album")) return;
          e.preventDefault(); albumDragCounter.current++; setAlbumDropIndex(listIndex);
        }}
        onDragLeave={() => {
          albumDragCounter.current--;
          if (albumDragCounter.current <= 0) { setAlbumDropIndex(null); albumDragCounter.current = 0; }
        }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("text/album")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("text/album")) return;
          e.preventDefault(); e.stopPropagation();
          const from = albumDragIndex;
          setAlbumDragIndex(null); setAlbumDropIndex(null); albumDragCounter.current = 0;
          if (from !== null && from !== listIndex) {
            setAlbumOrder(prev => {
              const current = prev.length > 0 ? [...prev] : albumGroups.map(g => g.album);
              const [moved] = current.splice(from, 1);
              current.splice(listIndex, 0, moved);
              return current;
            });
          }
        }}
      >
        <div className="album-header" onClick={() => toggleAlbum(group.album)}>
          <div className="album-drag-handle">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" opacity="0.3">
              <circle cx="3.5" cy="2" r="1.2"/><circle cx="8.5" cy="2" r="1.2"/>
              <circle cx="3.5" cy="6" r="1.2"/><circle cx="8.5" cy="6" r="1.2"/>
              <circle cx="3.5" cy="10" r="1.2"/><circle cx="8.5" cy="10" r="1.2"/>
            </svg>
          </div>
          <div className="album-art-small">
            {albumArt ? (
              <img src={albumArt} alt="" />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5">
                <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </div>
          <div className="album-info">
            <span className="album-name">{group.album}</span>
            <span className="album-count">{group.tracks.length} track{group.tracks.length !== 1 ? "s" : ""}</span>
          </div>
          <svg
            className={`album-chevron${isCollapsed ? " collapsed" : ""}`}
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
        {!isCollapsed && (
          <ul className="track-list album-tracks">
            {group.tracks.map(({ track, globalIndex }) => renderTrackItem(track, globalIndex))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <aside className="playlist">
      <div className="playlist-header">
        <span className="playlist-title">Library</span>
        <div className="playlist-controls">
          <button
            className={`view-toggle ${viewMode === "albums" ? "active" : ""}`}
            onClick={() => setViewMode(viewMode === "albums" ? "all" : "albums")}
            title={viewMode === "albums" ? "Show flat list" : "Group by album"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {viewMode === "albums" ? (
                <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>
              ) : (
                <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>
              )}
            </svg>
          </button>
          <span className="track-count">{tracks.length} tracks</span>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="playlist-empty">
          <div className="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4">
              <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <p>No tracks yet.</p>
          <p className="empty-sub">Upload an audio file to get started.</p>
        </div>
      ) : viewMode === "all" ? (
        <ul className="track-list">
          {tracks.map((track, i) => renderTrackItem(track, i))}
        </ul>
      ) : (
        <div className="album-groups">
          {originalGroups.length > 0 && (
            <>
              <div className="section-divider">
                <span className="section-label">Originals</span>
                <span className="section-count">{originalGroups.reduce((n, g) => n + g.tracks.length, 0)} tracks</span>
              </div>
              {originalGroups.map((group, i) => renderAlbumGroup(group, i))}
            </>
          )}
          {coverGroups.length > 0 && (
            <>
              <div className="section-divider">
                <span className="section-label">Covers</span>
                <span className="section-count">{coverGroups.reduce((n, g) => n + g.tracks.length, 0)} tracks</span>
              </div>
              {coverGroups.map((group, i) => renderAlbumGroup(group, originalGroups.length + i))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
