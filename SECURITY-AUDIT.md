# Security Audit — Cloud Records (music-platform)

**Date:** 2026-04-02
**Auditor:** Forge (Lead Engineer)
**Scope:** Backend (`backend/Main.mo`), Frontend (`frontend/src/`)

---

## Executive Summary

The Cloud Records canister has **zero access control**. Every public update method is callable by anonymous users with no authentication, no ownership checks, and no input validation. The canister is suitable for trusted-demo use only — deploying it as a public-facing music platform without fixes would allow any caller to upload, modify, or delete all tracks and exhaust canister storage.

**Finding counts:**

| Severity | Backend | Frontend | Total |
|----------|---------|----------|-------|
| Critical | 4       | 0        | 4     |
| High     | 3       | 3        | 6     |
| Medium   | 3       | 4        | 7     |
| Low      | 3       | 3        | 6     |

---

## Critical Findings

### C1. No Anonymous Caller Rejection
**Backend — Main.mo, all update functions**

Every public update method (`uploadChunk`, `finalizeTrack`, `setCoverArt`, `setOrder`, `updateTrack`, `deleteTrack`) lacks `Principal.isAnonymous()` checks. Any anonymous caller can upload, modify, reorder, or delete any track.

**Fix:** Add caller validation to all update methods:
```motoko
assert(not Principal.isAnonymous(msg.caller));
```

### C2. Unbounded Storage — DoS Vector
**Backend — Main.mo, all storage maps**

All maps (`chunks`, `tracks`, `trackExtras`, `coverArts`) are unbounded. No limits on:
- Total stored data
- Number of tracks
- Individual chunk size
- Cover art size
- Metadata field length

An attacker can exhaust canister memory by uploading unlimited chunks.

**Fix:** Add size constants and validate in every write path:
```motoko
let MAX_CHUNK_SIZE    = 2_000_000;   // 2MB
let MAX_COVER_ART     = 5_000_000;   // 5MB
let MAX_TRACKS        = 1_000;
let MAX_METADATA_LEN  = 500;         // chars
```

### C3. No Chunk Integrity Validation
**Backend — Main.mo, `finalizeTrack()`**

`finalizeTrack()` records `totalChunks` and `size` but never verifies:
- That all chunks 0..totalChunks-1 actually exist
- That the declared size matches actual chunk data
- That chunks are sequential and complete

A caller can finalize a track with 1 chunk but claim 1000, causing frontend fetch failures.

**Fix:** Iterate chunks 0..n-1 and verify existence + total size before finalizing.

### C4. No Data Ownership Model
**Backend — Main.mo**

No concept of track ownership. Tracks are not tied to the caller who uploaded them. Any caller can modify or delete any track.

**Fix:** Store `owner: Principal` per track and verify `msg.caller == owner` on update/delete.

---

## High Findings

### H1. Reorder Function — Unbounded Loop / Cycle Drain
**Backend — Main.mo, `setOrder()` (lines 149-210)**

`setOrder()` iterates through all `trackCount` slots. If an attacker inflates trackCount via fake uploads, each reorder call burns excessive cycles with an O(n) loop.

### H2. Upgrade Safety Uncertainty
**Backend — Main.mo**

Uses `persistent actor` with Enhanced Orthogonal Persistence. Code comments warn about maintaining identical data shapes. If a type change is introduced during upgrade, all data could be lost. No explicit upgrade tests exist.

### H3. Query Method Can Trap
**Backend — Main.mo, `listTracks()`**

If the order index becomes inconsistent (gaps in `trackOrder`), `listTracks()` hits a `Runtime.trap()` — crashing the query and making the canister unable to serve track listings.

### H4. No MIME Type Validation on Blob URLs
**Frontend — `agent.ts` lines 115-116, 144-145**

Blob URLs for cover art and audio are created using `mimeType` directly from canister data without whitelisting. Should validate against `audio/*` and `image/*` allowlists.

### H5. No Content Security Policy
**Frontend — `index.html`, `vite.config.ts`**

No CSP headers configured. Script injection is not blocked by policy — relies entirely on React's auto-escaping.

### H6. File Upload Validation is Client-Side Only
**Frontend — `UploadModal.tsx` lines 28-32**

Audio/image type checking uses `file.type` which is trivially bypassed by renaming files. Backend accepts any blob.

---

## Medium Findings

### M1. No Rate Limiting
**Backend — all update methods**

No per-caller request tracking or cooldowns. An attacker can call any function thousands of times rapidly.

### M2. No Input Sanitization on Text Fields
**Backend — `finalizeTrack()`, `updateTrack()`**

`name`, `artist`, `album` are stored raw. While React auto-escapes on render, control characters, RTL overrides, or extremely long strings could cause UI issues.

### M3. Orphaned Data on Delete Race
**Backend — `deleteTrack()` vs `setCoverArt()`**

If `setCoverArt()` races with `deleteTrack()`, cover art blobs can be orphaned in memory or the set call can trap.

### M4. Error Messages Leak Canister State
**Frontend — `App.tsx`, `UploadModal.tsx`, `usePlayer.ts`**

Raw canister error objects are logged to console and sometimes surfaced in UI. Motoko `trap()` messages expose internal track IDs and state.

### M5. Hardcoded Fallback Canister ID
**Frontend — `agent.ts` line 8**

Falls back to `"aaaaa-aa"` if env var is missing — fails silently instead of erroring at init.

### M6. No Canister Response Validation
**Frontend — `agent.ts`, `App.tsx`**

Data returned from canister is assumed to match the IDL interface with no runtime type checking. Malformed responses cause silent failures.

### M7. No Authentication Layer
**Frontend — `agent.ts` `getActor()`**

Creates actor with anonymous principal. No Internet Identity integration. All users share the same anonymous access.

---

## Low Findings

### L1. Predictable Track IDs
**Frontend — `agent.ts`**

Track IDs use `Date.now()` + weak `Math.random()`. Predictable but low risk given current architecture.

### L2. Fragile Order Tracking
**Backend — `trackOrder` map**

Separate order map can become inconsistent with `tracks` map. Should be consolidated or invariant-checked.

### L3. No Audit Logging
**Backend**

No events logged for uploads, deletes, or metadata changes. No forensic capability.

### L4. Blob URL Memory Leak
**Frontend**

`URL.createObjectURL()` calls are never revoked. Long sessions accumulate leaked memory.

### L5. No Upload Rate Limiting (Frontend)
**Frontend — `UploadModal.tsx`**

No throttle or cooldown on upload button. Users can spam uploads.

### L6. Console Error Exposure in Production
**Frontend — multiple catch blocks**

Full error objects logged via `console.error()` in all environments, not just dev.

---

## Recommended Fix Priority

1. **Add caller authentication** to all backend update methods (C1, C4) — blocks all anonymous abuse
2. **Add input size limits** (C2, M2) — prevents storage DoS
3. **Validate chunk integrity** on finalize (C3) — prevents data corruption
4. **Integrate Internet Identity** (M7) — enables per-user access control
5. **Add CSP headers** (H5) — defense in depth for frontend
6. **Whitelist MIME types** (H4, H6) — prevent content type abuse
7. **Add rate limiting** (M1, L5) — prevent spam attacks
8. **Sanitize error messages** (M4, L6) — prevent information leakage

---

## Conclusion

The most urgent work is backend access control (C1 + C4). Without it, every other fix is moot — an anonymous caller can bypass all frontend validation by calling the canister directly via `dfx` or any agent library. Adding `assert(not Principal.isAnonymous(msg.caller))` to every update method is the single highest-impact change and should be deployed immediately.
