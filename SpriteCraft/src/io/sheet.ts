// Sprite sheets in both directions, and frame sequences as new documents.
import { composeFrame } from '../core/compose';
import { newDoc, trimToCel } from '../core/doc';
import { celKey, type Doc, type Rect } from '../core/types';
import type { Image32 } from './png';

export interface SliceOptions { frameW: number; frameH: number; marginX: number; marginY: number; spacingX: number; spacingY: number; count?: number }

export function sheetGrid(imgW: number, imgH: number, o: SliceOptions) {
  const cols = Math.max(0, Math.floor((imgW - o.marginX + o.spacingX) / (o.frameW + o.spacingX)));
  const rows = Math.max(0, Math.floor((imgH - o.marginY + o.spacingY) / (o.frameH + o.spacingY)));
  return { cols, rows };
}

export function sliceSheet(img: Image32, o: SliceOptions): Uint32Array[] {
  const { cols, rows } = sheetGrid(img.w, img.h, o);
  const out: Uint32Array[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (o.count !== undefined && out.length >= o.count) return out;
    const f = new Uint32Array(o.frameW * o.frameH);
    const ox = o.marginX + c * (o.frameW + o.spacingX), oy = o.marginY + r * (o.frameH + o.spacingY);
    for (let y = 0; y < o.frameH; y++) f.set(img.data.subarray((oy + y) * img.w + ox, (oy + y) * img.w + ox + o.frameW), y * o.frameW);
    out.push(f);
  }
  return out;
}

/** Finds a frame size from fully transparent gutters, or from the image being a neat strip. */
export function detectGrid(img: Image32): { frameW: number; frameH: number; spacingX: number; spacingY: number } {
  const colEmpty = new Array(img.w).fill(true), rowEmpty = new Array(img.h).fill(true);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.data[y * img.w + x] >>> 24) { colEmpty[x] = false; rowEmpty[y] = false; }
  const runs = (flags: boolean[]) => {
    // Lengths of non-empty stretches and of the gaps between them.
    const solid: number[] = [], gaps: number[] = [];
    let i = 0;
    while (i < flags.length && flags[i]) i++;
    let run = i; if (run) solid.push(run);
    while (i < flags.length) {
      let g = 0; while (i < flags.length && !flags[i]) { i++; g++; }
      if (i >= flags.length) break;
      if (solid.length) gaps.push(g);
      let s = 0; while (i < flags.length && flags[i]) { i++; s++; }
      solid.push(s);
    }
    return { solid, gaps };
  };
  const pick = (flags: boolean[], total: number) => {
    const { solid, gaps } = runs(flags);
    if (solid.length > 1 && gaps.length) {
      const gap = Math.min(...gaps);
      // Frames are as wide as the widest stretch: a small sprite inside a large cell still divides evenly.
      const step = (total + gap) / solid.length;
      if (Number.isInteger(step)) return { size: step - gap, spacing: gap };
      return { size: Math.max(...solid), spacing: gap };
    }
    return { size: total, spacing: 0 };
  };
  const px = pick(colEmpty.map((e) => !e), img.w), py = pick(rowEmpty.map((e) => !e), img.h);
  return { frameW: px.size, frameH: py.size, spacingX: px.spacing, spacingY: py.spacing };
}

/** A new document with one layer and one frame per image. */
export function docFromFrames(frames: Uint32Array[], w: number, h: number, name: string, durations?: number[]): Doc {
  const doc = newDoc(w, h, name, Math.max(1, frames.length));
  const layer = doc.layers[0];
  frames.forEach((data, i) => {
    doc.frames[i].duration = durations?.[i] ?? 100;
    const cel = trimToCel(data, w, h, 0, 0);
    if (cel) doc.cels[celKey(layer.id, doc.frames[i].id)] = cel;
  });
  return doc;
}

export type SheetLayout = 'horizontal' | 'vertical' | 'grid';

export interface SheetOptions { layout: SheetLayout; columns?: number; padding: number; scale: number; from: number; to: number }

export interface SheetResult {
  image: Image32;
  rects: Rect[];
  /** Follows the widely read "array" JSON sprite sheet shape, so existing engine importers can use it. */
  json: unknown;
}

export const scaleNearest = (src: Uint32Array, w: number, h: number, s: number): Uint32Array => {
  if (s === 1) return src;
  const out = new Uint32Array(w * s * h * s);
  for (let y = 0; y < h; y++) {
    const row = new Uint32Array(w * s);
    for (let x = 0; x < w; x++) row.fill(src[y * w + x], x * s, (x + 1) * s);
    for (let k = 0; k < s; k++) out.set(row, (y * s + k) * (w * s));
  }
  return out;
};

export function renderFrames(doc: Doc, from: number, to: number, scale = 1): Uint32Array[] {
  const out: Uint32Array[] = [];
  for (let f = from; f <= to; f++) out.push(scaleNearest(composeFrame(doc, f, { skipReference: true }), doc.width, doc.height, scale));
  return out;
}

export function buildSheet(doc: Doc, o: SheetOptions, imageName = 'sheet.png'): SheetResult {
  const frames = renderFrames(doc, o.from, o.to, o.scale);
  const n = frames.length, fw = doc.width * o.scale, fh = doc.height * o.scale, pad = o.padding;
  const cols = o.layout === 'horizontal' ? n : o.layout === 'vertical' ? 1 : Math.max(1, o.columns ?? Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const W = cols * fw + (cols - 1) * pad, H = rows * fh + (rows - 1) * pad;
  const data = new Uint32Array(W * H);
  const rects: Rect[] = [];
  frames.forEach((f, i) => {
    const x = (i % cols) * (fw + pad), y = Math.floor(i / cols) * (fh + pad);
    rects.push({ x, y, w: fw, h: fh });
    for (let row = 0; row < fh; row++) data.set(f.subarray(row * fw, (row + 1) * fw), (y + row) * W + x);
  });
  const json = {
    frames: rects.map((r, i) => ({
      filename: `${doc.name} ${o.from + i}`,
      frame: r, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: fw, h: fh }, sourceSize: { w: fw, h: fh },
      duration: doc.frames[o.from + i].duration,
    })),
    meta: {
      app: 'SpriteCraft', version: '0.1', image: imageName, format: 'RGBA8888', size: { w: W, h: H }, scale: String(o.scale),
      frameTags: doc.tags
        .filter((t) => t.to >= o.from && t.from <= o.to)
        .map((t) => ({ name: t.name, from: Math.max(t.from, o.from) - o.from, to: Math.min(t.to, o.to) - o.from, direction: t.dir })),
      layers: doc.layers.filter((l) => l.kind === 'image').map((l) => ({ name: l.name, opacity: l.opacity, blendMode: l.blend })),
    },
  };
  return { image: { w: W, h: H, data }, rects, json };
}
