"use client";

import { useCallback, useEffect, useRef } from "react";

const SQUARE = 3;
const GAP = 3;
const STEP = SQUARE + GAP;
const TEXT = "24hrs. Vetted. Ready.";
const COLOR = [73, 215, 167] as const;
const MAX_OP = 0.22;
const FLICKER = 0.05;

export function FooterCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    squares: number[];
    cols: number;
    rows: number;
    mask: ImageData | null;
    last: number;
    raf: number;
  }>({ squares: [], cols: 0, rows: 0, mask: null, last: 0, raf: 0 });

  const buildMask = useCallback((canvas: HTMLCanvasElement, dpr: number) => {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const oc = off.getContext("2d");
    if (!oc) return null;
    oc.scale(dpr, dpr);
    oc.fillStyle = "white";
    const fs = Math.min(w * 0.17, 96);
    oc.font = `800 ${fs}px 'Sora', sans-serif`;
    oc.textAlign = "center";
    oc.textBaseline = "middle";
    oc.fillText(TEXT, w / 2, h / 2);
    return oc.getImageData(0, 0, canvas.width, canvas.height);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const state = stateRef.current;

    function resize() {
      if (!canvas || !wrap) return;
      canvas.width = wrap.offsetWidth * dpr;
      canvas.height = wrap.offsetHeight * dpr;
      canvas.style.width = `${wrap.offsetWidth}px`;
      canvas.style.height = `${wrap.offsetHeight}px`;
      state.cols = Math.ceil(wrap.offsetWidth / STEP);
      state.rows = Math.ceil(wrap.offsetHeight / STEP);
      state.squares = Array.from({ length: state.cols * state.rows }, () => Math.random() * MAX_OP);
      state.mask = null;
    }

    function draw() {
      if (!canvas || !ctx) return;
      if (!state.mask) state.mask = buildMask(canvas, dpr);
      if (!state.mask) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const { cols, rows, squares, mask } = state;
      const sw = SQUARE * dpr;

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = i * STEP * dpr;
          const y = j * STEP * dpr;
          const px = Math.min(Math.floor(x + sw / 2), canvas.width - 1);
          const py = Math.min(Math.floor(y + sw / 2), canvas.height - 1);
          const idx = (py * canvas.width + px) * 4;
          const inText = mask.data[idx] > 10;
          let op = squares[i * rows + j];
          if (inText) op = Math.min(1, op * 5 + 0.55);
          ctx.fillStyle = `rgba(${COLOR[0]},${COLOR[1]},${COLOR[2]},${op})`;
          ctx.fillRect(x, y, sw, sw);
        }
      }
    }

    function animate(ts: number) {
      const dt = Math.min((ts - state.last) / 1000, 0.1);
      state.last = ts;
      for (let i = 0; i < state.squares.length; i++) {
        if (Math.random() < FLICKER * dt * 60) {
          state.squares[i] = Math.random() * MAX_OP;
        }
      }
      draw();
      state.raf = requestAnimationFrame(animate);
    }

    resize();
    window.addEventListener("resize", resize);
    state.raf = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(state.raf);
    };
  }, [buildMask]);

  return (
    <div ref={wrapRef} className="relative mt-2 h-[180px] w-full">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[55%] bg-gradient-to-b from-[#111111] to-transparent" />
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
