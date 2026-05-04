'use client';

import { useEffect, useRef } from 'react';
import type { Candle } from '@/lib/indicators';
import type { IndicatorResult } from '@/lib/indicators';

interface Props {
  candles:    Candle[];
  indicators: IndicatorResult;
  height?:    number;
}

const W_VOL_RATIO = 0.2; // bottom 20% = volume

export default function CandlestickChart({ candles, indicators, height = 420 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || candles.length < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = height;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, W, H);

    const padL = 60, padR = 10, padT = 10, padB = 24;
    const volH  = H * W_VOL_RATIO;
    const priceH = H - volH - padT - padB - 4;

    // Price domain
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const priceMax = Math.max(...highs, ...indicators.bb.map(b => b.upper ?? -Infinity).filter(isFinite));
    const priceMin = Math.min(...lows, ...indicators.bb.map(b => b.lower ?? Infinity).filter(isFinite));
    const priceRange = priceMax - priceMin || 1;
    const py = (v: number) => padT + priceH - ((v - priceMin) / priceRange) * priceH;

    // Volume domain
    const maxVol = Math.max(...candles.map(c => c.volume), 1);
    const vy = (v: number) => H - padB - (v / maxVol) * volH;

    const n = candles.length;
    const slotW = (W - padL - padR) / n;
    const candleW = Math.max(1, slotW * 0.6);
    const cx = (i: number) => padL + (i + 0.5) * slotW;

    // Grid lines
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    const gridLines = 5;
    for (let g = 0; g <= gridLines; g++) {
      const y = padT + (priceH / gridLines) * g;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      const val = priceMax - (priceRange / gridLines) * g;
      ctx.fillStyle = '#4b5563';
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(val.toFixed(val > 100 ? 0 : 2), padL - 4, y + 3);
    }

    // Bollinger Bands
    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const b = indicators.bb[i];
      if (b.upper === null) continue;
      if (!started) { ctx.moveTo(cx(i), py(b.upper)); started = true; }
      else ctx.lineTo(cx(i), py(b.upper));
    }
    for (let i = n - 1; i >= 0; i--) {
      const b = indicators.bb[i];
      if (b.lower === null) continue;
      ctx.lineTo(cx(i), py(b.lower));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(99,102,241,0.08)';
    ctx.fill();
    // BB mid
    ctx.beginPath(); started = false;
    for (let i = 0; i < n; i++) {
      const b = indicators.bb[i];
      if (b.mid === null) continue;
      if (!started) { ctx.moveTo(cx(i), py(b.mid)); started = true; }
      else ctx.lineTo(cx(i), py(b.mid));
    }
    ctx.strokeStyle = 'rgba(99,102,241,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();

    // SMA 20
    ctx.beginPath(); started = false;
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const v = indicators.sma20[i];
      if (v === null) continue;
      if (!started) { ctx.moveTo(cx(i), py(v)); started = true; } else ctx.lineTo(cx(i), py(v));
    }
    ctx.stroke();

    // SMA 50
    ctx.beginPath(); started = false;
    ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const v = indicators.sma50[i];
      if (v === null) continue;
      if (!started) { ctx.moveTo(cx(i), py(v)); started = true; } else ctx.lineTo(cx(i), py(v));
    }
    ctx.stroke();

    // Candles
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const bull = c.close >= c.open;
      const col  = bull ? '#10b981' : '#ef4444';
      const x    = cx(i);
      // Wick
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, py(c.high)); ctx.lineTo(x, py(c.low)); ctx.stroke();
      // Body
      ctx.fillStyle = bull ? '#10b981' : '#ef4444';
      const bodyTop = py(Math.max(c.open, c.close));
      const bodyBot = py(Math.min(c.open, c.close));
      const bodyH   = Math.max(1, bodyBot - bodyTop);
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    }

    // Volume bars
    const volTop = H - padB - volH;
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const bull = c.close >= c.open;
      ctx.fillStyle = bull ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)';
      const barH = (c.volume / maxVol) * volH;
      ctx.fillRect(cx(i) - candleW / 2, volTop + volH - barH, candleW, barH);
    }

    // X-axis date labels (every ~15 candles)
    ctx.fillStyle = '#4b5563'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
    const step = Math.max(1, Math.round(n / 6));
    for (let i = 0; i < n; i += step) {
      const label = candles[i].time.slice(0, 10);
      ctx.fillText(label, cx(i), H - 6);
    }

    // Legend
    const legend = [
      { color: '#f59e0b', label: 'SMA20' },
      { color: '#a78bfa', label: 'SMA50' },
      { color: 'rgba(99,102,241,0.5)', label: 'BB' },
    ];
    legend.forEach((l, idx) => {
      ctx.fillStyle = l.color;
      ctx.fillRect(padL + idx * 70, padT, 12, 3);
      ctx.fillStyle = '#9ca3af'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(l.label, padL + idx * 70 + 15, padT + 4);
    });

  }, [candles, indicators, height]);

  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height }}
      className="rounded-lg bg-gray-900 block"
    />
  );
}
