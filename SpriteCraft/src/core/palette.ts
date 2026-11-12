// Palettes: built-in sets, extraction by median cut, colour ramps, and the common palette file formats.
import { A, B, G, R, fromHex, hsvToRgb, rgba, rgbToHsv, toHex } from './color';
import type { Pixel } from './types';

/**
 * All built-in palettes are generated here from a few numbers, not taken from any existing palette, so they carry no
 * outside licence question. Each ramp runs dark to light while its hue drifts, which is what makes it good for shading.
 */
function genRamp(hue: number, drift: number, sat: [number, number], val: [number, number], steps: number): Pixel[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const [r, g, b] = hsvToRgb(hue + drift * t, sat[0] + (sat[1] - sat[0]) * t, val[0] + (val[1] - val[0]) * t);
    return rgba(r, g, b);
  });
}
const greys = (n: number) => Array.from({ length: n }, (_, i) => { const v = Math.round((i * 255) / (n - 1)); return rgba(v, v, v); });

/** The starting palette: greys and six hue-shifted ramps of eight colours. */
export const DEFAULT_PALETTE: Pixel[] = [
  ...greys(8),
  ...genRamp(345, 55, [0.85, 0.55], [0.22, 1], 8), // Reds to golds.
  ...genRamp(165, -80, [0.8, 0.5], [0.2, 0.98], 8), // Sea greens to limes.
  ...genRamp(245, -60, [0.8, 0.28], [0.25, 1], 8), // Deep blues to sky.
  ...genRamp(275, 50, [0.7, 0.25], [0.22, 1], 8), // Violets to pinks.
  ...genRamp(10, 25, [0.65, 0.22], [0.18, 0.98], 8), // Earth and skin.
];

export const PALETTE_PRESETS: { name: string; colors: Pixel[] }[] = [
  { name: 'SpriteCraft 48', colors: DEFAULT_PALETTE },
  { name: '1-bit', colors: greys(2) },
  { name: 'Four greys', colors: greys(4) },
  { name: 'Eight greys', colors: greys(8) },
  { name: 'Four greens', colors: genRamp(125, -25, [0.75, 0.6], [0.2, 0.8], 4) },
  { name: 'Warm 8', colors: genRamp(330, 70, [0.7, 0.3], [0.2, 1], 8) },
  { name: 'Cool 8', colors: genRamp(235, -70, [0.75, 0.2], [0.2, 1], 8) },
  { name: 'Skin 8', colors: genRamp(12, 18, [0.6, 0.2], [0.25, 1], 8) },
];

/**
 * Reduces any set of pixels to at most `count` colours by median cut. Colours are weighted by how often they appear,
 * and an image that already fits comes back exactly, in order of appearance.
 */
export function extractPalette(buffers: Uint32Array[], count: number): Pixel[] {
  const hist = new Map<number, number>();
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) {
      const p = buf[i];
      if (A(p) < 128) continue;
      const o = (p | 0xff000000) >>> 0;
      hist.set(o, (hist.get(o) ?? 0) + 1);
    }
  }
  const unique = [...hist.keys()];
  if (unique.length <= count) return unique;
  type Box = { colors: number[] };
  const boxes: Box[] = [{ colors: unique }];
  const rangeOf = (b: Box) => {
    let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
    for (const c of b.colors) {
      r0 = Math.min(r0, R(c)); r1 = Math.max(r1, R(c)); g0 = Math.min(g0, G(c)); g1 = Math.max(g1, G(c)); b0 = Math.min(b0, B(c)); b1 = Math.max(b1, B(c));
    }
    const dr = r1 - r0, dg = g1 - g0, db = b1 - b0;
    return { size: Math.max(dr, dg, db), ch: dg >= dr && dg >= db ? G : dr >= db ? R : B };
  };
  while (boxes.length < count) {
    let pick = -1, best = 0;
    boxes.forEach((b, i) => {
      if (b.colors.length < 2) return;
      const { size } = rangeOf(b);
      if (size > best) { best = size; pick = i; }
    });
    if (pick < 0) break;
    const box = boxes[pick];
    const { ch } = rangeOf(box);
    box.colors.sort((a, b) => ch(a) - ch(b));
    let total = 0;
    for (const c of box.colors) total += hist.get(c)!;
    let acc = 0, cut = 1;
    for (let i = 0; i < box.colors.length - 1; i++) {
      acc += hist.get(box.colors[i])!;
      if (acc >= total / 2) { cut = i + 1; break; }
    }
    boxes.splice(pick, 1, { colors: box.colors.slice(0, cut) }, { colors: box.colors.slice(cut) });
  }
  return boxes.map((b) => {
    let wr = 0, wg = 0, wb = 0, wt = 0;
    for (const c of b.colors) { const n = hist.get(c)!; wr += R(c) * n; wg += G(c) * n; wb += B(c) * n; wt += n; }
    return rgba(Math.round(wr / wt), Math.round(wg / wt), Math.round(wb / wt));
  });
}

/**
 * A ramp between two colours. hueShift (degrees) bends the hue away from a straight blend across the middle of the ramp,
 * the classic way to make shading in pixel art feel lively rather than grey.
 */
export function makeRamp(a: Pixel, b: Pixel, steps: number, hueShift = 0): Pixel[] {
  const [h0, s0, v0] = rgbToHsv(R(a), G(a), B(a));
  const [h1, s1, v1] = rgbToHsv(R(b), G(b), B(b));
  let dh = h1 - h0;
  if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
  // A grey end has no hue of its own: take it from the other end instead of swinging through red.
  const hStart = s0 < 0.01 ? h1 : h0, hDelta = s0 < 0.01 || s1 < 0.01 ? 0 : dh;
  return Array.from({ length: steps }, (_, i) => {
    if (i === 0) return a;
    if (i === steps - 1) return b;
    const t = i / (steps - 1);
    const [r, g, bl] = hsvToRgb(hStart + hDelta * t + hueShift * Math.sin(t * Math.PI), s0 + (s1 - s0) * t, v0 + (v1 - v0) * t);
    return rgba(r, g, bl);
  });
}

// --- Palette files

/** Reads GIMP .gpl, JASC .pal, or plain .hex (one colour per line). Throws when nothing can be read. */
export function parsePaletteFile(text: string): Pixel[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Pixel[] = [];
  if (/^GIMP Palette/i.test(lines[0] ?? '')) {
    for (const l of lines.slice(1)) {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)/);
      if (m) out.push(rgba(+m[1], +m[2], +m[3]));
    }
  } else if (/^JASC-PAL/i.test(lines[0] ?? '')) {
    for (const l of lines.slice(3)) {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)/);
      if (m) out.push(rgba(+m[1], +m[2], +m[3]));
    }
  } else {
    for (const l of lines) { const c = fromHex(l.split(/[\s,;]+/)[0]); if (c !== null) out.push(c); }
  }
  if (!out.length) throw new Error('No colours found in this palette file');
  return out;
}

export const paletteToGpl = (pal: Pixel[], name: string) =>
  `GIMP Palette\nName: ${name}\nColumns: 8\n#\n` + pal.map((c) => `${R(c)} ${G(c)} ${B(c)}\t${toHex(c)}`).join('\n') + '\n';

export const paletteToHex = (pal: Pixel[]) => pal.map((c) => toHex(c).slice(1)).join('\n') + '\n';
