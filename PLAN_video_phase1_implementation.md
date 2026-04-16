# Cloud Records — Phase 1 Video Implementation Plan

**Status:** planning complete 2026-04-15, stress-tested by a 5-agent validation session same day, revised with edits 1–19 from `HANDOFF_video_phase1_validation_2026-04-15.md`. Ready for implementation in a fresh session ONLY after the two Part B preflight gates below are closed.
**Supersedes:** `PLAN_video_phase1.md` (the outer gate document) and `RESEARCH_video_icp_2026-04-14.md` (first-pass research, partially wrong). Both are kept for history but should not be trusted for implementation details.

## Preflight gates

1. **Staging canister redeployed — DONE 2026-04-15.** New mainnet staging canister is **`dwebo-aiaaa-aaaah-avm2q-cai`** (replaces the dead `bf3co-iqaaa-aaaah-avmua-cai`). Wasm installed (module hash `0x45bf00b2…e8fd904`), `test.mp4` uploaded (13,313,893 bytes, 8 chunks), `realStatus()` reports matching size. The test harness source is unchanged from the original — still uses the 2 MB clamp, so today's baseline is NOT yet evidence for the revised plan's 1.5 MB clamp; that's a separate cheap test if we want to lock 1.5 MB in with evidence. **Controller:** `v4rbq-…-3qe` (same as production). **Keep alive through W6.1 EOP upgrade dry-run** — do NOT tear down until production deploy is verified. Preflight Gate 1 also requires re-verifying iPhone Safari LTE playback on a 5-minute clip (not just the 78-second clip from the original baseline) before W1 — see W7 launch gate.
2. **`.raw.icp0.io` duplicate-Content-Length curl probe — DONE 2026-04-15, PASS.** Three probes against `https://dwebo-aiaaa-aaaah-avm2q-cai.raw.icp0.io/real.mp4`:
   - `Range: bytes=0-1` → HTTP/2 206, **single `content-length: 2`**, `content-range: bytes 0-1/13313893`
   - `Range: bytes=5000000-` → HTTP/2 206, **single `content-length: 2097152`** (clamped to 2 MB), `content-range: bytes 5000000-7097151/13313893` (clamped end echoed correctly)
   - Non-Range GET → HTTP/2 200, **single `content-length: 13313893`**, full 13.3 MB body streamed via `streaming_strategy` callback walk
   No duplicate `Content-Length` headers on any probe. The [forum/63187](https://forum.dfinity.org/t/ic-gateway-issue-content-range-header/63187) bug (PR #61 still unmerged as of 2026-04-15) is NOT triggering on this canister's current subnet/boundary-node replica. **Hard Constraint #3 stays `.raw.icp0.io`.** Caveat: the bug is replica-order dependent per the forum thread; one clean pass does not prove raw is bug-free for every user on every replica. If it reappears during W7 mobile smoke-testing, flip to `.icp0.io` — the handler code is gateway-agnostic, only the URL base changes.

## What this plan is

Step 4 of the higher-level video scoping plan. This document is what a fresh implementation session executes against. It contains:

- Locked product and technical decisions (with the empirical receipts behind them)
- Seven workstreams with concrete tasks, file paths, and acceptance criteria
- The Step 2 fix-before-video security checklist integrated into the workstreams
- A deploy checklist and launch gate
- A Phase 2+ deferred list
- A handoff prompt for starting the implementation session

## Hard constraints (do not re-litigate)

1. **Scope: 3 flagship clips, not 100.** Do not design for 1000-clip scale. Defer anything that only matters past ~20 videos.
2. **480p rendition on-chain, 720p + 1080p off-chain via `storageLocation` abstraction.** Off-chain provider TBD — design the type, leave URLs empty until Phase 2.
3. **Serve from `.raw.icp0.io` — CONDITIONAL on the Preflight Gate 2 curl probe.** If the probe shows a single `Content-Length` header, raw stays. If duplicated, flip to `.icp0.io` (no response certification either way in Phase 1, but raw is actively broken per forum/63187). No HTTP v2 certification in Phase 1 regardless.
4. **Range and Callback paths are kept SEPARATE in `http_request`, per OpenChat's production pattern.** Range → 206 direct, NO `streaming_strategy`. Non-Range GET → 200 + `streaming_strategy = #Callback`. Do NOT unify — iOS Safari never takes the Callback 200 path for `<video>` (it requires 206), and unifying hides bugs. Reference: `open-chat-labs/open-chat/backend/canisters/storage_bucket/impl/src/queries/http_request.rs`.
5. **1.5 MB clamp (`MAX_SLICE = 3 * 512 * 1024 = 1_572_864`) for Range response slices.** Matches OpenChat's production constant; leaves Candid framing headroom under the 2 MB message limit. Streaming-callback chunks use the same clamp for consistency. The 2026-04-15 empirical test hit 2 MB without issue, but OpenChat pulled back for a reason — match them.
6. **`persistent actor` + EOP.** No pre/post_upgrade hooks. Never drop existing persistent fields.
7. **Admin-only uploads.** No public video upload path. `requireAdmin` on every mutating video method.
8. **The mobile-playback audio fix (uncommitted working-tree changes to `App.tsx`, `usePlayer.ts`, `agent.ts`, `.ic-assets.json5`) gets its own test-and-merge cycle BEFORE this video deploy.** Do not bundle the two.

## Empirical baseline that this plan depends on

All originally verified via the throwaway canister `bf3co-iqaaa-aaaah-avmua-cai` on mainnet 2026-04-15. **That canister is currently `canister_not_found` per the boundary node** — the baseline below is not presently reproducible. Preflight Gate 1 redeploys the harness as a fresh `video-staging` canister so these claims can be re-verified; none of them are trusted until they are.

- ◻️ `streaming_strategy` + Range coexist in a single `http_request` handler (re-verify)
- ◻️ Chrome's media backend picks Range strides from the server's clamp (re-verify)
- ◻️ iOS Safari LTE plays + seeks on `.raw.icp0.io` end-to-end (re-verify on a full 5-min clip, not just 78 seconds — `moov` atom placement on a 5-min file exercises a different code path)
- ◻️ Full 13.3 MB video round-trips byte-identical via chunk upload → reassemble → serve (re-verify)
- ◻️ EOP upgrades preserve state with `--wasm-memory-persistence keep` (re-verify)
- ⚠️ Per-upgrade cost for a ~10 MB state canister: ~0.3 TC — **DO NOT LINEAR-EXTRAPOLATE TO 530 MB**. EOP migration cost scales with heap object count and re-serialization work, not byte count. W6.1 MUST dry-run the upgrade against a full W1.2 restore of production state before mainnet W6.2.

The test harness lives at `/Users/chrisyost/music-platform/video-range-test/` and is the reference implementation for the `http_request` handler shape. **Read it first** before touching Main.mo.

---

## Workstream 1 — Security hardening (Step 2 fix-before-video items)

These are security fixes that are independent of video but must ship before video data lands in the canister. A1 and A2 are already done and committed as `084cc98`. Remaining items:

### W1.1 — Backup controller (Step 2 A3) — HIGH

Single controller is the only recovery path. Loss = canister becomes unrecoverable.

- [ ] Create a second dfx identity (suggest: `chriscloud-backup`)
- [ ] Run `dfx canister --network ic update-settings kfhms-uaaaa-aaaae-ageyq-cai --add-controller <backup-principal>` from the existing `chriscloud-admin` identity
- [ ] Verify with `dfx canister --network ic info kfhms-uaaaa-aaaae-ageyq-cai` — should show two controllers
- [ ] Same for frontend canister `kmeho-ciaaa-aaaae-ageza-cai`
- [ ] Store the backup identity PEM offline (encrypted USB, password manager, printed seed — Chris's call)

**Acceptance:** both production canisters have two controllers. Backup identity PEM is in cold storage. Document location in `project_cloudrecords_video_phase1.md` memory (DO NOT commit the PEM to git).

### W1.2 — Restore script + backup coverage (Step 2 A4) — HIGH

`backup.mjs` is write-only and misses several state tables. Before video (irreplaceable source content) lands, backup must be round-trippable.

- [ ] **Extend `backup.mjs`** to also call: `getAllReplies`, `getAllPlayCounts`, `getAllTomatoCounts`, `listFeatured`. Write them to the manifest JSON.
- [ ] **Write `restore.mjs`** that reads a backup directory and replays state into a target canister: `finalizeTrack` for each track, `setCoverArt` for each cover, `setFeatured` for each flagged track, `replyToComment` for each reply, upload each chunk in order.
- [ ] **Dry-run** `restore.mjs` into a fresh staging canister (can reuse the `video-range-test` subdir pattern — spin up a one-shot staging canister, restore into it, verify with `listTracks`, tear down).
- [ ] Document the restore procedure in `backup-cron.sh` comments + a `RESTORE.md` in music-platform root.

**Acceptance:** a `restore.mjs` run against a fresh staging canister produces a functionally equivalent copy of the production state verified by comparing `listTracks` + `getStats` output.

### W1.3 — Unbounded collection cleanup (Step 2 A5 + A6 + A9) — HIGH

Six maps in Main.mo grow without bound per unique `listenerId` or `principal`. At video scale this matters for heap growth, not cycle drain (queries are free). The affected maps: `uniqueListeners`, `uniqueListenersPerTrack`, `tomatoDedup`, `playRateLimit`, `lastPostAt`, and — tangentially — `lastPlayAt` (already dead, kept for EOP compat).

Two-part fix:

- [ ] **Per-map monotonic ring-buffer eviction.** Add a cap constant per map (suggest: `MAX_UNIQUE_LISTENERS = 50_000`, `MAX_TOMATO_DEDUP = 100_000`, etc.). Maintain a companion write-order queue (`[(Int, Text)]` or a second `Map` keyed by monotonic counter) alongside each capped map. On write, if size >= cap, pop the oldest entry from the queue and delete it from the main map. **Do NOT use random-sample eviction** — `mo:core/Map` has no O(1) random access (sampling requires `Map.entries → Iter.toArray` which is O(n)) AND random eviction is broken for `playRateLimit`: dropping an entry effectively resets the spammer's own cooldown. Monotonic write-order eviction is correct and cheap.
- [ ] **`deleteTrack` cleanup (A9).** Currently leaves zombie entries in `uniqueListenersPerTrack` (`uuid:trackId`) and `tomatoDedup` (`listenerId:trackId`) after track deletion. Iterate and delete matching suffixes on track delete. O(n) per delete but deletes are rare.
- [ ] Update inline comments referencing the caps.

**Acceptance:** after the update, a stress test of 200 unique listener IDs against a single track results in a map size bounded by the cap, not 200. Track deletion cleans zombies verified by `Map.size` before/after.

### W1.4 — `throwTomato` hardening (Step 2 A7) — MED

Currently `public func`, not `shared(msg)`, no rate limit, only one-shot dedup. Spammer with rotating `listenerId` can inflate `tomatoDedup` unboundedly.

- [ ] Convert signature to `public shared(msg) func throwTomato`
- [ ] Reject anonymous principal: `if Principal.isAnonymous(msg.caller) return;`
- [ ] Apply `checkRateLimit(msg.caller)` (existing helper at Main.mo:186)
- [ ] Cap `tomatoDedup` size per the W1.3 eviction pattern
- [ ] Verify existing frontend call sites still work (anonymous browser is fine — II principal used otherwise)

**Acceptance:** `throwTomato` trap tests from anonymous caller, rate limit triggers on repeated calls, cap enforced.

### W1.5 — `/share/{trackId}` HTML injection fix (Step 2 A8) — MED

`Main.mo:888-901` interpolates `core.name`, `extra.artist`, `extra.album` directly into `<meta content="...">` with zero escaping. Admin-write-only today but the share surface is the marketing surface for the video launch.

- [ ] Add a helper: `func escapeHtmlAttr(t : Text) : Text` that replaces `"` → `&quot;`, `<` → `&lt;`, `>` → `&gt;`, `&` → `&amp;`
- [ ] Apply to all three fields in the `/share/` branch
- [ ] Test with a track whose name contains `"` (e.g. `Paul's "Long Piano Cover"`) — OG preview should render correctly on X/LinkedIn

**Acceptance:** a track with `"<>&` in its name serves a valid OG preview (quotes don't break the HTML).

### W1.6 — EOP field-drop discipline (A10) — PROCESS RULE

Not a code change, a deploy rule. Add to `CLAUDE.md` or a new `DEPLOY.md`:

> **Never drop an existing persistent field during the same upgrade that adds new fields.** Specifically: `lastPlayAt` (Main.mo:112) is dead code kept for EOP compat. Do NOT remove it during the video-adding upgrade. If it ever gets removed, it must be its own isolated upgrade, tested on staging first.

- [ ] Add the rule to `CLAUDE.md`

**Acceptance:** rule is written down and the implementation session reads it.

---

## Workstream 2 — Backend video handler (Motoko)

### W2.1 — Extend types

Edit `/Users/chrisyost/music-platform/backend/Main.mo`.

- [ ] **Add streaming types near the existing HTTP types** (around line 820):
  ```motoko
  type Token = {
    resource : Text;   // "v-<trackId>-<resolution>"
    index    : Nat;    // chunk index after the initial body
  };
  type StreamingCallbackHttpResponse = {
    body  : Blob;
    token : ?Token;
  };
  type CallbackStrategy = {
    callback : shared query Token -> async StreamingCallbackHttpResponse;
    token    : Token;
  };
  type StreamingStrategy = { #Callback : CallbackStrategy };
  ```

- [ ] **Extend `HttpResponse` type** to include `streaming_strategy : ?StreamingStrategy`. This is a **one-time Candid interface change**. Every existing return in http_request (`/cover/`, `/share/`, 404) must add `streaming_strategy = null`.

- [ ] **Add `VideoVariant` and `VideoCore` types** near the existing track types:
  ```motoko
  type VideoVariant = {
    resolution      : Text;
    size            : Nat;
    totalChunks     : Nat;
    chunkSize       : Nat;   // size of every non-final chunk; final chunk is size - (totalChunks-1)*chunkSize
    mimeType        : Text;
    storageLocation : { #onChain; #offChain : { url : Text; provider : Text } };
  };
  type VideoCore = {
    id          : Text;
    trackId     : Text;
    durationSec : Nat;
    variants    : Map.Map<Text, VideoVariant>;  // key = resolution ("480p", "720p", "1080p")
    createdAt   : Int;
  };
  ```
  `variants` is a `Map` (keyed by resolution), not an array, so `setVideoStorageLocation` doesn't rebuild an immutable array on every call and Phase 2 can add mirror/redundancy fields without a Candid type migration. `chunkSize` is stored per-variant so `readVideoRange` does not hardcode a global constant (eliminates the silent-corruption class — see W2.5).
  Every `switch` over `storageLocation` must enumerate `#onChain` and `#offChain` to avoid M0145.

- [ ] **Add the videos map**:
  ```motoko
  let videos : Map.Map<Text, VideoCore> = Map.empty();
  ```

- [ ] **Add constants**:
  ```motoko
  let VIDEO_MAX_SLICE : Nat = 3 * 512 * 1024;   // 1_572_864 — matches OpenChat production
  let MAX_VIDEOS : Nat = 20;
  let MAX_VIDEO_SIZE_BYTES : Nat = 150 * 1024 * 1024;
  let MAX_CHUNKS_PER_VARIANT : Nat = 100;
  let VIDEO_CHUNK_SIZE_DEFAULT : Nat = 1_500_000;  // upload tool target; stored per-variant in VideoVariant.chunkSize
  ```

### W2.2 — Video upload API

- [ ] **`uploadVideoChunk(videoId, resolution, index, chunkSize, data)`** — `shared(msg)`, `requireAdmin`, stores chunk in the existing `chunks : Map<Text, Blob>` map. Key helper: `func videoChunkKey(videoId, resolution, i) = "vid:" # videoId # "-" # resolution # ":" # Nat.toText(i)`. The `"vid:"` prefix keeps video chunk keys in a disjoint namespace from audio (`audio uses trackId # ":" # index`) so the two cannot collide even for pathological trackIds. Validates:
  - `index < MAX_CHUNKS_PER_VARIANT`
  - `data.size() <= VIDEO_CHUNK_SIZE_DEFAULT` (1.5 MB hard ceiling, leaves Candid framing room)
  - `data.size() == chunkSize` (enforces uniform sizing so `readVideoRange` can do offset math without reassembly) — final chunk is the ONLY exception; see finalize below
  - Caller passes `chunkSize` so the server can reject drift between uploader and finalize
- [ ] **`finalizeVideoVariant(videoId, trackId, resolution, totalChunks, chunkSize, totalSize, mimeType, storageLocation, durationSec)`** — `shared(msg)`, `requireAdmin`. Creates or updates the `VideoCore` record. Validates:
  - `trackId` exists in `tracks`
  - **`videoId == "v-" # trackId`** — enforce the 1:1 `id = "v-" # trackId` invariant at create time so the separate `id` field can never drift from `trackId`. The field remains in the schema for Phase 2+ flexibility but in Phase 1 it is mechanically derived.
  - `totalSize <= MAX_VIDEO_SIZE_BYTES`
  - `totalChunks <= MAX_CHUNKS_PER_VARIANT`
  - `Map.size(videos) <= MAX_VIDEOS` when creating a new video
  - Every chunk `[0, totalChunks-2]` has size exactly `chunkSize`; final chunk `totalChunks-1` has size `totalSize - (totalChunks-1) * chunkSize` and that value is in `(0, chunkSize]`. If any check fails, trap with a clear message and do NOT insert the variant — leave the uploaded chunks for W2.2's cancelVideoUpload to clean up.
  - Inserts or replaces the variant at the given resolution inside the `variants : Map` on `VideoCore`.
- [ ] **`cancelVideoUpload(videoId, resolution)`** — `shared(msg)`, `requireAdmin`. Walks all `videoChunkKey(videoId, resolution, i)` for `i in [0, MAX_CHUNKS_PER_VARIANT)` and deletes any present. Use for aborting partial uploads before finalize, or cleaning up a finalize that trapped.
- [ ] **`getVideoUploadProgress(videoId, resolution) : [Nat]`** — `public query`, returns the sorted list of chunk indices currently present for that upload. Used by the upload client to resume after a dropped call without re-uploading completed chunks.
- [ ] **`deleteVideo(videoId : Text)`** — `shared(msg)`, `requireAdmin`. Iterates all variants (via `Map.entries(variants)`), deletes all chunks in `chunks` map, removes from `videos`.
- [ ] **`setVideoStorageLocation(videoId, resolution, location)`** — `shared(msg)`, `requireAdmin`. Lets admin retroactively move a variant on-chain/off-chain without re-uploading.
- [ ] **Query methods**: `listVideos() : [VideoCore]`, `getVideo(id) : ?VideoCore`, `getVideosByTrack(trackId) : [VideoCore]`.

### W2.3 — http_request video branch

**Range and Callback are SEPARATE code paths in the handler, per OpenChat's production pattern (`open-chat-labs/open-chat/backend/canisters/storage_bucket/impl/src/queries/http_request.rs`).** Do not unify them. iOS Safari never takes the Callback 200 path for `<video>` — it requires 206 Partial Content — so unifying hides bugs that only surface on the demo device.

- [ ] **New path handler** before the 404 fallback in `http_request`:
  ```
  /video/{videoId}/{resolution}
  ```
- [ ] Parse path, look up `videos[videoId]`, find variant in `variants` Map at key `resolution`. If missing, 404.
- [ ] If `storageLocation = #offChain({ url; provider })`: return **307 Temporary Redirect** with `Location: url`, no body, `streaming_strategy = null`. If `url == ""` (Phase 1 placeholder), return 404 instead — never redirect to an empty URL. Variant case for `#onChain` continues below.
- [ ] If `storageLocation = #onChain`, branch on `Range:` header presence:
  - **Range path (206, no streaming_strategy):** parse `Range: bytes=<start>-<end>`, clamp `end` to `min(end, start + VIDEO_MAX_SLICE - 1, totalSize - 1)`, walk chunks via `readVideoRange` (W2.5), return:
    - `status_code = 206`
    - `Content-Range: bytes <start>-<clampedEnd>/<totalSize>`
    - `Content-Length: <clampedEnd - start + 1>`
    - `Accept-Ranges: bytes`
    - `Content-Type: <variant.mimeType>`
    - `streaming_strategy = null`
    Safari rejects 206 responses where `last-byte-pos` in `Content-Range` differs from what the player expects for its own reasons; use the clamped end, NOT the caller's requested end, and always include the correct `totalSize` denominator. Verify empirically on a 5-minute clip, not just the 78-second clip — `moov` atom placement differs on 5-min files and exercises a different browser code path.
  - **No-Range path (200 + Callback):** return first `VIDEO_MAX_SLICE` bytes as body, plus:
    - `Content-Length: <totalSize>` (full size, NOT the slice size)
    - `Content-Type: <variant.mimeType>`
    - `Accept-Ranges: bytes`
    - `streaming_strategy = ?#Callback({ callback = http_request_streaming_callback; token = { resource = "v-" # videoId # "-" # resolution; index = 1 } })`
    Token `index = 1` because the initial body is chunk 0.
- [ ] **Reuse the test harness's `parseRange`, `extractPath`, `getHeader`, `toLower`, `trim`, `parseNat` helpers.** Copy-paste from `video-range-test/src/main.mo`. Do NOT reinvent. (The test harness's `slice` and reassembly helpers are superseded by `readVideoRange` in W2.5 — do not copy those.)

### W2.4 — Streaming callback

- [ ] **`public shared query func http_request_streaming_callback(token : Token) : async StreamingCallbackHttpResponse`**
- [ ] Parse `token.resource` — expect the prefix `v-` followed by `<videoId>-<resolution>`. Reject anything else with an empty response (see never-trap rule below).
- [ ] Look up the variant in `videos`. If the video or variant is missing (e.g. `deleteVideo` was called mid-stream), return `{ body = "" : Blob; token = null }`.
- [ ] Compute byte offset from `token.index` (chunk index after the initial body in the http_request response).
- [ ] If `index >= variant.totalChunks`, return `{ body = ""; token = null }`.
- [ ] Walk the chunks to extract the byte range via `readVideoRange` (W2.5), clamped to `VIDEO_MAX_SLICE`.
- [ ] Return `{ body; token = ?next }` if there are more chunks to stream, or `{ body; token = null }` on the last chunk.

**NEVER TRAP in the callback path.** `canister-security` skill mistake #11: a trap in a streaming callback either (a) corrupts an in-flight HTTP response for a real user, or (b) gives an attacker a reliable way to surface canister internals via boundary-node 5xx responses. Every unhappy path — unknown token prefix, missing video, missing variant, out-of-range index, impossible byte math — returns `{ body = ""; token = null }`. Acceptance: a fuzzed token call with junk `resource`/`index` returns 200 empty, never a 5xx.

### W2.5 — Helper: chunked byte range reader

The test harness reassembles everything into a single `realPayload` Blob on finalize, which is simple but doubles memory. For production at ~60 MB of on-chain video across 3 variants, we can't afford that — need to read byte ranges directly from the `chunks` map without reassembly.

- [ ] **`func readVideoRange(variant : VideoVariant, videoId : Text, absStart : Nat, absEnd : Nat) : Blob`** that walks the `chunks` map, finds the chunk containing `absStart`, extracts bytes, continues into subsequent chunks until `absEnd`, returns concatenated Blob. Takes the `VideoVariant` record directly so it reads `chunkSize`/`totalChunks`/`totalSize` from the source of truth, not from a global constant.
- [ ] **Chunk math uses `variant.chunkSize`**, NOT a module-level constant. The finalize validation in W2.2 enforces that every non-final chunk is exactly `chunkSize` bytes and the final chunk is `totalSize - (totalChunks-1)*chunkSize`, so offset arithmetic is deterministic.
- [ ] **Bounds:** `absEnd - absStart + 1 <= VIDEO_MAX_SLICE` by caller contract, so at most `ceil(VIDEO_MAX_SLICE / chunkSize) + 1` chunks are touched (≤ 2 for the 1.5 MB clamp × 1.5 MB chunk default).
- [ ] **Never traps.** If `absStart >= totalSize`, return empty Blob. If a referenced chunk is missing from `chunks` (shouldn't happen post-finalize, but defensive), return empty Blob. All unhappy paths return empty, matching W2.4's never-trap rule.

**Acceptance for W2:** `dfx build` clean, types compile, test harness-equivalent curl + Playwright tests against the new `video-staging` canister all pass. A fuzzed `readVideoRange` with `absStart > totalSize` returns empty, never traps.

---

## Workstream 3 — Encoding pipeline (ffmpeg, multi-rendition)

### W3.1 — Extend optimize_media.py

Current `optimize_tracks.py` handles audio. Extend for video with a single ffmpeg invocation producing three renditions.

- [ ] **New script** `/Users/chrisyost/music-platform/optimize_videos.py` (or extend `optimize_media.py`).
- [ ] **Input:** path to source MP4/MOV (any codec).
- [ ] **Output:** three files in `optimized/videos/<source-basename>/`:
  - `<base>-480p.mp4` (854×480, CRF 25, ~800 kbps, ~30 MB for 5 min)
  - `<base>-720p.mp4` (1280×720, CRF 23, ~1.5 Mbps, ~56 MB for 5 min)
  - `<base>-1080p.mp4` (1920×1080, CRF 21, ~3 Mbps, ~112 MB for 5 min)
- [ ] **Three sequential ffmpeg invocations**, one per rendition. Single-invocation multi-output with per-output `-vf` is error-prone (filters apply to the next output only, and without `-filter_complex split` the source is re-decoded N times anyway, so there is no real efficiency win). Sequential is slower in wall-clock but correct:
  ```bash
  ffmpeg -y -i SOURCE -vf "scale=854:-2"  -c:v libx264 -profile:v high -level:v 4.0 -preset medium -crf 25 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart out-480p.mp4
  ffmpeg -y -i SOURCE -vf "scale=1280:-2" -c:v libx264 -profile:v high -level:v 4.0 -preset medium -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart out-720p.mp4
  ffmpeg -y -i SOURCE -vf "scale=1920:-2" -c:v libx264 -profile:v high -level:v 4.0 -preset medium -crf 21 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart out-1080p.mp4
  ```
  `-2` preserves aspect; `-pix_fmt yuv420p` guarantees iOS Safari compatibility; `+faststart` is mandatory — without it the `moov` atom lands at the end of the file and the first seek on mobile triggers a tail Range before first frame. Chris knows video production — this snippet is a starting point, not the final ffmpeg recipe.
- [ ] **Verify faststart** on each output (use the same `python3 head/mdat` check pattern from the Phase B runbook).
- [ ] **Generate thumbnail** via `ffmpeg -ss 2 -i SOURCE -vframes 1 -vf scale=640:-2 out-thumb.jpg`.
- [ ] **Write manifest JSON** describing the three variants for the upload script to consume.

**Acceptance:** running the script on a 5-minute source video produces three valid H.264 MP4s + thumbnail + manifest, with faststart verified on all three.

---

## Workstream 4 — Upload tooling

### W4.1 — upload-video.mjs

Model on `upload-optimized.mjs` + `video-range-test/upload-mp4.mjs`. Lives in music-platform root or under `migration/`.

- [ ] **Input:** path to the manifest from W3 + a `trackId` to associate with.
- [ ] **Load chriscloud-admin identity** (existing pattern via `Secp256k1KeyIdentity.fromPem`).
- [ ] **For each variant in the manifest:**
  - Chunk the file into uniform 1.5 MB pieces (`VIDEO_CHUNK_SIZE_DEFAULT`) with a possibly-smaller final chunk. Every non-final chunk MUST be exactly `chunkSize` bytes — the backend rejects drift.
  - Call `uploadVideoChunk(videoId, resolution, index, chunkSize, chunk)` sequentially (5 args — `chunkSize` is passed on every call so the server can reject drift between uploader and finalize)
  - Call `finalizeVideoVariant(videoId, trackId, resolution, totalChunks, chunkSize, totalSize, mimeType, storageLocation, durationSec)` after all chunks are uploaded. Compute `videoId = "v-" # trackId` to match the backend invariant.
- [ ] **For 480p variant: `storageLocation = #onChain`.** For 720p/1080p: DO NOT finalize them in Phase 1. Leave them out of the `variants` map entirely — the frontend picker (W5.1) must not see a `#offChain` variant with an empty URL, because its default-resolution logic would otherwise hand an empty `src=""` to `<video>` and silently fail on Safari. When Phase 2 picks an off-chain provider, a separate upload run will add the 720p/1080p variants with populated URLs via `setVideoStorageLocation` or a second `finalizeVideoVariant` call.
- [ ] **Resume support:** before uploading a chunk, call `getVideoUploadProgress(videoId, resolution)` and skip indices already present. On interrupt, the next run resumes without re-uploading successful chunks.
- [ ] **Print test URLs** on success, both frontend (`kmeho-...icp0.io/videos/<trackId>`) and direct canister (`kfhms-...raw.icp0.io/video/<videoId>/480p`).

**Acceptance:** running the script uploads all three clips, `listVideos()` on the canister returns all three, direct canister URLs play in browser.

---

## Workstream 5 — Frontend video playback

### W5.1 — Video component

- [ ] **New React component** `/Users/chrisyost/music-platform/frontend/src/components/VideoPlayer.tsx`:
  - Props: `track : TrackInfo` (existing type)
  - Fetches `getVideosByTrack(track.id)` via a new agent.ts helper
  - Renders HTML5 `<video>` element pointed at the selected variant's URL
  - URL pattern: `https://<backend-canister-id>.<gateway>.icp0.io/video/<videoId>/<resolution>` where `<gateway>` is `raw` or empty depending on the Preflight Gate 2 curl-probe outcome (see top of plan)
  - **Default resolution picker logic — ORDER MATTERS:**
    1. **Only consider variants whose `storageLocation` is `#onChain`, OR `#offChain` with a non-empty `url`.** A variant with `#offChain` + empty `url` is a placeholder for Phase 2 and MUST NOT be selectable. In Phase 1 this means 720p/1080p are hidden entirely.
    2. From the remaining set, pick based on bandwidth heuristic:
       - `navigator.connection?.effectiveType` in `["slow-2g", "2g", "3g"]` → lowest on-chain variant (480p)
       - `navigator.connection?.effectiveType === "4g"` → highest available on-chain variant
       - **`navigator.connection === undefined` (iOS Safari — the demo device!)** → lowest on-chain variant (480p). DO NOT default to 720p when we can't detect bandwidth; Safari returning undefined is not "assume Wi-Fi". This is the fix for R3.
    3. If the chosen variant's URL would be empty for any reason, fall through to the first `#onChain` variant in the list. This is a belt-and-suspenders guard against future off-chain provider mistakes.
- [ ] **Resolution picker dropdown** in the player UI showing only selectable variants (filtered per step 1 above) with their size (e.g. "480p · 30 MB"). In Phase 1 with only 480p on-chain, the picker shows a single disabled row — that's fine, it's documentation for the launch post.
- [ ] **Poster-image-as-control pattern for the track list page.** Do NOT render three `<video>` elements on the track list when three tracks have videos. Render the thumbnail (from W3.1) with a play button overlay; only mount a `<video>` element when the user taps a card. iOS fires backchannel `bytes=0-1` probes even with `preload="none"` (Steve Souders, still true), and on a 3-video list that means 3-6 cold boundary-node roundtrips on first paint. A click-to-load card eliminates the class. Set `preload="none"` on the element once it mounts, and only flip to `preload="metadata"` when the user clicks play.
- [ ] **Loading state** while `getVideosByTrack` resolves.
- [ ] **Fallback**: if a track has no video, don't render the component. Existing Player.tsx shows a "no video" placeholder only if track.hasVideo (add this field to TrackInfo if useful, or derive from getVideosByTrack result).

### W5.2 — Agent helpers

- [ ] **`frontend/src/lib/agent.ts`**: add `getVideosByTrack(trackId: string)` wrapping the new backend query.
- [ ] **`frontend/src/lib/types.ts`**: add `VideoVariant` and `VideoCore` type definitions matching the Motoko types.
- [ ] **`frontend/src/lib/video.ts`** (new): helper for building video URLs from (videoId, resolution) and for picking the default resolution based on `navigator.connection`.

### W5.3 — Integration into Player.tsx

- [ ] **Near the existing track detail view** in `Player.tsx`, conditionally render `<VideoPlayer track={track} />` when the track has a linked video.
- [ ] **Visual treatment**: video sits above the waveform or replaces it on toggle. Chris to decide aesthetic — the component hands off to his existing CSS vars and brand system.
- [ ] **Accessibility**: controls exposed, captions placeholder (even if empty for Phase 1).

### W5.4 — Acceptance

- [ ] Click a track with a video → poster + play button renders, tap play → `<video>` mounts, plays, scrubs, pauses
- [ ] On cellular-emulated (Chrome DevTools throttling "Slow 3G") the default variant is 480p
- [ ] On fast Wi-Fi the default variant is whichever highest on-chain variant is available (Phase 1: still 480p, that's OK)
- [ ] **On iPhone Safari with Wi-Fi OFF (LTE only) the loaded variant is `#onChain` 480p, NOT an empty-URL off-chain variant** — this is the R3 regression guard. Open Safari Web Inspector via USB to macOS and confirm the `<video>` element's `src` resolves to the `kfhms-…` canister URL.
- [ ] Resolution picker change swaps the video `src` without breaking playback state (or prompts "reload to change quality")
- [ ] No video layout shift when a track without a video is selected
- [ ] No `<video>` element exists in the DOM for inactive track cards (poster-image-as-control check — inspect the DOM, not Network tab)

---

## Workstream 6 — Deploy checklist

This runs once, in order, on a deploy day. **Do not skip steps.**

### W6.1 — Pre-flight

- [ ] Preflight Gates 1 & 2 at the top of this doc are both closed — the curl probe outcome is documented and Hard Constraint #3 reflects the chosen gateway (raw or icp0).
- [ ] All of W1 through W5 merged to main (or to a release branch)
- [ ] `npm --prefix frontend run build` clean
- [ ] `dfx build backend` clean (or `icp build backend` — see W6.2 on toolchain reconciliation)
- [ ] **Bump freezing_threshold to 90 days** on the production backend canister. `cycles-management` skill mistake #2 flags 30 days as the red line for high-storage canisters, and Mission 70's burn-rate rebalance ([forum/65400](https://forum.dfinity.org/t/icp-s-mission-70-a-candid-and-detailed-analysis/65400)) makes 30 days materially tighter. One-line change, zero risk, buys 60 days of recovery margin:
  ```
  dfx canister --network ic update-settings backend --freezing-threshold 7776000
  ```
- [ ] **Top up production canister with 2-3 TC** before upgrade. Current balance ~7.32 TC (per 2026-04-15 live status); install/upgrade + 60 MB video state will consume an unknown amount — DO NOT linear-extrapolate from the throwaway's 0.3 TC at 10 MB. Target ≥5 TC balance post-deploy for comfort.
- [ ] Run `backup.mjs --metadata` and `backup.mjs` (full) to create a pre-deploy backup.
- [ ] **Dry-run `restore.mjs` into a fresh staging canister** — do not deploy if restore fails.
- [ ] **HARD GATE — staging EOP upgrade dry-run against the fully-restored staging canister.** Spin up a fresh staging canister, use `restore.mjs` to load the full production backup into it (audio chunks, cover art, tracks, comments, replies, featured, play counts — everything), then run the exact W6.2 upgrade command against that staging canister. Measure:
  - Actual cycle burn for the upgrade (must be under 5 TC, ideally under 3 TC)
  - Post-upgrade `listTracks`, `listVideos`, `getStats` return the same values as pre-upgrade plus the new video endpoints
  - No trap, no `IC0504`/`IC0522`
  - Module hash matches the intended build
  If any of the above fails, **the production upgrade does not run** — re-plan first. This gate exists because EOP migration cost scales with heap object count and re-serialization work, not byte count, and the throwaway's 0.3 TC at 10 MB cannot be extrapolated to 530 MB.
- [ ] Mobile-playback audio fix (the uncommitted working-tree changes) has been committed + tested + shipped in a PRIOR separate deploy.

### W6.2 — Backend upgrade

**Toolchain reconciliation — READ FIRST.** Project `CLAUDE.md` mandates `icp` CLI for deploys; `icp-cli` skill explicitly forbids `dfx` ("Never use `dfx` — always use `icp`"). This plan's steps below use `dfx` because `--wasm-memory-persistence keep` is a documented `dfx` flag and it is not clear as of 2026-04-15 whether `icp canister install -e ic --mode upgrade` passes the EOP persistence flag through correctly. **Before running this on production, confirm one of:**
- (a) `icp canister install backend -e ic --mode upgrade` preserves EOP state end-to-end on the W6.1 staging canister dry-run, in which case replace the `dfx` commands below with the `icp` equivalents; OR
- (b) this plan deviates from the `icp`-only rule for the EOP install step only, with the deviation documented here as a known constraint and `dfx` used exclusively for install-upgrade. The `icp build` step can still be used for compilation.

Upgrade steps (written in `dfx` syntax pending the above reconciliation):
- [ ] `DFX_WARNING=-mainnet_plaintext_identity dfx build --network ic backend` (or `icp build backend -e ic`)
- [ ] `DFX_WARNING=-mainnet_plaintext_identity dfx canister --network ic install backend --mode upgrade --wasm-memory-persistence keep` ← **this flag is mandatory under EOP**
- [ ] Verify: `dfx canister --network ic status backend` — note the new module hash, the new `memory_size`, and delta from the W6.1 pre-upgrade baseline
- [ ] Verify: `dfx canister --network ic call backend listTracks` still returns all existing tracks (no data loss)
- [ ] Verify: `dfx canister --network ic call backend listVideos` returns empty list (no videos yet)

### W6.3 — Encode + upload the 3 flagship videos

- [ ] Run `optimize_videos.py` on each of the 3 source files
- [ ] Verify faststart + codec on each output
- [ ] Run `upload-video.mjs` for each, linked to the corresponding audio track
- [ ] Verify: `dfx canister --network ic call backend listVideos` returns 3 records
- [ ] Smoke test each video URL on desktop Chrome + iPhone Safari LTE

### W6.4 — Frontend deploy

- [ ] `npm --prefix frontend run build`
- [ ] `icp deploy -e ic frontend` (asset canister) or `dfx canister --network ic install frontend --mode upgrade` as appropriate
- [ ] Smoke test end-to-end: open production site, play audio, open a track with video, play video, scrub

### W6.5 — Post-deploy

- [ ] Canister status: note cycles balance, memory size, runway
- [ ] Update `project_cloudrecords_video_phase1.md` memory with deploy date and cycles consumed
- [ ] Social: the "ICP can do this" post — screenshot of the video player running from the canister URL, cycles burn stats, no CDN

---

## Workstream 7 — Launch gate criteria

Phase 1 ships when all of these are true. **Do not ship if any are false.**

- [ ] **Preflight Gate 1 closed** — new `video-staging` canister ID committed in the plan, harness redeployed, 13.3 MB clip round-trip re-verified on iOS Safari LTE against a FIVE-minute clip (not just the 78-second clip from the original baseline)
- [ ] **Preflight Gate 2 closed** — `.raw.icp0.io` curl probe returned a single `Content-Length` header (or plan flipped to `.icp0.io`)
- [ ] All 10 Step 2 fix-before-video items are closed (A1+A2 already done)
- [ ] Backup + restore dry-run successful against a staging canister
- [ ] **W6.1 staging EOP upgrade dry-run against a fully-restored staging canister consumed < 5 TC and left state intact**
- [ ] Backup controller added to both canisters
- [ ] Freezing threshold bumped to 90 days on the production backend canister
- [ ] 3 flagship videos encoded, uploaded, and play end-to-end on iPhone Safari over LTE (not just Wi-Fi)
- [ ] **On iPhone Safari with Wi-Fi OFF (LTE forced), the variant that loads is `#onChain` — inspect the `<video>` `src` via Safari Web Inspector over USB to confirm it resolves to the `kfhms-…` canister URL, not an empty string** (R3 regression guard)
- [ ] **ffprobe on all 3 flagship MP4s shows `moov` atom positioned before `mdat`** (required for progressive streaming on mobile)
- [ ] Cycles balance post-deploy ≥ 5 TC (target ~1 year runway)
- [ ] Frontend resolution picker defaults correctly on cellular-throttled Chrome DevTools
- [ ] `/share/{trackId}` OG preview renders correctly for a track whose name contains quotes
- [ ] Nothing from the uncommitted mobile-playback fix is in the deploy bundle

## Fix-before-video checklist (from Step 2, for cross-reference)

| # | Item | WS | Status |
|---|---|---|---|
| A1 | `setOrder` auth guard + frontend drag gate | - | ✅ committed `084cc98` |
| A2 | `removeAdmin` last-admin protection | - | ✅ committed `084cc98` |
| A3 | Backup controller on both canisters | W1.1 | TODO |
| A4 | Restore script + backup coverage gaps | W1.2 | TODO |
| A5 | Unbounded collections (re-cat: storage, not cycles) | W1.3 | TODO |
| A6 | `recordPlay` 4 unbounded maps | W1.3 | TODO |
| A7 | `throwTomato` auth + rate limit + cap | W1.4 | TODO |
| A8 | `/share/` HTML injection | W1.5 | TODO |
| A9 | `deleteTrack` zombie cleanup | W1.3 | TODO |
| A10 | EOP field-drop discipline (process rule) | W1.6 | TODO |

## Phase 2+ deferred (do NOT implement in Phase 1)

- HTTP v2 response certification for Range-served video. Genuinely unsolved in Motoko today: no `ic-http-certification` Motoko parity exists, and certifying 206 responses requires either certifying every possible byte slice or a chunked tree scheme that no reference implementation ships. Phase 2 options: (a) Rust side-canister proxy that certifies responses on behalf of the Motoko backend, (b) wait for Motoko parity, (c) wait for `ic-http-gateway-protocol#61` to land and re-evaluate. Defer until one of those exists.
- Off-chain storage provider selection + integration (Arweave/S3/Cloudflare R2 — scope TBD)
- Multi-canister bucket model for >20 videos (Phase 1 is capped at 20 via `MAX_VIDEOS`; beyond that, shard)
- **`Region`-backed stable memory migration — trigger at ~1 GB total heap, NOT 2 GB.** EOP wasm32 is capped at 4 GB and the production canister currently shows a 3 GiB wasm memory limit in `dfx canister status`. Comfort zone is ~1 GB; 2 GB is already into the danger band. Log `memory_size` from `dfx canister status backend` after every release so the trend is visible and the trigger fires with advance warning.
- HEVC/AV1 transcoding for bandwidth efficiency (H.264 baseline is sufficient for 3-clip demo)
- Live stream support
- DRM/watermarking
- Video comments separate from audio comments (Phase 1 reuses the existing comments system via `trackId`)
- Per-video analytics dashboard (Phase 1 reuses existing play counts, claps, etc.)
- Captions/subtitles system (placeholder in the player UI only)
- Removal of the dead `lastPlayAt` persistent field (its own isolated upgrade, not during video deploy)

---

## Cost budget

**All numbers below are pre-Mission-70 estimates and need re-derivation before the launch post.** Mission 70's pricing rebalance ([forum/65400](https://forum.dfinity.org/t/icp-s-mission-70-a-candid-and-detailed-analysis/65400), March 2026) cut fees ~70% but raised the per-canister burn-rate target ~15×. Net effect on a ~530 MB storage-heavy canister is not a simple multiplier — it depends on the ratio of query serving to idle heap to upgrade cost. Before writing the "ICP can do this, no CDN, costs $X/year" post, measure actual idle burn for 7 days after deploy and derive the annual envelope from real telemetry, not the table below.

| Line item | Estimate (pre-Mission-70) | Notes |
|---|---|---|
| Backend upgrade install cycles | Unknown — MUST be measured by W6.1 staging dry-run | 0.3 TC at 10 MB state on the throwaway does NOT linear-extrapolate to 530 MB |
| Frontend asset re-deploy | ~0.1 TC (~$0.14) | Small diff |
| Ongoing storage burn (3 × 480p ≈ 60 MB on-chain) | +~5 TC/yr nominal | Re-derive against current pricing; Mission 70 changes this |
| Ongoing query serving (video plays) | Free to caller, instruction cost to canister | 13-node application subnet, queries free at protocol; per-query instructions do count against the canister budget |
| Off-chain storage for 720p + 1080p × 3 | TBD | Provider not yet selected; estimate ~$1-5/month for ~600 MB |
| **Pre-deploy top-up recommendation** | **2-3 TC** | Target ≥5 TC post-deploy balance |

Current production canister (2026-04-15 live status): **7.32 TC**, 12 B cycles/day idle, Wasm memory limit 3 GiB, memory_size 469.83 MB, module hash `fe3e408a…7a6df`. Post-video estimated: ~4-5 TC pending W6.1 measurement, 20+ B cycles/day idle; top up to restore ≥5 TC comfort.

---

# Handoff prompt for implementation session

**Copy-paste the block below into a fresh Claude Code session working in `/Users/chrisyost/music-platform/`.**

---

```
I'm starting implementation of Cloud Records Phase 1 video support. Planning is complete — your job is to execute against the plan document.

## Before you do ANYTHING else, read these files in full, in this order

1. /Users/chrisyost/music-platform/PLAN_video_phase1_implementation.md ← the plan you are executing
2. /Users/chrisyost/music-platform/backend/Main.mo ← the production canister (923 lines)
3. /Users/chrisyost/music-platform/video-range-test/src/main.mo ← the reference implementation for streaming_strategy + Range (verified working on mainnet 2026-04-15)
4. /Users/chrisyost/music-platform/video-range-test/upload-mp4.mjs ← reference for admin-authed chunk upload
5. /Users/chrisyost/music-platform/CLAUDE.md ← project conventions
6. /Users/chrisyost/.claude/CLAUDE.md ← my global preferences
7. /Users/chrisyost/.claude/projects/-Users-chrisyost/memory/project_cloudrecords_video_phase1.md ← locked decisions + empirical baseline

## Hard rules

- Do NOT re-litigate the locked decisions in the plan doc. They were decided after a 4-step gated process with empirical mainnet verification. If you think something is wrong, STOP and ask me — don't quietly change it.
- Do NOT bundle the uncommitted mobile-playback audio fix (App.tsx, usePlayer.ts, agent.ts, .ic-assets.json5) into the video deploy. It gets its own test-and-merge cycle first, in a separate deploy.
- Do NOT deploy to mainnet without explicit confirmation. Local builds + staging canister tests first.
- Do NOT skip the backup controller (A3) or restore script (A4) — those are launch gates.
- Do NOT invent numbers. If you need pricing, query the canister or use the empirical numbers in the memory file.
- Never run `dfx canister install` on the production canister without `--wasm-memory-persistence keep`. The upgrade will fail with IC0504 under EOP.

## Execution order

Work through the workstreams in the plan doc in order. Report between each workstream — do not chain them without a gate.

1. W1: Security hardening (backend changes for A3-A10)
   - Stop and report after W1 is complete. Get my OK before W2.
2. W2: Backend video handler (types, upload API, http_request video branch, streaming callback)
   - Stop and report. Test against a fresh staging canister BEFORE touching production.
3. W3: Encoding pipeline (optimize_videos.py)
   - I will run this myself on my source video files. You write the script.
4. W4: Upload tooling (upload-video.mjs)
   - I will run this. You write the script.
5. W5: Frontend video playback (VideoPlayer.tsx, agent helpers, Player.tsx integration)
6. W6: Deploy checklist — ONLY after I explicitly say "deploy"
7. W7: Launch gate — verify all checkboxes before shipping

## Session preferences

- Lead with "what it does" not implementation details — plain language for architecture
- No trailing summaries after code changes
- Reference file:line when citing code
- Use the Motoko, canister-security, stable-memory, cycles-management skills when relevant
- If a step surfaces something that changes a locked decision, STOP and re-plan. Do not race ahead.

## Current state snapshot (2026-04-15)

- Production backend canister: kfhms-uaaaa-aaaae-ageyq-cai, 5.989 TC balance, 35 tracks, 470 MB memory
- Production frontend canister: kmeho-ciaaa-aaaae-ageza-cai, ~5.2 TC balance
- Subnet: 13-node verified_application (shefu-...)
- Last commit: 084cc98 "fix: auth guard on setOrder + last-admin protection (audit A1/A2)" — applied but NOT deployed
- Working tree has uncommitted mobile-playback audio fix — DO NOT TOUCH during video work
- Phase B throwaway canister still live: bf3co-iqaaa-aaaah-avmua-cai (has streaming_strategy reference code and a real uploaded MP4 — keep it for demo purposes, tear down after production deploy)

Start by reading the 7 files above. When you're done reading, summarize back to me in 5 bullets: (1) your understanding of the Phase 1 scope, (2) the architecture of the video handler, (3) the sequence you plan to work in, (4) any questions you have that the plan doesn't answer, (5) the first concrete change you intend to make. Then wait for my go.
```

---

## References to keep alive

- **Test harness:** `/Users/chrisyost/music-platform/video-range-test/` — keep until production deploy is verified; tear down after
- **Throwaway canister:** `bf3co-iqaaa-aaaah-avmua-cai`, ~1 TC balance, streaming_strategy reference implementation
- **Commit `084cc98`:** A1+A2 security patches, applied but not deployed — will ship with the video deploy
- **Memory file:** `/Users/chrisyost/.claude/projects/-Users-chrisyost/memory/project_cloudrecords_video_phase1.md`
- **Production canister IDs:** backend `kfhms-uaaaa-aaaae-ageyq-cai`, frontend `kmeho-ciaaa-aaaae-ageza-cai`

---

**Plan complete. Ready for handoff to a fresh implementation session.**
