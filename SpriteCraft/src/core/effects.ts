// The effect API. An effect is a pure function over pixels with declared parameters; the dialog, its live preview and
// "all frames" come from this description, so adding an effect needs no UI work. Later modules register through the same
// call, including effects loaded from plugins.
import { A, B, G, R, hsvToRgb, nearestIndex, rgba, rgbToHsv, fromHex } from './color';
import { ditherThreshold } from './raster';
import type { Pixel } from './types';

export type EffectParam =
  | { key: string; label: string; type: 'number'; min: number; max: number; step?: number; value: number }
  | { key: string; label: string; type: 'bool'; value: boolean }
  | { key: string; label: string; type: 'color'; value: string }
  | { key: string; label: string; type: 'choice'; options: string[]; value: string }
  | { key: string; label: string; type: 'text'; value: string };

export interface EffectContext {
  palette: Pixel[];
  /**
   * Where this frame sits in an animated run, 0 at the first frame and approaching 1 at the last, so a whole number of
   * cycles loops without a repeated frame. 0 when the effect is applied to a single image.
   */
  t?: number;
  /** Live shaders: the frame being drawn and how many there are. */
  frame?: number;
  frames?: number;
  /** Live shaders: everything drawn under this layer, and everything drawn over it (canvas-sized). */
  below?: Uint32Array;
  above?: Uint32Array;
  /** Live shaders: what was drawn over this layer on another frame (for trails). */
  aboveAt?: (frame: number) => Uint32Array;
  /** Live shaders: seconds from the first frame to this one, and the whole animation's length in seconds. */
  seconds?: number;
  loopSeconds?: number;
  /** Live shaders: only some of the layers under this one (see `layersBelow`); `backdrop` marks full-canvas layers. */
  belowWhere?: (keep: (layer: import('./types').Layer, backdrop: boolean) => boolean) => Uint32Array;
  /** Live shaders: another layer's own pixels on this frame (hidden layers too), for node graphs. */
  layerPixels?: (id: string) => Uint32Array;
}

export interface Effect {
  id: string;
  name: string;
  params: EffectParam[];
  /** Only makes sense live on a layer (it reads the layers around it), so it isn't offered in the Effects menu. */
  liveOnly?: boolean;
  /** Returns the result image, same size as the input. Must not change `src`. */
  apply(src: Uint32Array, w: number, h: number, p: Record<string, any>, ctx: EffectContext): Uint32Array;
}

const registry = new Map<string, Effect>();
export const registerEffect = (e: Effect) => { registry.set(e.id, e); };
export const effects = () => [...registry.values()];
export const effectById = (id: string) => registry.get(id);
export const defaultParams = (e: Effect) => Object.fromEntries(e.params.map((p) => [p.key, p.value]));

/**
 * Settings part way between a start and an end, for effects animated across frames. Numbers and colours blend; on/off
 * and choices keep the start value, since there is nothing in between.
 */
export function lerpParams(e: Effect, a: Record<string, any>, b: Record<string, any>, t: number): Record<string, any> {
  const out: Record<string, any> = { ...a };
  for (const p of e.params) {
    if (p.type === 'number') out[p.key] = a[p.key] + (b[p.key] - a[p.key]) * t;
    else if (p.type === 'color') {
      const ca = fromHex(a[p.key]) ?? 0, cb = fromHex(b[p.key]) ?? 0;
      const m = (s: number) => Math.round(((ca >>> s) & 255) + (((cb >>> s) & 255) - ((ca >>> s) & 255)) * t);
      out[p.key] = '#' + [m(0), m(8), m(16)].map((v) => v.toString(16).padStart(2, '0')).join('');
    }
  }
  return out;
}

const eachPixel = (src: Uint32Array, fn: (p: Pixel, i: number) => Pixel) => {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = fn(src[i], i);
  return out;
};
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

registerEffect({
  id: 'outline', name: 'Outline',
  params: [
    { key: 'color', label: 'Colour', type: 'color', value: '#000000' },
    { key: 'where', label: 'Where', type: 'choice', options: ['Outside', 'Inside'], value: 'Outside' },
    { key: 'corners', label: 'Include corners', type: 'bool', value: false },
  ],
  apply(src, w, h, p) {
    const col = fromHex(p.color) ?? rgba(0, 0, 0);
    const out = src.slice();
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && A(src[y * w + x]) > 0;
    const near: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], ...(p.corners ? [[1, 1], [-1, 1], [1, -1], [-1, -1]] as [number, number][] : [])];
    const outside = p.where === 'Outside';
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const me = solid(x, y);
      if (outside ? me : !me) continue;
      if (near.some(([dx, dy]) => solid(x + dx, y + dy) !== me)) out[y * w + x] = col;
    }
    return out;
  },
});

registerEffect({
  id: 'hsv', name: 'Hue / Saturation / Value',
  params: [
    { key: 'hue', label: 'Hue', type: 'number', min: -180, max: 180, value: 0 },
    { key: 'sat', label: 'Saturation', type: 'number', min: -100, max: 100, value: 0 },
    { key: 'val', label: 'Value', type: 'number', min: -100, max: 100, value: 0 },
  ],
  apply(src, _w, _h, p) {
    const cache = new Map<number, number>();
    return eachPixel(src, (c) => {
      if (!A(c)) return c;
      let o = cache.get(c);
      if (o === undefined) {
        const [h, s, v] = rgbToHsv(R(c), G(c), B(c));
        const [r, g, b] = hsvToRgb(h + p.hue, Math.max(0, Math.min(1, s + p.sat / 100)), Math.max(0, Math.min(1, v + p.val / 100)));
        o = rgba(r, g, b, A(c));
        cache.set(c, o);
      }
      return o;
    });
  },
});

registerEffect({
  id: 'levels', name: 'Brightness / Contrast',
  params: [
    { key: 'bright', label: 'Brightness', type: 'number', min: -100, max: 100, value: 0 },
    { key: 'contrast', label: 'Contrast', type: 'number', min: -100, max: 100, value: 0 },
  ],
  apply(src, _w, _h, p) {
    const k = (100 + p.contrast) / 100, add = (p.bright * 255) / 100;
    const f = (v: number) => clamp8((v - 127.5) * k + 127.5 + add);
    return eachPixel(src, (c) => (A(c) ? rgba(f(R(c)), f(G(c)), f(B(c)), A(c)) : c));
  },
});

registerEffect({
  id: 'invert', name: 'Invert colours', params: [],
  apply: (src) => eachPixel(src, (c) => (A(c) ? rgba(255 - R(c), 255 - G(c), 255 - B(c), A(c)) : c)),
});

registerEffect({
  id: 'shadow', name: 'Drop shadow',
  params: [
    { key: 'dx', label: 'Offset X', type: 'number', min: -32, max: 32, value: 1 },
    { key: 'dy', label: 'Offset Y', type: 'number', min: -32, max: 32, value: 1 },
    { key: 'color', label: 'Colour', type: 'color', value: '#000000' },
  ],
  apply(src, w, h, p) {
    const col = fromHex(p.color) ?? rgba(0, 0, 0);
    const out = src.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (A(src[y * w + x])) continue;
      const sx = x - p.dx, sy = y - p.dy;
      if (sx >= 0 && sy >= 0 && sx < w && sy < h && A(src[sy * w + sx])) out[y * w + x] = col;
    }
    return out;
  },
});

// Wave Warp: moves pixels along sine waves. Every output pixel takes the colour of one source pixel (nearest), so no new
// colours appear. With `cycles` the wave travels a whole number of wavelengths over an animated run, which loops.
registerEffect({
  id: 'wave-warp', name: 'Wave warp',
  params: [
    { key: 'mode', label: 'Waves', type: 'choice', options: ['Horizontal', 'Vertical', 'Both', 'Ripple'], value: 'Horizontal' },
    { key: 'amp', label: 'Amplitude (px)', type: 'number', min: 0, max: 32, step: 0.5, value: 2 },
    { key: 'length', label: 'Wavelength (px)', type: 'number', min: 2, max: 256, value: 16 },
    { key: 'phase', label: 'Phase (°)', type: 'number', min: 0, max: 360, value: 0 },
    { key: 'cycles', label: 'Cycles per loop', type: 'number', min: -8, max: 8, value: 1 },
    { key: 'cx', label: 'Centre X (%)', type: 'number', min: 0, max: 100, value: 50 },
    { key: 'cy', label: 'Centre Y (%)', type: 'number', min: 0, max: 100, value: 50 },
    { key: 'radius', label: 'Only within radius (px, 0 = everywhere)', type: 'number', min: 0, max: 512, value: 0 },
    { key: 'edges', label: 'Edges', type: 'choice', options: ['Transparent', 'Wrap', 'Clamp'], value: 'Transparent' },
    { key: 'whole', label: 'Whole-pixel steps', type: 'bool', value: true },
  ],
  apply(src, w, h, p, ctx) {
    const out = new Uint32Array(src.length);
    const tau = Math.PI * 2;
    const shift = (p.phase / 360) * tau + tau * p.cycles * (ctx.t ?? 0);
    const k = tau / Math.max(1, p.length);
    const cx = (p.cx / 100) * w, cy = (p.cy / 100) * h;
    const round = (v: number) => (p.whole ? Math.round(v) : v);
    const read = (x: number, y: number) => {
      let sx = Math.floor(x), sy = Math.floor(y);
      if (p.edges === 'Wrap') { sx = ((sx % w) + w) % w; sy = ((sy % h) + h) % h; }
      else if (p.edges === 'Clamp') { sx = Math.max(0, Math.min(w - 1, sx)); sy = Math.max(0, Math.min(h - 1, sy)); }
      else if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0;
      return src[sy * w + sx];
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      const rx = px - cx, ry = py - cy, r = Math.hypot(rx, ry);
      // A soft edge for the local region, so the warp fades out instead of tearing.
      const weight = p.radius > 0 ? Math.max(0, 1 - r / p.radius) : 1;
      let dx = 0, dy = 0;
      if (weight > 0) {
        const a = p.amp * weight;
        if (p.mode === 'Horizontal' || p.mode === 'Both') dx = a * Math.sin(py * k + shift);
        if (p.mode === 'Vertical' || p.mode === 'Both') dy = a * Math.sin(px * k + shift);
        if (p.mode === 'Ripple' && r > 1e-6) {
          // Rings move outward as the phase advances.
          const d = a * Math.sin(r * k - shift);
          dx = (rx / r) * d; dy = (ry / r) * d;
        }
      }
      out[y * w + x] = read(px - round(dx), py - round(dy));
    }
    return out;
  },
});

registerEffect({
  id: 'palette-map', name: 'Map to palette',
  params: [
    { key: 'dither', label: 'Dither', type: 'choice', options: ['none', 'bayer2', 'bayer4', 'bayer8'], value: 'none' },
    { key: 'strength', label: 'Dither strength', type: 'number', min: 0, max: 100, value: 40 },
  ],
  apply(src, w, _h, p, ctx) {
    if (!ctx.palette.length) return src.slice();
    const amt = (p.strength / 100) * 64;
    return eachPixel(src, (c, i) => {
      if (!A(c)) return c;
      const off = p.dither === 'none' ? 0 : (ditherThreshold(p.dither, i % w, Math.floor(i / w)) - 0.5) * amt;
      const n = rgba(clamp8(R(c) + off), clamp8(G(c) + off), clamp8(B(c) + off));
      const hit = ctx.palette[nearestIndex(n, ctx.palette)];
      return ((hit & 0xffffff) | (A(c) << 24)) >>> 0;
    });
  },
});
