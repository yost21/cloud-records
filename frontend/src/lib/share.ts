import type { TrackInfo } from "./types";

const SITE_URL = "https://kmeho-ciaaa-aaaae-ageza-cai.icp0.io";

export function shareTrack(track: TrackInfo | null): void {
  if (!track) return;
  const url = `${SITE_URL}/?track=${track.id}`;
  if (navigator.share) {
    navigator.share({ title: `${track.name} — Cloud Records`, url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).catch(() => {});
  }
}
