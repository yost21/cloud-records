# Cloud Records — Fully On-Chain Video on ICP: Research Report

**Date:** 2026-04-14
**Status:** First-pass research. Single agent, ~19 sources, mostly DFINITY docs + forum archaeology + GitHub repo surveys. Directional verdict only — Step 3 in `PLAN_video_phase1.md` will corroborate and fill gaps with a 5-agent structure.

## Verdict

**Fully on-chain video on ICP is viable with caveats for the target use case** (~5-min clips, <100 items, paired with existing on-chain audio). The economics work at that scale, the architecture patterns are proven by OpenChat's OpenStorage, and HTTP Range support — the historical dealbreaker — has been fixed at the boundary node / ic-gateway layer as of 2024. Where it breaks down is scaling to hundreds of hours of HD or adding live streaming; that's still impractical without hybrid CDN. The one pattern you should NOT use is the asset canister — use a custom Motoko canister that mirrors the existing audio chunk scheme, because that's where the certified-Range story is still incomplete.

---

## 1. Confirmed On-Chain Video Precedents on ICP

Separating what's truly on-chain from what's labeled "on-chain" but actually points to S3/IPFS:

| Project | On-chain video? | Reality |
|---|---|---|
| **DSCVR** | **No** | Uses IPFS + Arweave for post content. "DSCVR doesn't actually store post content on ICP, it uses IPFS and arweave." (infinityswap blog / forum) |
| **OpenChat (OpenStorage)** | **Yes** | Index-canister + bucket-canister factory pattern written in Rust. Media files (images, video, audio) stored in stable memory inside bucket canisters. Buckets become read-only when full; new ones spawn. Content-addressed (dedupes identical blobs via reference counting). This is the **most production-proven on-chain media storage architecture on ICP.** The repo `open-chat-labs/open-storage` has been merged into `open-chat-labs/open-chat`. |
| **Videate** (paulyoung) | **Partial / abandoned-ish** | DFINITY-grant Motoko project that tried to build an open video-podcast platform. Ran into exactly the problems relevant here: `http_request` function couldn't call other canisters' query methods (forced everything into one canister), and range requests were broken. Proved the concept but never scaled. Worth reading as a cautionary tale, not as a reference implementation. |
| **CanCan** (DFINITY demo) | **Yes (demo only)** | Open-source "decentralized TikTok" released by DFINITY Foundation. Motoko backend, JS frontend, DHT-style sharding approach across canisters. Chunked uploads. The canonical DFINITY reference for chunked media — your existing audio design is already in this lineage. Tech demo, not a shipped product, predates the streaming-protocol and range-request improvements. |
| **Nuance** | **Yes, for text/images** | Fully on-chain blog platform, SNS-DAO governed. Stores post bodies and cover images in canisters. No meaningful video support. |
| **Funded / Distrikt / DecideAI** | No dedicated on-chain video | Funded is crowdfunding; Distrikt is social (went quiet); DecideAI is AI-focused. None ship video as a core storage concern. |
| **"ICP Netflix"** | Does not exist as a shipped product | No credible precedent. Every thread that mentions it is aspirational. |

**Bottom line:** The only production-grade on-chain media storage at any real scale on ICP today is **OpenChat's OpenStorage**. Everything else is hybrid (DSCVR), a demo (CanCan), text-dominant (Nuance), or abandoned/dormant (Videate, Distrikt).

Sources:
- OpenChat architecture: https://github.com/open-chat-labs/open-chat/blob/master/architecture/doc.md
- OpenStorage repo (archived, merged into open-chat): https://github.com/open-chat-labs/open-storage
- DSCVR hybrid storage: https://forum.dfinity.org/t/so-the-ic-cant-store-files-well-either/14536
- Videate devpost: https://devpost.com/software/videate
- CanCan source: https://github.com/dfinity/cancan
- DFINITY CanCan announcement: https://medium.com/dfinity/cancan-the-internet-computers-decentralized-tiktok-is-now-open-source-5eed04547aa1

---

## 2. Architecture Patterns for On-Chain Video on ICP

### 2a. Asset canister vs custom canister

**Skip the asset canister for video.** The canonical `certified-assets` canister still has Range support as an **open, unresolved issue from Dec 2021** (`dfinity/certified-assets#10`). It exposes `http_request_streaming_callback` for responses >2 MB, but that's a forward-only streaming pattern — the gateway pulls the entire body sequentially. It is not a true Range implementation. A video player that tries to seek to minute 4:00 of a 5-minute file with the stock asset canister will either re-fetch from byte 0 or fail outright on mobile Safari.

**Use a custom Motoko canister with its own `http_request` handler that parses the `Range:` header and returns 206 Partial Content directly.** Same code path as the current `http_request`, extended.

### 2b. Stable data structure for chunks

Current canister uses `Map.Map<Text, Blob>` (heap-backed, `mo:core/Map`). That works fine up to a few GB but the heap is bounded and upgrades get riskier as it fills. For video, switch chunk storage to **`StableBTreeMap` (Motoko region-backed stable memory)** so it can grow past heap limits without pre/post-upgrade hooks moving gigabytes. Keep metadata (track/video records, admins) on the heap — metadata is small.

### 2c. Chunking strategy

- The current 1.9 MB audio chunks are the right ballpark — hard ingress limit per update call is **2 MB**, need headroom for Candid framing. Keep 1.9 MB for video too.
- For video, align chunks to **1 MiB boundaries** (1,048,576 bytes). Cleaner Range math and matches what browsers ask for (Chrome: 1–2 MB hunks, Safari: smaller initial then larger).
- Upload concurrency: 4–8 in-flight chunks is the sweet spot. Above that → agent throttling and nondeterministic ordering. Current upload pipeline is already doing this.
- Download concurrency: for true progressive playback via MediaSource Extensions, 2–4 concurrent range fetches. For v1, skip MSE and let the browser drive range fetches via a native `<video>` tag.

### 2d. HTTP Range requests via `http_request`

Load-bearing piece. The custom Motoko canister's `http_request(req)` needs to:

1. Parse `req.headers` for `Range: bytes=<start>-<end>`.
2. If absent, return normal 200 with HEAD-style response (or small first chunk + streaming callback for legacy clients).
3. If present, compute which stored chunks overlap `[start, end]`, concatenate the slice, return **HTTP 206** with headers:
   - `Content-Range: bytes <start>-<end>/<total>`
   - `Content-Length: <end - start + 1>`
   - `Accept-Ranges: bytes`
   - `Content-Type: video/mp4`
4. Never exceed 2 MB in response body — if requested range is bigger, clamp to 2 MB and return 206 with clamped `Content-Range`; the player will immediately issue a follow-up Range request for the next window. Video players are designed to issue many range requests. **No streaming callback needed.**

### 2e. HLS / DASH manifests

Don't bother generating HLS on-chain at this scale. A single 5-minute MP4 played through a native `<video>` element with Range support is simpler, uses fewer cycles, and is what iOS Safari handles best. HLS only earns its keep with adaptive bitrate (multiple renditions) or live streams — neither is in the plan.

### 2f. Multi-canister patterns

Two usable shapes:

1. **Single canister, extend what you have (recommended for MVP).** Add video as a new entity type alongside tracks. Share admin model, reuse chunk-key scheme (`videoId:idx`). Good up to the subnet storage limit.
2. **Factory / bucket pattern (OpenChat-style).** One index canister stores metadata and routes reads; N bucket canisters each hold ~50–100 GB of video blobs. Buckets go read-only when full and you spawn new ones. Scalable answer but premature at <100 videos.

Start with #1. Can always migrate to #2 once you push past ~50 GB.

### 2g. Hard canister limits (current as of 2025)

| Limit | Value | Source |
|---|---|---|
| Wasm heap | 4 GiB | docs.internetcomputer.org/building-apps/canister-management/storage |
| Stable memory per canister | **500 GiB** (up from 8 GB originally) | same |
| Ingress message (update call) payload | 2 MiB | same |
| Response body without streaming | 2 MiB | HTTP Gateway spec |
| Instructions per message (update) | ~40 B (billion) | fee page |

500 GiB is plenty. At ~100 MB per 5-minute 720p H.264 clip, one canister holds ~5,000 videos. Won't reach the limit at Chris's library size.

Sources:
- Asset canister reference: https://docs.internetcomputer.org/references/asset-canister
- Range open issue: https://github.com/dfinity/certified-assets/issues/10
- Storage limits: https://docs.internetcomputer.org/building-apps/canister-management/storage
- Blob size/chunking: https://forum.dfinity.org/t/canister-and-blob-size-limits/12333

---

## 3. Cycles & Cost Reality Check

Numbers from the current fee breakdown (docs.internetcomputer.org/building-apps/essentials/gas-cost):

- **Storage:** 127,000 cycles per GiB per second → **~4 T cycles per GiB per year → ~$5.35/GiB/year** at the May 2025 XDR rate ($1.35/XDR, 1 T cycles = 1 XDR). **VERIFY IN STEP 3 — PRICES MAY HAVE CHANGED.**
- **Ingress message:** 1.2 M base fee + 2,000 cycles/byte, paid by the receiving canister. A 1.9 MB upload chunk costs ~3.8 B cycles ≈ $0.005 per chunk on the receiving side.
- **Update call:** 260 K base + 1 K cycles/byte sending.
- **Query calls:** free for the caller but count against the canister's instruction budget.

**Worked example for 100-video scale (NOT Chris's actual scope — his is 3 clips Phase 1):**

- 100 videos × 100 MB each = **10 GB stored → ~$53/year** in storage cycles.
- Uploading the library (one-time): 10 GB ÷ 1.9 MB/chunk ≈ 5,400 chunks × $0.005 ≈ **~$27 one-time**.
- Serving: queries are free, but canister is billed for instructions on each range request. Well-written range handler ~5 M instructions per 1 MB response window — effectively free at these volumes. **Under $10/year in compute for hundreds of plays per day.**

**For 3 flagship videos (actual Phase 1 scope):**
- ~300 MB stored → ~$1.60/year storage
- ~150 chunks × $0.005 = ~$0.75 one-time upload
- Compute: rounding error
- **Total Phase 1 ongoing cost: well under $5/year.** Verify in Step 3 with current fees.

**Cost becomes painful around:**
- ~5 TB stored (≈$25K/year storage, and you're also running into multi-subnet scaling)
- High-concurrency live events (consensus-replicated range serving isn't a CDN — each query hits every replica)

Sources:
- Fee breakdown: https://docs.internetcomputer.org/building-apps/essentials/gas-cost
- Cycles per GB-year discussion: https://forum.dfinity.org/t/cycle-cost-of-storage-per-month/2009

---

## 4. Codec & Format Compatibility

For the devices Chris cares about (iOS Safari + Chrome mobile + desktop):

- **Container: MP4 (ISO base media / fragmented MP4).** Universal. Do NOT use WebM — excludes iOS Safari.
- **Video codec: H.264 (AVC), High Profile, Level 4.0 or lower.** Plays everywhere. Hardware-accelerated on all iPhones.
- **Audio codec: AAC-LC, 128 kbps stereo.** Apple-mandated for HLS, also universal for MP4.
- **Resolution/bitrate sweet spot:** 1280×720 at 2–3 Mbps for body shots, 1920×1080 at 4–5 Mbps for HD. A 5-minute 720p clip at 2.5 Mbps is ~94 MB — the number in the cost model.
- **Encoding recipe (ffmpeg):** `-c:v libx264 -profile:v high -level 4.0 -preset slow -crf 23 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k`. The **`+faststart`** flag is CRITICAL — moves the MOOV atom to the front of the file so the player can start decoding without reading the whole file first. Without it, range-based playback will stall on the first seek.
- **Skip for now:** H.265/HEVC (licensing, Chrome desktop patchy), AV1 (encoding too slow, mobile decode spotty), VP9 (no iOS Safari).

**Mobile data consideration (per Chris's product answer):** 94 MB over LTE as the only option is not acceptable. Options for Step 4 plan:
- **Resolution picker:** encode each flagship at 480p (~40 MB), 720p (~94 MB), 1080p (~180 MB) and let the player choose.
- **Wifi-only default:** detect connection type via NetworkInformation API (if supported) and gate auto-play.
- **Hybrid:** both.

Sources:
- Apple HLS authoring spec: https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices
- Range-and-mp4 playback mechanics: https://www.zeng.dev/post/2023-http-range-and-play-mp4-in-browser/

---

## 5. HTTP Range Requests on ICP — The Dealbreaker That Isn't Anymore

This was the historical blocker and it has a messy timeline:

- **Dec 2021:** `dfinity/certified-assets#10` opened asking for Range support in the asset canister. Still open.
- **2022–2023:** Developers (Videate team and "Can't host podcasts from canisters" thread — `forum.dfinity.org/t/cant-host-podcasts-from-canisters/15324`) report that even when their canister returned correct 206 responses, the boundary node stripped the `Range` request header before it reached the canister. Hard block for anything but sequential playback from byte 0.
- **Feb 2024:** Root cause identified in the boundary-node `nginx` cache layer: "When nginx receives a range request and default caching is enabled, nginx actually tries to fetch the full file from the upstream and then serve only the bytes requested by the client." Fix committed and rolled out to a canary node (test IP `212.133.1.43`) on Feb 29, 2024, then to all boundary nodes the following week. Source: https://forum.dfinity.org/t/range-headers-being-stripped-out/27761
- **Later 2024:** Follow-on bug where ic-gateway was returning duplicate `Content-Length` headers on `.raw.icp0.io` range responses (https://forum.dfinity.org/t/ic-gateway-issue-content-range-header/63187). **PR #61 opened to fix it. NOT CONFIRMED MERGED — Step 3 must verify.**
- **2024–2025:** Per the HTTP Gateway Protocol Spec (https://internetcomputer.org/docs/references/http-gateway-protocol-spec), the gateway now explicitly allows `Range` in `access-control-allow-headers` and exposes `Content-Range`. One forum user confirmed running "fragmented MP4 data without metadata files like MPD or M3U8" with range requests returning proper 206 Partial Content.

**What Step 3's empirical agent must verify:** deploy a tiny test canister that returns 206 for a Range request and open it from iOS Safari and Chrome mobile on the non-`.raw` subdomain (`https://<canister>.icp0.io`). If seek works → good. If not → fall back to `.raw.icp0.io` which bypasses some gateway logic at the cost of losing response certification. Certification for range responses is still an area where the spec notes the gateway "does not fully support HTTP range requests" in the certified-query sense.

Sources:
- HTTP Gateway spec: https://internetcomputer.org/docs/references/http-gateway-protocol-spec
- Streaming protocol announcement: https://forum.dfinity.org/t/announcing-a-new-http-gateway-streaming-protocol/35034
- Range stripping fix: https://forum.dfinity.org/t/range-headers-being-stripped-out/27761
- Content-Range gateway bug: https://forum.dfinity.org/t/ic-gateway-issue-content-range-header/63187

---

## 6. Known Failure Modes & War Stories

From forum archaeology:

- **Upgrade traps when heap is near full** — "During upgrades your canister might do some allocations that can go beyond the 4gig heap limit which will render your canister impossible to upgrade." Mitigation: keep blobs in stable memory, not heap. (`forum.dfinity.org/t/canister-and-blob-size-limits/12333`)
- **Inter-canister query calls from `http_request`** — Videate team hit this: from inside `http_request`, a canister cannot call another canister's query methods, forcing everything into one canister or upgrading to update calls (expensive and breaks caching). Design around it by keeping video serving inside a single canister or precomputing the data you'll need before the HTTP call lands. **This is why Phase 1 stays single-canister.**
- **Boundary-node cache eating range requests** — described above, fixed but verify on deployment.
- **Subnet-fill risk** — 500 GiB per canister is the spec, but the subnet has to have the room. On a crowded subnet you might hit a soft wall well before 500 GiB. Pick a less-loaded subnet or plan for the bucket pattern.
- **Cycles drain from misbehaving clients** — a range request that returns a response body costs cycles per byte. A malicious or dumb client fetching the same 2 MB window in a loop is a DoS-by-cycles. **Per Chris's plan: rate limit on the Range handler from day one. Not a v2 problem.**
- **"Everything works locally, breaks on mainnet"** — extremely common for media-serving canisters, usually because `dfx start`'s local replica doesn't exercise the boundary-node cache path. Test on mainnet early.

---

## 7. Recommended Architecture for Cloud Records (First-Pass — Step 4 Will Finalize)

Given the existing single-canister Motoko audio setup (`Main.mo`, `chunks : Map<Text, Blob>`, `http_request`, admin model, 200 MB IndexedDB cache), the lowest-friction path to video:

**Phase 1 — Add video to the existing canister (ship in days, not weeks):**

1. Add a `Video` record type alongside `Track` (id, title, artist, description, cover-art reference, `sizeBytes`, `chunkCount`, `mimeType`, `duration`, timestamps, **storage location** per Chris's product answer).
2. Reuse the chunking scheme — key videos as `video:<id>:<idx>`, separate namespace from tracks. Keep 1.9 MB chunk size. Move chunk storage from `Map<Text, Blob>` to **`StableBTreeMap`** in a `Region` so heap isn't growing with GBs of video. **Step 2 audit must confirm this migration is safe for existing audio chunks.**
3. Extend `uploadChunk` to accept a "kind" tag (`#audio` or `#video`) and `deleteTrack`-style cleanup for videos.
4. Extend `http_request`: path `/video/<id>` → parse `Range:`, fetch overlapping chunks from stable storage, concatenate slice, return **HTTP 206** with `Content-Range`/`Content-Length`/`Accept-Ranges: bytes`/`Content-Type: video/mp4`. **Clamp to 2 MB per response.**
5. Frontend: plain `<video src="https://<canister>.icp0.io/video/<id>" controls>` element. Do NOT try MediaSource Extensions for v1.
6. Encoding pipeline: extend `optimize_tracks.py` for video — `libx264 high@4.0, CRF 23, 720p, +faststart, AAC 128k stereo`. Target ≤100 MB per 5-minute clip.
7. **Always upload cover art first** for each video, per existing Cloud Records rule.

**Phase 2 — Only if past ~50 GB or ~500 videos:** migrate to the OpenChat-style Index + Bucket pattern. Existing canister becomes the Index; spawn new Bucket canisters as storage fills. **Not on Chris's roadmap.**

**Verify before shipping:**
- Range response end-to-end on mainnet (not local replica) from iOS Safari and Chrome mobile. Specifically seek to the middle of the file and confirm it plays without re-fetching from byte 0.
- ic-gateway `content-range` duplicate-header fix (PR #61) deployed, or use `.raw.icp0.io` as fallback.
- Top up canister for at least 1 year of projected storage before opening uploads so you can't get locked out mid-library.

**Drop on the floor:** HLS manifests, adaptive bitrate, DASH, MSE-based players, asset-canister integration, live streaming fantasy. None earn their cost for a 3-clip flagship demo.

---

## Caveats on This Report

- **Single-pass research.** One agent, ~25 min, mostly web search + forum archaeology. Step 3 in `PLAN_video_phase1.md` will corroborate with 5 parallel agents + empirical testing + live canister queries.
- **Numbers may be stale.** Cycle prices (May 2025), storage costs, and gateway behavior need Step 3 re-verification.
- **Main.mo not read.** This report discusses the current canister abstractly based on CLAUDE.md descriptions. Step 1 will ground-truth.
- **Nothing empirically tested.** The Range story is the biggest risk — Step 3's empirical agent MUST actually deploy a test canister and verify from real mobile browsers before committing to the architecture.
- **PR #61 merge status unverified.** Step 3 must check.
- **OpenChat bucket canister source not read.** Step 3's code-grounded agent should translate its actual Rust into concrete Motoko.

---

## Sources

- https://medium.com/dfinity/cancan-the-internet-computers-decentralized-tiktok-is-now-open-source-5eed04547aa1
- https://github.com/dfinity/cancan
- https://github.com/open-chat-labs/open-chat/blob/master/architecture/doc.md
- https://github.com/open-chat-labs/open-storage
- https://devpost.com/software/videate
- https://docs.internetcomputer.org/references/asset-canister
- https://github.com/dfinity/certified-assets/issues/10
- https://docs.internetcomputer.org/building-apps/essentials/gas-cost
- https://docs.internetcomputer.org/building-apps/canister-management/storage
- https://forum.dfinity.org/t/canister-and-blob-size-limits/12333
- https://forum.dfinity.org/t/cant-host-podcasts-from-canisters/15324
- https://forum.dfinity.org/t/so-the-ic-cant-store-files-well-either/14536
- https://forum.dfinity.org/t/range-headers-being-stripped-out/27761
- https://forum.dfinity.org/t/announcing-a-new-http-gateway-streaming-protocol/35034
- https://forum.dfinity.org/t/ic-gateway-issue-content-range-header/63187
- https://internetcomputer.org/docs/references/http-gateway-protocol-spec
- https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices
- https://www.zeng.dev/post/2023-http-range-and-play-mp4-in-browser/
- https://forum.dfinity.org/t/cycle-cost-of-storage-per-month/2009
