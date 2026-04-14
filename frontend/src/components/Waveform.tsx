import { useRef, useEffect, useState, useCallback } from "react";

interface Props {
  audioUrl   : string | null;  // blob URL of the current track
  progress   : number;         // 0–1
  onSeek     : (fraction: number) => void;
  isPlaying  : boolean;
}

const BAR_COUNT = 80;
const BAR_GAP = 2;

export default function Waveform({ audioUrl, progress, onSeek, isPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const barsRef = useRef<number[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const [ready, setReady] = useState(false);

  // Decode audio and extract waveform peaks
  useEffect(() => {
    barsRef.current = [];
    setReady(false);
    if (!audioUrl) return;

    let cancelled = false;

    (async () => {
      try {
        const resp = await fetch(audioUrl);
        const buf = await resp.arrayBuffer();
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        ctxRef.current = ctx;
        const decoded = await ctx.decodeAudioData(buf);
        const raw = decoded.getChannelData(0);

        // Downsample to BAR_COUNT peaks
        const samplesPerBar = Math.floor(raw.length / BAR_COUNT);
        const peaks: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          let max = 0;
          const start = i * samplesPerBar;
          for (let j = start; j < start + samplesPerBar && j < raw.length; j++) {
            const abs = Math.abs(raw[j]);
            if (abs > max) max = abs;
          }
          peaks.push(max);
        }

        // Normalize
        const maxPeak = Math.max(...peaks, 0.01);
        const normalized = peaks.map(p => p / maxPeak);

        if (!cancelled) {
          barsRef.current = normalized;
          setReady(true);
        }
        ctx.close();
        ctxRef.current = null;
      } catch {
        // Decoding failed — show flat bars
        if (!cancelled) {
          barsRef.current = Array(BAR_COUNT).fill(0.15);
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (ctxRef.current) {
        ctxRef.current.close();
        ctxRef.current = null;
      }
    };
  }, [audioUrl]);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;

    const drawCtx = canvas.getContext("2d");
    if (!drawCtx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    drawCtx.scale(dpr, dpr);
    const bars = barsRef.current;
    const barWidth = (w - (BAR_COUNT - 1) * BAR_GAP) / BAR_COUNT;
    const playedBars = Math.floor(progress * BAR_COUNT);

    // Read colors from CSS variables
    const style = getComputedStyle(canvas);
    const accentColor = style.getPropertyValue('--accent').trim() || '#f59c26';
    const mutedColor = style.getPropertyValue('--text-3').trim() || '#888';

    drawCtx.clearRect(0, 0, w, h);

    for (let i = 0; i < bars.length; i++) {
      const x = i * (barWidth + BAR_GAP);
      const barH = Math.max(2, bars[i] * (h * 0.85));
      const y = (h - barH) / 2;

      if (i <= playedBars) {
        drawCtx.fillStyle = accentColor;
        drawCtx.globalAlpha = 0.9;
      } else {
        drawCtx.fillStyle = mutedColor;
        drawCtx.globalAlpha = 0.25;
      }

      const radius = Math.max(0, Math.min(barWidth / 2, 2));
      drawCtx.beginPath();
      drawCtx.roundRect(x, y, barWidth, barH, radius);
      drawCtx.fill();
    }
    drawCtx.globalAlpha = 1;
  }, [progress, ready]);

  // Click-to-seek
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(1, fraction)));
  }, [onSeek]);

  if (!audioUrl) return null;

  return (
    <canvas
      ref={canvasRef}
      className={`waveform-canvas${isPlaying ? " playing" : ""}`}
      onClick={handleClick}
      style={{ width: "100%", height: 48, cursor: "pointer", display: "block" }}
      role="img"
      aria-label="Audio waveform visualization"
    />
  );
}
