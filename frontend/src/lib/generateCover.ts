/**
 * Auto-generates stylized cover art when none is provided.
 * Returns a JPEG Uint8Array (500x500) based on track name + album.
 */

// Deterministic hash from string → number
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Color palettes — warm, moody, bold (never generic)
const PALETTES = [
  ["#1a0a00", "#f59c26", "#f5c040"],  // brand orange/gold
  ["#0a0a1a", "#6b4fa0", "#c8a0f0"],  // deep purple
  ["#0a1a1a", "#2a8a7a", "#60d0b8"],  // teal
  ["#1a0a0a", "#c04040", "#f08060"],  // warm red
  ["#0a0a0a", "#4080c0", "#80c0f0"],  // steel blue
  ["#1a1a0a", "#a08830", "#e0c860"],  // amber
  ["#0a1a0a", "#408040", "#80c080"],  // forest
  ["#1a0a1a", "#a04080", "#e080b0"],  // rose
];

// Simple geometric patterns
type PatternFn = (ctx: CanvasRenderingContext2D, w: number, accent: string, light: string, seed: number) => void;

const patterns: PatternFn[] = [
  // Concentric circles
  (ctx, w, accent, light, seed) => {
    const cx = w / 2, cy = w / 2;
    for (let r = w * 0.45; r > 20; r -= 25 + (seed % 15)) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = r > w * 0.25 ? accent : light;
      ctx.globalAlpha = 0.15 + (r / w) * 0.15;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  // Radial lines
  (ctx, w, accent, light, seed) => {
    const cx = w / 2, cy = w / 2;
    const count = 12 + (seed % 8);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const len = w * 0.35 + (seed % 50);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
      ctx.strokeStyle = i % 2 === 0 ? accent : light;
      ctx.globalAlpha = 0.1;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  // Diagonal stripes
  (ctx, w, accent, _light, seed) => {
    const gap = 20 + (seed % 20);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.08;
    ctx.lineWidth = 2;
    for (let i = -w; i < w * 2; i += gap) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + w, w);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  // Floating dots
  (ctx, w, accent, light, seed) => {
    let s = seed;
    for (let i = 0; i < 30; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const x = (s % w);
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const y = (s % w);
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const r = 3 + (s % 12);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = i % 3 === 0 ? light : accent;
      ctx.globalAlpha = 0.08 + (s % 10) * 0.01;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
  // Wave lines
  (ctx, w, accent, _light, seed) => {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    const waves = 4 + (seed % 4);
    for (let j = 0; j < waves; j++) {
      ctx.beginPath();
      ctx.globalAlpha = 0.08 + j * 0.03;
      const baseY = w * 0.3 + j * (w * 0.12);
      for (let x = 0; x <= w; x += 2) {
        const y = baseY + Math.sin((x / w) * Math.PI * (3 + (seed % 3)) + j) * (20 + seed % 20);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
];

export function generateCoverArt(trackName: string, album: string): Promise<Uint8Array> {
  const seed = hash(trackName + album);
  const palette = PALETTES[seed % PALETTES.length];
  const [bg, accent, light] = palette;
  const pattern = patterns[seed % patterns.length];

  const SIZE = 500;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Subtle gradient overlay
  const grad = ctx.createRadialGradient(SIZE / 2, SIZE * 0.4, 0, SIZE / 2, SIZE / 2, SIZE * 0.7);
  grad.addColorStop(0, accent + "18");
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Pattern
  pattern(ctx, SIZE, accent, light, seed);

  // Large initial letter
  const initial = trackName.replace(/[^a-zA-Z0-9]/g, "")[0]?.toUpperCase() || "♪";
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.12;
  ctx.font = `bold ${SIZE * 0.6}px Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initial, SIZE / 2, SIZE * 0.42);
  ctx.globalAlpha = 1;

  // Track name
  ctx.fillStyle = light;
  ctx.font = `bold ${SIZE * 0.055}px Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  // Truncate long names
  let displayName = trackName;
  if (displayName.length > 30) displayName = displayName.slice(0, 28) + "…";
  ctx.fillText(displayName, SIZE / 2, SIZE * 0.82);

  // Album name
  if (album) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.6;
    ctx.font = `${SIZE * 0.035}px Georgia, serif`;
    let displayAlbum = album;
    if (displayAlbum.length > 35) displayAlbum = displayAlbum.slice(0, 33) + "…";
    ctx.fillText(displayAlbum, SIZE / 2, SIZE * 0.88);
    ctx.globalAlpha = 1;
  }

  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        blob!.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      },
      "image/jpeg",
      0.85
    );
  });
}
