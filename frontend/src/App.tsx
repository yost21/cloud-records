import { useState, useEffect, useCallback, useRef } from "react";
import type { TrackInfo } from "./lib/types";
import { getActor, setTrackOrder } from "./lib/agent";
import { usePlayer } from "./hooks/usePlayer";
import Playlist    from "./components/Playlist";
import Player      from "./components/Player";
import UploadModal from "./components/UploadModal";

// Pixel art cloud logo SVG
function CloudLogo() {
  return (
    <svg className="logo-cloud" width="28" height="22" viewBox="0 0 28 22" fill="currentColor">
      <rect x="8" y="0" width="8" height="2"/>
      <rect x="6" y="2" width="2" height="2"/>
      <rect x="16" y="2" width="2" height="2"/>
      <rect x="4" y="4" width="2" height="2"/>
      <rect x="18" y="4" width="4" height="2"/>
      <rect x="2" y="6" width="2" height="2"/>
      <rect x="22" y="6" width="2" height="2"/>
      <rect x="24" y="8" width="2" height="2"/>
      <rect x="0" y="8" width="2" height="4"/>
      <rect x="24" y="10" width="4" height="2"/>
      <rect x="2" y="12" width="2" height="2"/>
      <rect x="26" y="12" width="2" height="2"/>
      <rect x="2" y="14" width="26" height="2"/>
      <rect x="4" y="16" width="22" height="2"/>
      <rect x="6" y="18" width="18" height="2"/>
      <rect x="8" y="20" width="14" height="2"/>
    </svg>
  );
}

export default function App() {
  const [tracks,      setTracks]      = useState<TrackInfo[]>([]);
  const [showUpload,  setShowUpload]  = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [listError,   setListError]   = useState("");
  const [isAdmin,     setIsAdmin]     = useState(false);

  const { state, play, togglePlay, skipNext, skipPrev, seek, setVolume, currentTrack } =
    usePlayer(tracks);

  const fetchTracks = useCallback(async () => {
    setLoadingList(true);
    setListError("");
    try {
      const actor  = await getActor();
      const result = await actor.listTracks();
      const sorted = [...result].sort((a, b) => Number(a.order) - Number(b.order));
      setTracks(sorted);
    } catch (err) {
      console.error(err);
      setListError("Could not load tracks. Please try again.");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { fetchTracks(); }, [fetchTracks]);

  // Triple-click the logo to toggle admin mode
  // Security is enforced at the canister level — non-admin calls are rejected
  const adminClickCount = useRef(0);
  const adminTimer = useRef<ReturnType<typeof setTimeout>>();
  const handleLogoClick = useCallback(() => {
    adminClickCount.current++;
    clearTimeout(adminTimer.current);
    if (adminClickCount.current >= 3) {
      setIsAdmin(prev => !prev);
      adminClickCount.current = 0;
    } else {
      adminTimer.current = setTimeout(() => { adminClickCount.current = 0; }, 600);
    }
  }, []);

  const handleDelete = useCallback((trackId: string) => {
    setTracks(prev => prev.filter(t => t.id !== trackId));
  }, []);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    setTracks(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    const track = tracks[fromIndex];
    const targetOrder = Number(tracks[toIndex].order);
    setTrackOrder(track.id, targetOrder).catch(err => {
      console.error("Reorder failed:", err);
      fetchTracks();
    });
  }, [tracks, fetchTracks]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo" onClick={handleLogoClick} style={{cursor: "pointer"}}>
          <CloudLogo />
          <span className="logo-text">Cloud Records</span>
          <span className="logo-badge">{isAdmin ? "admin" : "on-chain"}</span>
        </div>
        <div className="header-actions">
          {isAdmin && (
            <>
              <button className="btn-upload" onClick={() => setShowUpload(true)}>+ Upload</button>
              <button className="btn-logout" onClick={() => setIsAdmin(false)} title="Exit admin">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
              </button>
            </>
          )}
        </div>
      </header>

      <main className="app-body">
        {loadingList ? (
          <div className="full-loader">
            <div className="loader-ring" />
            <p>Connecting to canister...</p>
          </div>
        ) : listError ? (
          <div className="full-error">
            <p>{listError}</p>
            <button className="btn-primary" onClick={fetchTracks}>Retry</button>
          </div>
        ) : (
          <>
            <Playlist
              tracks       ={tracks}
              currentIndex ={state.currentIndex}
              isPlaying    ={state.isPlaying}
              isAdmin      ={isAdmin}
              onSelect     ={play}
              onDelete     ={handleDelete}
              onReorder    ={handleReorder}
              onTrackUpdated={fetchTracks}
            />
            <Player
              track     ={currentTrack}
              state     ={state}
              onToggle  ={togglePlay}
              onNext    ={skipNext}
              onPrev    ={skipPrev}
              onSeek    ={seek}
              onVolume  ={setVolume}
            />
          </>
        )}
      </main>

      {showUpload && (
        <UploadModal
          onClose    ={() => setShowUpload(false)}
          onUploaded ={() => { fetchTracks(); }}
        />
      )}
    </div>
  );
}
