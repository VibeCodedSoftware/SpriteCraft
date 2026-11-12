// Pure document operations. Each takes a Doc and returns a new Doc; nothing is changed in place.
import { nearestIndex, A } from './color';
import { celKey, defaultGrid, maskKey, newId, type Cel, type Doc, type Frame, type Layer, type LayerKind, type Pixel, type Rect, type Tag } from './types';
import { DEFAULT_PALETTE } from './palette';

export function newLayer(name: string, kind: LayerKind = 'image', parentId: string | null = null): Layer {
  return { id: newId('l'), name, kind, parentId, visible: true, locked: false, opacity: 255, blend: 'normal', alphaLock: false, clip: false, mask: false, maskEnabled: true, collapsed: false };
}

export function newDoc(width: number, height: number, name = 'Untitled', frames = 1): Doc {
  return {
    id: newId('sprite'), name, width, height, colorMode: 'rgba', palette: [...DEFAULT_PALETTE],
    layers: [newLayer('Layer 1')],
    frames: Array.from({ length: frames }, () => ({ id: newId('f'), duration: 100 })),
    cels: {}, tags: [], selection: null, guides: [], grid: defaultGrid(), fpsHint: 10,
  };
}

// --- Cels

/** Cuts empty space off an image. Returns null when it is fully transparent. */
export function trimToCel(data: Uint32Array, w: number, h: number, ox: number, oy: number, opacity = 255, id?: string): Cel | null {
  let l = w, r = -1, t = h, b = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x] >>> 24) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        b = y;
      }
    }
  }
  if (r < 0) return null;
  const cw = r - l + 1, ch = b - t + 1;
  const out = new Uint32Array(cw * ch);
  for (let y = 0; y < ch; y++) out.set(data.subarray((y + t) * w + l, (y + t) * w + r + 1), y * cw);
  return { id: id ?? newId('c'), x: ox + l, y: oy + t, w: cw, h: ch, data: out, opacity };
}

/** Copies a cel into a canvas-sized (or any rect-sized) buffer. */
export function celToBuffer(cel: Cel | undefined | null, rect: Rect): Uint32Array {
  const out = new Uint32Array(rect.w * rect.h);
  if (!cel) return out;
  const x0 = Math.max(cel.x, rect.x), x1 = Math.min(cel.x + cel.w, rect.x + rect.w);
  const y0 = Math.max(cel.y, rect.y), y1 = Math.min(cel.y + cel.h, rect.y + rect.h);
  if (x1 <= x0) return out;
  for (let y = y0; y < y1; y++) {
    const si = (y - cel.y) * cel.w + (x0 - cel.x);
    out.set(cel.data.subarray(si, si + (x1 - x0)), (y - rect.y) * rect.w + (x0 - rect.x));
  }
  return out;
}

/** Puts a cel at a key, or removes it when null. If the old cel is linked, every linked key follows. */
export function setCel(doc: Doc, key: string, cel: Cel | null, followLinks = true): Doc {
  const cels = { ...doc.cels };
  const old = cels[key];
  const keys = followLinks && old ? Object.keys(cels).filter((k) => cels[k] === old) : [key];
  for (const k of keys.length ? keys : [key]) { if (cel) cels[k] = cel; else delete cels[k]; }
  return { ...doc, cels };
}

// --- Layers

export const layerById = (doc: Doc, id: string | null | undefined) => doc.layers.find((l) => l.id === id);

export function updateLayer(doc: Doc, id: string, patch: Partial<Layer>): Doc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

/** Adds a layer just above another (or on top), in the same group. */
export function addLayer(doc: Doc, layer: Layer, above?: string | null): Doc {
  const layers = [...doc.layers];
  const anchor = above ? layers.findIndex((l) => l.id === above) : -1;
  if (anchor >= 0) {
    // Above a group means above all of its contents too; the flat order keeps a group's children after it.
    let at = anchor + 1;
    const inside = new Set(descendants(doc, layers[anchor].id).map((l) => l.id));
    while (at < layers.length && inside.has(layers[at].id)) at++;
    layer = { ...layer, parentId: layers[anchor].parentId };
    layers.splice(at, 0, layer);
  } else layers.push(layer);
  return { ...doc, layers };
}

export function descendants(doc: Doc, id: string): Layer[] {
  const out: Layer[] = [];
  const walk = (p: string) => { for (const l of doc.layers) if (l.parentId === p) { out.push(l); if (l.kind === 'group') walk(l.id); } };
  walk(id);
  return out;
}

export function removeLayer(doc: Doc, id: string): Doc {
  const gone = new Set([id, ...descendants(doc, id).map((l) => l.id)]);
  const cels: Record<string, Cel> = {};
  for (const [k, c] of Object.entries(doc.cels)) if (!gone.has(k.split(':')[0])) cels[k] = c;
  const out: Doc = { ...doc, layers: doc.layers.filter((l) => !gone.has(l.id)), cels };
  if (doc.motions?.length) out.motions = doc.motions.filter((m) => !gone.has(m.layerId));
  return out;
}

export function duplicateLayer(doc: Doc, id: string): { doc: Doc; id: string } {
  const src = layerById(doc, id)!;
  const copyTree = (d: Doc, from: Layer, parent: string | null, above: string | null | undefined): { doc: Doc; id: string } => {
    const l: Layer = { ...from, id: newId('l'), name: parent === from.parentId ? `${from.name} copy` : from.name, parentId: parent };
    let nd = above !== undefined ? addLayer(d, l, above) : { ...d, layers: [...d.layers, l] };
    if (above !== undefined) nd = updateLayer(nd, l.id, { parentId: parent });
    const cels = { ...nd.cels };
    // New Cel objects, so editing the copy leaves the original alone. Pixel arrays are immutable and can be shared, and
    // cels linked to each other inside the source layer stay linked inside the copy.
    const copies = new Map<Cel, Cel>();
    const copyOf = (c: Cel) => { let n = copies.get(c); if (!n) { n = { ...c, id: newId('c') }; copies.set(c, n); } return n; };
    for (const f of nd.frames) {
      const c = cels[celKey(from.id, f.id)];
      if (c) cels[celKey(l.id, f.id)] = copyOf(c);
      const m = cels[maskKey(from.id, f.id)];
      if (m) cels[maskKey(l.id, f.id)] = copyOf(m);
    }
    nd = { ...nd, cels };
    for (const child of d.layers.filter((x) => x.parentId === from.id)) nd = copyTree(nd, child, l.id, undefined).doc;
    return { doc: nd, id: l.id };
  };
  return copyTree(doc, src, src.parentId, id);
}

/** Moves a layer up (+1) or down (-1) among its siblings. */
export function moveLayer(doc: Doc, id: string, delta: number): Doc {
  const l = layerById(doc, id);
  if (!l) return doc;
  const sibs = doc.layers.filter((x) => x.parentId === l.parentId);
  const i = sibs.indexOf(l), j = i + delta;
  if (j < 0 || j >= sibs.length) return doc;
  const a = doc.layers.indexOf(l), b = doc.layers.indexOf(sibs[j]);
  const layers = [...doc.layers];
  layers[a] = sibs[j]; layers[b] = l;
  return { ...doc, layers };
}

/** Puts a layer into a group (or back to the top level), keeping it above what is already there. */
export function setLayerParent(doc: Doc, id: string, parentId: string | null): Doc {
  if (id === parentId || (parentId && descendants(doc, id).some((d) => d.id === parentId))) return doc;
  const l = layerById(doc, id)!;
  return { ...doc, layers: [...doc.layers.filter((x) => x !== l), { ...l, parentId }] };
}

/** Moves a layer to just above another, joining that layer's group. */
export function placeLayerAbove(doc: Doc, id: string, target: string): Doc {
  if (id === target) return doc;
  const l = layerById(doc, id), t = layerById(doc, target);
  if (!l || !t || descendants(doc, id).some((d) => d.id === target)) return doc;
  const layers = doc.layers.filter((x) => x !== l);
  layers.splice(layers.indexOf(t) + 1, 0, { ...l, parentId: t.parentId });
  return { ...doc, layers };
}

/** Top-to-bottom display order with depth, skipping the contents of collapsed groups. */
export function layerRows(doc: Doc): { layer: Layer; depth: number }[] {
  const rows: { layer: Layer; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const sibs = doc.layers.filter((l) => l.parentId === parent);
    for (let i = sibs.length - 1; i >= 0; i--) {
      rows.push({ layer: sibs[i], depth });
      if (sibs[i].kind === 'group' && !sibs[i].collapsed) walk(sibs[i].id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

// --- Frames

function shiftTags(tags: Tag[], at: number, delta: number): Tag[] {
  return tags.map((t) => ({ ...t, from: t.from >= at ? t.from + delta : t.from, to: t.to >= at ? t.to + delta : t.to }));
}

export function insertFrame(doc: Doc, at: number, duration = doc.frames[Math.max(0, at - 1)]?.duration ?? 100): Doc {
  const frames = [...doc.frames];
  frames.splice(at, 0, { id: newId('f'), duration });
  return { ...doc, frames, tags: shiftTags(doc.tags, at, 1) };
}

/** Copies a frame right after itself. With link=true the new frame's cels are linked to the originals. */
export function duplicateFrame(doc: Doc, index: number, link = false): Doc {
  const src = doc.frames[index];
  const copy: Frame = { id: newId('f'), duration: src.duration };
  const frames = [...doc.frames];
  frames.splice(index + 1, 0, copy);
  const cels = { ...doc.cels };
  for (const l of doc.layers) {
    const c = doc.cels[celKey(l.id, src.id)];
    if (c) cels[celKey(l.id, copy.id)] = link ? c : { ...c, id: newId('c') };
    const m = doc.cels[maskKey(l.id, src.id)];
    if (m) cels[maskKey(l.id, copy.id)] = link ? m : { ...m, id: newId('c') };
  }
  return { ...doc, frames, cels, tags: shiftTags(doc.tags, index + 1, 1) };
}

export function removeFrame(doc: Doc, index: number): Doc {
  if (doc.frames.length <= 1) return doc;
  const f = doc.frames[index];
  const cels: Record<string, Cel> = {};
  for (const [k, c] of Object.entries(doc.cels)) if (k.split(':')[1] !== f.id) cels[k] = c;
  const tags = doc.tags
    .map((t) => ({ ...t, from: t.from > index ? t.from - 1 : t.from, to: t.to >= index ? t.to - 1 : t.to }))
    .filter((t) => t.to >= t.from);
  return { ...doc, frames: doc.frames.filter((_, i) => i !== index), cels, tags };
}

export function moveFrame(doc: Doc, from: number, to: number): Doc {
  if (from === to || to < 0 || to >= doc.frames.length) return doc;
  const frames = [...doc.frames];
  const [f] = frames.splice(from, 1);
  frames.splice(to, 0, f);
  return { ...doc, frames };
}

export const totalDuration = (doc: Doc) => doc.frames.reduce((s, f) => s + f.duration, 0);

/** Moves, copies or links a cel to another position. */
export function placeCel(doc: Doc, fromKey: string, toKey: string, mode: 'move' | 'copy' | 'link'): Doc {
  const c = doc.cels[fromKey];
  if (fromKey === toKey) return doc;
  const cels = { ...doc.cels };
  if (!c) { if (mode === 'move') delete cels[toKey]; return { ...doc, cels }; }
  cels[toKey] = mode === 'copy' ? { ...c, id: newId('c') } : c;
  if (mode === 'move') delete cels[fromKey];
  return { ...doc, cels };
}

export const isLinkedCel = (doc: Doc, key: string) => {
  const c = doc.cels[key];
  if (!c) return false;
  let n = 0;
  for (const k in doc.cels) if (doc.cels[k] === c && ++n > 1) return true;
  return false;
};

// --- Whole-sprite pixel operations

export function mapAllCels(doc: Doc, fn: (cel: Cel, key: string) => Cel | null): Doc {
  const seen = new Map<Cel, Cel | null>();
  const cels: Record<string, Cel> = {};
  for (const [k, c] of Object.entries(doc.cels)) {
    if (!seen.has(c)) seen.set(c, fn(c, k));
    const n = seen.get(c);
    if (n) cels[k] = n;
  }
  return { ...doc, cels };
}

/** Recolours every pixel through a function. Skips mask cels, whose colour means nothing. */
export function mapPixels(doc: Doc, fn: (p: Pixel) => Pixel): Doc {
  return mapAllCels(doc, (c, k) => {
    if (k.endsWith(':m')) return c;
    const data = new Uint32Array(c.data.length);
    for (let i = 0; i < data.length; i++) data[i] = A(c.data[i]) ? fn(c.data[i]) : 0;
    return { ...c, data };
  });
}

/** Snaps every pixel to the palette and marks the document indexed. */
export function toIndexed(doc: Doc): Doc {
  if (!doc.palette.length) return doc;
  const cache = new Map<number, number>();
  const pal = doc.palette;
  return { ...mapPixels(doc, (p) => {
    let c = cache.get(p);
    if (c === undefined) { c = pal[nearestIndex(p, pal)]; cache.set(p, c); }
    return c;
  }), colorMode: 'indexed' };
}

/** Changes the canvas size without scaling. Content keeps its offset from the chosen anchor (0, 0.5 or 1 on each axis). */
export function resizeCanvas(doc: Doc, width: number, height: number, ax = 0, ay = 0): Doc {
  const dx = Math.round((width - doc.width) * ax), dy = Math.round((height - doc.height) * ay);
  return { ...mapAllCels(doc, (c) => ({ ...c, x: c.x + dx, y: c.y + dy })), width, height, selection: null };
}

/** Scales the whole sprite with nearest-neighbour sampling. */
export function scaleSprite(doc: Doc, width: number, height: number): Doc {
  const sx = width / doc.width, sy = height / doc.height;
  return { ...mapAllCels(doc, (c) => {
    const w = Math.max(1, Math.round(c.w * sx)), h = Math.max(1, Math.round(c.h * sy));
    const data = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      const v = Math.min(c.h - 1, Math.floor(((y + 0.5) * c.h) / h));
      for (let x = 0; x < w; x++) data[y * w + x] = c.data[v * c.w + Math.min(c.w - 1, Math.floor(((x + 0.5) * c.w) / w))];
    }
    return { ...c, x: Math.round(c.x * sx), y: Math.round(c.y * sy), w, h, data };
  }), width, height, selection: null };
}

export function flipCel(c: Cel, axis: 'h' | 'v', docW: number, docH: number): Cel {
  const data = new Uint32Array(c.data.length);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const nx = axis === 'h' ? c.w - 1 - x : x, ny = axis === 'v' ? c.h - 1 - y : y;
    data[ny * c.w + nx] = c.data[y * c.w + x];
  }
  return { ...c, data, x: axis === 'h' ? docW - c.x - c.w : c.x, y: axis === 'v' ? docH - c.y - c.h : c.y };
}

export const flipSprite = (doc: Doc, axis: 'h' | 'v'): Doc => ({ ...mapAllCels(doc, (c) => flipCel(c, axis, doc.width, doc.height)), selection: null });

/** Turns the whole sprite by 90 degree steps clockwise. */
export function rotateSprite(doc: Doc, quarter: 1 | 2 | 3): Doc {
  const W = doc.width, H = doc.height;
  const turn = (c: Cel): Cel => {
    const w = quarter === 2 ? c.w : c.h, h = quarter === 2 ? c.h : c.w;
    const data = new Uint32Array(w * h);
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const p = c.data[y * c.w + x];
      if (quarter === 1) data[x * w + (c.h - 1 - y)] = p;
      else if (quarter === 2) data[(c.h - 1 - y) * w + (c.w - 1 - x)] = p;
      else data[(c.w - 1 - x) * w + y] = p;
    }
    const nx = quarter === 1 ? H - c.y - c.h : quarter === 2 ? W - c.x - c.w : c.y;
    const ny = quarter === 1 ? c.x : quarter === 2 ? H - c.y - c.h : W - c.x - c.w;
    return { ...c, data, x: nx, y: ny, w, h };
  };
  return { ...mapAllCels(doc, turn), width: quarter === 2 ? W : H, height: quarter === 2 ? H : W, selection: null };
}

/** The smallest box around everything visible on any frame, or null for an empty sprite. */
export function contentBounds(doc: Doc): Rect | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const [k, c] of Object.entries(doc.cels)) {
    if (k.endsWith(':m') || k.includes(':src:')) continue;
    l = Math.min(l, c.x); t = Math.min(t, c.y); r = Math.max(r, c.x + c.w); b = Math.max(b, c.y + c.h);
  }
  return r > l ? { x: l, y: t, w: r - l, h: b - t } : null;
}

export function cropTo(doc: Doc, rect: Rect): Doc {
  return { ...mapAllCels(doc, (c) => ({ ...c, x: c.x - rect.x, y: c.y - rect.y })), width: rect.w, height: rect.h, selection: null };
}

/** Rough memory held by a set of documents, counting shared cels once. Used to keep undo history within a budget. */
export function celBytes(docs: Doc[]): number {
  const seen = new Set<Uint32Array>();
  let n = 0;
  for (const d of docs) for (const k in d.cels) {
    const a = d.cels[k].data;
    if (!seen.has(a)) { seen.add(a); n += a.byteLength; }
  }
  return n;
}
