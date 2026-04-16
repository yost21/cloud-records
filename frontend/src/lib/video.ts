// Cloud Records video helpers (W5.2) — resolution picker + URL builder.
//
// The picker enforces the R3 regression guard from HANDOFF_video_phase1_validation:
// if `navigator.connection` is undefined (iOS Safari!), fall back to the
// lowest on-chain variant rather than defaulting to a (possibly empty-URL)
// high-bandwidth variant. Chrome has connection.effectiveType; Safari does
// not. The original plan defaulted to 720p on "undefined", which on Phase 1
// hands the <video> element `src=""` and silently fails on Chris's demo
// iPhone. This fix is tested as part of W5.4 acceptance.

import type { VideoInfo, VideoVariant, StorageLocation } from "./types";
import { getVideoStreamUrl } from "./agent";

// Canonical rendering order — lowest to highest. Unknown labels sort last.
const RESOLUTION_ORDER = ["480p", "720p", "1080p"] as const;

function isOnChain(loc: StorageLocation): boolean {
  return "onChain" in loc;
}

function offChainUrl(loc: StorageLocation): string | null {
  if ("offChain" in loc) return loc.offChain.url || null;
  return null;
}

// A variant is "playable" iff (a) it's on-chain, OR (b) it's off-chain with
// a non-empty URL. Off-chain variants with empty URL are Phase 1 placeholders
// — they're present in the schema so Phase 2 can populate URLs later without
// a backend migration, but they cannot be rendered into a <video src>.
export function isPlayableVariant(variant: VideoVariant): boolean {
  if (isOnChain(variant.storageLocation)) return true;
  return offChainUrl(variant.storageLocation) !== null;
}

export interface PlayableVariant {
  resolution : string;
  variant    : VideoVariant;
  url        : string;
}

// Project a VideoInfo into the sorted list of playable variants. Any
// placeholder variants (off-chain + empty URL) are excluded entirely — the
// picker and UI never see them.
export function listPlayableVariants(video: VideoInfo): PlayableVariant[] {
  const playable: PlayableVariant[] = [];
  for (const [resolution, variant] of video.variants) {
    if (!isPlayableVariant(variant)) continue;
    const offUrl = offChainUrl(variant.storageLocation);
    const url = offUrl !== null ? offUrl : getVideoStreamUrl(video.id, resolution);
    playable.push({ resolution, variant, url });
  }
  playable.sort((a, b) => {
    const ai = RESOLUTION_ORDER.indexOf(a.resolution as (typeof RESOLUTION_ORDER)[number]);
    const bi = RESOLUTION_ORDER.indexOf(b.resolution as (typeof RESOLUTION_ORDER)[number]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return playable;
}

type EffectiveType = "slow-2g" | "2g" | "3g" | "4g" | undefined;

function readEffectiveType(): EffectiveType {
  if (typeof navigator === "undefined") return undefined;
  // navigator.connection is Chromium-only; Safari returns undefined.
  const conn = (navigator as unknown as { connection?: { effectiveType?: EffectiveType } }).connection;
  return conn?.effectiveType;
}

// Pick the default variant for first-load based on connection bandwidth,
// with a hard Safari fallback. Order matters:
//   1. Filter to playable variants only (see listPlayableVariants).
//   2. If no playable variants → return null (caller hides the player).
//   3. If Safari (effectiveType undefined) → LOWEST playable variant. DO NOT
//      guess 720p. Safari returning undefined is not "assume Wi-Fi" — it's
//      "we have no signal." The Phase 1 demo device is Chris's iPhone, and
//      picking the lowest variant is the only way to guarantee it plays.
//   4. Chromium cellular (slow-2g/2g/3g) → LOWEST playable variant.
//   5. Chromium 4g → HIGHEST playable variant.
//   6. Belt-and-suspenders: if the chosen variant's URL is empty for any
//      reason, fall through to the first playable variant in the list.
export function pickDefaultVariant(video: VideoInfo): PlayableVariant | null {
  const playable = listPlayableVariants(video);
  if (playable.length === 0) return null;

  const effectiveType = readEffectiveType();

  let chosen: PlayableVariant;
  if (effectiveType === undefined) {
    // Safari path — always lowest.
    chosen = playable[0];
  } else if (effectiveType === "4g") {
    chosen = playable[playable.length - 1];
  } else {
    // slow-2g, 2g, 3g — always lowest.
    chosen = playable[0];
  }

  // Defensive fallback: if we somehow ended up with an empty URL (shouldn't
  // happen because listPlayableVariants filters those out, but invariant
  // drift is cheap to guard), return the first playable variant.
  if (!chosen.url) {
    return playable[0];
  }
  return chosen;
}

// Format a human-readable label for the resolution picker dropdown.
// Example: `480p · 30 MB`.
export function formatVariantLabel(p: PlayableVariant): string {
  const mb = Number(p.variant.size) / 1_000_000;
  const sizeLabel = mb >= 100 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
  return `${p.resolution} · ${sizeLabel}`;
}
