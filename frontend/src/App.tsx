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
  const [showTip,     setShowTip]     = useState(false);
  const [copied,      setCopied]      = useState(false);

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
      <div className="tip-banner" onClick={() => setShowTip(true)} style={{cursor: "pointer"}}>
        All music <span className="tip-roughly">(roughly)</span> self-produced. <span className="tip-cta">Tip me</span> so I can afford a real producer.
      </div>
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

      {showTip && (
        <div className="modal-overlay" onClick={() => setShowTip(false)}>
          <div className="modal tip-modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowTip(false)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
            <h3>Support Cloud Records</h3>
            <p className="tip-sub">Every tip goes directly toward better gear, mixing, and maybe one day... a real producer.</p>

            <div className="tip-options">
              <a
                href="https://buy.stripe.com/test_fZu14peAv7aC1843Uhawo00"
                target="_blank"
                rel="noopener noreferrer"
                className="tip-option tip-card"
              >
                <div className="tip-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="1" y="4" width="22" height="16" rx="2" />
                    <line x1="1" y1="10" x2="23" y2="10" />
                  </svg>
                </div>
                <div className="tip-label">Tip with Card</div>
                <div className="tip-desc">Visa, Mastercard, Apple Pay</div>
              </a>

              <div className="tip-option tip-crypto" onClick={() => {
                navigator.clipboard.writeText("yxsim-sclu2-ed6yw-julz4-yn5th-hwyvs-d3pab-sflmr-iv4ah-yxikq-nae");
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}>
                <div className="tip-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold" stroke="none">ICP</text>
                  </svg>
                </div>
                <div className="tip-label">{copied ? "Copied!" : "Tip with ICP"}</div>
                <div className="tip-desc tip-address">yxsim-sclu2-ed6yw-julz4-yn5th-hwyvs-d3pab-sflmr-iv4ah-yxikq-nae</div>
                <div className="tip-hint">{copied ? "Paste in your wallet" : "Click to copy address"}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
