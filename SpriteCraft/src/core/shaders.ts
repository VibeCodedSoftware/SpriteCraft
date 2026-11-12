// Phase 5: the shader library. Each shader is an ordinary registered effect: it can be applied once from the Effects
// menu, or stacked live on a layer (Shaders panel), where it is animated by `ctx.t` (0..1 over the animation) and its
// number settings can be keyed. Everything works in whole pixels, and shaders that add colour do it in steps.
import { A, B, G, R, fromHex, hsvToRgb, nearestIndex, rgba, rgbToHsv } from './color';
import { registerEffect, type Effect, type EffectContext } from './effects';
import { ditherThreshold } from './raster';

// ---- helpers

const TAU = Math.PI * 2;
/** A repeatable 0..1 value for integer coordinates. */
export function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise, 0..1. */
export function noise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash3(xi, yi, seed), b = hash3(xi + 1, yi, seed), c = hash3(xi, yi + 1, seed), d = hash3(xi + 1, yi + 1, seed);
  const u = s(xf), v = s(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const col = (s: string, fallback = 0xffffffff) => fromHex(s) ?? fallback;
const mix = (a: number, b: number, k: number) => rgba(
  Math.round(R(a) + (R(b) - R(a)) * k), Math.round(G(a) + (G(b) - G(a)) * k), Math.round(B(a) + (B(b) - B(a)) * k), A(a));
/** Moves every pixel by a per-pixel offset, taking the nearest source pixel (no blending). */
function displace(src: Uint32Array, w: number, h: number, off: (x: number, y: number) => [number, number], wrap = false): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [dx, dy] = off(x, y);
    let sx = Math.round(x - dx), sy = Math.round(y - dy);
    if (wrap) { sx = ((sx % w) + w) % w; sy = ((sy % h) + h) % h; }
    else if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    out[y * w + x] = src[sy * w + sx];
  }
  return out;
}
const loop = (ctx: EffectContext) => ctx.t ?? 0;
const frameOf = (ctx: EffectContext) => ctx.frame ?? 0;

// ---- distortion

registerEffect({
  id: 'heat-haze', name: 'Heat haze',
  params: [
    { key: 'amp', label: 'Shimmer (px)', type: 'number', min: 0, max: 8, step: 0.5, value: 1.5 },
    { key: 'scale', label: 'Ripple size (px)', type: 'number', min: 2, max: 32, value: 6 },
    { key: 'rise', label: 'Rises per loop', type: 'number', min: 0, max: 8, value: 1 },
    { key: 'fade', label: 'Stronger at the top', type: 'bool', value: true },
  ],
  apply(src, w, h, p, ctx) {
    const t = loop(ctx) * p.rise * h;
    return displace(src, w, h, (x, y) => {
      const k = p.fade ? 1 - y / h : 1;
      return [(noise2(x / p.scale, (y + t) / p.scale, 7) - 0.5) * 2 * p.amp * k, 0];
    });
  },
});

registerEffect({
  id: 'wobble', name: 'Wobble',
  params: [
    { key: 'amp', label: 'Amount (px)', type: 'number', min: 0, max: 12, step: 0.5, value: 1 },
    { key: 'length', label: 'Wavelength (px)', type: 'number', min: 2, max: 64, value: 12 },
    { key: 'cycles', label: 'Cycles per loop', type: 'number', min: 0, max: 8, value: 1 },
  ],
  apply(src, w, h, p, ctx) {
    const ph = TAU * p.cycles * loop(ctx), k = TAU / p.length;
    return displace(src, w, h, (x, y) => [p.amp * Math.sin(y * k + ph), p.amp * Math.sin(x * k + ph * 1.3)]);
  },
});

registerEffect({
  id: 'noise-displace', name: 'Pixel scatter',
  params: [
    { key: 'amp', label: 'Scatter (px)', type: 'number', min: 0, max: 8, value: 1 },
    { key: 'scale', label: 'Grain (px)', type: 'number', min: 1, max: 16, value: 2 },
    { key: 'animate', label: 'Changes every frame', type: 'bool', value: true },
  ],
  apply(src, w, h, p, ctx) {
    const seed = p.animate ? frameOf(ctx) : 0;
    return displace(src, w, h, (x, y) => [(noise2(x / p.scale, y / p.scale, seed * 2 + 1) - 0.5) * 2 * p.amp, (noise2(x / p.scale, y / p.scale, seed * 2 + 2) - 0.5) * 2 * p.amp]);
  },
});

// ---- colour

registerEffect({
  id: 'hue-cycle', name: 'Hue cycle',
  params: [
    { key: 'turns', label: 'Turns per loop', type: 'number', min: -4, max: 4, value: 1 },
    { key: 'steps', label: 'Steps (0 = smooth)', type: 'number', min: 0, max: 24, value: 6 },
  ],
  apply(src, _w, _h, p, ctx) {
    let shift = 360 * p.turns * loop(ctx);
    if (p.steps > 0) shift = Math.round(shift / (360 / p.steps)) * (360 / p.steps);
    const cache = new Map<number, number>(), out = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (!A(c)) continue;
      let o = cache.get(c);
      if (o === undefined) { const [hh, s, v] = rgbToHsv(R(c), G(c), B(c)); const [r, g, b] = hsvToRgb(hh + shift, s, v); o = rgba(r, g, b, A(c)); cache.set(c, o); }
      out[i] = o;
    }
    return out;
  },
});

registerEffect({
  id: 'palette-cycle', name: 'Palette cycle',
  params: [
    { key: 'from', label: 'First palette colour', type: 'number', min: 0, max: 255, value: 0 },
    { key: 'count', label: 'How many colours', type: 'number', min: 2, max: 64, value: 4 },
    { key: 'steps', label: 'Steps per loop', type: 'number', min: -64, max: 64, value: 4 },
  ],
  apply(src, _w, _h, p, ctx) {
    // The classic trick for water and fire: colours in a run of the palette rotate along it.
    const pal = ctx.palette, n = Math.max(2, Math.min(p.count, pal.length - p.from));
    if (pal.length < 2 || n < 2) return src.slice();
    const run = pal.slice(p.from, p.from + n).map((c) => c & 0xffffff);
    const shift = Math.round(p.steps * loop(ctx));
    const out = src.slice();
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (!A(c)) continue;
      const k = run.indexOf(c & 0xffffff);
      if (k >= 0) out[i] = ((run[(((k + shift) % n) + n) % n]) | (A(c) << 24)) >>> 0;
    }
    return out;
  },
});

registerEffect({
  id: 'gradient-map', name: 'Gradient map',
  params: [
    { key: 'dark', label: 'Darks', type: 'color', value: '#1a1c2c' },
    { key: 'mid', label: 'Mids', type: 'color', value: '#b13e53' },
    { key: 'light', label: 'Lights', type: 'color', value: '#ffcd75' },
    { key: 'steps', label: 'Steps', type: 'number', min: 2, max: 16, value: 5 },
    { key: 'scroll', label: 'Scroll per loop', type: 'number', min: -4, max: 4, step: 0.25, value: 0 },
  ],
  apply(src, _w, _h, p, ctx) {
    const d = col(p.dark), m = col(p.mid), l = col(p.light), out = new Uint32Array(src.length);
    const ramp = Array.from({ length: p.steps }, (_, i) => { const k = i / (p.steps - 1); return k < 0.5 ? mix(d, m, k * 2) : mix(m, l, (k - 0.5) * 2); });
    const off = p.scroll * loop(ctx);
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (!A(c)) continue;
      let v = (0.3 * R(c) + 0.59 * G(c) + 0.11 * B(c)) / 255 + off;
      v = v - Math.floor(v === Math.floor(v) && v > 0 ? v - 1e-9 : v);
      out[i] = ((ramp[Math.min(p.steps - 1, Math.floor(v * p.steps))] & 0xffffff) | (A(c) << 24)) >>> 0;
    }
    return out;
  },
});

registerEffect({
  id: 'anim-gradient', name: 'Moving gradient tint',
  params: [
    { key: 'a', label: 'Colour A', type: 'color', value: '#41a6f6' },
    { key: 'b', label: 'Colour B', type: 'color', value: '#ef7d57' },
    { key: 'strength', label: 'Strength (%)', type: 'number', min: 0, max: 100, value: 35 },
    { key: 'angle', label: 'Angle (°)', type: 'number', min: -180, max: 180, value: 0 },
    { key: 'bands', label: 'Bands', type: 'number', min: 2, max: 16, value: 4 },
  ],
  apply(src, w, h, p, ctx) {
    const ca = col(p.a), cb = col(p.b), a = (p.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), len = Math.abs(w * dx) + Math.abs(h * dy) || 1;
    const out = new Uint32Array(src.length), k = p.strength / 100;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, c = src[i];
      if (!A(c)) continue;
      let u = (x * dx + y * dy) / len + loop(ctx);
      u = u - Math.floor(u);
      const tri = Math.round((u < 0.5 ? u * 2 : 2 - u * 2) * (p.bands - 1)) / (p.bands - 1);
      out[i] = mix(c, mix(ca, cb, tri), k);
    }
    return out;
  },
});

// ---- appear, disappear, glitch

registerEffect({
  id: 'dissolve', name: 'Dissolve',
  params: [
    { key: 'amount', label: 'Gone (%)', type: 'number', min: 0, max: 100, value: 50 },
    { key: 'grain', label: 'Grain (px)', type: 'number', min: 1, max: 8, value: 1 },
    { key: 'edge', label: 'Edge colour', type: 'color', value: '#ffcd75' },
    { key: 'edgeWidth', label: 'Edge width (%)', type: 'number', min: 0, max: 30, value: 8 },
  ],
  apply(src, w, h, p) {
    const out = new Uint32Array(src.length), cut = p.amount / 100, e = p.edgeWidth / 100, edge = col(p.edge);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!A(src[i])) continue;
      const v = (ditherThreshold('bayer8', Math.floor(x / p.grain), Math.floor(y / p.grain)) + noise2(x / 6, y / 6, 3)) / 2;
      if (v < cut) continue;
      out[i] = v < cut + e ? ((edge & 0xffffff) | (A(src[i]) << 24)) >>> 0 : src[i];
    }
    return out;
  },
});

registerEffect({
  id: 'glitch', name: 'Glitch',
  params: [
    { key: 'amount', label: 'Amount (%)', type: 'number', min: 0, max: 100, value: 30 },
    { key: 'shift', label: 'Slice shift (px)', type: 'number', min: 0, max: 32, value: 4 },
    { key: 'split', label: 'Colour split (px)', type: 'number', min: 0, max: 8, value: 1 },
  ],
  apply(src, w, h, p, ctx) {
    const f = frameOf(ctx), out = new Uint32Array(src.length);
    for (let y = 0; y < h; y++) {
      // Horizontal slices jump sideways on some frames.
      const band = Math.floor(y / 3), on = hash3(band, f, 11) < p.amount / 100;
      const off = on ? Math.round((hash3(band, f, 12) - 0.5) * 2 * p.shift) : 0;
      for (let x = 0; x < w; x++) {
        const at = (dx: number) => { const sx = x - off - dx; return sx < 0 || sx >= w ? 0 : src[y * w + sx]; };
        const c = at(0);
        if (!p.split || !on) { out[y * w + x] = c; continue; }
        const r = at(p.split), b = at(-p.split), a = Math.max(A(c), A(r), A(b));
        if (a) out[y * w + x] = rgba(R(r), G(c), B(b), a);
      }
    }
    return out;
  },
});

registerEffect({
  id: 'chromatic', name: 'Colour split',
  params: [
    { key: 'dist', label: 'Distance (px)', type: 'number', min: 0, max: 8, value: 1 },
    { key: 'angle', label: 'Angle (°)', type: 'number', min: -180, max: 180, value: 0 },
    { key: 'pulse', label: 'Pulses per loop', type: 'number', min: 0, max: 8, value: 0 },
  ],
  apply(src, w, h, p, ctx) {
    const d = p.dist * (p.pulse ? 0.5 + 0.5 * Math.sin(TAU * p.pulse * loop(ctx)) : 1), a = (p.angle * Math.PI) / 180;
    const ox = Math.round(Math.cos(a) * d), oy = Math.round(Math.sin(a) * d), out = new Uint32Array(src.length);
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[y * w + x]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = at(x - ox, y - oy), g = at(x, y), b = at(x + ox, y + oy), al = Math.max(A(r), A(g), A(b));
      if (al) out[y * w + x] = rgba(R(r), G(g), B(b), al);
    }
    return out;
  },
});

// ---- light

registerEffect({
  id: 'glow', name: 'Glow',
  params: [
    { key: 'colour', label: 'Glow colour', type: 'color', value: '#ffcd75' },
    { key: 'threshold', label: 'Brighter than (%)', type: 'number', min: 0, max: 100, value: 70 },
    { key: 'radius', label: 'Reach (px)', type: 'number', min: 1, max: 8, value: 2 },
    { key: 'pulse', label: 'Pulses per loop', type: 'number', min: 0, max: 8, value: 0 },
  ],
  apply(src, w, h, p, ctx) {
    // Pixel-art bloom: bright pixels spread rings of the glow colour, fading in steps, behind the art.
    const glow = col(p.colour), rad = Math.max(1, Math.round(p.radius * (p.pulse ? 0.6 + 0.4 * Math.sin(TAU * p.pulse * loop(ctx)) : 1)));
    const lit = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) { const c = src[i]; if (A(c) && Math.max(R(c), G(c), B(c)) / 255 * 100 >= p.threshold) lit[i] = 1; }
    const out = src.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (A(src[i])) continue;
      let best = Infinity;
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h || !lit[sy * w + sx]) continue;
        const dd = Math.max(Math.abs(dx), Math.abs(dy));
        if (dd < best) best = dd;
      }
      if (best <= rad) out[i] = ((glow & 0xffffff) | (Math.round(255 * (1 - (best - 1) / (rad + 1)) * 0.8) << 24)) >>> 0;
    }
    return out;
  },
});

registerEffect({
  id: 'halftone', name: 'Halftone',
  params: [
    { key: 'size', label: 'Dot spacing (px)', type: 'number', min: 2, max: 12, value: 4 },
    { key: 'ink', label: 'Ink colour', type: 'color', value: '#1a1c2c' },
    { key: 'paper', label: 'Keep art under dots', type: 'bool', value: true },
  ],
  apply(src, w, h, p) {
    const ink = col(p.ink), s = Math.max(2, Math.round(p.size)), out = new Uint32Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, c = src[i];
      if (!A(c)) continue;
      // Dot radius grows with darkness of the cell's centre pixel.
      const cx = Math.floor(x / s) * s + s / 2, cy = Math.floor(y / s) * s + s / 2;
      const cc = src[Math.min(h - 1, Math.floor(cy)) * w + Math.min(w - 1, Math.floor(cx))];
      const dark = 1 - (0.3 * R(cc) + 0.59 * G(cc) + 0.11 * B(cc)) / 255;
      const inDot = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= dark * s * 0.7;
      out[i] = inDot ? ((ink & 0xffffff) | (A(c) << 24)) >>> 0 : p.paper ? c : 0;
    }
    return out;
  },
});

// ---- custom formula

type Node = (v: Record<string, number>) => number;

/**
 * Parses a small maths language into a function: numbers, x y t u v r g b a w h frame, + - * / % ^, comparisons,
 * ( ), and sin cos tan abs floor ceil round sqrt min max clamp mix step fract noise. Nothing else can run, so a formula
 * from a file is safe to load.
 */
export function compileFormula(src: string): Node {
  const toks = src.match(/\s*(\d+\.?\d*|\.\d+|[A-Za-z_]\w*|<=|>=|==|!=|[-+*/%^(),<>?:])/g)?.map((t) => t.trim()) ?? [];
  if (toks.join('') !== src.replace(/\s+/g, '')) throw new Error('Unexpected character in the formula');
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const expect = (t: string) => { if (next() !== t) throw new Error(`Expected "${t}"`); };
  const FN: Record<string, (...a: number[]) => number> = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt,
    min: Math.min, max: Math.max, clamp: (x, a, b) => Math.min(b, Math.max(a, x)), mix: (a, b, k) => a + (b - a) * k,
    step: (e, x) => (x < e ? 0 : 1), fract: (x) => x - Math.floor(x), noise: (x, y) => noise2(x, y, 5),
  };
  const CONST: Record<string, number> = { pi: Math.PI, tau: TAU };
  const ternary = (): Node => {
    const c = compare();
    if (peek() !== '?') return c;
    next(); const a = ternary(); expect(':'); const b = ternary();
    return (v) => (c(v) ? a(v) : b(v));
  };
  const compare = (): Node => {
    let l = sum();
    while (['<', '>', '<=', '>=', '==', '!='].includes(peek())) {
      const op = next(), a = l, b = sum();
      l = op === '<' ? (v) => +(a(v) < b(v)) : op === '>' ? (v) => +(a(v) > b(v)) : op === '<=' ? (v) => +(a(v) <= b(v)) : op === '>=' ? (v) => +(a(v) >= b(v)) : op === '==' ? (v) => +(a(v) === b(v)) : (v) => +(a(v) !== b(v));
    }
    return l;
  };
  const sum = (): Node => {
    let l = prod();
    while (peek() === '+' || peek() === '-') { const op = next(), a = l, b = prod(); l = op === '+' ? (v) => a(v) + b(v) : (v) => a(v) - b(v); }
    return l;
  };
  const prod = (): Node => {
    let l = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next(), a = l, b = power();
      l = op === '*' ? (v) => a(v) * b(v) : op === '/' ? (v) => { const d = b(v); return d ? a(v) / d : 0; } : (v) => { const d = b(v); return d ? ((a(v) % d) + d) % d : 0; };
    }
    return l;
  };
  const power = (): Node => {
    const a = unary();
    if (peek() !== '^') return a;
    next(); const b = power();
    return (v) => Math.pow(a(v), b(v));
  };
  const unary = (): Node => {
    if (peek() === '-') { next(); const a = unary(); return (v) => -a(v); }
    if (peek() === '+') { next(); return unary(); }
    return atom();
  };
  const atom = (): Node => {
    const t = next();
    if (t === undefined) throw new Error('The formula ends too soon');
    if (t === '(') { const e = ternary(); expect(')'); return e; }
    if (/^[\d.]/.test(t)) { const n = parseFloat(t); return () => n; }
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        // Own names only: `in` and plain lookups would also find built-ins such as "constructor".
        const f = Object.hasOwn(FN, t) ? FN[t] : undefined;
        if (!f) throw new Error(`Unknown function "${t}"`);
        next();
        const args: Node[] = [];
        if (peek() !== ')') { args.push(ternary()); while (peek() === ',') { next(); args.push(ternary()); } }
        expect(')');
        return (v) => f(...args.map((a) => a(v)));
      }
      if (Object.hasOwn(CONST, t)) { const c = CONST[t]; return () => c; }
      if (!['x', 'y', 't', 'u', 'v', 'r', 'g', 'b', 'a', 'w', 'h', 'frame'].includes(t)) throw new Error(`Unknown name "${t}"`);
      return (v) => v[t];
    }
    throw new Error(`Unexpected "${t}"`);
  };
  const root = ternary();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i]}"`);
  return root;
}

registerEffect({
  id: 'formula', name: 'Custom formula',
  params: [
    { key: 'dx', label: 'Move X by', type: 'text', value: '0' },
    { key: 'dy', label: 'Move Y by', type: 'text', value: 'round(sin(x / 4 + t * tau) * 1)' },
    { key: 'r', label: 'Red', type: 'text', value: 'r' },
    { key: 'g', label: 'Green', type: 'text', value: 'g' },
    { key: 'b', label: 'Blue', type: 'text', value: 'b' },
    { key: 'a', label: 'Alpha', type: 'text', value: 'a' },
  ],
  apply(src, w, h, p, ctx) {
    // Formulas see x, y (pixels), u, v (0..1), t (0..1 over the loop), frame, w, h, and the pixel's r g b a (0..255).
    let f: Record<string, Node>;
    try { f = Object.fromEntries(['dx', 'dy', 'r', 'g', 'b', 'a'].map((k) => [k, compileFormula(String(p[k] ?? '0'))])); }
    catch { return src.slice(); }
    const out = new Uint32Array(src.length), vars: Record<string, number> = { t: loop(ctx), frame: frameOf(ctx), w, h };
    const clamp8 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      vars.x = x; vars.y = y; vars.u = x / w; vars.v = y / h;
      const dx = Math.round(f.dx(vars)) || 0, dy = Math.round(f.dy(vars)) || 0;
      const sx = x - dx, sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const c = src[sy * w + sx];
      if (!A(c)) continue;
      vars.r = R(c); vars.g = G(c); vars.b = B(c); vars.a = A(c);
      const a = clamp8(f.a(vars));
      if (a) out[y * w + x] = rgba(clamp8(f.r(vars)), clamp8(f.g(vars)), clamp8(f.b(vars)), a);
    }
    return out;
  },
});

// ---- water

/** Points (canvas pixels) where the water is touched by something on this frame: runs of solid pixels in the
 *  "above" image that overlap the water's top rows. */
export function contacts(water: Uint32Array, above: Uint32Array, w: number, h: number, band = 3): [number, number][] {
  const top = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (A(water[y * w + x])) { top[x] = y; break; }
  const pts: [number, number][] = [];
  let runStart = -1, runY = 0;
  for (let x = 0; x <= w; x++) {
    let hit = false, hy = 0;
    if (x < w && top[x] >= 0) for (let y = top[x]; y < Math.min(h, top[x] + band); y++) if (A(above[y * w + x])) { hit = true; hy = top[x]; break; }
    if (hit && runStart < 0) { runStart = x; runY = hy; }
    if (!hit && runStart >= 0) { pts.push([(runStart + x - 1) / 2, runY]); runStart = -1; }
  }
  return pts;
}

const water: Effect = {
  id: 'water', name: 'Water', liveOnly: true,
  params: [
    { key: 'shallow', label: 'Shallow colour', type: 'color', value: '#41a6f6' },
    { key: 'deep', label: 'Deep colour', type: 'color', value: '#29366f' },
    { key: 'foam', label: 'Foam colour', type: 'color', value: '#f4f4f4' },
    { key: 'shine', label: 'Highlight colour', type: 'color', value: '#a7f0ff' },
    { key: 'clarity', label: 'See-through (%)', type: 'number', min: 0, max: 100, value: 35 },
    { key: 'depth', label: 'Depth to darkest (px)', type: 'number', min: 1, max: 64, value: 12 },
    { key: 'reflect', label: 'Reflection (%)', type: 'number', min: 0, max: 100, value: 55 },
    { key: 'amp', label: 'Wave size (px)', type: 'number', min: 0, max: 6, step: 0.5, value: 1 },
    { key: 'length', label: 'Wavelength (px)', type: 'number', min: 2, max: 48, value: 8 },
    { key: 'speed', label: 'Waves per loop', type: 'number', min: -8, max: 8, value: 1 },
    { key: 'direction', label: 'Wave direction', type: 'choice', options: ['Right', 'Left'], value: 'Right' },
    { key: 'foamWidth', label: 'Foam width (px)', type: 'number', min: 0, max: 4, value: 1 },
    { key: 'sparkle', label: 'Sparkles (%)', type: 'number', min: 0, max: 20, value: 3 },
    { key: 'ripples', label: 'Ripples where things touch it', type: 'bool', value: true },
    { key: 'trails', label: 'Trails behind moving things', type: 'bool', value: true },
    { key: 'rippleSize', label: 'Ripple reach (px)', type: 'number', min: 2, max: 32, value: 10 },
    { key: 'points', label: 'Ripple points (x,y; x,y)', type: 'text', value: '' },
    { key: 'steps', label: 'Colour steps', type: 'number', min: 2, max: 8, value: 4 },
  ],
  apply(src, w, h, p, ctx) {
    const out = new Uint32Array(src.length);
    const below = ctx.below ?? new Uint32Array(src.length), above = ctx.above ?? new Uint32Array(src.length);
    const t = loop(ctx), frame = frameOf(ctx), frames = Math.max(1, ctx.frames ?? 1);
    const dir = p.direction === 'Left' ? -1 : 1, k = TAU / p.length, ph = TAU * p.speed * t * dir;
    const shallow = col(p.shallow), deep = col(p.deep), foam = col(p.foam), shine = col(p.shine);
    const q = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * (p.steps - 1)) / (p.steps - 1);
    // The waterline per column: the water's top edge.
    const top = new Int32Array(w).fill(-1);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (A(src[y * w + x])) { top[x] = y; break; }
    const isWater = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && A(src[y * w + x]) > 0;
    const scene = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return 0;
      const a = above[y * w + x];
      return A(a) ? a : below[y * w + x];
    };

    // Ripple sources: points typed in, things touching the water now, and (for trails) where they touched before.
    type Src = { x: number; y: number; age: number };
    const sources: Src[] = [];
    for (const part of String(p.points ?? '').split(';')) {
      const m = part.split(',').map((s) => parseFloat(s));
      if (m.length === 2 && m.every(Number.isFinite)) sources.push({ x: m[0], y: m[1], age: (t * frames * 1.5) % (p.rippleSize / 1.5) });
    }
    if (p.ripples) {
      // Something standing in the water keeps sending rings out: two at a time, growing over the loop.
      const span = p.rippleSize / 1.5;
      for (const [cx, cy] of contacts(src, above, w, h)) {
        for (const k of [0, 0.5]) sources.push({ x: cx, y: cy + 1, age: ((t + k) % 1) * span });
      }
      // Trails: where it touched the water on earlier frames, rings that have had longer to spread.
      const look = p.trails && ctx.aboveAt ? Math.min(frames - 1, 6) : 0;
      for (let back = 2; back <= look; back += 2) {
        for (const [cx, cy] of contacts(src, ctx.aboveAt!(frame - back), w, h)) sources.push({ x: cx, y: cy + 1, age: back * 1.5 });
      }
    }

    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!A(src[i])) continue;
      const depth = y - top[x];
      // Waves move pixels sideways a whole pixel at a time; deeper water moves a little less.
      const wave = Math.round(p.amp * Math.sin(y * k * 1.7 + x * k * 0.35 - ph) * (depth < 2 ? 1 : 0.7));
      // Under the surface: what is behind the water, bent by the waves.
      const under = scene(x + wave, y);
      let c = mix(shallow, deep, q(depth / p.depth));
      if (A(under)) c = mix(c, under, q(p.clarity / 100) * 0.9);
      // Reflection: the scene mirrored across this column's waterline, wobbling with the waves.
      const ry = 2 * top[x] - y - 1, rx = x + Math.round(p.amp * Math.sin(y * k - ph));
      const refl = scene(rx, ry);
      if (A(refl) && !isWater(rx, ry)) c = mix(c, refl, q((p.reflect / 100) * (1 - Math.min(1, depth / (p.depth * 1.5)))));
      // Foam along the waterline and where something stands in the water.
      let isFoam = false;
      if (p.foamWidth > 0) {
        if (depth < p.foamWidth && noise2(x / 2 + t * 4 * dir, y, 9) > 0.35) isFoam = true;
        for (let d = 1; d <= p.foamWidth && !isFoam; d++) {
          for (const [ox, oy] of [[d, 0], [-d, 0], [0, -d]]) {
            const nx = x + ox, ny = y + oy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && A(above[ny * w + nx]) && depth < 4 && hash3(x, y, frame) > 0.3) isFoam = true;
          }
        }
      }
      // Ripple rings: ellipses (flattened by perspective) spreading from each source.
      let ring = 0;
      for (const s of sources) {
        const r = s.age * 1.5 + 1;
        if (r > p.rippleSize) continue;
        const d = Math.hypot(x + 0.5 - s.x, (y + 0.5 - s.y) * 2.2);
        if (Math.abs(d - r) < 0.8) ring = Math.max(ring, 1 - r / p.rippleSize);
      }
      // Young rings are solid foam pixels; older ones half fade, then go.
      if (ring > 0.55) c = foam;
      else if (ring > 0.15) c = mix(c, foam, 0.5);
      if (isFoam) c = foam;
      // Sparkles: a few highlight pixels near the surface that come and go each frame.
      else if (p.sparkle > 0 && depth < p.depth / 2 && hash3(x, y, frame) < p.sparkle / 100) c = shine;
      out[i] = ((c & 0xffffff) | (A(src[i]) << 24)) >>> 0;
    }
    return out;
  },
};
registerEffect(water);

/** Built-in shader stacks, applied from the Shaders panel. */
export const SHADER_PRESETS: { name: string; fx: { effect: string; params: Record<string, any> }[] }[] = [
  { name: 'Calm water', fx: [{ effect: 'water', params: {} }] },
  { name: 'Stormy sea', fx: [{ effect: 'water', params: { amp: 2, length: 6, speed: 3, foamWidth: 2, sparkle: 1, deep: '#1a1c2c', shallow: '#3b5dc9', reflect: 30 } }] },
  { name: 'Lava', fx: [{ effect: 'water', params: { shallow: '#ffcd75', deep: '#b13e53', foam: '#fff1c1', shine: '#ffffff', clarity: 0, reflect: 10, amp: 1, speed: 1, sparkle: 6 } }, { effect: 'glow', params: { colour: '#ef7d57', threshold: 60, radius: 2 } }] },
  { name: 'Heat shimmer', fx: [{ effect: 'heat-haze', params: {} }] },
  { name: 'Hologram', fx: [{ effect: 'gradient-map', params: { dark: '#0b2a3f', mid: '#41a6f6', light: '#a7f0ff' } }, { effect: 'glitch', params: { amount: 15 } }, { effect: 'chromatic', params: { dist: 1, pulse: 2 } }] },
  { name: 'Dissolve away', fx: [{ effect: 'dissolve', params: {} }] },
  { name: 'Magic glow', fx: [{ effect: 'glow', params: { pulse: 2 } }, { effect: 'hue-cycle', params: { turns: 0, steps: 6 } }] },
];
