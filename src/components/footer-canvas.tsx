"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SQUARE = 3;
const GAP = 3;
const STEP = SQUARE + GAP;
const TEXT = "24hrs. Vetted. Ready.";
const COLOR = [73, 215, 167] as const;
const MAX_OP = 0.22;
const FLICKER = 0.05;
const TARGET_FPS = 30;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

// Reference width where the unscaled SQUARE/GAP/font-size look "correct".
// Below this, scaleFactor shrinks both the text and the dot grid so the
// pixelated text string fits cleanly on narrow viewports.
const REFERENCE_WIDTH = 1200;
const MIN_SCALE = 0.35;
const MAX_SCALE = 1.0;

// Pre-build color strings to avoid template literal in hot loop
const COLOR_STRINGS = Array.from({ length: 256 }, (_, i) => {
  const opacity = i / 255;
  return `rgba(${COLOR[0]},${COLOR[1]},${COLOR[2]},${opacity})`;
});

export function FooterCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const stateRef = useRef<{
    squares: number[];
    cols: number;
    rows: number;
    mask: ImageData | null;
    last: number;
    raf: number;
    lastFrameTime: number;
    scale: number;
    square: number;
    step: number;
  }>({
    squares: [],
    cols: 0,
    rows: 0,
    mask: null,
    last: 0,
    raf: 0,
    lastFrameTime: 0,
    scale: 1,
    square: SQUARE,
    step: STEP,
  });

  const buildMask = useCallback(
    (canvas: HTMLCanvasElement, dpr: number, scale: number) => {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const oc = off.getContext("2d");
      if (!oc) return null;
      oc.scale(dpr, dpr);
      oc.fillStyle = "white";
      const fs = Math.min(w * 0.17, 96) * scale;
      oc.font = `800 ${fs}px 'Sora', sans-serif`;
      oc.textAlign = "center";
      oc.textBaseline = "middle";
      oc.fillText(TEXT, w / 2, h / 2);
      return oc.getImageData(0, 0, canvas.width, canvas.height);
    },
    [],
  );

  // Visibility observer to pause animation when off-screen
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { threshold: 0.1 },
    );
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const state = stateRef.current;
    let resizeTimeout: ReturnType<typeof setTimeout>;

    function resize() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!canvas || !wrap) return;
        canvas.width = wrap.offsetWidth * dpr;
        canvas.height = wrap.offsetHeight * dpr;
        canvas.style.width = `${wrap.offsetWidth}px`;
        canvas.style.height = `${wrap.offsetHeight}px`;

        // Compute scaleFactor relative to a 1200px reference width.
        // Clamped to [0.35, 1.0] so very narrow viewports don't render
        // illegibly tiny dots, and very wide viewports stay at the
        // unscaled 6px-grid + 96px-cap font-size.
        const scale = Math.max(
          MIN_SCALE,
          Math.min(MAX_SCALE, wrap.offsetWidth / REFERENCE_WIDTH),
        );
        state.scale = scale;
        state.square = SQUARE * scale;
        state.step = STEP * scale;

        state.cols = Math.ceil(wrap.offsetWidth / state.step);
        state.rows = Math.ceil(wrap.offsetHeight / state.step);
        state.squares = Array.from(
          { length: state.cols * state.rows },
          () => Math.random() * MAX_OP,
        );
        state.mask = null;
      }, 100);
    }

    function draw() {
      if (!canvas || !ctx) return;
      if (!state.mask) state.mask = buildMask(canvas, dpr, state.scale);
      if (!state.mask) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const { cols, rows, squares, mask, square, step } = state;
      const sw = square * dpr;
      const stepDpr = step * dpr;

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = i * stepDpr;
          const y = j * stepDpr;
          const px = Math.min(Math.floor(x + sw / 2), canvas.width - 1);
          const py = Math.min(Math.floor(y + sw / 2), canvas.height - 1);
          const idx = (py * canvas.width + px) * 4;
          const inText = mask.data[idx] > 10;
          let op = squares[i * rows + j];
          if (inText) op = Math.min(1, op * 5 + 0.55);
          // Use pre-built color string instead of template literal
          const colorIdx = Math.min(Math.floor(op * 255), 255);
          ctx.fillStyle = COLOR_STRINGS[colorIdx];
          ctx.fillRect(x, y, sw, sw);
        }
      }
    }

    function animate(ts: number) {
      // Frame rate limiting - cap at 30fps
      const elapsed = ts - state.lastFrameTime;
      if (elapsed < FRAME_INTERVAL) {
        state.raf = requestAnimationFrame(animate);
        return;
      }
      state.lastFrameTime = ts - (elapsed % FRAME_INTERVAL);

      // Pause animation when not visible
      if (!isVisible) {
        state.raf = requestAnimationFrame(animate);
        return;
      }

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
      clearTimeout(resizeTimeout);
      cancelAnimationFrame(state.raf);
    };
  }, [buildMask, isVisible]);

  return (
    <div ref={wrapRef} className="relative mt-2 h-[180px] w-full">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[55%] bg-gradient-to-b from-[#111111] to-transparent" />
      <canvas ref={canvasRef} aria-hidden="true" className="block size-full" />
    </div>
  );
}
