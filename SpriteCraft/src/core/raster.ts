// Pixel-accurate shape rasterizers. They produce coordinates through a callback and know nothing about documents,
// so the same code serves brushes, previews, symmetry, selection shapes and tests.
export type Plot = (x: number, y: number) => void;

export function line(x0: number, y0: number, x1: number, y1: number, plot: Plot) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  // Exact 2:1 lines step in clean pairs from the first pixel, which is what isometric art needs.
  if (dy !== 0 && dx === -2 * dy) { for (let i = 0; i <= dx; i++) plot(x0 + sx * i, y0 + sy * Math.floor(i / 2)); return; }
  if (dx !== 0 && -dy === 2 * dx) { for (let i = 0; i <= -dy; i++) plot(x0 + sx * Math.floor(i / 2), y0 + sy * i); return; }
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function rectOutline(x0: number, y0: number, x1: number, y1: number, plot: Plot) {
  const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
  for (let x = l; x <= r; x++) { plot(x, t); if (b !== t) plot(x, b); }
  for (let y = t + 1; y < b; y++) { plot(l, y); if (r !== l) plot(r, y); }
}

export function rectFill(x0: number, y0: number, x1: number, y1: number, plot: Plot) {
  const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
  for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) plot(x, y);
}

/**
 * Spans (left, right per row) of an ellipse inscribed in a pixel box. Symmetric on both axes for any box size, which is
 * what pixel artists expect: a width-6 circle has flat 2-pixel tops, not a lopsided edge.
 */
function ellipseSpans(l: number, w: number, h: number): [number, number][] {
  const rows: [number, number][] = [];
  const a = w / 2, b = h / 2;
  for (let row = 0; row < h; row++) {
    const dy = (row + 0.5 - b) / b;
    const half = a * Math.sqrt(Math.max(0, 1 - dy * dy));
    const inset = Math.min(Math.round(a - half), Math.floor((w - 1) / 2));
    rows.push([l + inset, l + w - 1 - inset]);
  }
  return rows;
}

export function ellipseFill(x0: number, y0: number, x1: number, y1: number, plot: Plot) {
  const l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0) + 1, h = Math.abs(y1 - y0) + 1;
  ellipseSpans(l, w, h).forEach(([a, b], i) => { for (let x = a; x <= b; x++) plot(x, t + i); });
}

export function ellipseOutline(x0: number, y0: number, x1: number, y1: number, plot: Plot) {
  const l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0) + 1, h = Math.abs(y1 - y0) + 1;
  const rows = ellipseSpans(l, w, h);
  // A pixel is on the outline when it is inside the shape and any 4-neighbour is outside.
  const inside = (x: number, y: number) => { const r = rows[y - t]; return !!r && x >= r[0] && x <= r[1]; };
  rows.forEach(([a, b], i) => {
    const y = t + i;
    for (let x = a; x <= b; x++) {
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) plot(x, y);
    }
  });
}

export function polygonOutline(pts: { x: number; y: number }[], plot: Plot, close = true) {
  for (let i = 0; i + 1 < pts.length; i++) line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, plot);
  if (close && pts.length > 2) line(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y, plot);
}

/** Even-odd scanline fill, sampled at pixel centres, plus the outline so thin shapes keep their edge. */
export function polygonFill(pts: { x: number; y: number }[], plot: Plot) {
  if (pts.length < 3) { polygonOutline(pts, plot, false); return; }
  let top = Infinity, bottom = -Infinity;
  for (const p of pts) { top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); }
  for (let y = top; y <= bottom; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) plot(x, y);
  }
  polygonOutline(pts, plot, true);
}

export interface Pt { x: number; y: number }

/**
 * Pixel-perfect filter for a freehand path. Given the path so far ending at a new point, returns the index of a corner
 * pixel to remove (an "L" made of three pixels where the first and third touch diagonally), or -1.
 */
export function pixelPerfectCorner(path: Pt[]): number {
  const n = path.length;
  if (n < 3) return -1;
  const a = path[n - 3], b = path[n - 2], c = path[n - 1];
  const touchesA = (a.x === b.x || a.y === b.y) && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
  const touchesC = (c.x === b.x || c.y === b.y) && Math.abs(c.x - b.x) + Math.abs(c.y - b.y) === 1;
  return touchesA && touchesC && a.x !== c.x && a.y !== c.y ? n - 2 : -1;
}

/** Scanline flood fill on packed pixels. Returns a byte mask of matching pixels over the region w × h. */
export function floodMask(data: Uint32Array, w: number, h: number, sx: number, sy: number, tolerance: number, contiguous: boolean): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const target = data[sy * w + sx];
  const tr = target & 255, tg = (target >>> 8) & 255, tb = (target >>> 16) & 255, ta = target >>> 24;
  const same = (p: number) => {
    if (p === target) return true;
    if (tolerance <= 0) return false;
    const a = p >>> 24;
    if (a === 0 && ta === 0) return true;
    return Math.abs((p & 255) - tr) <= tolerance && Math.abs(((p >>> 8) & 255) - tg) <= tolerance && Math.abs(((p >>> 16) & 255) - tb) <= tolerance && Math.abs(a - ta) <= tolerance;
  };
  if (!contiguous) {
    for (let i = 0; i < data.length; i++) if (same(data[i])) mask[i] = 255;
    return mask;
  }
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!, x0 = stack.pop()!;
    let i = y * w + x0;
    if (mask[i] || !same(data[i])) continue;
    let l = x0, r = x0;
    while (l > 0 && !mask[i - (x0 - l) - 1] && same(data[y * w + l - 1])) l--;
    while (r < w - 1 && !mask[y * w + r + 1] && same(data[y * w + r + 1])) r++;
    for (let x = l; x <= r; x++) {
      i = y * w + x;
      mask[i] = 255;
      if (y > 0 && !mask[i - w] && same(data[i - w])) { stack.push(x, y - 1); }
      if (y < h - 1 && !mask[i + w] && same(data[i + w])) { stack.push(x, y + 1); }
    }
  }
  return mask;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BAYER8 = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];

export type DitherKind = 'none' | 'bayer2' | 'bayer4' | 'bayer8' | 'checker';

/** Threshold in 0..1 at a pixel. Compare a shade amount against it to choose between two colours. */
export function ditherThreshold(kind: DitherKind, x: number, y: number): number {
  const mx = ((x % 8) + 8) % 8, my = ((y % 8) + 8) % 8;
  switch (kind) {
    case 'none': return 0.5;
    case 'checker': return (mx + my) % 2 ? 0.75 : 0.25;
    case 'bayer2': return ([0, 2, 3, 1][(my % 2) * 2 + (mx % 2)] + 0.5) / 4;
    case 'bayer4': return (BAYER4[(my % 4) * 4 + (mx % 4)] + 0.5) / 16;
    case 'bayer8': return (BAYER8[my * 8 + mx] + 0.5) / 64;
  }
}

/** Offsets covered by a round or square brush of a given size. Odd and even sizes both stay centred on the cursor. */
export function brushOffsets(size: number, shape: 'square' | 'circle'): Pt[] {
  const out: Pt[] = [];
  const o = Math.floor((size - 1) / 2);
  if (shape === 'square' || size <= 2) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out.push({ x: x - o, y: y - o });
    return out;
  }
  ellipseFill(0, 0, size - 1, size - 1, (x, y) => out.push({ x: x - o, y: y - o }));
  return out;
}

/** Constrains an end point to the angles pixel artists use: 0, 90, 45 and the 2:1 and 1:2 iso lines. */
export function constrainLine(x0: number, y0: number, x1: number, y1: number): Pt {
  const dx = x1 - x0, dy = y1 - y0, adx = Math.abs(dx), ady = Math.abs(dy);
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
  if (ady * 4 < adx) return { x: x1, y: y0 };
  if (adx * 4 < ady) return { x: x0, y: y1 };
  if (adx > ady * 1.5) { const h = Math.round(adx / 2); return { x: x0 + sx * h * 2, y: y0 + sy * h }; }
  if (ady > adx * 1.5) { const w = Math.round(ady / 2); return { x: x0 + sx * w, y: y0 + sy * w * 2 }; }
  const m = Math.max(adx, ady);
  return { x: x0 + sx * m, y: y0 + sy * m };
}
