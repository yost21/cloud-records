import { useRef, useState, useCallback } from "react";
import { uploadTrack, type UploadProgress, type TrackMetadata } from "../lib/agent";

interface Props {
  onClose      : () => void;
  onUploaded   : () => void;
}

type Phase = "idle" | "metadata" | "uploading" | "done" | "error";

export default function UploadModal({ onClose, onUploaded }: Props) {
  const audioInputRef = useRef<HTMLInputElement>(null);
  const artInputRef   = useRef<HTMLInputElement>(null);
  const [phase,    setPhase]    = useState<Phase>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [isDrag,   setIsDrag]   = useState(false);

  const [file,         setFile]         = useState<File | null>(null);
  const [title,        setTitle]        = useState("");
  const [artist,       setArtist]       = useState("");
  const [album,        setAlbum]        = useState("");
  const [trackNumber,  setTrackNumber]  = useState("");
  const [coverArt,     setCoverArt]     = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  const handleFile = useCallback((f: File) => {
    if (!f.type.startsWith("audio/")) {
      setErrorMsg("Please select an audio file (MP3, M4A, WAV, OGG...)");
      setPhase("error");
      return;
    }
    setFile(f);
    setTitle(f.name.replace(/\.[^/.]+$/, ""));
    setPhase("metadata");
  }, []);

  const handleCoverArt = useCallback((f: File) => {
    if (!f.type.startsWith("image/")) return;
    setCoverArt(f);
    const url = URL.createObjectURL(f);
    setCoverPreview(url);
  }, []);

  const handleUpload = useCallback(async () => {
    if (!file) return;
    setPhase("uploading");
    setProgress({ chunksUploaded: 0, totalChunks: 1 });

    const metadata: TrackMetadata = {
      name:        title || file.name.replace(/\.[^/.]+$/, ""),
      artist:      artist,
      album:       album,
      trackNumber: parseInt(trackNumber) || 0,
      coverArt:    coverArt || undefined,
    };

    try {
      await uploadTrack(file, metadata, p => setProgress(p));
      setPhase("done");
      onUploaded();
    } catch (err) {
      console.error(err);
      setErrorMsg(err instanceof Error ? err.message : "Upload failed");
      setPhase("error");
    }
  }, [file, title, artist, album, trackNumber, coverArt, onUploaded]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const pct = progress
    ? Math.round((progress.chunksUploaded / progress.totalChunks) * 100)
    : 0;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>Upload Track</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">x</button>
        </div>

        {phase === "idle" && (
          <div
            className={`drop-zone ${isDrag ? "drag-over" : ""}`}
            onDragOver={e => { e.preventDefault(); setIsDrag(true); }}
            onDragLeave={() => setIsDrag(false)}
            onDrop={onDrop}
            onClick={() => audioInputRef.current?.click()}
          >
            <div className="drop-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <p className="drop-main">Drop an audio file here</p>
            <p className="drop-sub">or click to browse</p>
            <p className="drop-formats">MP3 . M4A . WAV . OGG . FLAC</p>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </div>
        )}

        {phase === "metadata" && (
          <div className="metadata-form">
            <div className="form-row">
              <label>Title</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Track title" autoFocus />
            </div>
            <div className="form-row">
              <label>Artist</label>
              <input type="text" value={artist} onChange={e => setArtist(e.target.value)} placeholder="Artist name" />
            </div>
            <div className="form-row-half">
              <div className="form-row">
                <label>Album</label>
                <input type="text" value={album} onChange={e => setAlbum(e.target.value)} placeholder="Album name" />
              </div>
              <div className="form-row">
                <label>Track #</label>
                <input type="number" value={trackNumber} onChange={e => setTrackNumber(e.target.value)} placeholder="1" min="0" />
              </div>
            </div>
            <div className="form-row">
              <label>Cover Art <span className="optional-tag">optional</span></label>
              <div
                className="cover-art-picker"
                onClick={() => artInputRef.current?.click()}
              >
                {coverPreview ? (
                  <img src={coverPreview} alt="Cover art preview" className="cover-preview" />
                ) : (
                  <div className="cover-placeholder">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                    <span>Add cover art</span>
                  </div>
                )}
              </div>
              <input
                ref={artInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) handleCoverArt(f);
                }}
              />
            </div>
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => { setPhase("idle"); setFile(null); }}>Back</button>
              <button className="btn-primary" onClick={handleUpload}>Upload</button>
            </div>
          </div>
        )}

        {phase === "uploading" && progress && (
          <div className="upload-progress">
            <div className="progress-label">
              Uploading chunk {progress.chunksUploaded} of {progress.totalChunks}...
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-pct">{pct}%</div>
          </div>
        )}

        {phase === "done" && (
          <div className="upload-done">
            <div className="done-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <p>Track uploaded successfully!</p>
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        )}

        {phase === "error" && (
          <div className="upload-error">
            <div className="error-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </div>
            <p>{errorMsg}</p>
            <button className="btn-primary" onClick={() => setPhase("idle")}>Try Again</button>
          </div>
        )}
      </div>
    </div>
  );
}
