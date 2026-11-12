// Animated GIF reading and writing. GIF only has on/off transparency and 256 colours; both limits are handled here and
// described to the user at export time.
import { extractPalette } from '../core/palette';
import { A, B, G, R, nearestIndex, rgba } from '../core/color';
import type { Pixel } from '../core/types';

export interface GifFrame { data: Uint32Array; delay: number }

function lzwEncode(indices: Uint8Array, minCode: number, out: number[]) {
  const clear = 1 << minCode, end = clear + 1;
  let size = minCode + 1, next = end + 1;
  let dict = new Map<number, number>();
  let bits = 0, nbits = 0;
  const block: number[] = [];
  const flushBlock = () => { if (block.length) { out.push(block.length, ...block); block.length = 0; } };
  const emit = (code: number) => {
    bits |= code << nbits; nbits += size;
    while (nbits >= 8) { block.push(bits & 255); bits >>>= 8; nbits -= 8; if (block.length === 255) flushBlock(); }
  };
  out.push(minCode);
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next);
      // Grow only after the entry that needs the larger size exists: the decoder is always one entry behind.
      if (next === 1 << size && size < 12) size++;
      next++;
    } else {
      emit(clear);
      dict = new Map(); size = minCode + 1; next = end + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(end);
  if (nbits > 0) block.push(bits & 255);
  flushBlock();
  out.push(0);
}

export interface GifOptions { loop?: boolean; palette?: Pixel[]; matte?: Pixel | null; alphaThreshold?: number }

/** Writes an animation. Colours are mapped to `palette`, or reduced from the frames when there are more than fit. */
export function encodeGif(frames: GifFrame[], w: number, h: number, o: GifOptions = {}): Uint8Array {
  const thresh = o.alphaThreshold ?? 128;
  const matte = o.matte ?? null;
  const flat = (p: number) => {
    if (matte === null || A(p) === 255) return p;
    const a = A(p) / 255;
    return rgba(Math.round(R(p) * a + R(matte) * (1 - a)), Math.round(G(p) * a + G(matte) * (1 - a)), Math.round(B(p) * a + B(matte) * (1 - a)));
  };
  const flatFrames = matte === null ? frames.map((f) => f.data) : frames.map((f) => f.data.map(flat));
  const hasTrans = matte === null && flatFrames.some((d) => d.some((p) => A(p) < thresh));
  const room = hasTrans ? 255 : 256;
  const pal = o.palette && o.palette.length <= room ? o.palette : extractPalette(flatFrames, room);
  const colors = hasTrans ? [rgba(0, 0, 0), ...pal] : pal.length ? pal : [rgba(0, 0, 0)];
  const first = hasTrans ? 1 : 0;
  let bitsN = 1;
  while (1 << bitsN < colors.length) bitsN++;
  const tableSize = 1 << bitsN;

  const out: number[] = [];
  const str = (s: string) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  const u16 = (n: number) => out.push(n & 255, (n >> 8) & 255);
  str('GIF89a'); u16(w); u16(h);
  out.push(0x80 | 0x70 | (bitsN - 1), 0, 0);
  for (let i = 0; i < tableSize; i++) { const c = colors[i] ?? 0; out.push(R(c), G(c), B(c)); }
  if (o.loop !== false && frames.length > 1) { out.push(0x21, 0xff, 11); str('NETSCAPE2.0'); out.push(3, 1, 0, 0, 0); }

  const cache = new Map<number, number>();
  const solid = colors.slice(first);
  const indices = new Uint8Array(w * h);
  flatFrames.forEach((data, f) => {
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      if (hasTrans && A(p) < thresh) { indices[i] = 0; continue; }
      const o2 = (p | 0xff000000) >>> 0;
      let idx = cache.get(o2);
      if (idx === undefined) { idx = nearestIndex(o2, solid) + first; cache.set(o2, idx); }
      indices[i] = idx;
    }
    const cs = Math.max(2, Math.round(frames[f].delay / 10));
    // Each frame replaces the last whole: disposal "restore to background" stops transparent frames piling up.
    out.push(0x21, 0xf9, 4, ((hasTrans ? 2 : 1) << 2) | (hasTrans ? 1 : 0), cs & 255, (cs >> 8) & 255, 0, 0);
    out.push(0x2c); u16(0); u16(0); u16(w); u16(h); out.push(0);
    lzwEncode(indices, Math.max(2, bitsN), out);
  });
  out.push(0x3b);
  return Uint8Array.from(out);
}

export function decodeGif(file: Uint8Array): { w: number; h: number; frames: GifFrame[] } {
  const sig = String.fromCharCode(...file.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('Not a GIF file');
  const w = file[6] | (file[7] << 8), h = file[8] | (file[9] << 8);
  let at = 13;
  const readTable = (size: number) => { const t: number[] = []; for (let i = 0; i < size; i++) { t.push(rgba(file[at], file[at + 1], file[at + 2])); at += 3; } return t; };
  const flags = file[10];
  const gct = flags & 0x80 ? readTable(2 << (flags & 7)) : [];
  const canvas = new Uint32Array(w * h);
  const frames: GifFrame[] = [];
  let delay = 100, trans = -1, disposal = 0;
  while (at < file.length) {
    const b = file[at++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = file[at++];
      if (label === 0xf9) {
        const f = file[at + 1];
        disposal = (f >> 2) & 7;
        delay = (file[at + 2] | (file[at + 3] << 8)) * 10 || 100;
        trans = f & 1 ? file[at + 4] : -1;
      }
      while (file[at]) at += file[at] + 1;
      at++;
    } else if (b === 0x2c) {
      const fx = file[at] | (file[at + 1] << 8), fy = file[at + 2] | (file[at + 3] << 8);
      const fw = file[at + 4] | (file[at + 5] << 8), fh = file[at + 6] | (file[at + 7] << 8), fl = file[at + 8];
      at += 9;
      const table = fl & 0x80 ? readTable(2 << (fl & 7)) : gct;
      const pixels = lzwDecode(file, at, fw * fh);
      at = pixels.next;
      const saved = disposal === 3 ? canvas.slice() : null;
      const interlaced = (fl & 0x40) !== 0;
      const rowOf = (() => {
        if (!interlaced) return (i: number) => i;
        const rows: number[] = [];
        for (const [s, d] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let r = s; r < fh; r += d) rows.push(r);
        return (i: number) => rows[i];
      })();
      for (let row = 0; row < fh; row++) {
        const y = fy + rowOf(row);
        if (y >= h) continue;
        for (let x = 0; x < fw; x++) {
          const v = pixels.data[row * fw + x];
          if (v === trans || fx + x >= w) continue;
          canvas[y * w + fx + x] = table[v] ?? 0;
        }
      }
      frames.push({ data: canvas.slice(), delay });
      if (disposal === 2) for (let y = fy; y < Math.min(h, fy + fh); y++) canvas.fill(0, y * w + fx, y * w + Math.min(w, fx + fw));
      else if (saved) canvas.set(saved);
      delay = 100; trans = -1; disposal = 0;
    } else break;
  }
  if (!frames.length) throw new Error('This GIF has no frames');
  return { w, h, frames };
}

function lzwDecode(file: Uint8Array, start: number, count: number) {
  let at = start;
  const minCode = file[at++];
  const clear = 1 << minCode, end = clear + 1;
  const data = new Uint8Array(count);
  let n = 0, size = minCode + 1, mask = (1 << size) - 1, next = end + 1, old = -1;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let bits = 0, nbits = 0, first = 0;
  let left = 0;
  outer: for (;;) {
    while (nbits < size) {
      if (left === 0) { left = file[at++]; if (!left) break outer; }
      bits |= file[at++] << nbits; nbits += 8; left--;
    }
    const code = bits & mask;
    bits >>>= size; nbits -= size;
    if (code === clear) { size = minCode + 1; mask = (1 << size) - 1; next = end + 1; old = -1; continue; }
    if (code === end) break;
    let top = 0, c = code;
    if (old === -1) { if (n < count) data[n++] = suffix[code]; first = suffix[code]; old = code; continue; }
    if (code >= next) { stack[top++] = first; c = old; }
    while (c >= clear) { stack[top++] = suffix[c]; c = prefix[c]; }
    first = suffix[c];
    stack[top++] = first;
    if (next < 4096) {
      prefix[next] = old; suffix[next] = first; next++;
      if (next === 1 << size && size < 12) { size++; mask = (1 << size) - 1; }
    }
    while (top > 0 && n < count) data[n++] = stack[--top];
    old = code;
  }
  // Skip what remains of the image data.
  if (left > 0) at += left;
  while (at < file.length && file[at]) at += file[at] + 1;
  return { data, next: at + 1 };
}
