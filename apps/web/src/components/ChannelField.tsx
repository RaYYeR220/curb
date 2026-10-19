import { useEffect, useRef, type RefObject } from "react";

const INK = "#0e0d0c";
const WALL = "#e2621b";
const LABEL = "#8b8985";

interface Particle {
  x: number;
  /** Offset from the channel's centre line. */
  o: number;
  vx: number;
  vo: number;
  s: number;
  a: number;
  /** Heat from a burst: pushed particles brighten and speed up, then cool. */
  hot: number;
  /** How recently it hit a wall. */
  wall: number;
}

/**
 * The landing's one object: a field of trades flowing through a band they cannot leave. Every few
 * seconds one actor pushes a burst at the upper limit, and it piles up against the wall instead of
 * crossing. The pointer can push particles too, with the same result.
 */
export function ChannelField({ host, clearOf }: { host: RefObject<HTMLElement | null>; clearOf: RefObject<HTMLElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const hero = host.current;
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!hero || !cv || !ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let W = 0;
    let H = 0;
    let parts: Particle[] = [];
    let ambient: { x: number; y: number; v: number; a: number }[] = [];
    let clear = { x: 0, y: 0, rx: 1, ry: 1 };
    let t = 0;
    let nextBurst = 140;
    let impact: { x: number; t: number } | null = null;
    const ptr = { x: -9999, y: -9999, on: false };

    const amp = () => Math.min(1, W / 1100);
    const center = (x: number, tt: number) =>
      H * 0.55 +
      amp() *
        (H * 0.06 * Math.sin((x / W) * Math.PI * 1.6 + tt * 0.0042) + H * 0.025 * Math.sin((x / W) * Math.PI * 4.2 - tt * 0.007));
    const half = () => Math.min(H * 0.27, 250);

    const spawn = (x: number): Particle => {
      const w = half();
      const r = Math.random() * 2 - 1;
      // Biased toward the walls, so the edge zones read as the darkest part of the band.
      return {
        x,
        o: Math.sign(r) * Math.pow(Math.abs(r), 0.62) * w * 0.97,
        vx: 0.35 + Math.random() * 0.85,
        vo: 0,
        s: 1.3 + Math.random() * 1.1,
        a: 0.35 + Math.random() * 0.25,
        hot: 0,
        wall: 0,
      };
    };

    const measureClear = () => {
      const col = clearOf.current;
      if (!col) return;
      const r = hero.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      clear = { x: c.left - r.left + c.width / 2, y: c.top - r.top + c.height / 2, rx: c.width * 0.62, ry: c.height * 0.64 };
    };

    const size = () => {
      const r = hero.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width;
      H = r.height;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      measureClear();
      const n = Math.round(Math.min(4400, (W * H) / 290));
      parts = Array.from({ length: n }, () => spawn(Math.random() * W));
      ambient = Array.from({ length: Math.round(n * 0.03) }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        v: 0.05 + Math.random() * 0.12,
        a: 0.04 + Math.random() * 0.05,
      }));
    };

    // Particles thin out behind the copy so it stays readable.
    const mask = (x: number, y: number) => {
      const dx = (x - clear.x) / clear.rx;
      const dy = (y - clear.y) / clear.ry;
      const d = dx * dx + dy * dy;
      return d >= 1 ? 1 : 0.4 + 0.6 * d;
    };

    const step = () => {
      t++;
      const w = half();
      if (--nextBurst <= 0) {
        const x0 = W * (0.08 + Math.random() * 0.22);
        for (const p of parts) {
          if (p.x > x0 && p.x < x0 + W * 0.16 && Math.random() < 0.75) {
            p.vo -= 2.4 + Math.random() * 2.2;
            p.vx += 1.2;
            p.hot = 1;
          }
        }
        impact = { x: x0 + W * 0.12, t: 0 };
        nextBurst = 380 + Math.random() * 160;
      }
      for (const p of parts) {
        p.vo += (Math.random() - 0.5) * 0.05;
        p.vo *= 0.965;
        if (ptr.on) {
          const y = center(p.x, t) + p.o;
          const dx = p.x - ptr.x;
          const dy = y - ptr.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 130 * 130) {
            const d = Math.sqrt(d2) || 1;
            p.vo += (dy / d) * 1.1 * (1 - d / 130);
            p.vx += (dx / d) * 0.25 * (1 - d / 130);
          }
        }
        const edge = Math.abs(p.o) > w * 0.86;
        p.x += (p.vx + (p.hot ? 0.6 : 0)) * (edge ? 0.55 : 1);
        p.o += p.vo;
        // The wall: a particle that reaches it stays inside, as a refused swap leaves the price.
        if (p.o > w) {
          p.o = w - Math.random() * 1.5;
          p.vo *= -0.2;
          p.wall = 1;
        }
        if (p.o < -w) {
          p.o = -w + Math.random() * 1.5;
          p.vo *= -0.2;
          p.wall = 1;
        }
        if (p.o > -w * 0.93 && p.o < -w * 0.8 && p.hot > 0.2) p.vo -= 0.05;
        p.vx += (0.35 + p.s * 0.4 - p.vx) * 0.02;
        p.hot *= 0.996;
        p.wall *= p.o < 0 ? 0.993 : 0.985;
        if (p.x > W + 6) Object.assign(p, spawn(-6));
      }
      for (const a of ambient) {
        a.x += a.v;
        if (a.x > W + 4) a.x = -4;
      }
      if (impact && ++impact.t > 220) impact = null;
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const w = half();
      ctx.fillStyle = INK;
      for (const a of ambient) {
        ctx.globalAlpha = a.a * mask(a.x, a.y);
        ctx.fillRect(a.x, a.y, 1.2, 1.2);
      }
      for (const side of [-1, 1]) {
        ctx.beginPath();
        for (let x = 0; x <= W + 8; x += 8) {
          const y = center(x, t) + side * w;
          if (x) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.globalAlpha = 0.42;
        ctx.strokeStyle = WALL;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        for (let x = 0; x <= W + 8; x += 8) {
          const y = center(x, t) + side * w * 0.86;
          if (x) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.globalAlpha = 0.09;
        ctx.strokeStyle = INK;
        ctx.setLineDash([2, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (impact) {
        const k = 1 - impact.t / 220;
        ctx.beginPath();
        for (let x = impact.x - 140; x <= impact.x + 140; x += 4) {
          const y = center(x, t) - w;
          if (x === impact.x - 140) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.globalAlpha = 0.85 * k;
        ctx.strokeStyle = WALL;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      // The band's tonal mass: a light body, darker edge zones, a crust under the upper limit.
      const strip = (a: number, b: number, alpha: number) => {
        ctx.beginPath();
        for (let x = 0; x <= W + 8; x += 8) {
          const y = center(x, t) + a;
          if (x) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        for (let x = Math.ceil((W + 8) / 8) * 8; x >= 0; x -= 8) ctx.lineTo(x, center(x, t) + b);
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = INK;
        ctx.fill();
      };
      strip(-w, w, 0.12);
      for (const [k, al] of [
        [0.7, 0.025],
        [0.8, 0.03],
        [0.88, 0.035],
        [0.94, 0.04],
      ] as const) {
        strip(-w, -w * k, al);
        strip(w * k, w, al * 0.85);
      }
      strip(-w, -w + 10, 0.09);
      strip(-w, -w + 4, 0.08);
      ctx.beginPath();
      for (let x = 0; x <= W; x += 14) {
        ctx.moveTo(x, center(x, t));
        ctx.lineTo(x + 5, center(x + 5, t));
      }
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.fillStyle = INK;
      for (const p of parts) {
        const y = center(p.x, t) + p.o;
        ctx.globalAlpha = Math.min(0.95, (p.a + p.wall * 0.35 + p.hot * 0.35) * mask(p.x, y));
        const s = p.s + p.hot * 0.5;
        const len = 1 + (p.vx + p.hot * 0.6) * 3.4;
        ctx.fillRect(p.x, y, s, s);
        ctx.globalAlpha *= 0.5;
        ctx.fillRect(p.x - len, y + s * 0.3, len, 0.9);
      }
      // A soft paper halo keeps the copy readable over the band.
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.translate(clear.x, clear.y);
      ctx.scale(clear.rx, clear.ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, "rgba(241,240,238,.62)");
      g.addColorStop(0.55, "rgba(241,240,238,.4)");
      g.addColorStop(1, "rgba(241,240,238,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (W > 700) {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = LABEL;
        ctx.font = '10.5px "DM Mono", monospace';
        const lx = W - 168;
        ctx.fillText("upper limit  +10.5%", lx, center(lx, t) - w - 8);
        ctx.fillText("lower limit  −10.5%", lx, center(lx, t) + w + 16);
      }
      ctx.globalAlpha = 1;
    };

    let raf = 0;
    let visible = true;
    const loop = () => {
      step();
      draw();
      raf = requestAnimationFrame(loop);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (!reduce && visible && !document.hidden) raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      const r = hero.getBoundingClientRect();
      ptr.x = e.clientX - r.left;
      ptr.y = e.clientY - r.top;
      ptr.on = true;
    };
    const onLeave = () => {
      ptr.on = false;
    };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        size();
        for (let i = 0; i < 260; i++) step();
        draw();
      }, 120);
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      run();
    });

    size();
    for (let i = 0; i < 260; i++) step();
    draw();
    hero.addEventListener("pointermove", onMove);
    hero.addEventListener("pointerleave", onLeave);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", run);
    io.observe(hero);
    void document.fonts?.ready.then(() => {
      measureClear();
      if (reduce) draw();
    });
    run();

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      io.disconnect();
      hero.removeEventListener("pointermove", onMove);
      hero.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", run);
    };
  }, [host, clearOf]);

  return <canvas ref={canvas} className="hero__field" aria-hidden="true" />;
}
