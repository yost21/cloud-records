# Cloud Records — ICP Music Hosting Platform

## Project Overview

Cloud Records is a fully on-chain music hosting platform built on the Internet Computer Protocol (ICP). Every byte of audio, metadata, cover art, comments, and analytics lives in a single canister — no AWS, no CDN, no external dependencies.

**Live URL:** https://kmeho-ciaaa-aaaae-ageza-cai.icp0.io/
**Frontend (asset) canister:** `kmeho-ciaaa-aaaae-ageza-cai`
**Backend canister:** `kfhms-uaaaa-aaaae-ageyq-cai`

## Stack

- **Backend:** Motoko (Main.mo) — single canister, chunk-based audio storage, Enhanced Orthogonal Persistence
- **Frontend:** React + TypeScript + Vite — deployed as certified assets via @dfinity/asset-canister
- **Build:** `icp` CLI (icp.yaml config), `mops` for Motoko packages, `moc` 1.3.0 compiler
- **Deploy:** `icp build && icp deploy -e ic -y` to mainnet
- **Auth:** Internet Identity for admin login

## Architecture

### Audio Storage
- Chunk-based: files split into 1.9MB chunks on frontend, stored as Blobs in canister Map
- Upload: `uploadChunk(trackId, chunkIndex, blob)` → `finalizeTrack()` with metadata
- Playback: parallel fetch (concurrency 4), reassemble client-side, HTML5 `<audio>` element
- Cover art stored separately via `setCoverArt(trackId, blob, mimeType)`
- Browser-side IndexedDB cache (200MB cap, LRU eviction) avoids re-fetching on replay

### Backend Data Model (split-storage pattern — NEVER modify existing types)
- `tracks: Map<Text, TrackCore>` — id, name, mimeType, totalChunks, size, createdAt, order
- `trackExtras: Map<Text, TrackExtra>` — artist, album, trackNumber, coverArtType
- `chunks: Map<Text, Blob>` — key: "trackId:chunkIndex"
- `coverArts: Map<Text, Blob>`
- `featured: Map<Text, Bool>`
- `playCounts: Map<Text, Nat>` + `playLog: Map<Text, [Int]>` (rolling 200 timestamps)
- `uniqueListeners: Map<Text, Bool>` + `uniqueListenersPerTrack: Map<Text, Bool>`
- `tomatoCounts: Map<Text, Nat>` + `tomatoDedup: Map<Text, Bool>` (clap button)
- `comments: Map<Text, [Comment]>` + `replies: Map<Text, [Reply]>`
- `guestbook: [GuestbookEntry]`
- `admins: Map<Principal, Bool>`
- Rate limiting maps: `lastPostAt`, `playRateLimit`

### Frontend Key Components
- `App.tsx` — root, auth state, modals
- `Playlist.tsx` — sidebar with albums, search, sort, featured, queue, clap
- `Player.tsx` — transport, waveform, comments, queue display
- `Dashboard.tsx` — admin analytics (lazy-loaded), stats, tracks, comments, guestbook
- `TrackDetail.tsx` — per-track drill-in with 30-day activity chart
- `Waveform.tsx` — Web Audio API canvas visualization
- `usePlayer.ts` — playback state, queue, media session, preloading
- `agent.ts` — canister actor, parallel chunk fetch, cache integration
- `audioCache.ts` — IndexedDB cache
- `share.ts` — shared shareTrack utility

## Build & Deploy

```bash
# Install dependencies
npm --prefix frontend install
mops install

# Local dev
icp start && icp deploy

# Mainnet deploy
npm --prefix frontend run build
icp deploy -e ic -y
```

## ICP Development Rules

- **Motoko stable types:** NEVER change the shape of existing persistent types. Use the split-storage pattern (new Maps) for adding fields.
- **EOP field-drop discipline:** Never drop an existing persistent field during the same upgrade that adds new fields. Specifically: `lastPlayAt : Map<Principal, Int>` at `backend/Main.mo:120` is dead code retained for EOP compatibility — do NOT remove it during the Phase 1 video upgrade. Removal, if ever, must be its own isolated upgrade tested against a restored staging canister first. Additive schema changes (new maps, new types, new fields on existing records) are safe under `persistent actor` + `dfx canister install --mode upgrade --wasm-memory-persistence keep`.
- **EOP upgrade flag is mandatory:** Never run `dfx canister install` on a `persistent actor` production canister without `--wasm-memory-persistence keep`. The upgrade will trap with `IC0504`/`IC0522` under EOP.
- **Chunk uploads:** 1.9MB chunks (under 2MB canister call limit). Frontend splits, backend stores, parallel fetch on download.
- **Certified assets:** After frontend changes, `icp build` rebuilds dist/.
- **Canister cycles:** `dfx canister status kfhms-uaaaa-aaaae-ageyq-cai --network ic` to check.
- **Testing:** Build check (`npm --prefix frontend run build`) before every deploy.

## Current State (as of April 2026)

- 37 tracks uploaded, optimized MP3s, ~470MB total on-chain storage
- Full CRUD: upload, list, play, edit metadata, delete, cover art, featured toggle
- Comments with admin replies, guestbook, spam protection (rate limiting + link filtering + storage caps)
- Admin dashboard with play counts, unique listeners, per-track analytics, 30-day activity charts
- Queue system, search, sort, waveform visualization, Media Session API (lock screen controls)
- PWA manifest (Add to Home Screen with branded icon)
- Browser audio cache (IndexedDB), parallel chunk fetching, next-track preloading
- Logo: orange cloud + premium headphones + gold infinity symbol (DFINITY nod)
- 6 automated LaunchAgents: crypto tips, Stripe tips, cycle balance, daily digest, weekly backup, monthly backup
- All monitoring posts to Mr. Cloud Discord via webhook

## Design Principles

- Bold, distinctive — NOT Inter, Roboto, Arial, or generic system fonts
- Orange accent (#f59c26), white background, cream surfaces
- CSS variables for cohesive color system
- Purposeful animations, no generic AI aesthetics
- Every track must have cover art (generate if none provided)
