# Handoff — Cloud Records Phase 1 Video Plan Validation

**Date:** 2026-04-15
**Purpose:** Independent third-party review of an implementation plan that was just stress-tested by a Claude Code validation session. I want a cold read from a different model with no prior context. Tell me what the first reviewer missed or got wrong.

---

## What you're reviewing

**Cloud Records** is a fully on-chain music hosting dApp on the Internet Computer (ICP), built in Motoko. Live at `kmeho-ciaaa-aaaae-ageza-cai.icp0.io`, backend canister `kfhms-uaaaa-aaaae-ageyq-cai`. Currently hosts 35 audio tracks (~470 MB on-chain, 7.32 TC balance, 12 B cycles/day idle burn, 3 GiB Wasm memory limit).

The team is adding on-chain video — 3 flagship music videos as an "ICP can do this, no CDN" demo — by extending the existing `persistent actor` (Enhanced Orthogonal Persistence) with a new `http_request` branch that parses HTTP Range, returns 206 Partial Content, and combines it with `streaming_strategy = #Callback` for the non-Range path.

## Locked decisions in the plan (do not re-litigate)

1. Scope: 3 flagship clips, not 100. Phase 1 cap `MAX_VIDEOS = 20`.
2. **480p rendition on-chain**, 720p + 1080p recorded in metadata but served off-chain via a `storageLocation : {#onChain; #offChain : {url; provider}}` variant (URLs empty in Phase 1, Phase 2 will fill them from Arweave/R2/TBD).
3. Serve from **`.raw.icp0.io`** (no HTTP v2 response certification in Phase 1 — certified Range is unsolved in Motoko today; no `ic-http-certification` parity exists).
4. `streaming_strategy = #Callback` is used for the non-Range 200 path alongside Range 206 handling in a single `http_request` query.
5. **2 MB clamp** on both Range response bodies and streaming chunk responses.
6. `persistent actor` + EOP. No pre/post_upgrade hooks. Never drop an existing persistent field (a dead `lastPlayAt : Map<Principal, Int>` is explicitly kept for upgrade safety).
7. Admin-only uploads (`requireAdmin` on every mutating video method).
8. Single canister, shared `chunks : Map<Text, Blob>` on heap for both audio and video.

## Empirical baseline the plan depends on

A throwaway canister `bf3co-iqaaa-aaaah-avmua-cai` was used on 2026-04-15 to prove out:
- `streaming_strategy` + Range coexist in a single `http_request` handler
- Chrome's media backend picks Range strides from the server's 2 MB clamp
- iOS Safari over LTE plays + seeks on `.raw.icp0.io` end-to-end
- Full 13.3 MB video round-trips byte-identical via chunk upload → reassemble → serve
- EOP upgrades preserve state with `--wasm-memory-persistence keep`
- Per-upgrade cost for a ~10 MB state canister: ~0.3 TC

**CRITICAL CAVEAT: The throwaway canister is currently `canister_not_found` per boundary node (verified by curl 2026-04-15 15:12 UTC).** The "empirical baseline" cannot presently be reproduced. This is one of the ship-blockers below.

## Seven workstreams

- **W1** — Security hardening (backup controller, restore script, unbounded-collection LRU eviction across 6 maps, `throwTomato` auth/rate-limit, `/share/` HTML injection fix, EOP never-drop rule)
- **W2** — Backend video handler (new types, upload API, `http_request` video branch, streaming callback, `readVideoRange` helper)
- **W3** — Encoding pipeline (ffmpeg multi-rendition with `+faststart`)
- **W4** — Upload tooling (`upload-video.mjs`)
- **W5** — Frontend video playback (`VideoPlayer.tsx`, `navigator.connection`-based resolution autoselect)
- **W6** — Deploy checklist (pre-flight, backend upgrade with `--wasm-memory-persistence keep`, encode+upload, frontend deploy)
- **W7** — Launch gate

Full plan lives at `/Users/chrisyost/music-platform/PLAN_video_phase1_implementation.md` — ask the user for the raw text if you want the complete detail.

---

## First reviewer's findings

Validation session ran 5 parallel research agents across: ICP toolchain/protocol currency, skill-library cross-reference (motoko/stable-memory/canister-security/multi-canister/cycles-management/asset-canister/certified-variables/icp-cli), live canister ground-truth via ic-mcp + curl, mobile playback edge cases, and architecture alternatives.

### Confirmed sound

- dfx 0.31.0 and moc 1.5.1 still support EOP + `--wasm-memory-persistence keep`; no breaking changes.
- PR #61 (`ic-http-gateway-protocol` content-range fix) is still OPEN, not merged, `mergeable_state: dirty`, last DFINITY activity 2026-02-20. Plan's assumption holds.
- `certified-assets#10` still open; asset canister confirmed to have **no Range support** in current `dfinity/sdk` master (`src/canisters/frontend/ic-certified-assets/src/lib.rs`). Rolling a custom handler is correct.
- Extending `HttpResponse` with `streaming_strategy : ?StreamingStrategy` is forward-compatible under Candid record subtyping; frontend never calls `http_request` directly (zero matches for `HttpResponse` in `frontend/src`). One-time interface change, no client updates needed.
- `public query` + streaming_strategy is valid per HTTP gateway spec and matches the test harness pattern.
- Single-canister design is correct for 3 videos; multi-canister factory is correctly deferred.
- No Motoko-side `ic-http-certification` exists — deferring HTTP v2 cert to Phase 2 is forced, not a choice.
- OpenChat's `storage_bucket` (Rust) is the only production reference; plan correctly copies the pattern.
- Plan's skill coverage matches `canister-security` checklist: backup controller, `throwTomato` hardening, anonymous rejection, rate limiting, unbounded-collection caps, never-drop EOP rule, blanket `requireAdmin`.

### Ship-blockers (must fix before touching production)

**R1. The test canister is dead — empirical baseline cannot be reproduced.**
`bf3co-iqaaa-aaaah-avmua-cai` returns `canister_not_found` via the boundary node. The 2026-04-15 validation the plan rests on is unreproducible from this ID. Either recover it or redeploy a fresh `video-staging` canister and re-verify before W6.

**R2. `.raw.icp0.io` has an ACTIVE duplicate-Content-Length bug on Range responses.**
[forum.dfinity.org/t/ic-gateway-issue-content-range-header/63187](https://forum.dfinity.org/t/ic-gateway-issue-content-range-header/63187), posted 2026-01-23. ic-gateway emits two conflicting `Content-Length` headers on Range responses; curl and Safari reject as "Invalid HTTP header field." Affects `.raw.icp0.io` ONLY — `.icp0.io` is fine. PR #61 fixes it but is unmerged. The 2026-04-15 test may have been lucky (bug can be replica-order dependent) or the 78-second clip may have hit a code path that doesn't trigger it. Before committing to raw, run:
```
curl -i -H "Range: bytes=0-1" https://<staging>.raw.icp0.io/clip.mp4 | grep -i content-length
curl -i -H "Range: bytes=5000000-" https://<staging>.raw.icp0.io/clip.mp4 | grep -i content-length
```
If two `content-length` lines appear, raw is actively broken. Plan must flip to `.icp0.io` and accept the certification gap instead.

**R3. iPhone Safari LTE — the demo device — will default to an empty URL at launch.**
W5.1 picks resolution via `navigator.connection.effectiveType`. `navigator.connection` is Chromium-only; Safari returns `undefined`. The fallthrough branch hands off 720p. 720p has `storageLocation = #offChain` with `url = ""` in Phase 1 (provider `"pending"`). The `<video>` element loads `src=""` and silently fails. Chris demos on his iPhone (the entire empirical baseline device) and sees a black box. Four-line TypeScript fix: if the chosen variant's `storageLocation` is `#offChain` with empty url, fall back to the first `#onChain` variant regardless of bandwidth heuristic. Add explicit W7 launch-gate row: "iPhone, Wi-Fi OFF, variant loaded has `storageLocation = #onChain`".

**R4. iOS Safari will never take the `#Callback` 200 path.**
Safari requires `206 Partial Content` for `<video>`. On 200 OK with a streaming callback body it stops loading after the initial chunk and does not auto-play. Callback is effectively dead code on iOS. The plan unifies Range + Callback in one handler with a 2 MB clamp. **OpenChat's production pattern keeps them completely separate: Range → 206 direct, no callback; non-Range → 200 + Callback. OpenChat also clamps at 1.5 MB (`3 << 19 = 1_572_864`), not 2 MB, with 256 KB range chunks.** Plan is combining two patterns OpenChat deliberately separates. Source: `open-chat-labs/open-chat/backend/canisters/storage_bucket/impl/src/queries/http_request.rs`.

**R5. W6.2 upgrade cost extrapolation is not linear.**
Plan extrapolates "0.3 TC at ~10 MB state → 2-4 TC at ~530 MB state." EOP migration cost scales with heap object count and re-serialization work, not byte count. There is no W6.1 staging dry-run against a *full restored production state* — W1.2 restore and W6.2 upgrade are independent checkboxes. If the upgrade traps, the production canister goes into frozen limbo and recovery requires the W1.1 backup controller. Staging dry-run with the full restore must be a hard W6.1 gate, not a recommendation.

### High-severity (will bite during implementation)

- **R6.** `readVideoRange` hardcodes `CHUNK_SIZE = 1_900_000` with no `chunkSize` field on `VideoVariant` and no server-side size validation. A single bad chunk silently corrupts the MP4 with no actionable error on iOS. Add `chunkSize : Nat` to `VideoVariant`; validate on every non-final chunk.
- **R7.** `variants : [VideoVariant]` as an immutable array forces O(n) rebuild on every `setVideoStorageLocation` and forces a Candid type migration when Phase 2 needs keyed access or mirror URLs. Change to `variants : Map.Map<Text, VideoVariant>` (key = resolution) from day one. Same data, no rebuild, no migration.
- **R8.** W1.3 random-sample LRU eviction is broken: `mo:core/Map` has no O(1) random access, and evicting `playRateLimit` entries resets the spammer's own cooldown. Use a monotonic ring-buffer keyed by write-order, or a `(timestamp, key)` priority list.
- **R9.** `http_request_streaming_callback` has no "never trap" rule. On unknown `Token.resource` or out-of-range index, must return `{ body = ""; token = null }` — a trap either corrupts an in-flight response for a real user or leaks internals via 5xx. `canister-security` skill mistake #11.
- **R10.** Freezing threshold still at 30-day default. With Mission 70's ~15× burn rate target ([forum/65400](https://forum.dfinity.org/t/icp-s-mission-70-a-candid-and-detailed-analysis/65400)), 30 days is the red line. Bump to 90 days (`7776000`) in W6.1 pre-flight. One command, zero risk.
- **R11.** Project `CLAUDE.md` requires `icp` CLI for deploys; W6.2 uses `dfx`. icp-cli skill explicitly forbids `dfx`. Reconcile or document deviation before discovering mid-upgrade.
- **R12.** W4 has no upload resume / orphan cleanup. Dropped mid-upload call leaves orphaned chunks burning storage cycles forever. Add `getVideoUploadProgress` query and `cancelVideoUpload` admin method.

### Medium-severity (plan works but you'll regret it)

- **R13.** "Trigger Region migration at ~2 GB heap" is too high. EOP wasm32 caps at 4 GB; comfort zone is ~1 GB. Production canister's wasm memory limit is 3 GiB (not 4) per live status. Update Phase 2+ deferred list to trigger at 1 GB.
- **R14.** 2 MB clamp vs OpenChat's 1.5 MB — latter gives Candid framing headroom. Consider matching.
- **R15.** W3.1 ffmpeg multi-output snippet uses `-vf` per output without `-filter_complex split`, which re-decodes the source N times and applies filters incorrectly. Use three sequential invocations.
- **R16.** "~$10-15/yr" cost estimate is pre-Mission-70. Re-derive against current pricing before the launch post.
- **R17.** iOS fires backchannel `bytes=0-1` probes even with `preload="none"`, per Steve Souders (still true). Three `<video>` elements on the track list page = 3-6 cold boundary-node roundtrips on first paint. Use poster-image-as-control pattern: don't render `<video>` until user taps the card.
- **R18.** Safari rejects Range responses if the echoed `last-byte-pos` doesn't match what was requested. Verify the Motoko handler's `Content-Range` math on the 5-minute clip, not just the 78-second clip (moov atom placement differs).

---

## My specific ask

Give me a cold, independent read. Specifically:

1. **What did the first reviewer miss?** New angles of attack — architectural, operational, or mobile-playback specific — that aren't in the flagged risks above.
2. **What did the first reviewer get wrong?** Places where I should push back on the flagged risks. Any of the 5 ship-blockers that you think are overblown or misdiagnosed.
3. **If you were executing this plan tomorrow, what is the single change you'd make first?** Not a list — one answer, with reasoning.
4. **Has the IC ecosystem shipped anything in the last 12 months that would change the fundamental approach?** (Multi-canister video, asset canister Range support, new mops package, certified Range for Motoko, new ic-http-gateway feature — anything.) Give URLs.
5. **Mobile playback specifically:** the plan's entire mobile story rests on one 78-second test on one iPhone on one LTE connection. What stress tests would you run before calling Phase 1 shippable?

Don't summarize the plan back. Don't hedge. If you think the whole thing should pivot to a different architecture, say so and defend it.

---

## Files the first reviewer read

- `/Users/chrisyost/music-platform/PLAN_video_phase1_implementation.md` (the plan under review)
- `/Users/chrisyost/music-platform/PLAN_video_phase1.md` (the outer gate document)
- `/Users/chrisyost/music-platform/RESEARCH_video_icp_2026-04-14.md` (first-pass research, partially superseded)
- `/Users/chrisyost/music-platform/backend/Main.mo` (923-line production canister)
- `/Users/chrisyost/music-platform/CLAUDE.md` (project conventions)
- `/Users/chrisyost/.claude/CLAUDE.md` (global preferences)

Plus: ICP skill library (motoko, stable-memory, canister-security, multi-canister, cycles-management, asset-canister, certified-variables, icp-cli), live canister queries via ic-mcp against production + throwaway canisters, forum.dfinity.org archaeology restricted to last 12 months, GitHub searches against dfinity/ic, dfinity/sdk, dfinity/motoko, dfinity/ic-http-gateway-protocol, dfinity/response-verification, open-chat-labs/open-chat, and WebKit / Chromium bug trackers.
