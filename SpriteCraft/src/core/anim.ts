// Phase 2: keyframes, easing curves and motion tweens. Plain data and pure functions, no DOM.
//
// A Motion moves one layer's artwork over a run of frames. It is non-destructive: the original art is kept in the
// document under its own key (srcKey), keyframes live on frame ids (so they follow frames that are moved), and the
// frames in between are *generated* cels, marked with `gen` = the motion's id. Painting on a generated cel makes a
// normal cel (the surface writes a fresh one), which re-baking then leaves alone. That is the line between generated
// frames and frames the artist owns.
import { A, B, G, R, hsvToRgb, nearestIndex, rgba, rgbToHsv } from './color';
import { trimToCel } from './doc';
import { renderPlaced, upscale8, type Bitmap, type Placement, type RotateQuality } from './transform';
import { celKey, newId, type Cel, type Doc } from './types';

// ---- Easing

export const EASE_PRESETS = [
  'linear', 'hold',
  'in-sine', 'out-sine', 'in-out-sine',
  'in-quad', 'out-quad', 'in-out-quad',
  'in-cubic', 'out-cubic', 'in-out-cubic',
  'in-expo', 'out-expo', 'in-out-expo',
  'in-back', 'out-back', 'in-out-back',
  'out-elastic', 'out-bounce',
] as const;
export type EasePreset = (typeof EASE_PRESETS)[number];

/** How a segment between two keys is timed. `hold` keeps the first value until the next key (a step). */
export type Ease = EasePreset | { bezier: [number, number, number, number] } | { steps: number };

const PI = Math.PI;
const bounceOut = (t: number) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d; return n * t * t + 0.984375;
};
const BACK = 1.70158;

const PRESET_FN: Record<EasePreset, (t: number) => number> = {
  linear: (t) => t,
  hold: (t) => (t >= 1 ? 1 : 0),
  'in-sine': (t) => 1 - Math.cos((t * PI) / 2),
  'out-sine': (t) => Math.sin((t * PI) / 2),
  'in-out-sine': (t) => -(Math.cos(PI * t) - 1) / 2,
  'in-quad': (t) => t * t,
  'out-quad': (t) => 1 - (1 - t) * (1 - t),
  'in-out-quad': (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  'in-cubic': (t) => t * t * t,
  'out-cubic': (t) => 1 - (1 - t) ** 3,
  'in-out-cubic': (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  'in-expo': (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  'out-expo': (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  'in-out-expo': (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  'in-back': (t) => (BACK + 1) * t * t * t - BACK * t * t,
  'out-back': (t) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2,
  'in-out-back': (t) => {
    const c = BACK * 1.525;
    return t < 0.5 ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2 : ((2 * t - 2) ** 2 * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
  },
  'out-elastic': (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * PI) / 3) + 1),
  'out-bounce': bounceOut,
};

/**
 * A cubic bezier timing curve through (0,0), (x1,y1), (x2,y2), (1,1), the same shape CSS uses. x is solved for t with
 * Newton steps and a bisection fallback, so steep handles stay exact.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  x1 = Math.max(0, Math.min(1, x1)); x2 = Math.max(0, Math.min(1, x2));
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-7) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1; t = x;
    for (let i = 0; i < 60; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

export function easeFn(e: Ease): (t: number) => number {
  if (typeof e === 'string') return PRESET_FN[e] ?? PRESET_FN.linear;
  if ('steps' in e) { const n = Math.max(1, Math.round(e.steps)); return (t) => (t >= 1 ? 1 : Math.floor(t * n) / n); }
  return cubicBezier(...e.bezier);
}

export const easeLabel = (e: Ease): string => {
  if (typeof e === 'string') return e === 'linear' ? 'Linear' : e === 'hold' ? 'Hold (step)' : e.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  if ('steps' in e) return `${e.steps} steps`;
  return 'Custom curve';
};

// ---- Keyframes

/** Animatable numbers on a layer. Offsets are in pixels, scale and opacity in percent, rotation and hue in degrees. */
export type Prop = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'opacity' | 'hue' | 'value';
export const PROPS: { key: Prop; label: string; base: number; min: number; max: number; unit: string }[] = [
  { key: 'x', label: 'Move X', base: 0, min: -4096, max: 4096, unit: 'px' },
  { key: 'y', label: 'Move Y', base: 0, min: -4096, max: 4096, unit: 'px' },
  { key: 'rotation', label: 'Rotation', base: 0, min: -3600, max: 3600, unit: '°' },
  { key: 'scaleX', label: 'Scale X', base: 100, min: -1000, max: 1000, unit: '%' },
  { key: 'scaleY', label: 'Scale Y', base: 100, min: -1000, max: 1000, unit: '%' },
  { key: 'opacity', label: 'Opacity', base: 100, min: 0, max: 100, unit: '%' },
  { key: 'hue', label: 'Hue shift', base: 0, min: -360, max: 360, unit: '°' },
  { key: 'value', label: 'Brightness', base: 0, min: -100, max: 100, unit: '%' },
];
export const propBase = (p: Prop) => PROPS.find((d) => d.key === p)!.base;

/** A value at a frame. `ease` times the segment that leaves this key. */
export interface Key { f: string; v: number; ease: Ease }

export interface Motion {
  id: string;
  name: string;
  layerId: string;
  /** Point the art turns and scales around, in canvas pixels. */
  pivot: { x: number; y: number };
  tracks: Partial<Record<Prop, Key[]>>;
  /** Move along a smooth curve through the position keys, instead of straight lines between them. */
  curvedPath: boolean;
  /** 0..100: stretch along the direction of travel by speed, keeping area (bouncing balls, jumps). */
  squash: number;
  /** Round positions to whole pixels, so the art never shimmers between frames. */
  snap: boolean;
  quality: RotateQuality;
  /** While the source art is being edited, the frame id it is laid out on. */
  editing?: string;
}

export const srcKey = (layerId: string, motionId: string) => `${layerId}:src:${motionId}`;
export const isSrcKey = (k: string) => k.includes(':src:');

/** Frame index of each frame id, for ordering keys. */
const indexOf = (doc: Doc) => new Map(doc.frames.map((f, i) => [f.id, i] as const));

/** A track's keys sorted by frame, leaving out keys whose frame has been deleted. */
export function liveKeys(doc: Doc, keys: Key[] | undefined, idx = indexOf(doc)): (Key & { i: number })[] {
  if (!keys) return [];
  return keys.filter((k) => idx.has(k.f)).map((k) => ({ ...k, i: idx.get(k.f)! })).sort((a, b) => a.i - b.i);
}

/** A track's value at a frame index: held before the first key and after the last, eased in between. */
export function sampleKeys(keys: (Key & { i: number })[], frame: number, base: number): number {
  if (!keys.length) return base;
  if (frame <= keys[0].i) return keys[0].v;
  const last = keys[keys.length - 1];
  if (frame >= last.i) return last.v;
  let a = 0;
  while (keys[a + 1].i <= frame) a++;
  const k0 = keys[a], k1 = keys[a + 1];
  const t = (frame - k0.i) / (k1.i - k0.i);
  return k0.v + (k1.v - k0.v) * easeFn(k0.ease)(t);
}

export type Sample = Record<Prop, number>;

/** Frames the motion covers: from its first key to its last, across every track. */
export function motionRange(doc: Doc, m: Motion): [number, number] | null {
  const idx = indexOf(doc);
  let lo = Infinity, hi = -Infinity;
  for (const keys of Object.values(m.tracks)) for (const k of liveKeys(doc, keys, idx)) { lo = Math.min(lo, k.i); hi = Math.max(hi, k.i); }
  return lo <= hi ? [lo, hi] : null;
}

/** Centripetal-free Catmull-Rom through points, evaluated at u in 0..1 between p1 and p2. */
const catmull = (p0: number, p1: number, p2: number, p3: number, u: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);

/** Every property at a frame index. With a curved path, position follows a spline through the position keys. */
export function sampleMotion(doc: Doc, m: Motion, frame: number): Sample {
  const idx = indexOf(doc);
  const out = {} as Sample;
  for (const p of PROPS) out[p.key] = sampleKeys(liveKeys(doc, m.tracks[p.key], idx), frame, p.base);
  if (m.curvedPath) {
    // The spline needs x and y at the same frames: take every frame that keys either one, sampled from both tracks.
    const xs = liveKeys(doc, m.tracks.x, idx), ys = liveKeys(doc, m.tracks.y, idx);
    const frames = [...new Set([...xs, ...ys].map((k) => k.i))].sort((a, b) => a - b);
    if (frames.length >= 3 && frame > frames[0] && frame < frames[frames.length - 1]) {
      const pts = frames.map((i) => ({ i, x: sampleKeys(xs, i, 0), y: sampleKeys(ys, i, 0) }));
      let a = 0;
      while (pts[a + 1].i <= frame) a++;
      const p0 = pts[Math.max(0, a - 1)], p1 = pts[a], p2 = pts[a + 1], p3 = pts[Math.min(pts.length - 1, a + 2)];
      // Timing still follows the easing of the key that starts the segment (x's key when both exist).
      const k = xs.find((q) => q.i === p1.i) ?? ys.find((q) => q.i === p1.i);
      const u = easeFn(k?.ease ?? 'linear')((frame - p1.i) / (p2.i - p1.i));
      out.x = catmull(p0.x, p1.x, p2.x, p3.x, u);
      out.y = catmull(p0.y, p1.y, p2.y, p3.y, u);
    }
  }
  return out;
}

// ---- Turning a sample into pixels

/** Squash and stretch from the speed of travel between this frame and its neighbours. Returns scale factors along x, y. */
export function squashScale(doc: Doc, m: Motion, frame: number): { sx: number; sy: number; angle: number } {
  if (!m.squash) return { sx: 1, sy: 1, angle: 0 };
  const a = sampleMotion(doc, m, Math.max(0, frame - 1)), b = sampleMotion(doc, m, Math.min(doc.frames.length - 1, frame + 1));
  const vx = (b.x - a.x) / 2, vy = (b.y - a.y) / 2;
  const speed = Math.hypot(vx, vy);
  if (speed < 1e-6) return { sx: 1, sy: 1, angle: 0 };
  // Stretch grows with speed and levels off; area is kept by squashing across the motion.
  const k = 1 + (m.squash / 100) * Math.min(1, speed / 12);
  return { sx: k, sy: 1 / k, angle: Math.atan2(vy, vx) };
}

/** Draws the source art at a frame, returning a canvas-positioned cel (or null when nothing lands). */
export function renderMotionFrame(doc: Doc, m: Motion, frame: number, src: Cel, cache?: { big?: Bitmap }): Cel | null {
  const s = sampleMotion(doc, m, frame);
  const sq = squashScale(doc, m, frame);
  const bmp: Bitmap = { w: src.w, h: src.h, data: src.data };
  let ox = s.x, oy = s.y;
  if (m.snap) { ox = Math.round(ox); oy = Math.round(oy); }
  const angle = (s.rotation * Math.PI) / 180;
  const kx = s.scaleX / 100, ky = s.scaleY / 100;

  // Where the art's centre goes: the offset from the pivot is scaled, turned, then moved.
  const c0x = src.x + src.w / 2 - m.pivot.x, c0y = src.y + src.h / 2 - m.pivot.y;
  const rx = c0x * kx, ry = c0y * ky;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = m.pivot.x + ox + rx * cos - ry * sin, cy = m.pivot.y + oy + rx * sin + ry * cos;

  const W = doc.width, H = doc.height;
  // Rendered into a canvas-sized buffer with a margin so art that moves off the edge is kept, like any moved cel.
  const pad = Math.max(src.w, src.h) * 2 + 8;
  const bw = W + pad * 2, bh = H + pad * 2;
  const buf = new Uint32Array(bw * bh);
  const plot = (x: number, y: number, c: number) => {
    const px = x + pad, py = y + pad;
    if (px >= 0 && py >= 0 && px < bw && py < bh) buf[py * bw + px] = c;
  };

  const turned = Math.abs(angle % (2 * Math.PI)) > 1e-6 || sq.angle !== 0;
  const smooth = turned && m.quality === 'smooth-edges';
  let sampler = bmp, factor = 1;
  if (smooth) { if (!cache?.big) { const big = upscale8(bmp); if (cache) cache.big = big; sampler = big; } else sampler = cache.big; factor = 8; }

  if (sq.sx !== 1) {
    // Squash is applied in the direction of travel: render scaled along x of a frame turned to that direction.
    // That is the same as an extra rotation, a scale, and turning back, done here by composing two placements.
    const stretched = stretchAlong(bmp, sampler, factor, sq, kx, ky, angle);
    const p: Placement = { cx, cy, sw: stretched.w, sh: stretched.h, angle: 0 };
    renderPlaced(stretched, p, plot);
  } else {
    const p: Placement = { cx, cy, sw: src.w * kx, sh: src.h * ky, angle };
    renderPlaced(bmp, p, plot, sampler, factor);
  }

  let cel = trimToCel(buf, bw, bh, -pad, -pad, Math.round((src.opacity * Math.max(0, Math.min(100, s.opacity))) / 100));
  if (!cel) return null;
  if (s.hue || s.value) cel = { ...cel, data: shiftColors(cel.data, s.hue, s.value) };
  if (doc.colorMode === 'indexed' && doc.palette.length) {
    const pal = doc.palette, data = cel.data;
    for (let i = 0; i < data.length; i++) if (A(data[i])) data[i] = ((pal[nearestIndex(data[i], pal)] & 0xffffff) | (A(data[i]) << 24)) >>> 0;
  }
  return { ...cel, gen: m.id };
}

/** Renders the art turned and scaled, then stretched along the travel direction, into a new upright bitmap. */
function stretchAlong(bmp: Bitmap, sampler: Bitmap, factor: number, sq: { sx: number; sy: number; angle: number }, kx: number, ky: number, angle: number): Bitmap {
  // Forward map: scale (kx,ky) → rotate(angle) → rotate(-a) → scale(sx,sy) → rotate(a). Done by inverse sampling.
  const a = sq.angle;
  const ca = Math.cos(a), sa = Math.sin(a), cr = Math.cos(angle), sr = Math.sin(angle);
  const hw = (Math.abs(bmp.w * kx) / 2) * Math.max(sq.sx, 1) + 2, hh = (Math.abs(bmp.h * ky) / 2) * Math.max(sq.sx, 1) + 2;
  const ext = Math.ceil(Math.hypot(hw, hh));
  const w = ext * 2, h = ext * 2;
  const data = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let dx = x + 0.5 - ext, dy = y + 0.5 - ext;
    // Undo rotate(a)
    let ux = dx * ca + dy * sa, uy = -dx * sa + dy * ca;
    ux /= sq.sx; uy /= sq.sy;
    // Undo rotate(-a)
    dx = ux * ca - uy * sa; dy = ux * sa + uy * ca;
    // Undo rotate(angle)
    ux = dx * cr + dy * sr; uy = -dx * sr + dy * cr;
    // Undo scale
    const u = ux / (kx || 1e-9) + bmp.w / 2, v = uy / (ky || 1e-9) + bmp.h / 2;
    if (u < 0 || v < 0 || u >= bmp.w || v >= bmp.h) continue;
    data[y * w + x] = sampler.data[Math.floor(v * factor) * sampler.w + Math.floor(u * factor)];
  }
  return { w, h, data };
}

function shiftColors(src: Uint32Array, hue: number, value: number): Uint32Array {
  const out = new Uint32Array(src.length);
  const cache = new Map<number, number>();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!A(c)) continue;
    let o = cache.get(c);
    if (o === undefined) {
      const [h, s, v] = rgbToHsv(R(c), G(c), B(c));
      const [r, g, b] = hsvToRgb(h + hue, s, Math.max(0, Math.min(1, v + value / 100)));
      o = rgba(r, g, b, A(c));
      cache.set(c, o);
    }
    out[i] = o;
  }
  return out;
}

// ---- Document operations

export const motionsOf = (doc: Doc) => doc.motions ?? [];
export const motionById = (doc: Doc, id: string | null | undefined) => motionsOf(doc).find((m) => m.id === id);
export const motionsOnLayer = (doc: Doc, layerId: string) => motionsOf(doc).filter((m) => m.layerId === layerId);

/**
 * Starts a motion from the art on one frame. Keys at both ends hold the art still until the user changes them; every
 * cel already on the layer inside the range is taken over by the tween (undo brings them back).
 */
export function createMotion(doc: Doc, layerId: string, sourceFrame: number, from: number, to: number, name = 'Motion'): { doc: Doc; id: string } | null {
  const src = doc.cels[celKey(layerId, doc.frames[sourceFrame].id)];
  if (!src) return null;
  const id = newId('mo');
  const lo = Math.min(from, to), hi = Math.max(from, to);
  const key = (i: number): Key => ({ f: doc.frames[i].id, v: 0, ease: 'linear' });
  const m: Motion = {
    id, name, layerId,
    pivot: { x: src.x + src.w / 2, y: src.y + src.h / 2 },
    tracks: { x: [key(lo), key(hi)], y: [key(lo), key(hi)] },
    curvedPath: false, squash: 0, snap: true, quality: 'smooth-edges',
  };
  // Its own object, so it is never linked to a cel left on a frame outside the range.
  const cels = { ...doc.cels, [srcKey(layerId, id)]: { ...src, id: newId('c'), gen: undefined } };
  for (let i = lo; i <= hi; i++) delete cels[celKey(layerId, doc.frames[i].id)];
  return { doc: bakeMotion({ ...doc, cels, motions: [...motionsOf(doc), m] }, id).doc, id };
}

/** Rebuilds a motion's generated cels. Cels the artist drew on inside the range are kept and counted. */
export function bakeMotion(doc: Doc, id: string): { doc: Doc; kept: number; made: number } {
  const m = motionById(doc, id);
  if (!m) return { doc, kept: 0, made: 0 };
  const src = doc.cels[srcKey(m.layerId, m.id)];
  const cels = { ...doc.cels };
  for (const f of doc.frames) {
    const k = celKey(m.layerId, f.id);
    if (cels[k]?.gen === m.id) delete cels[k];
  }
  const range = motionRange(doc, m);
  let kept = 0, made = 0;
  if (src && range) {
    const cache: { big?: Bitmap } = {};
    for (let i = range[0]; i <= range[1]; i++) {
      const k = celKey(m.layerId, doc.frames[i].id);
      if (cels[k]) { kept++; continue; }
      const c = renderMotionFrame(doc, m, i, src, cache);
      if (c) { cels[k] = c; made++; }
    }
  }
  return { doc: { ...doc, cels }, kept, made };
}

export function updateMotion(doc: Doc, id: string, patch: Partial<Motion>): Doc {
  const motions = motionsOf(doc).map((m) => (m.id === id ? { ...m, ...patch } : m));
  return bakeMotion({ ...doc, motions }, id).doc;
}

/** Sets (or adds) the key for a property at a frame, then re-bakes. */
export function setKey(doc: Doc, id: string, prop: Prop, frame: number, v: number, ease?: Ease): Doc {
  const m = motionById(doc, id);
  if (!m) return doc;
  const f = doc.frames[frame].id;
  const keys = [...(m.tracks[prop] ?? [])];
  if (!liveKeys(doc, keys).length) {
    // A property's first key would otherwise hold its value on every frame. Anchor the resting value at the tween's
    // start so the change animates from there, the way a first key is expected to behave.
    const r = motionRange(doc, m);
    if (r && r[0] !== frame) keys.push({ f: doc.frames[r[0]].id, v: propBase(prop), ease: 'linear' });
  }
  const at = keys.findIndex((k) => k.f === f);
  if (at >= 0) keys[at] = { ...keys[at], v, ease: ease ?? keys[at].ease };
  else {
    // A new key between two others starts with the easing of the segment it splits, so the curve doesn't jump.
    const live = liveKeys(doc, keys);
    const before = [...live].reverse().find((k) => k.i < frame);
    keys.push({ f, v, ease: ease ?? before?.ease ?? 'linear' });
  }
  return updateMotion(doc, id, { tracks: { ...m.tracks, [prop]: keys } });
}

export function removeKey(doc: Doc, id: string, prop: Prop, frame: number): Doc {
  const m = motionById(doc, id);
  if (!m) return doc;
  const f = doc.frames[frame].id;
  const keys = (m.tracks[prop] ?? []).filter((k) => k.f !== f);
  const tracks = { ...m.tracks };
  if (keys.length) tracks[prop] = keys; else delete tracks[prop];
  return updateMotion(doc, id, { tracks });
}

/** Changes the easing leaving every key on this frame (all properties), or one property's key. */
export function setEase(doc: Doc, id: string, frame: number, ease: Ease, prop?: Prop): Doc {
  const m = motionById(doc, id);
  if (!m) return doc;
  const f = doc.frames[frame].id;
  const tracks: Motion['tracks'] = {};
  for (const [p, keys] of Object.entries(m.tracks) as [Prop, Key[]][]) {
    tracks[p] = !prop || prop === p ? keys.map((k) => (k.f === f ? { ...k, ease } : k)) : keys;
  }
  return updateMotion(doc, id, { tracks });
}

/** Frame indexes that hold a key on any property. */
export function keyFrames(doc: Doc, m: Motion): Set<number> {
  const idx = indexOf(doc), out = new Set<number>();
  for (const keys of Object.values(m.tracks)) for (const k of liveKeys(doc, keys, idx)) out.add(k.i);
  return out;
}

/** Removes the tween. `keep` turns the generated frames into ordinary cels; otherwise the original art goes back on its first frame. */
export function removeMotion(doc: Doc, id: string, keep: boolean): Doc {
  const m = motionById(doc, id);
  if (!m) return doc;
  const cels = { ...doc.cels };
  const src = cels[srcKey(m.layerId, id)];
  delete cels[srcKey(m.layerId, id)];
  for (const f of doc.frames) {
    const k = celKey(m.layerId, f.id);
    const c = cels[k];
    if (c?.gen === id) { if (keep) { const { gen: _g, ...rest } = c; cels[k] = { ...rest, id: newId('c') }; } else delete cels[k]; }
  }
  if (!keep && src) {
    const r = motionRange(doc, m);
    const k = celKey(m.layerId, doc.frames[r ? r[0] : 0].id);
    if (!cels[k]) cels[k] = src;
  }
  return { ...doc, cels, motions: motionsOf(doc).filter((x) => x.id !== id) };
}

/** Puts the tween's frame back on a cel the artist had drawn over. */
export function resetToTween(doc: Doc, layerId: string, frame: number): Doc {
  const k = celKey(layerId, doc.frames[frame].id);
  const m = motionsOnLayer(doc, layerId).find((x) => { const r = motionRange(doc, x); return r && frame >= r[0] && frame <= r[1]; });
  if (!m) return doc;
  const cels = { ...doc.cels };
  delete cels[k];
  return bakeMotion({ ...doc, cels }, m.id).doc;
}

/** Re-bakes every motion. Used after whole-sprite edits (scaling, flipping, palette changes) touched the source art. */
export function bakeAll(doc: Doc): Doc {
  let d = doc;
  for (const m of motionsOf(doc)) d = bakeMotion(d, m.id).doc;
  return d;
}

/** Drops motions whose layer is gone, and their source art. Called by layer removal. */
export function pruneMotions(doc: Doc): Doc {
  const live = new Set(doc.layers.map((l) => l.id));
  const motions = motionsOf(doc).filter((m) => live.has(m.layerId));
  if (motions.length === motionsOf(doc).length) return doc;
  const cels = { ...doc.cels };
  for (const k of Object.keys(cels)) if (isSrcKey(k) && !live.has(k.split(':')[0])) delete cels[k];
  return { ...doc, motions, cels };
}
