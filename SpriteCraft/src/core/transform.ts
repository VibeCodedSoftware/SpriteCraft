// Pixel-preserving image transforms. No filtering: every output pixel is a colour that exists in the source.
// The 8x enlargement path is the base later phases build on for rotating sprites in 3D.

export interface Bitmap { w: number; h: number; data: Uint32Array }

/** One Scale2x pass: doubles an image and rounds its diagonals by looking at neighbours. Introduces no new colours. */
export function scale2x(src: Bitmap): Bitmap {
  const { w, h, data } = src;
  const out = new Uint32Array(w * h * 4);
  const W = w * 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = data[y * w + x];
      const b = y > 0 ? data[(y - 1) * w + x] : e;
      const h2 = y < h - 1 ? data[(y + 1) * w + x] : e;
      const d = x > 0 ? data[y * w + x - 1] : e;
      const f = x < w - 1 ? data[y * w + x + 1] : e;
      const i = y * 2 * W + x * 2;
      if (b !== h2 && d !== f) {
        out[i] = d === b ? d : e;
        out[i + 1] = b === f ? f : e;
        out[i + W] = d === h2 ? d : e;
        out[i + W + 1] = h2 === f ? f : e;
      } else {
        out[i] = e; out[i + 1] = e; out[i + W] = e; out[i + W + 1] = e;
      }
    }
  }
  return { w: W, h: h * 2, data: out };
}

export interface Placement {
  /** Centre of the result in canvas coordinates. */
  cx: number; cy: number;
  /** Size in pixels after scaling, signed: a negative value flips. */
  sw: number; sh: number;
  /** Radians, clockwise on screen. */
  angle: number;
}

export type RotateQuality = 'nearest' | 'smooth-edges';

/** Enlarged copy used for clean rotation. Worth keeping between frames of an interactive drag. */
export const upscale8 = (src: Bitmap): Bitmap => scale2x(scale2x(scale2x(src)));

/** Bounds on the canvas of a placed image. */
export function placedBounds(p: Placement) {
  const hw = Math.abs(p.sw) / 2, hh = Math.abs(p.sh) / 2;
  const c = Math.abs(Math.cos(p.angle)), s = Math.abs(Math.sin(p.angle));
  const ex = hw * c + hh * s, ey = hw * s + hh * c;
  // The small margin stops floating point error at exact right angles from adding an empty row or column.
  const e = 1e-9;
  const x0 = Math.floor(p.cx - ex + e), y0 = Math.floor(p.cy - ey + e);
  return { x: x0, y: y0, w: Math.ceil(p.cx + ex - e) - x0, h: Math.ceil(p.cy + ey - e) - y0 };
}

/**
 * Samples a bitmap under a placement, by inverse mapping at each output pixel's centre. Pass an enlarged copy
 * (`sampler`, with `factor`) for cleaner edges when rotating.
 */
export function renderPlaced(src: Bitmap, p: Placement, plot: (x: number, y: number, c: number) => void, sampler: Bitmap = src, factor = 1) {
  const b = placedBounds(p);
  const cos = Math.cos(-p.angle), sin = Math.sin(-p.angle);
  const sx = src.w / (p.sw || 1), sy = src.h / (p.sh || 1);
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const dx = x + 0.5 - p.cx, dy = y + 0.5 - p.cy;
      const u = (dx * cos - dy * sin) * sx + src.w / 2;
      const v = (dx * sin + dy * cos) * sy + src.h / 2;
      if (u < 0 || v < 0 || u >= src.w || v >= src.h) continue;
      const c = sampler.data[Math.floor(v * factor) * sampler.w + Math.floor(u * factor)];
      if (c >>> 24) plot(x, y, c);
    }
  }
}
