// Cloud Records VideoPlayer (W5.1)
//
// Renders a single <video> element pointed at the selected variant's URL.
// Only mounted from Player.tsx when the currently-selected track has a
// linked VideoInfo. This means the entire app only ever has ONE <video>
// element mounted at a time — the Playlist sidebar shows cover art only,
// so R17 (iOS backchannel preload probes on multi-<video> pages) is not
// a risk in Cloud Records' UI architecture. Poster-image-as-control is
// therefore unnecessary.
//
// The resolution picker uses `navigator.connection.effectiveType` with a
// Safari fallback to the LOWEST playable variant (see lib/video.ts).

import { useEffect, useMemo, useState } from "react";
import type { VideoInfo } from "../lib/types";
import {
  listPlayableVariants,
  pickDefaultVariant,
  formatVariantLabel,
  type PlayableVariant,
} from "../lib/video";

interface Props {
  video : VideoInfo;
}

export default function VideoPlayer({ video }: Props) {
  const playable = useMemo(() => listPlayableVariants(video), [video]);
  const defaultVariant = useMemo(() => pickDefaultVariant(video), [video]);
  const [selected, setSelected] = useState<PlayableVariant | null>(defaultVariant);

  // When the video prop changes (e.g. user picks a different track that has
  // its own video), recompute the default and reset the selection.
  useEffect(() => {
    setSelected(pickDefaultVariant(video));
  }, [video]);

  if (playable.length === 0 || !selected) {
    // No playable variants at all — Phase 1 with all off-chain URLs empty
    // shouldn't happen for a track that HAS a video record, but be defensive.
    return null;
  }

  const handlePick = (resolution: string) => {
    const next = playable.find(p => p.resolution === resolution);
    if (next) setSelected(next);
  };

  return (
    <div className="video-player">
      <video
        key={selected.url}
        className="video-player-el"
        src={selected.url}
        controls
        playsInline
        preload="metadata"
      />
      {playable.length > 1 && (
        <div className="video-player-picker">
          <label htmlFor="video-resolution" className="video-player-picker-label">
            Quality
          </label>
          <select
            id="video-resolution"
            value={selected.resolution}
            onChange={e => handlePick(e.target.value)}
            className="video-player-picker-select"
          >
            {playable.map(p => (
              <option key={p.resolution} value={p.resolution}>
                {formatVariantLabel(p)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
