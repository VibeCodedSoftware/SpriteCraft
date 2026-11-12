// Selections: byte masks over a bounding box, plus combining them and tracing their outline for marching ants.
import { rectIntersect, type Rect, type Selection } from './types';

export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

/** Builds a selection from a full-region mask, tightening its box. Null when nothing is selected. */
export function fromMask(mask: Uint8Array, region: Rect): Selection | null {
  let l = region.w, r = -1, t = region.h, b = -1;
  for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) {
    if (mask[y * region.w + x]) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; b = y; }
  }
  if (r < 0) return null;
  const w = r - l + 1, h = b - t + 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(mask.subarray((y + t) * region.w + l, (y + t) * region.w + r + 1), y * w);
  return { x: region.x + l, y: region.y + t, w, h, mask: out };
}

export const isSelected = (s: Selection, x: number, y: number) =>
  x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h && s.mask[(y - s.y) * s.w + (x - s.x)] !== 0;

/** Full-canvas byte mask of a selection (a null selection gives an empty mask). */
export function toFullMask(s: Selection | null, W: number, H: number): Uint8Array {
  const m = new Uint8Array(W * H);
  if (!s) return m;
  const r = rectIntersect(s, { x: 0, y: 0, w: W, h: H });
  if (!r) return m;
  for (let y = r.y; y < r.y + r.h; y++) {
    const si = (y - s.y) * s.w + (r.x - s.x);
    m.set(s.mask.subarray(si, si + r.w), y * W + r.x);
  }
  return m;
}

/** Combines a new canvas-sized mask with the existing selection. */
export function combine(old: Selection | null, mask: Uint8Array, W: number, H: number, mode: SelectMode): Selection | null {
  const region = { x: 0, y: 0, w: W, h: H };
  if (mode === 'replace' || !old) return mode === 'subtract' || mode === 'intersect' ? (mode === 'subtract' ? old : null) : fromMask(mask, region);
  const prev = toFullMask(old, W, H);
  for (let i = 0; i < prev.length; i++) {
    if (mode === 'add') prev[i] = prev[i] || mask[i];
    else if (mode === 'subtract') prev[i] = mask[i] ? 0 : prev[i];
    else prev[i] = prev[i] && mask[i] ? 255 : 0;
  }
  return fromMask(prev, region);
}

export function invertSelection(s: Selection | null, W: number, H: number): Selection | null {
  const m = toFullMask(s, W, H);
  for (let i = 0; i < m.length; i++) m[i] = m[i] ? 0 : 255;
  return fromMask(m, { x: 0, y: 0, w: W, h: H });
}

export function selectAll(W: number, H: number): Selection {
  return { x: 0, y: 0, w: W, h: H, mask: new Uint8Array(W * H).fill(255) };
}

/** Grows (positive) or shrinks (negative) a selection by whole pixels, using 4-neighbour steps. */
export function growSelection(s: Selection, amount: number, W: number, H: number): Selection | null {
  let m = toFullMask(s, W, H);
  const grow = amount > 0;
  for (let n = 0; n < Math.abs(amount); n++) {
    const next = m.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grow ? m[i] : !m[i]) continue;
      const hit = grow
        ? (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W])
        : x === 0 || y === 0 || x === W - 1 || y === H - 1 || !m[i - 1] || !m[i + 1] || !m[i - W] || !m[i + W];
      if (hit) next[i] = grow ? 255 : 0;
    }
    m = next;
  }
  return fromMask(m, { x: 0, y: 0, w: W, h: H });
}

/** Line segments along the selection's edge, in canvas coordinates: [x0, y0, x1, y1] runs. */
export function outlineSegments(s: Selection): number[] {
  const out: number[] = [];
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < s.w && y < s.h && s.mask[y * s.w + x] !== 0;
  // Horizontal edges, merged along each row so a large box costs a few segments, not thousands.
  for (let y = 0; y <= s.h; y++) {
    let start = -1, startKind = 0;
    for (let x = 0; x <= s.w; x++) {
      const kind = x < s.w ? (on(x, y - 1) ? 1 : 0) - (on(x, y) ? 1 : 0) : 0;
      if (kind !== startKind) {
        if (startKind !== 0) out.push(s.x + start, s.y + y, s.x + x, s.y + y);
        start = x; startKind = kind;
      }
    }
  }
  for (let x = 0; x <= s.w; x++) {
    let start = -1, startKind = 0;
    for (let y = 0; y <= s.h; y++) {
      const kind = y < s.h ? (on(x - 1, y) ? 1 : 0) - (on(x, y) ? 1 : 0) : 0;
      if (kind !== startKind) {
        if (startKind !== 0) out.push(s.x + x, s.y + start, s.x + x, s.y + y);
        start = y; startKind = kind;
      }
    }
  }
  return out;
}
