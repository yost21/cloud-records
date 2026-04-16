#!/usr/bin/env python3
"""
Cloud Records Video Encoding Pipeline (W3.1)

Takes a source MP4/MOV and produces three H.264 renditions + thumbnail +
manifest ready for `upload-video.mjs` to consume.

THREE SEQUENTIAL FFMPEG INVOCATIONS — NOT single-invocation multi-output.
Single-invocation multi-output with per-output -vf applies filters to the
next output only, re-decodes the source N times, and produces broken results
without -filter_complex split. Sequential is slower in wall-clock but correct.

Renditions:
    480p:  854×480,  CRF 25, H.264 High@4.0, AAC 128k, +faststart
    720p:  1280×720, CRF 23, H.264 High@4.0, AAC 128k, +faststart
    1080p: 1920×1080,CRF 21, H.264 High@4.0, AAC 128k, +faststart

All renditions use `-pix_fmt yuv420p` for iOS Safari compatibility and
`+faststart` so the moov atom lands at the FRONT of the file — mandatory
for progressive streaming over Range requests on mobile (without it, the
first seek triggers a tail fetch before the player can start decoding).

Output layout (relative to the script's working directory unless --out-dir):
    optimized/videos/<basename>/
        <basename>-480p.mp4
        <basename>-720p.mp4
        <basename>-1080p.mp4
        <basename>-thumb.jpg
        manifest.json

The manifest format matches what upload-video.mjs expects:
    {
      "durationSec": <int>,
      "variants": {
        "480p":  { "file": "...", "size": <bytes>, "mimeType": "video/mp4",
                   "storageLocation": { "onChain": true } },
        "720p":  { "file": "...", "size": <bytes>, "mimeType": "video/mp4",
                   "storageLocation": { "offChain": { "url": "", "provider": "pending" } } },
        "1080p": { "file": "...", "size": <bytes>, "mimeType": "video/mp4",
                   "storageLocation": { "offChain": { "url": "", "provider": "pending" } } }
      }
    }

In Phase 1 only 480p is marked `onChain` — the uploader will skip 720p and
1080p because they're off-chain with empty URLs. When Phase 2 picks a
provider, you edit the manifest to populate the URLs and re-run upload-video.mjs.

USAGE:
    python3 optimize_videos.py <source-video>
    python3 optimize_videos.py <source-video> --out-dir /some/dir
    python3 optimize_videos.py <source-video> --force       # re-encode even if outputs exist
    python3 optimize_videos.py <source-video> --dry-run     # print commands, don't run
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ── Encoding presets ──────────────────────────────────────────────────────
# (resolution_label, scale_filter, crf, level)
# CRF values per revised PLAN_video_phase1_implementation.md W3.1. Preset
# `medium` balances encode speed and compression.
RENDITIONS = [
    ("480p",  "scale=854:-2",  25, "4.0"),
    ("720p",  "scale=1280:-2", 23, "4.0"),
    ("1080p", "scale=1920:-2", 21, "4.0"),
]

# Phase 1 storage split: only 480p is on-chain; 720p/1080p stay off-chain with
# empty URLs until Phase 2 wires up a provider. upload-video.mjs treats
# offChain-with-empty-url as "skip".
ONCHAIN_RESOLUTIONS = {"480p"}


def run(cmd, dry_run=False, check=True, capture=False):
    """Run a shell command. Prints the command first for copy-paste / grep."""
    print("  $", " ".join(str(c) for c in cmd))
    if dry_run:
        return ""
    if capture:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if check and result.returncode != 0:
            print(f"    FAILED (exit {result.returncode})")
            if result.stderr:
                print("    stderr:", result.stderr[-500:])
            sys.exit(1)
        return result.stdout.strip()
    # Stream ffmpeg output so encode progress is visible.
    result = subprocess.run(cmd)
    if check and result.returncode != 0:
        print(f"    FAILED (exit {result.returncode})")
        sys.exit(1)
    return ""


def ffprobe_duration(source: Path) -> int:
    """Get duration in seconds (rounded to int) via ffprobe."""
    out = run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(source),
        ],
        capture=True,
    )
    try:
        return max(1, round(float(out)))
    except (ValueError, TypeError):
        print(f"  WARN: could not parse duration from ffprobe, defaulting to 0")
        return 0


def verify_faststart(path: Path) -> bool:
    """
    Verify the MP4 has its `moov` atom BEFORE the `mdat` atom — the condition
    `+faststart` enforces. Without this, progressive playback on mobile stalls
    on the first seek because the player can't decode until it has read the
    moov atom from the tail of the file.

    We walk the MP4 atom tree from the start. Each atom is:
        uint32 size (big-endian) | 4 bytes type | payload
    If size == 1, the real size is a uint64 after the type (`largesize`).
    If size == 0, the atom runs to EOF.

    Return True if `moov` is encountered before `mdat`.
    """
    try:
        with path.open("rb") as f:
            offset = 0
            filesize = path.stat().st_size
            while offset < filesize:
                f.seek(offset)
                header = f.read(8)
                if len(header) < 8:
                    return False
                size = int.from_bytes(header[:4], "big")
                atom_type = header[4:8].decode("ascii", errors="replace")
                if size == 1:
                    ext = f.read(8)
                    if len(ext) < 8:
                        return False
                    size = int.from_bytes(ext, "big")
                elif size == 0:
                    size = filesize - offset  # runs to EOF
                if size < 8:
                    return False  # malformed
                if atom_type == "moov":
                    return True
                if atom_type == "mdat":
                    return False  # mdat before moov = NOT faststart
                offset += size
    except Exception as e:
        print(f"  WARN: faststart check failed for {path.name}: {e}")
        return False
    return False


def encode_rendition(
    source: Path,
    out_path: Path,
    scale_filter: str,
    crf: int,
    level: str,
    force: bool,
    dry_run: bool,
) -> None:
    if out_path.exists() and not force and not dry_run:
        print(f"  skip (exists): {out_path.name} — pass --force to re-encode")
        return
    # Delete stale output first so a failed encode doesn't leave a broken file
    if out_path.exists() and not dry_run:
        out_path.unlink()
    cmd = [
        "ffmpeg", "-y",
        "-i", str(source),
        "-vf", scale_filter,
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level:v", level,
        "-preset", "medium",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",        # iOS Safari compatibility
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",    # moov atom at front — mandatory
        str(out_path),
    ]
    t0 = time.monotonic()
    run(cmd, dry_run=dry_run)
    if not dry_run:
        elapsed = time.monotonic() - t0
        size_mb = out_path.stat().st_size / 1_000_000
        print(f"  done in {elapsed:.1f}s, {size_mb:.1f} MB")


def generate_thumbnail(source: Path, out_path: Path, force: bool, dry_run: bool) -> None:
    if out_path.exists() and not force and not dry_run:
        print(f"  skip (exists): {out_path.name}")
        return
    if out_path.exists() and not dry_run:
        out_path.unlink()
    cmd = [
        "ffmpeg", "-y",
        "-ss", "2",
        "-i", str(source),
        "-vframes", "1",
        "-vf", "scale=640:-2",
        "-q:v", "3",
        str(out_path),
    ]
    run(cmd, dry_run=dry_run)


def build_manifest(basename: str, out_dir: Path, duration_sec: int) -> dict:
    """
    Assemble the manifest JSON from actual encoded file sizes. Called AFTER
    encoding so every `size` field reflects reality, not an estimate.
    """
    variants = {}
    for label, _, _, _ in RENDITIONS:
        path = out_dir / f"{basename}-{label}.mp4"
        if not path.exists():
            print(f"  WARN: {path.name} missing from output — excluded from manifest")
            continue
        if label in ONCHAIN_RESOLUTIONS:
            storage_location = {"onChain": True}
        else:
            storage_location = {"offChain": {"url": "", "provider": "pending"}}
        variants[label] = {
            "file": path.name,
            "size": path.stat().st_size,
            "mimeType": "video/mp4",
            "storageLocation": storage_location,
        }
    return {
        "durationSec": duration_sec,
        "variants": variants,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Encode a source video into 480p/720p/1080p H.264 renditions for Cloud Records.",
    )
    parser.add_argument("source", type=Path, help="Source video file (MP4/MOV/any codec ffmpeg can decode)")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Output directory (default: optimized/videos/<source-basename>/)",
    )
    parser.add_argument("--force", action="store_true", help="Re-encode even if outputs already exist")
    parser.add_argument("--dry-run", action="store_true", help="Print commands without executing")
    args = parser.parse_args()

    source: Path = args.source.resolve()
    if not source.exists():
        print(f"ERROR: source file not found: {source}")
        sys.exit(1)

    basename = source.stem
    if args.out_dir is not None:
        out_dir: Path = args.out_dir.resolve()
    else:
        out_dir = Path.cwd() / "optimized" / "videos" / basename
    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print(f"  Source:     {source}")
    print(f"  Output dir: {out_dir}")
    print(f"  Basename:   {basename}")
    print("=" * 60)

    # 1. Probe source duration
    print("\n[1/5] ffprobe duration")
    duration_sec = ffprobe_duration(source) if not args.dry_run else 0
    print(f"  duration: {duration_sec}s")

    # 2. Encode three renditions sequentially
    for i, (label, scale_filter, crf, level) in enumerate(RENDITIONS, start=2):
        print(f"\n[{i}/5] encode {label} (CRF {crf}, {scale_filter})")
        out_path = out_dir / f"{basename}-{label}.mp4"
        encode_rendition(
            source=source,
            out_path=out_path,
            scale_filter=scale_filter,
            crf=crf,
            level=level,
            force=args.force,
            dry_run=args.dry_run,
        )
        if not args.dry_run:
            if verify_faststart(out_path):
                print(f"  faststart: OK (moov before mdat)")
            else:
                print(f"  faststart: FAIL — moov atom is NOT before mdat. ABORT.")
                sys.exit(2)

    # 3. Generate thumbnail
    print("\n[5/5] thumbnail + manifest")
    thumb_path = out_dir / f"{basename}-thumb.jpg"
    generate_thumbnail(source=source, out_path=thumb_path, force=args.force, dry_run=args.dry_run)

    # 4. Write manifest from actual file sizes
    if args.dry_run:
        print("  (dry run — manifest skipped)")
        return

    manifest = build_manifest(basename=basename, out_dir=out_dir, duration_sec=duration_sec)
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"  wrote {manifest_path}")

    # 5. Summary
    print("\n" + "=" * 60)
    print("  Encoding complete.")
    print("=" * 60)
    for label in ("480p", "720p", "1080p"):
        if label not in manifest["variants"]:
            continue
        entry = manifest["variants"][label]
        size_mb = entry["size"] / 1_000_000
        loc = "onChain" if "onChain" in entry["storageLocation"] else "offChain (skipped in Phase 1)"
        print(f"  {label}: {size_mb:6.1f} MB  {loc}")
    print(f"  thumb: {thumb_path.name}")
    print()
    print("  Next step — upload to staging (dwebo-...) or production (kfhms-...):")
    print(f"  node upload-video.mjs {manifest_path.relative_to(Path.cwd()) if manifest_path.is_relative_to(Path.cwd()) else manifest_path} \\")
    print(f"      --track <trackId> --target <canister-id>")
    print()


if __name__ == "__main__":
    main()
