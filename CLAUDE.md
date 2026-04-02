# Cloud Records — ICP Music Hosting Platform

## Project Overview

Cloud Records is a fully on-chain music hosting platform built on the Internet Computer Protocol (ICP). Every byte of audio, metadata, and cover art lives in a single canister — no AWS, no CDN, no external dependencies. Built during the 3-day ICP AI Builder Sprint with Claude Code.

**Live URL:** https://gptw6-kyaaa-aaaas-qe6pq-cai.icp0.io/
**Backend canister:** `gptw6-kyaaa-aaaas-qe6pq-cai`

## Stack

- **Backend:** Motoko (Main.mo) — single canister, chunk-based audio storage, Enhanced Orthogonal Persistence
- **Frontend:** React + TypeScript + Vite — deployed as certified assets via @dfinity/asset-canister
- **Build:** `icp` CLI (icp.yaml config), `mops` for Motoko packages, `moc` 1.3.0 compiler
- **Deploy:** `icp build && icp deploy` to mainnet

## Architecture

### Backend (Main.mo)
- **Audio storage:** Chunk-based upload/download. Tracks split into chunks on upload, reassembled on playback.
- **Schema:** Split-storage pattern — `TrackCore` (essential fields) + `TrackExtra` (metadata) maps for upgrade safety
- **Fields:** title, artist, album, trackNumber, coverArtType, coverArt (separate storage)
- **Methods:** uploadChunk, listTracks, getChunk, updateTrack, deleteTrack, setCoverArt, getCoverArt
- **Ordering:** Track display order maintained in canister state

### Frontend
- **Components:** App.tsx (root), Playlist.tsx (track list), Player.tsx (audio player), UploadModal.tsx (upload form)
- **Theme:** Pixel art cloud logo, orange pastel (#f59c26), white background — "Cloud Records" brand
- **Audio playback:** Fetches chunks from canister, assembles into blob URL, plays via HTML5 audio

## Build & Deploy

```bash
# Install dependencies
npm --prefix frontend install
mops install

# Local dev
icp start        # start local replica
icp deploy       # deploy to local

# Mainnet deploy
icp build
icp deploy --network ic
```

## ICP Development Rules

When modifying this project:
- **Motoko stable types:** Never change the shape of stable vars in a way that breaks upgrade compatibility. Use the split-storage pattern (separate maps) for adding fields.
- **Chunk uploads:** Audio is uploaded in chunks (default ~256KB). Frontend splits, backend stores, reassembly on download.
- **Certified assets:** Frontend is served as certified assets. After changing frontend, run `icp build` to rebuild the dist/ folder.
- **Canister cycles:** Check cycle balance before large operations. Use `dfx canister status gptw6-kyaaa-aaaas-qe6pq-cai --network ic` to check.
- **Testing:** Test locally with `icp start && icp deploy` before deploying to mainnet.

## Current State (as of April 2026)

- 9 tracks uploaded to mainnet (15-20MB each — needs optimization to ~1-2MB)
- Full CRUD: upload, list, play, edit metadata, delete, cover art
- Mobile responsive (fixed in Day 2 sprint)
- Rebranded from "Sonic" to "Cloud Records"

## Design Principles

- Bold, specific aesthetic — pixel art cloud logo, orange/white theme
- Distinctive fonts, not generic defaults
- Purposeful animations and micro-interactions
- Match code complexity to aesthetic vision
