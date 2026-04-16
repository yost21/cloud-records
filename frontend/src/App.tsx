import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import type { TrackInfo } from "./lib/types";
import { getActor, setTrackOrder, loginAdmin, logoutAdmin, isAdmin as checkIsAdmin, getGuestbookEntries, addGuestbookEntry, deleteGuestbookEntryApi, getAllPlayCounts as fetchAllPlayCounts, getAllTomatoCounts as fetchAllTomatoCounts } from "./lib/agent";
import type { GuestbookEntry } from "./lib/types";
import { usePlayer } from "./hooks/usePlayer";
import Playlist    from "./components/Playlist";
import Player      from "./components/Player";
import UploadModal from "./components/UploadModal";
const Dashboard = lazy(() => import("./components/Dashboard"));

// Cloud Records logo (cloud with headphones)
function CloudLogo() {
  return (
    <img src="/cloud-logo.png" alt="Cloud Records" className="logo-cloud" />
  );
}

export default function App() {
  const [tracks,      setTracks]      = useState<TrackInfo[]>([]);
  const [playCounts,  setPlayCounts]  = useState<Map<string, number>>(new Map());
  const [tomatoCounts, setTomatoCounts] = useState<Map<string, number>>(new Map());
  const [showUpload,  setShowUpload]  = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [listError,   setListError]   = useState("");
  const [isAdmin,     setIsAdmin]     = useState(false);
  const [showTip,     setShowTip]     = useState(false);
  const [copied,      setCopied]      = useState(false);
  const [showGuestbook, setShowGuestbook] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [gbEntries,  setGbEntries]  = useState<GuestbookEntry[]>([]);
  const [gbAuthor,   setGbAuthor]   = useState(() => localStorage.getItem("cr-name") || "");
  const [gbText,     setGbText]     = useState("");
  const [gbPosting,  setGbPosting]  = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showInstallHint, setShowInstallHint] = useState(() => {
    if (typeof window === "undefined") return false;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
    const dismissed = localStorage.getItem("cr-install-dismissed");
    return isMobile && !isStandalone && !dismissed;
  });

  const { state, play, selectTrack, togglePlay, skipNext, skipPrev, seek, setVolume, toggleShuffle, cycleRepeat, playNext, addToQueue, removeFromQueue, clearQueue, currentTrack, currentAudioUrl } =
    usePlayer(tracks);

  const fetchTracks = useCallback(async () => {
    setLoadingList(true);
    setListError("");
    try {
      const actor  = await getActor();
      const result = await actor.listTracks();
      const sorted = [...result].sort((a, b) => Number(a.order) - Number(b.order));
      setTracks(sorted);
      fetchAllPlayCounts().then(setPlayCounts).catch(() => {});
      fetchAllTomatoCounts().then(setTomatoCounts).catch(() => {});
    } catch (err) {
      console.error(err);
      setListError("Could not load tracks. Please try again.");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { fetchTracks(); }, [fetchTracks]);

  // Deep link: ?track=TRACK_ID → pre-select that track on load (no autoplay).
  // Default (no deep link): pre-select "Comfortably Numb".
  // We use selectTrack (not play) because mobile browsers block autoplay on
  // mount — calling play() here would silently fail and poison the audio
  // element's unlock state, breaking subsequent real user clicks.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || tracks.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const trackId = params.get("track");
    if (trackId) {
      deepLinkHandled.current = true;
      const idx = tracks.findIndex(t => t.id === trackId);
      if (idx >= 0) {
        selectTrack(idx);
        window.history.replaceState({}, "", window.location.pathname);
      }
    } else {
      deepLinkHandled.current = true;
      const idx = tracks.findIndex(t => t.name.toLowerCase().includes("comfortably numb"));
      if (idx >= 0) selectTrack(idx);
    }
  }, [tracks, selectTrack]);

  // Keyboard shortcuts: Space=play/pause, Arrows=skip
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          skipNext();
          break;
        case "ArrowLeft":
          skipPrev();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, skipNext, skipPrev]);

  // Triple-click the logo to trigger Internet Identity login
  const adminClickCount = useRef(0);
  const adminTimer = useRef<ReturnType<typeof setTimeout>>();
  const handleLogoClick = useCallback(async () => {
    adminClickCount.current++;
    clearTimeout(adminTimer.current);
    if (adminClickCount.current >= 3) {
      adminClickCount.current = 0;
      if (isAdmin) {
        await logoutAdmin();
        setIsAdmin(false);
      } else {
        const result = await loginAdmin();
        if (result.success) {
          setIsAdmin(true);
          fetchTracks();
        } else if (result.error) {
          alert(result.error);
        }
      }
    } else {
      adminTimer.current = setTimeout(() => { adminClickCount.current = 0; }, 600);
    }
  }, [isAdmin, fetchTracks]);

  const handleShuffleAll = useCallback(() => {
    if (tracks.length === 0) return;
    if (!state.shuffle) toggleShuffle();
    const rand = Math.floor(Math.random() * tracks.length);
    play(rand);
  }, [tracks.length, state.shuffle, toggleShuffle, play]);

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

  const loadGuestbook = useCallback(async () => {
    try { setGbEntries(await getGuestbookEntries()); } catch { /* ignore */ }
  }, []);

  const openGuestbook = useCallback(() => {
    setShowGuestbook(true);
    loadGuestbook();
  }, [loadGuestbook]);

  const handlePostGb = async () => {
    if (!gbText.trim()) return;
    setGbPosting(true);
    try {
      if (gbAuthor) localStorage.setItem("cr-name", gbAuthor);
      await addGuestbookEntry(gbAuthor, gbText.trim());
      setGbText("");
      await loadGuestbook();
    } catch (e) { console.error(e); }
    setGbPosting(false);
  };

  const handleDeleteGb = async (entryId: string) => {
    try { await deleteGuestbookEntryApi(entryId); await loadGuestbook(); }
    catch (e) { console.error(e); }
  };

  function gbTimeAgo(ns: bigint): string {
    const seconds = Math.floor((Date.now() - Number(ns) / 1_000_000) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  return (
    <div className="app">
      <div className="tip-banner" onClick={() => setShowTip(true)} style={{cursor: "pointer"}}>
        All music <span className="tip-roughly">(roughly)</span> self-produced. <span className="tip-cta">Tip me</span> so I can afford a real producer. 🤣🫡🙌
      </div>
      <header className="app-header">
        <div className="logo" onClick={handleLogoClick} style={{cursor: "pointer"}}>
          <CloudLogo />
          <span className="logo-text">Cloud Records</span>
          <span className="logo-badge">{isAdmin ? "admin" : "on-chain"}</span>
        </div>
        <div className="header-actions">
          <button className="btn-shortcuts" onClick={() => setShowShortcuts(s => !s)} title="Keyboard shortcuts">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
            </svg>
          </button>
          <button className="btn-guestbook" onClick={openGuestbook} title="Guestbook">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
            </svg>
          </button>
          {isAdmin && (
            <>
              <button className="btn-dashboard" onClick={() => setShowDashboard(true)} title="Dashboard">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/>
                  <rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>
                </svg>
              </button>
              <button className="btn-upload" onClick={() => setShowUpload(true)}>+ Upload</button>
              <button className="btn-logout" onClick={async () => { await logoutAdmin(); setIsAdmin(false); }} title="Exit admin">
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
              onShuffleAll ={handleShuffleAll}
              onPlayNext   ={playNext}
              onAddToQueue ={addToQueue}
              playCounts   ={playCounts}
              tomatoCounts ={tomatoCounts}
              onTomatoThrown={() => fetchAllTomatoCounts().then(setTomatoCounts).catch(() => {})}
            />
            <Player
              track     ={currentTrack}
              tracks    ={tracks}
              state     ={state}
              isAdmin   ={isAdmin}
              onToggle  ={togglePlay}
              onNext    ={skipNext}
              onPrev    ={skipPrev}
              onSeek    ={seek}
              onVolume  ={setVolume}
              onShuffle ={toggleShuffle}
              onRepeat  ={cycleRepeat}
              onRemoveFromQueue={removeFromQueue}
              onClearQueue={clearQueue}
              audioUrl={currentAudioUrl}
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

      {showDashboard && isAdmin && (
        <Suspense fallback={<div className="modal-overlay"><div style={{color:"#f59c26",fontSize:16,fontWeight:600}}>Loading dashboard...</div></div>}>
          <Dashboard onClose={() => setShowDashboard(false)} />
        </Suspense>
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
                navigator.clipboard.writeText("2qpnt-4gq7m-b6gtl-tfvws-rmkjm-rbgrb-tul2j-lsbgs-sfphw-whjr7-qqe");
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}>
                <div className="tip-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 12h8M12 8v8" />
                  </svg>
                </div>
                <div className="tip-label">{copied ? "Copied!" : "Tip with Crypto"}</div>
                <div className="tip-desc">ICP, ckBTC, ckETH, ckUSDC</div>
                <div className="tip-desc tip-address">2qpnt-4gq7m-b6gtl-tfvws-rmkjm-rbgrb-tul2j-lsbgs-sfphw-whjr7-qqe</div>
                <div className="tip-hint">{copied ? "Paste in your wallet" : "Click to copy ICP address"}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showGuestbook && (
        <div className="modal-overlay" onClick={() => setShowGuestbook(false)}>
          <div className="modal guestbook-modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowGuestbook(false)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
            <h3>Guestbook</h3>
            <p className="gb-sub">Leave a message and let me know you stopped by.</p>

            <div className="gb-entries">
              {gbEntries.length === 0 && (
                <div className="gb-empty">No entries yet. Be the first!</div>
              )}
              {[...gbEntries].reverse().map(e => (
                <div key={e.id} className="gb-entry">
                  <div className="gb-entry-top">
                    <span className="gb-author">{e.author}</span>
                    <span className="gb-time">{gbTimeAgo(e.createdAt)}</span>
                    {isAdmin && (
                      <button className="gb-delete" onClick={() => handleDeleteGb(e.id)}>&times;</button>
                    )}
                  </div>
                  <div className="gb-text">{e.text}</div>
                </div>
              ))}
            </div>

            <div className="gb-form">
              <input
                className="gb-name"
                type="text"
                placeholder="Your name"
                value={gbAuthor}
                onChange={e => setGbAuthor(e.target.value)}
              />
              <div className="gb-input-row">
                <input
                  className="gb-input"
                  type="text"
                  placeholder="Leave a message..."
                  value={gbText}
                  onChange={e => setGbText(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handlePostGb()}
                  maxLength={500}
                />
                <button
                  className="gb-submit"
                  onClick={handlePostGb}
                  disabled={gbPosting || !gbText.trim()}
                >
                  {gbPosting ? "..." : "Sign"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Install hint banner for mobile */}
      {showInstallHint && (
        <div className="install-banner">
          <span>Add Cloud Records to your home screen for the full app experience</span>
          <button onClick={() => { setShowInstallHint(false); localStorage.setItem("cr-install-dismissed", "1"); }}>Got it</button>
        </div>
      )}

      {/* Keyboard shortcut legend */}
      {showShortcuts && (
        <div className="modal-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="modal shortcuts-modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowShortcuts(false)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
            <h3>Keyboard Shortcuts</h3>
            <div className="shortcut-list">
              <div className="shortcut-row"><kbd>Space</kbd><span>Play / Pause</span></div>
              <div className="shortcut-row"><kbd>←</kbd><span>Previous track</span></div>
              <div className="shortcut-row"><kbd>→</kbd><span>Next track</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
