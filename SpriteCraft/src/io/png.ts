// A PNG reader and writer in plain code. Canvas APIs premultiply alpha and can change colours in semi-transparent pixels,
// which is not acceptable for pixel art, so files round-trip exactly here.
import { unzlibSync, zlibSync } from 'fflate';

export interface Image32 { w: number; h: number; data: Uint32Array }

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(img: Image32, opts: { text?: Record<string, string> } = {}): Uint8Array {
  const { w, h, data } = img;
  const rowBytes = w * 4 + 1;
  const raw = new Uint8Array(rowBytes * h);
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes;
    const src = y * w * 4;
    // Filter "Up" compresses repeating pixel art rows well and is cheap: rows equal to the previous one become zeros.
    if (y === 0) { raw[row] = 0; raw.set(bytes.subarray(src, src + w * 4), row + 1); continue; }
    raw[row] = 2;
    const prev = src - w * 4;
    for (let i = 0; i < w * 4; i++) raw[row + 1 + i] = (bytes[src + i] - bytes[prev + i]) & 255;
  }
  const idat = zlibSync(raw, { level: 9 });
  const texts = Object.entries(opts.text ?? {}).map(([k, v]) => new TextEncoder().encode(`${k}\0${v}`));
  const size = 8 + (12 + 13) + texts.reduce((s, t) => s + 12 + t.length, 0) + (12 + idat.length) + 12;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = 8;
  const chunk = (type: string, body: Uint8Array) => {
    dv.setUint32(at, body.length); at += 4;
    const start = at;
    for (let i = 0; i < 4; i++) out[at++] = type.charCodeAt(i);
    out.set(body, at); at += body.length;
    dv.setUint32(at, crc32(out, start, at)); at += 4;
  };
  const ihdr = new Uint8Array(13);
  const hd = new DataView(ihdr.buffer);
  hd.setUint32(0, w); hd.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  chunk('IHDR', ihdr);
  for (const t of texts) chunk('tEXt', t);
  chunk('IDAT', idat);
  chunk('IEND', new Uint8Array(0));
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Reads greyscale, RGB, palette, and alpha PNGs of any bit depth. Interlaced files throw `InterlacedPng`. */
export class InterlacedPng extends Error {}

export function decodePng(file: Uint8Array): Image32 {
  for (let i = 0; i < 8; i++) if (file[i] !== SIG[i]) throw new Error('Not a PNG file');
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 8, w = 0, h = 0, depth = 8, type = 6, interlace = 0;
  let plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idats: Uint8Array[] = [];
  while (at + 8 <= file.length) {
    const len = dv.getUint32(at);
    const t = String.fromCharCode(file[at + 4], file[at + 5], file[at + 6], file[at + 7]);
    const body = file.subarray(at + 8, at + 8 + len);
    if (t === 'IHDR') { w = dv.getUint32(at + 8); h = dv.getUint32(at + 12); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (t === 'PLTE') plte = body;
    else if (t === 'tRNS') trns = body;
    else if (t === 'IDAT') idats.push(body);
    else if (t === 'IEND') break;
    at += 12 + len;
  }
  if (!w || !h) throw new Error('This PNG has no image header');
  if (interlace) throw new InterlacedPng('Interlaced PNG');
  const total = idats.reduce((s, b) => s + b.length, 0);
  const joined = new Uint8Array(total);
  let p = 0;
  for (const b of idats) { joined.set(b, p); p += b.length; }
  const raw = unzlibSync(joined);

  const channels = type === 0 ? 1 : type === 2 ? 3 : type === 3 ? 1 : type === 4 ? 2 : 4;
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((w * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const out = new Uint32Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[src++];
    for (let i = 0; i < stride; i++) {
      const v = raw[src++];
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      cur[i] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 255;
    }
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, al = 255;
      if (depth === 16) {
        const q = x * channels * 2;
        if (type === 0) { r = g = bl = cur[q]; if (trns && cur[q] === trns[0] && cur[q + 1] === trns[1]) al = 0; }
        else if (type === 2) { r = cur[q]; g = cur[q + 2]; bl = cur[q + 4]; }
        else if (type === 4) { r = g = bl = cur[q]; al = cur[q + 2]; }
        else { r = cur[q]; g = cur[q + 2]; bl = cur[q + 4]; al = cur[q + 6]; }
      } else if (depth === 8) {
        const q = x * channels;
        if (type === 0) { r = g = bl = cur[q]; if (trns && trns[1] === r) al = 0; }
        else if (type === 2) { r = cur[q]; g = cur[q + 1]; bl = cur[q + 2]; if (trns && trns[1] === r && trns[3] === g && trns[5] === bl) al = 0; }
        else if (type === 3) { const i = cur[q]; r = plte![i * 3]; g = plte![i * 3 + 1]; bl = plte![i * 3 + 2]; if (trns && i < trns.length) al = trns[i]; }
        else if (type === 4) { r = g = bl = cur[q]; al = cur[q + 1]; }
        else { r = cur[q]; g = cur[q + 1]; bl = cur[q + 2]; al = cur[q + 3]; }
      } else {
        const bit = x * depth, v = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        if (type === 3) { r = plte![v * 3]; g = plte![v * 3 + 1]; bl = plte![v * 3 + 2]; if (trns && v < trns.length) al = trns[v]; }
        else { r = g = bl = Math.round((v * 255) / ((1 << depth) - 1)); if (trns && trns[1] === v) al = 0; }
      }
      out[y * w + x] = ((al << 24) | (bl << 16) | (g << 8) | r) >>> 0;
    }
    const t = prev; prev = cur; cur = t;
  }
  return { w, h, data: out };
}
