# Cloud Records — Video Phase 1 Plan

**Status:** scoped 2026-04-14, awaiting Step 1 execution in fresh session.

## Behavioral rules (internalize — Chris flagged these)

1. Exploratory questions get exploration, not code blocks. Slow down.
2. Ambiguous/short input → ask before acting. Don't guess.
3. Never invent numbers. Go get them or say you can't.
4. If a step surfaces something that changes an earlier assumption, STOP and re-plan before continuing.
5. Report back between every step. These are gates, not a checklist to race through.

## Product answers (fixed)

- **Scope:** 3 flagship on-chain music videos as an "ICP can do this" demo. NOT 100. Others go off-chain later (provider TBD). Storage location must be a per-video property so off-chain videos can land later without a rewrite.
- **Format:** ~5 min, 720p, ~100MB per clip. H.264 High@4.0 + AAC 128k + `+faststart`.
- **Pairing:** videos pair 1:1 with existing audio tracks. Reuse existing analytics surface — same comments, play counts, clap counts, cover art. No parallel system.
- **Data model:** tradeoff to resolve in Step 4. Options: (a) optional `videoId` field on Track, (b) separate Video type referencing a Track, (c) something else. Tradeoffs must be stated; don't pick silently.
- **Upload workflow:** Chris only, no public uploads. Encoding local via extended `optimize_tracks.py` → `optimize_media.py` unless Step 3 surfaces a reason to push server-side.
- **Mobile data:** cellular users are expected. 94MB-only is NOT acceptable. Resolution picker and/or wifi-only default. Flagship demo MUST play well on LTE — broken demo is worse than no demo.
- **Forcing function:** content — new video recorded in tandem with launch. No hard deadline pushing video ahead of the audit.

## Scope constraint

**Phase 1 is sized for 3 flagship clips. Not 100. Not 1000.** Do not over-engineer for scale that may never happen. If a design decision only matters at 100+ video scale, defer it.

## Sequence — strict gates, do not race ahead

### Step 1 — Ground-truth the baseline. No guessing.

- Read `backend/Main.mo` end to end.
- Pull live canister status from mainnet via ic-mcp or dfx: cycles balance, subnet, memory size, heap vs stable split, storage used.
- Inspect rate-limiting maps (`lastPostAt`, `playRateLimit`, others). Report what they cover and what they don't.
- Inspect backup LaunchAgents. Would they survive multi-GB video? Has restore ever been tested?
- Flag the "playback struggling in general" issue from 2026-04-13 session as UNRESOLVED — chunk retry fix is plausible but unverified on real mobile network.
- **Output:** short baseline report, numbers not narrative.
- **Stop and report before Step 2.**

### Step 2 — Audit, scoped by Step 1 findings.

Scorched-earth pass on existing canister. Parallel agents OK. Explicit skills: `canister-security`, `motoko`, `stable-memory`.

Coverage:
- Comments, guestbook, rate limiting
- Upgrade hooks and stable memory layout
- Cycle-drain vectors
- Unbounded collections (explicitly — if unbounded, it changes the video data model)
- Auth on admin endpoints
- Frontend XSS in comments/guestbook
- Frontend auth state handling

Separate findings into "fix before video" vs "can defer". Anything that becomes harder to fix once stable memory holds GBs of video gets flagged as fix-before.

**Stop and report before Step 3.**

### Step 3 — Video research, building on prior findings.

**Do not start greenfield.** The 2026-04-14 research agent produced real findings. Treat as input:
- OpenStorage as the only production on-chain media precedent
- Range request history (stripped until Feb 2024, content-range bug later, verify PR #61)
- 2MB clamp pattern for range responses
- `+faststart` flag requirement
- Videate failure mode: no cross-canister query calls from inside `http_request`
- ~$53/year cost envelope for 10GB at May 2025 cycle prices
- H.264 High@4.0 + AAC codec recommendation

Job: corroborate, update, fill gaps. 5-agent structure:

1. **Code-grounded agent** — read OpenChat's actual bucket canister source on GitHub, translate Range/chunk patterns into concrete Motoko. Not "patterns" — real code references. Skills: `motoko`, `stable-memory`.
2. **2025-scoped forum/docs agent** — restrict to 2025 content only. Verify ic-gateway content-range PR #61 merge status. 2022–2024 forum archaeology lies.
3. **Empirical agent** — deploy throwaway test canister with Range-supporting `http_request`. Test from iOS Safari and Chrome mobile on both `.icp0.io` and `.raw.icp0.io`. Report what actually works. Skills: `icp-cli`. Tools: playwright.
4. **Cost-model agent** — pull current fee schedule, reprice against prior numbers, flag anything stale. Skills: `cycles-management`. Tools: ic-dashboard if useful.
5. **Synthesis agent** — cross-read all four, flag contradictions, run combined recommendation through `canister-security`, `stable-memory`, `motoko`, `cycles-management`, `certified-variables` as validation.

Use ic-mcp for live canister queries throughout.

**Stop and report before Step 4.**

### Step 4 — Phase 1 plan.

Integrate audit findings + product answers + Step 3 output. Deliverables:

1. Data model decision (videoId-on-Track vs separate Video vs other) with tradeoffs stated and a recommendation.
2. Storage-location abstraction (on-chain now, off-chain later, zero rewrite).
3. Concrete cycles/storage budget based on real Step 1 baseline numbers, sized for 3 clips.
4. Fix-before-video checklist from Step 2.
5. Encoding pipeline as its own tracked workstream — ffmpeg presets, `+faststart`, thumbnail extraction, cover-art-first rule.
6. Mobile-first playback plan — resolution picker, wifi-only option, realistic LTE behavior.
7. Range handler rate limiting on day one. Cycle-drain protection is NOT a v2 problem.
8. Explicit Phase 2+ deferred list with reasoning.

## References

- Mobile playback fix session handoff: `/Users/chrisyost/Documents/Claude CoWork/Sessions/code/HANDOFF_2026-04-14_cloud-records-mobile-playback.md`
- Prior video research (2026-04-14 session, agent report): sources list in conversation, not yet persisted — re-query if needed.
- CLAUDE.md: `/Users/chrisyost/music-platform/CLAUDE.md` and `/Users/chrisyost/.claude/CLAUDE.md`
