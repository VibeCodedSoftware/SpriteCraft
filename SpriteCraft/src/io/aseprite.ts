// .ase / .aseprite reader and writer, written from the published file format specification
// (https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md).
// Kept on read: layers, groups, frames and durations, cels (linked too), tags, palette, blend modes, opacity, grid.
// Tilemap layers are drawn into plain pixels. What cannot be kept is reported in `warnings`, never dropped silently.
import { unzlibSync, zlibSync } from 'fflate';
import { blendIndex, shadedLayer } from '../core/compose';
import { fromHex, rgba, toHex } from '../core/color';
import { newDoc, newLayer, trimToCel } from '../core/doc';
import { BLEND_MODES, celKey, maskKey, newId, type Cel, type Doc, type Layer, type LoopDir, type Tag } from '../core/types';

const DIRS: LoopDir[] = ['forward', 'reverse', 'pingpong', 'pingpong-reverse'];

class Reader {
  dv: DataView; at = 0;
  constructor(public b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8() { return this.b[this.at++]; }
  u16() { const v = this.dv.getUint16(this.at, true); this.at += 2; return v; }
  i16() { const v = this.dv.getInt16(this.at, true); this.at += 2; return v; }
  u32() { const v = this.dv.getUint32(this.at, true); this.at += 4; return v; }
  skip(n: number) { this.at += n; }
  str() { const n = this.u16(); const s = new TextDecoder().decode(this.b.subarray(this.at, this.at + n)); this.at += n; return s; }
}

export interface AseResult { doc: Doc; warnings: string[] }

export function readAseprite(file: Uint8Array, name = 'Imported'): AseResult {
  const r = new Reader(file);
  r.skip(4);
  if (r.u16() !== 0xa5e0) throw new Error('Not an Aseprite file');
  const frameCount = r.u16(), W = r.u16(), H = r.u16(), depth = r.u16(), hdrFlags = r.u32();
  r.skip(2 + 8);
  const transIndex = r.u8();
  r.skip(3);
  r.u16(); r.skip(2);
  const gridX = r.i16(), gridY = r.i16(), gridW = r.u16(), gridH = r.u16();
  r.at = 128;
  if (depth !== 32 && depth !== 16 && depth !== 8) throw new Error(`Unsupported colour depth: ${depth}`);

  const warnings = new Set<string>();
  const doc = newDoc(W, H, name, Math.max(1, frameCount));
  doc.layers = [];
  doc.cels = {};
  let palette: number[] = [];
  let sawNewPalette = false;
  const layers: { layer: Layer; type: number; tileset: number }[] = [];
  const parents: (string | null)[] = [null];
  const tilesets = new Map<number, { w: number; h: number; data: Uint32Array }>();
  const groupsValid = (hdrFlags & 2) !== 0, opacityValid = (hdrFlags & 1) !== 0;
  const bpp = depth === 32 ? 4 : depth === 16 ? 2 : 1;

  /** Converts raw pixels to our format. The palette chunk comes first in real files. */
  const toPixels = (raw: Uint8Array, n: number, background = false) => {
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      if (depth === 32) out[i] = rgba(raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3]);
      else if (depth === 16) out[i] = rgba(raw[i * 2], raw[i * 2], raw[i * 2], raw[i * 2 + 1]);
      else out[i] = raw[i] === transIndex && !background ? 0 : palette[raw[i]] ?? 0;
    }
    return out;
  };

  const frameStart = (f: number) => doc.frames[f];
  let tags: Tag[] = [];
  /** Tags whose colours still wait for their user data chunks. */
  let tagColorQueue = 0, firstQueued = 0;
  const celsByFrame: Cel[][] = doc.frames.map(() => []);

  for (let f = 0; f < frameCount; f++) {
    const start = r.at;
    const bytes = r.u32();
    if (r.u16() !== 0xf1fa) throw new Error('This Aseprite file is damaged (bad frame header)');
    const oldChunks = r.u16();
    doc.frames[f].duration = r.u16() || 100;
    r.skip(2);
    const newChunks = r.u32();
    const chunks = newChunks || oldChunks;
    for (let c = 0; c < chunks; c++) {
      const chunkStart = r.at;
      const size = r.u32(), type = r.u16();
      const chunkEnd = chunkStart + size;
      switch (type) {
        case 0x2019: {
          const total = r.u32(), from = r.u32(), to = r.u32();
          r.skip(8);
          if (!sawNewPalette) palette = new Array(total).fill(0);
          sawNewPalette = true;
          for (let i = from; i <= to; i++) {
            const fl = r.u16();
            palette[i] = rgba(r.u8(), r.u8(), r.u8(), r.u8());
            if (fl & 1) r.str();
          }
          break;
        }
        case 0x0004: case 0x0011: {
          if (sawNewPalette) break;
          const packets = r.u16();
          let idx = 0;
          for (let p = 0; p < packets; p++) {
            idx += r.u8();
            let n = r.u8(); if (n === 0) n = 256;
            for (let i = 0; i < n; i++, idx++) {
              const R0 = r.u8(), G0 = r.u8(), B0 = r.u8();
              palette[idx] = type === 0x0004 ? rgba(R0, G0, B0) : rgba(R0 * 4, G0 * 4, B0 * 4);
            }
          }
          break;
        }
        case 0x2004: {
          const fl = r.u16(), kind = r.u16(), level = r.u16();
          r.skip(4);
          const blend = r.u16(), opacity = r.u8();
          r.skip(3);
          const lname = r.str();
          const tileset = kind === 2 ? r.u32() : 0;
          const l = newLayer(lname, kind === 1 ? 'group' : fl & 64 ? 'reference' : 'image', level > 0 ? parents[level] ?? null : null);
          l.visible = (fl & 1) !== 0;
          l.locked = (fl & 2) === 0;
          l.collapsed = (fl & 32) !== 0;
          l.blend = BLEND_MODES[blend] ?? 'normal';
          l.opacity = (kind === 1 ? groupsValid : opacityValid) ? opacity : 255;
          if (kind === 1) { if (!groupsValid) { l.blend = 'normal'; } }
          parents[level + 1] = l.id;
          layers.push({ layer: l, type: kind, tileset });
          doc.layers.push(l);
          break;
        }
        case 0x2005: {
          const li = r.u16(), x = r.i16(), y = r.i16(), opacity = r.u8(), ct = r.u16(), z = r.i16();
          r.skip(5);
          if (z !== 0) warnings.add('Per-cel z-index is not supported; those cels draw in plain layer order.');
          const info = layers[li];
          if (!info) break;
          const key = celKey(info.layer.id, doc.frames[f].id);
          if (ct === 1) {
            const lf = r.u16();
            const linked = doc.cels[celKey(info.layer.id, frameStart(lf).id)];
            if (linked) doc.cels[key] = linked;
          } else if (ct === 0 || ct === 2) {
            const w = r.u16(), h = r.u16();
            const raw = ct === 2 ? unzlibSync(file.subarray(r.at, chunkEnd)) : file.subarray(r.at, chunkEnd);
            const data = toPixels(raw, w * h);
            const cel: Cel = { id: newId('c'), x, y, w, h, data, opacity };
            doc.cels[key] = cel;
            celsByFrame[f].push(cel);
          } else if (ct === 3) {
            const tw = r.u16(), th = r.u16(), bits = r.u16(), idMask = r.u32(), xf = r.u32(), yf = r.u32(), df = r.u32();
            r.skip(10);
            const raw = unzlibSync(file.subarray(r.at, chunkEnd));
            const ts = tilesets.get(info.tileset);
            if (!ts) { warnings.add('A tilemap referred to a tileset that was not in the file; it came in empty.'); break; }
            warnings.add('Tilemap layers came in as plain image layers (tile editing is planned, not built yet).');
            const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
            const iw = tw * ts.w, ih = th * ts.h;
            const data = new Uint32Array(iw * ih);
            for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
              const v = bits === 32 ? dv.getUint32((ty * tw + tx) * 4, true) : bits === 16 ? dv.getUint16((ty * tw + tx) * 2, true) : raw[ty * tw + tx];
              const id = v & idMask;
              if (id === 0) continue;
              for (let py = 0; py < ts.h; py++) for (let px = 0; px < ts.w; px++) {
                let sx = px, sy = py;
                if (v & df) { const t = sx; sx = sy; sy = t; }
                if (v & xf) sx = ts.w - 1 - sx;
                if (v & yf) sy = ts.h - 1 - sy;
                data[(ty * ts.h + py) * iw + tx * ts.w + px] = ts.data[(id * ts.h + sy) * ts.w + sx] ?? 0;
              }
            }
            const cel = trimToCel(data, iw, ih, x, y, opacity);
            if (cel) doc.cels[key] = cel;
          }
          break;
        }
        case 0x2018: {
          const n = r.u16();
          r.skip(8);
          tags = [...tags];
          firstQueued = tags.length;
          for (let t = 0; t < n; t++) {
            const from = r.u16(), to = r.u16(), dir = r.u8(), repeat = r.u16();
            r.skip(6);
            const cr = r.u8(), cg = r.u8(), cb = r.u8();
            r.skip(1);
            tags.push({ id: newId('t'), name: r.str(), from, to, dir: DIRS[dir] ?? 'forward', repeat, color: toHex(rgba(cr, cg, cb)) });
          }
          tagColorQueue = n;
          break;
        }
        case 0x2020: {
          if (tagColorQueue > 0) {
            const flags = r.u32();
            if (flags & 1) r.str();
            if (flags & 2) { const col = rgba(r.u8(), r.u8(), r.u8()); tags[firstQueued].color = toHex(col); }
            firstQueued++; tagColorQueue--;
          }
          break;
        }
        case 0x2022:
          warnings.add('Slices are not supported yet and were left out.');
          break;
        case 0x2023: {
          const id = r.u32(), fl = r.u32(), n = r.u32(), tw = r.u16(), th = r.u16();
          r.i16(); r.skip(14); r.str();
          if (fl & 1) { r.skip(8); warnings.add('A tileset stored in an external file could not be read.'); }
          if (fl & 2) {
            const len = r.u32();
            const raw = unzlibSync(file.subarray(r.at, r.at + len));
            tilesets.set(id, { w: tw, h: th, data: toPixels(raw, tw * th * n) });
          }
          break;
        }
        default: break;
      }
      r.at = chunkEnd;
    }
    r.at = start + bytes;
  }
  void bpp;
  doc.tags = tags;
  if (palette.length) doc.palette = palette.filter((c, i) => !(depth === 8 && i === transIndex && (c >>> 24) === 0));
  if (gridW && gridH && (gridW !== 16 || gridH !== 16 || gridX || gridY)) doc.grid = { ...doc.grid, tileW: gridW, tileH: gridH, offX: gridX, offY: gridY };
  if (depth === 8) warnings.add('This was an indexed file. It came in as RGB with its palette kept; choose Sprite › Colour mode › Indexed to lock it to the palette again.');
  if (!doc.layers.length) doc.layers = [newLayer('Layer 1')];
  return { doc, warnings: [...warnings] };
}

// --- Writer

class Writer {
  parts: number[] = [];
  buf = new Uint8Array(1 << 16); len = 0;
  ensure(n: number) { if (this.len + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n)); b.set(this.buf.subarray(0, this.len)); this.buf = b; } }
  u8(v: number) { this.ensure(1); this.buf[this.len++] = v & 255; }
  u16(v: number) { this.ensure(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >> 8) & 255; }
  i16(v: number) { this.u16(v & 0xffff); }
  u32(v: number) { this.ensure(4); new DataView(this.buf.buffer).setUint32(this.len, v >>> 0, true); this.len += 4; }
  zero(n: number) { this.ensure(n); this.buf.fill(0, this.len, this.len + n); this.len += n; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  str(s: string) { const b = new TextEncoder().encode(s); this.u16(b.length); this.bytes(b); }
  patch32(at: number, v: number) { new DataView(this.buf.buffer).setUint32(at, v >>> 0, true); }
  patch16(at: number, v: number) { new DataView(this.buf.buffer).setUint16(at, v, true); }
  result() { return this.buf.slice(0, this.len); }
}

/** Layers in file order: a group first, then its children, each level bottom to top, with their nesting depth. */
function fileOrder(doc: Doc): { layer: Layer; level: number }[] {
  const out: { layer: Layer; level: number }[] = [];
  const walk = (p: string | null, level: number) => {
    for (const l of doc.layers) if (l.parentId === p) { out.push({ layer: l, level }); if (l.kind === 'group') walk(l.id, level + 1); }
  };
  walk(null, 0);
  return out;
}

/** Layer masks do not exist in this format, so a masked cel is written with the mask already applied. */
function celWithMask(doc: Doc, l: Layer, frameId: string, c: Cel): Cel {
  const m = l.mask && l.maskEnabled ? doc.cels[maskKey(l.id, frameId)] : undefined;
  if (!m) return c;
  const data = new Uint32Array(c.data);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const mx = c.x + x - m.x, my = c.y + y - m.y;
    if (mx < 0 || my < 0 || mx >= m.w || my >= m.h) continue;
    const hide = m.data[my * m.w + mx] >>> 24;
    const i = y * c.w + x, a = data[i] >>> 24;
    data[i] = ((data[i] & 0xffffff) | ((((a * (255 - hide)) / 255) | 0) << 24)) >>> 0;
  }
  return { ...c, data };
}

/**
 * Layers with live effects (shaders, particles, weather, node graphs) as plain pixels: each frame drawn as it looks,
 * the effects removed. Aseprite has no live effects, so this keeps what you see.
 */
export function flattenLiveEffects(doc: Doc): { doc: Doc; names: string[] } {
  const live = doc.layers.filter((l) => l.kind === 'image' && l.fx?.some((f) => f.on));
  if (!live.length) return { doc, names: [] };
  const cels = { ...doc.cels };
  for (const l of live) {
    doc.frames.forEach((fr, i) => {
      const key = celKey(l.id, fr.id);
      const c = trimToCel(shadedLayer(doc, l.id, i), doc.width, doc.height, 0, 0, doc.cels[key]?.opacity ?? 255);
      if (c) cels[key] = c; else delete cels[key];
    });
  }
  const ids = new Set(live.map((l) => l.id));
  return { doc: { ...doc, cels, layers: doc.layers.map((l) => (ids.has(l.id) ? { ...l, fx: undefined } : l)) }, names: live.map((l) => l.name) };
}

export function writeAseprite(source: Doc): { bytes: Uint8Array; warnings: string[] } {
  const warnings = new Set<string>();
  const flat = flattenLiveEffects(source), doc = flat.doc;
  if (flat.names.length) warnings.add(`Live effects don't exist in this format: they were drawn into the pixels of ${flat.names.map((n) => `"${n}"`).join(', ')}. Keep the .spritecraft file to change them later.`);
  const order = fileOrder(doc);
  const w = new Writer();
  w.zero(128);
  w.patch16(4, 0xa5e0);
  w.patch16(6, doc.frames.length);
  w.patch16(8, doc.width);
  w.patch16(10, doc.height);
  w.patch16(12, 32);
  w.patch32(14, 3); // Layer opacity and group blending are valid.
  w.patch16(18, doc.frames[0]?.duration ?? 100);
  w.patch16(32, Math.min(0xffff, doc.palette.length));
  w.buf[36] = 1; w.buf[37] = 1;
  w.patch16(38, doc.grid.offX & 0xffff);
  w.patch16(40, doc.grid.offY & 0xffff);
  w.patch16(42, doc.grid.tileW);
  w.patch16(44, doc.grid.tileH);

  /** Global cel position → first frame holding that object, for linked cels. */
  const firstOf = new Map<string, Map<Cel, number>>();
  doc.frames.forEach((frame, f) => {
    const start = w.len;
    w.u32(0); w.u16(0xf1fa); const countAt = w.len; w.u16(0); w.u16(frame.duration); w.zero(2); w.u32(0);
    let chunks = 0;
    const chunk = (type: number, body: () => void) => {
      const s = w.len; w.u32(0); w.u16(type); body(); w.patch32(s, w.len - s); chunks++;
    };
    if (f === 0) {
      chunk(0x2019, () => {
        w.u32(doc.palette.length); w.u32(0); w.u32(Math.max(0, doc.palette.length - 1)); w.zero(8);
        for (const c of doc.palette) { w.u16(0); w.u8(c); w.u8(c >>> 8); w.u8(c >>> 16); w.u8(c >>> 24); }
      });
      for (const { layer: l, level } of order) {
        if (l.clip) warnings.add('Clipping masks do not exist in this format: those layers were saved unclipped.');
        chunk(0x2004, () => {
          w.u16((l.visible ? 1 : 0) | (l.locked ? 0 : 2) | (l.collapsed ? 32 : 0) | (l.kind === 'reference' ? 64 : 0));
          w.u16(l.kind === 'group' ? 1 : 0); w.u16(level); w.u16(0); w.u16(0);
          w.u16(blendIndex(l.blend)); w.u8(l.opacity); w.zero(3); w.str(l.name);
        });
        if (l.mask) warnings.add('Layer masks do not exist in this format: they were applied to the pixels.');
      }
      if (doc.tags.length) {
        chunk(0x2018, () => {
          w.u16(doc.tags.length); w.zero(8);
          for (const t of doc.tags) {
            const col = fromHex(t.color) ?? rgba(0, 0, 0);
            w.u16(t.from); w.u16(t.to); w.u8(DIRS.indexOf(t.dir)); w.u16(t.repeat); w.zero(6);
            w.u8(col); w.u8(col >>> 8); w.u8(col >>> 16); w.u8(0); w.str(t.name);
          }
        });
        for (const t of doc.tags) {
          const col = fromHex(t.color) ?? rgba(0, 0, 0);
          chunk(0x2020, () => { w.u32(2); w.u8(col); w.u8(col >>> 8); w.u8(col >>> 16); w.u8(255); });
        }
      }
    }
    order.forEach(({ layer: l }, li) => {
      if (l.kind === 'group') return;
      const c0 = doc.cels[celKey(l.id, frame.id)];
      if (!c0) return;
      let seen = firstOf.get(l.id);
      if (!seen) { seen = new Map(); firstOf.set(l.id, seen); }
      const linkFrame = seen.get(c0);
      chunk(0x2005, () => {
        w.u16(li); w.i16(c0.x); w.i16(c0.y); w.u8(c0.opacity);
        if (linkFrame !== undefined) { w.u16(1); w.i16(0); w.zero(5); w.u16(linkFrame); return; }
        seen!.set(c0, f);
        const c = celWithMask(doc, l, frame.id, c0);
        w.u16(2); w.i16(0); w.zero(5); w.u16(c.w); w.u16(c.h);
        w.bytes(zlibSync(new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.byteLength), { level: 6 }));
      });
    });
    w.patch32(start, w.len - start);
    w.patch16(countAt, Math.min(0xffff, chunks));
    w.patch32(countAt + 6, chunks);
  });
  w.patch32(0, w.len);
  return { bytes: w.result(), warnings: [...warnings] };
}
