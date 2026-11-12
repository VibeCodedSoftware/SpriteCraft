// Colour helpers for packed 0xAABBGGRR pixels.
import type { Pixel } from './types';

export const rgba = (r: number, g: number, b: number, a = 255): Pixel => (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
export const R = (p: Pixel) => p & 255;
export const G = (p: Pixel) => (p >>> 8) & 255;
export const B = (p: Pixel) => (p >>> 16) & 255;
export const A = (p: Pixel) => p >>> 24;

export const toHex = (p: Pixel, withAlpha = false) => {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return '#' + h(R(p)) + h(G(p)) + h(B(p)) + (withAlpha && A(p) < 255 ? h(A(p)) : '');
};

export function fromHex(text: string): Pixel | null {
  const s = text.trim().replace(/^#|^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(s)) return null;
  if (s.length === 3) return rgba(parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16));
  if (s.length === 6 || s.length === 8) {
    return rgba(parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255);
  }
  return null;
}

export const toCss = (p: Pixel) => `rgba(${R(p)},${G(p)},${B(p)},${A(p) / 255})`;

/** h 0..360, s and v 0..1. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Weighted squared distance: a little closer to how the eye judges colour than plain RGB distance. */
export function colorDist(a: Pixel, b: Pixel): number {
  const dr = R(a) - R(b), dg = G(a) - G(b), db = B(a) - B(b), da = A(a) - A(b);
  const rm = (R(a) + R(b)) / 2;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db + 3 * da * da;
}

/** Index of the palette entry closest to a colour; -1 for an empty palette. */
export function nearestIndex(c: Pixel, palette: Pixel[]): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = colorDist(c, palette[i]);
    if (d < bd) { bd = d; best = i; if (d === 0) break; }
  }
  return best;
}

export const mixColor = (a: Pixel, b: Pixel, t: number): Pixel => rgba(
  Math.round(R(a) + (R(b) - R(a)) * t), Math.round(G(a) + (G(b) - G(a)) * t), Math.round(B(a) + (B(b) - B(a)) * t), Math.round(A(a) + (A(b) - A(a)) * t));
