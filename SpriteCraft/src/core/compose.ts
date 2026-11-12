// The compositor: flattens a frame's layers into pixels on the CPU. The viewport, every export and the tests share it,
// so what is on screen is what gets written. Regions are supported so a brush stroke only recomputes what it touched.
import { BLEND_MODES, celKey, maskKey, rectIntersect, type BlendMode, type Cel, type Doc, type Layer, type Rect } from './types';
import { defaultParams, effectById } from './effects';
import { liveKeys, sampleKeys } from './anim';

// --- Separable blend functions, values 0..1 (W3C compositing spec; Addition, Subtract and Divide as Aseprite names them).
const softLight = (b: number, s: number) => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};
const hardLight = (b: number, s: number) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));
const SEP: Partial<Record<BlendMode, (b: number, s: number) => number>> = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hardLight(s, b),
  darken: Math.min,
  lighten: Math.max,
  'color-dodge': (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'hard-light': hardLight,
  'soft-light': softLight,
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  addition: (b, s) => Math.min(1, b + s),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (b === 0 ? 0 : s === 0 ? 1 : Math.min(1, b / s)),
};

// --- Non-separable modes.
type V3 = [number, number, number];
const lum = (c: V3) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const sat = (c: V3) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function clipColor(c: V3): V3 {
  const l = lum(c), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
  const f = (v: number) => {
    if (n < 0) v = l + ((v - l) * l) / (l - n);
    if (x > 1) v = l + ((v - l) * (1 - l)) / (x - l);
    return v;
  };
  return [f(c[0]), f(c[1]), f(c[2])];
}
function setLum(c: V3, l: number): V3 { const d = l - lum(c); return clipColor([c[0] + d, c[1] + d, c[2] + d]); }
function setSat(c: V3, s: number): V3 {
  const x = Math.max(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]);
  if (x === n) return [0, 0, 0];
  const f = (v: number) => ((v - n) * s) / (x - n);
  return [f(c[0]), f(c[1]), f(c[2])];
}
const NON_SEP: Partial<Record<BlendMode, (b: V3, s: V3) => V3>> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};

/** Draws one source pixel (with alpha 0..255 already scaled) onto a destination pixel. */
export function blendPixel(mode: BlendMode, dst: number, sr: number, sg: number, sb: number, sa: number): number {
  if (sa <= 0) return dst;
  const da = dst >>> 24;
  if (da === 0) return ((sa << 24) | (sb << 16) | (sg << 8) | sr) >>> 0;
  if (mode === 'normal' && sa >= 255) return ((255 << 24) | (sb << 16) | (sg << 8) | sr) >>> 0;
  const dr = dst & 255, dg = (dst >>> 8) & 255, db = (dst >>> 16) & 255;
  const as = sa / 255, ab = da / 255;
  let cr = sr, cg = sg, cb = sb;
  if (mode !== 'normal') {
    const sep = SEP[mode];
    let mr: number, mg: number, mb: number;
    if (sep) {
      mr = sep(dr / 255, sr / 255); mg = sep(dg / 255, sg / 255); mb = sep(db / 255, sb / 255);
    } else {
      const m = NON_SEP[mode]!([dr / 255, dg / 255, db / 255], [sr / 255, sg / 255, sb / 255]);
      mr = m[0]; mg = m[1]; mb = m[2];
    }
    cr = (1 - ab) * sr + ab * mr * 255; cg = (1 - ab) * sg + ab * mg * 255; cb = (1 - ab) * sb + ab * mb * 255;
  }
  const ao = as + ab - as * ab;
  const k1 = as / ao, k2 = ((1 - as) * ab) / ao;
  const r = (cr * k1 + dr * k2 + 0.5) | 0, g = (cg * k1 + dg * k2 + 0.5) | 0, b = (cb * k1 + db * k2 + 0.5) | 0;
  return (((ao * 255 + 0.5) << 24) | ((b > 255 ? 255 : b) << 16) | ((g > 255 ? 255 : g) << 8) | (r > 255 ? 255 : r)) >>> 0;
}

export interface ComposeOptions {
  /** Draw this cel in place of the stored one: how a stroke in progress is shown. */
  override?: { layerId: string; cel: Cel; isMask?: boolean };
  /** Leave out reference layers. Every export sets this. */
  skipReference?: boolean;
  /** Draw hidden layers too, and only this layer: used by per-layer export and tests. */
  onlyLayer?: string;
  /** Skip live shaders (used for what a shader sees above its own layer, so shaders don't feed on each other). */
  noFx?: boolean;
}

const hasFx = (l: Layer) => !!l.fx?.some((f) => f.on);

/** Live shaders that failed, by `layerId|fxId`, with the reason (shown by the Performance panel). */
export const fxErrors = new Map<string, string>();

// ---- live-shader cache
//
// A document is never changed in place, so a layer's shaded result for one document, frame and set of options can be
// kept and reused: playback, scrolling and hovering then cost no shader work at all. Only the most recent documents
// keep results (undo history would otherwise hold them all), within a memory budget.

export interface FxSettings {
  /** Cache shaded layers (on unless debugging). */
  cache: boolean;
  /** While a stroke is being drawn on another layer, show the shaded layers as they were before it (much faster). */
  deferWhileDrawing: boolean;
  /** Memory budget for kept results, in megabytes. */
  budgetMB: number;
  /** Show live effects on the editing canvas (off for slow machines; effect panels' previews and exports still have them). */
  showOnCanvas: boolean;
}
export const fxSettings: FxSettings = { cache: true, deferWhileDrawing: true, budgetMB: 192, showOnCanvas: true };
export const fxStats = { hits: 0, misses: 0, deferred: 0, bytes: 0, ms: new Map<string, number>() };

let cache = new WeakMap<Doc, Map<string, Cel | undefined>>();
const cacheDocs: Doc[] = [];
const KEEP_DOCS = 3;

function cacheFor(doc: Doc, create: boolean): Map<string, Cel | undefined> | undefined {
  let m = cache.get(doc);
  if (!m && create) {
    m = new Map();
    cache.set(doc, m);
    cacheDocs.push(doc);
    while (cacheDocs.length > KEEP_DOCS) {
      const old = cacheDocs.shift()!;
      for (const c of cache.get(old)?.values() ?? []) fxStats.bytes -= (c?.data.byteLength ?? 0);
      cache.delete(old);
    }
  }
  return m;
}
/** Forgets every kept result (after changing settings, or to free memory). */
export function clearFxCache() { cache = new WeakMap(); cacheDocs.length = 0; fxStats.bytes = 0; }

const optKey = (o: ComposeOptions) => `${o.skipReference ? 1 : 0}${o.onlyLayer ?? ''}`;

/** A layer's own pixels on a frame, canvas-sized, ignoring visibility, opacity and live shaders (for node inputs). */
export function layerPixels(doc: Doc, id: string, frameId: string): Uint32Array {
  const out = new Uint32Array(doc.width * doc.height);
  const c = doc.cels[celKey(id, frameId)];
  if (c) blit(out, { x: 0, y: 0, w: doc.width, h: doc.height }, { ...c, opacity: 255 }, 'normal', 255, null, null);
  return out;
}

/**
 * A layer's pixels on a frame with its live effects run, exactly as it is drawn inside the full frame (the effects see
 * the same layers below and above). For formats that can't keep live effects.
 */
export function shadedLayer(doc: Doc, layerId: string, frameIndex: number): Uint32Array {
  const l = doc.layers.find((x) => x.id === layerId), fr = doc.frames[frameIndex];
  if (!l || !fr) return new Uint32Array(doc.width * doc.height);
  const cel = doc.cels[celKey(l.id, fr.id)];
  if (!hasFx(l)) return layerPixels(doc, layerId, fr.id);
  // What's under it, drawn the way the compositor gives it to the effects (with their own effects).
  const at = doc.layers.findIndex((x) => x.id === layerId);
  const under = { ...doc, layers: doc.layers.map((x, k) => (k >= at ? { ...x, visible: false } : x)) };
  const below = composeFrame(under, frameIndex, {});
  const sibs = childrenOf(doc, l.parentId);
  const out = celWithFx(doc, l, cel, fr.id, below, sibs, sibs.indexOf(l), l.parentId, {});
  return out ? out.data.slice() : new Uint32Array(doc.width * doc.height);
}

/** True when a layer's cel on this frame covers the whole canvas with solid pixels: a background, not a surface. */
export function isBackdrop(doc: Doc, l: Layer, frameId: string): boolean {
  const c = doc.cels[celKey(l.id, frameId)];
  if (!c || c.x > 0 || c.y > 0 || c.x + c.w < doc.width || c.y + c.h < doc.height) return false;
  for (let y = -c.y; y < doc.height - c.y; y++) for (let x = -c.x; x < doc.width - c.x; x++) if ((c.data[y * c.w + x] >>> 24) < 255) return false;
  return true;
}

/**
 * The layers under `layerId` (in the flat order), drawn without live shaders, keeping only those `keep` accepts. Used
 * for what rain and snow land on, where a full-canvas sky layer must not count as a surface.
 */
export function layersBelow(doc: Doc, layerId: string, frameIndex: number, keep: (l: Layer, backdrop: boolean) => boolean): Uint32Array {
  const at = doc.layers.findIndex((l) => l.id === layerId);
  const fid = doc.frames[frameIndex]?.id ?? '';
  const d = { ...doc, layers: doc.layers.map((l, k) => (k >= at || (l.kind === 'image' && !keep(l, isBackdrop(doc, l, fid))) ? { ...l, visible: false } : l)) };
  return composeFrame(d, frameIndex, { skipReference: true, noFx: true });
}

/**
 * Runs a layer's live shaders over its cel. Each shader sees the layer's pixels (canvas-sized), what is drawn under the
 * layer (`below`), over it (`above`) and over it on other frames (`aboveAt`), and where this frame sits in the loop.
 */
function celWithFx(doc: Doc, l: Layer, cel: Cel | undefined, frameId: string, below: Uint32Array, sibs: Layer[], i: number, parent: string | null, o: ComposeOptions): Cel | undefined {
  const W = doc.width, H = doc.height, canvas = { x: 0, y: 0, w: W, h: H };
  const frame = Math.max(0, doc.frames.findIndex((f) => f.id === frameId)), frames = doc.frames.length;
  const aboveFor = (fid: string) => {
    const buf = new Uint32Array(W * H);
    drawSiblings(doc, parent, fid, canvas, buf, { ...o, noFx: true }, i + 1);
    return buf;
  };
  let above: Uint32Array | undefined;
  let img = new Uint32Array(W * H);
  if (cel) blit(img, canvas, { ...cel, opacity: 255 }, 'normal', 255, null, null);
  for (const f of l.fx!) {
    if (!f.on) continue;
    const e = effectById(f.effect);
    if (!e) continue;
    // Settings missing from older files take their defaults.
    const params = { ...defaultParams(e), ...f.params };
    if (f.keys) for (const [k, ks] of Object.entries(f.keys)) params[k] = sampleKeys(liveKeys(doc, ks), frame, params[k]);
    let seconds = 0, loopSeconds = 0;
    doc.frames.forEach((fr, k) => { if (k < frame) seconds += fr.duration / 1000; loopSeconds += fr.duration / 1000; });
    // A shader that fails is passed over, so one bad setting never blanks the canvas.
    try { img = e.apply(img, W, H, params, {
      palette: doc.palette, t: frame / frames, frame, frames, below, seconds, loopSeconds,
      get above() { return (above ??= aboveFor(frameId)); },
      aboveAt: (fi: number) => aboveFor(doc.frames[((fi % frames) + frames) % frames].id),
      belowWhere: (keep) => layersBelow(doc, l.id, frame, keep),
      layerPixels: (id: string) => layerPixels(doc, id, frameId),
    }); } catch (err) { fxErrors.set(`${l.id}|${f.id}`, String((err as Error)?.message ?? err)); }
  }
  void sibs;
  return { id: 'fx', x: 0, y: 0, w: W, h: H, data: img, opacity: cel?.opacity ?? 255 };
}

const childrenOf = (doc: Doc, parent: string | null) => doc.layers.filter((l) => l.parentId === parent);

/** Draws a cel into a region buffer. Alpha is scaled by opacity, by the layer mask and by an optional clip buffer. */
function blit(out: Uint32Array, region: Rect, cel: Cel, mode: BlendMode, opacity: number, mask: Cel | null, clip: Uint32Array | null) {
  const r = rectIntersect(region, cel);
  if (!r || opacity <= 0) return;
  const { data } = cel;
  for (let y = r.y; y < r.y + r.h; y++) {
    let si = (y - cel.y) * cel.w + (r.x - cel.x);
    let di = (y - region.y) * region.w + (r.x - region.x);
    for (let x = r.x; x < r.x + r.w; x++, si++, di++) {
      const s = data[si];
      let a = s >>> 24;
      if (a === 0) continue;
      if (opacity < 255) a = (a * opacity + 127) / 255 | 0;
      if (mask && x >= mask.x && y >= mask.y && x < mask.x + mask.w && y < mask.y + mask.h) {
        a = (a * (255 - (mask.data[(y - mask.y) * mask.w + (x - mask.x)] >>> 24)) + 127) / 255 | 0;
      }
      if (clip) a = (a * (clip[di] >>> 24) + 127) / 255 | 0;
      if (a === 0) continue;
      out[di] = blendPixel(mode, out[di], s & 255, (s >>> 8) & 255, (s >>> 16) & 255, a);
    }
  }
}

/** Blends one whole region buffer onto another. Used for groups and clipped stacks. */
function blendBuffer(out: Uint32Array, src: Uint32Array, mode: BlendMode, opacity: number) {
  for (let i = 0; i < out.length; i++) {
    const s = src[i];
    let a = s >>> 24;
    if (a === 0) continue;
    if (opacity < 255) a = (a * opacity + 127) / 255 | 0;
    if (a) out[i] = blendPixel(mode, out[i], s & 255, (s >>> 8) & 255, (s >>> 16) & 255, a);
  }
}

function baseLayerCel(doc: Doc, layer: Layer, frameId: string, o: ComposeOptions): { cel: Cel | undefined; mask: Cel | null } {
  const ov = o.override && o.override.layerId === layer.id ? o.override : undefined;
  const cel = ov && !ov.isMask ? ov.cel : doc.cels[celKey(layer.id, frameId)];
  let mask: Cel | null = null;
  if (layer.mask && layer.maskEnabled) mask = ov?.isMask ? ov.cel : doc.cels[maskKey(layer.id, frameId)] ?? null;
  return { cel, mask };
}

function drawSiblings(doc: Doc, parent: string | null, frameId: string, region: Rect, out: Uint32Array, o: ComposeOptions, from = 0) {
  const sibs = childrenOf(doc, parent);
  const layerCel = (d: Doc, l: Layer, fid: string, opts: ComposeOptions, i: number) => {
    const r = baseLayerCel(d, l, fid, opts);
    // Live shaders need the whole canvas; composeRegion guarantees that whenever any are on.
    if (!opts.noFx && hasFx(l)) {
      const key = `${l.id}|${fid}|${optKey(opts)}`;
      const ov = opts.override;
      // Kept results are valid for an unchanged document; while drawing on another layer they may be shown as they
      // were before the stroke (when that setting is on).
      const usable = fxSettings.cache && (!ov || (fxSettings.deferWhileDrawing && ov.layerId !== l.id));
      const kept = usable ? cacheFor(d, false) : undefined;
      if (kept?.has(key)) { if (ov) fxStats.deferred++; else fxStats.hits++; r.cel = kept.get(key); return r; }
      const t0 = performance.now();
      r.cel = celWithFx(d, l, r.cel, fid, out.slice(), sibs, i, parent, opts);
      fxStats.ms.set(l.id, performance.now() - t0);
      fxStats.misses++;
      if (fxSettings.cache && !ov) {
        const bytes = r.cel?.data.byteLength ?? 0;
        if (fxStats.bytes + bytes > fxSettings.budgetMB * 1048576) clearFxCache();
        cacheFor(d, true)!.set(key, r.cel);
        fxStats.bytes += bytes;
      }
    }
    return r;
  };
  for (let i = from; i < sibs.length; i++) {
    const l = sibs[i];
    if (!l.visible || (o.skipReference && l.kind === 'reference')) continue;
    if (o.onlyLayer && l.kind !== 'group' && l.id !== o.onlyLayer) continue;

    // Clipped layers directly above this one are drawn onto it before it reaches the destination.
    let end = i + 1;
    if (l.kind !== 'group') while (end < sibs.length && sibs[end].clip && sibs[end].kind !== 'group') end++;
    const clipped = sibs.slice(i + 1, end).filter((c) => c.visible);

    if (l.kind === 'group') {
      const tmp = new Uint32Array(out.length);
      drawSiblings(doc, l.id, frameId, region, tmp, o);
      blendBuffer(out, tmp, l.blend, l.opacity);
    } else if (clipped.length) {
      const base = new Uint32Array(out.length);
      const b = layerCel(doc, l, frameId, o, i);
      if (b.cel) blit(base, region, b.cel, 'normal', b.cel.opacity, b.mask, null);
      const shape = base.slice();
      for (const c of clipped) {
        const cc = layerCel(doc, c, frameId, o, sibs.indexOf(c));
        if (cc.cel) blit(base, region, cc.cel, c.blend, (c.opacity * cc.cel.opacity + 127) / 255 | 0, cc.mask, shape);
      }
      blendBuffer(out, base, l.blend, l.opacity);
    } else {
      const { cel, mask } = layerCel(doc, l, frameId, o, i);
      if (cel) blit(out, region, cel, l.blend, (l.opacity * cel.opacity + 127) / 255 | 0, mask, null);
    }
    i = end - 1;
  }
}

/** Flattens part of a frame into a new buffer (straight alpha, region.w × region.h). */
export function composeRegion(doc: Doc, frameIndex: number, region: Rect, o: ComposeOptions = {}, out?: Uint32Array): Uint32Array {
  const buf = out ?? new Uint32Array(region.w * region.h);
  if (out) buf.fill(0);
  const f = doc.frames[frameIndex];
  if (!f) return buf;
  const full = region.x === 0 && region.y === 0 && region.w === doc.width && region.h === doc.height;
  if (!full && !o.noFx && doc.layers.some((l) => l.visible && hasFx(l))) {
    // Shaders can move pixels anywhere (waves, reflections), so the whole frame is drawn and the region cut from it.
    const all = composeRegion(doc, frameIndex, { x: 0, y: 0, w: doc.width, h: doc.height }, o);
    for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) {
      const sx = region.x + x, sy = region.y + y;
      buf[y * region.w + x] = sx >= 0 && sy >= 0 && sx < doc.width && sy < doc.height ? all[sy * doc.width + sx] : 0;
    }
    return buf;
  }
  drawSiblings(doc, null, f.id, region, buf, o);
  return buf;
}

export const composeFrame = (doc: Doc, frameIndex: number, o: ComposeOptions = {}) =>
  composeRegion(doc, frameIndex, { x: 0, y: 0, w: doc.width, h: doc.height }, o);

export const blendModeLabel = (m: BlendMode) => m.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' ');
export const blendIndex = (m: BlendMode) => Math.max(0, BLEND_MODES.indexOf(m));
