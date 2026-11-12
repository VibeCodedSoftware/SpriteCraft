// Live brush dynamics (Phase 2): spacing, scatter, size and colour variation, pen pressure, density, and turning the
// brush with the stroke. Pure functions and a seeded random source, so a stroke is repeatable and testable.
//
// Turning only happens in quarter turns and mirror flips: those move pixels without resampling, so a pixel-art brush
// never gains new colours or soft edges.
import { A, B, G, R, hsvToRgb, rgba, rgbToHsv } from './color';

export interface Dynamics {
  on: boolean;
  /** Pixels of stroke between dabs. 1 paints at every pixel. */
  spacing: number;
  /** Each dab lands up to this many pixels away from the stroke. */
  scatter: number;
  /** 0..100: how much smaller a dab may randomly be (round and square brushes). */
  sizeJitter: number;
  /** A pen's pressure scales the brush size (ignored for a mouse). */
  pressureSize: boolean;
  /** Degrees of hue a dab may shift either way. */
  hueJitter: number;
  /** Percent of brightness a dab may shift either way. */
  valueJitter: number;
  /** 0..100: chance that each dab is placed at all. */
  density: number;
  /** Quarter turns of the brush: none, random, or following the stroke's direction. */
  rotate: 'none' | 'random' | 'direction';
  /** Randomly mirror each dab. */
  flip: boolean;
}

export const defaultDynamics = (): Dynamics => ({
  on: false, spacing: 1, scatter: 0, sizeJitter: 0, pressureSize: true, hueJitter: 0, valueJitter: 0, density: 100, rotate: 'none', flip: false,
});

/** Small fast seeded random numbers (mulberry32), 0 ≤ n < 1. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Dab {
  x: number; y: number;
  /** Brush size for round and square brushes. */
  size: number;
  /** Quarter turns clockwise, 0..3. */
  quarter: number;
  flip: boolean;
  /** Colour shift for this dab. */
  hue: number; value: number;
}

/**
 * Decides where dabs go along a stroke. Feed it every pixel the stroke passes through; it returns a dab when one is due,
 * or null between dabs and for dabs that density drops.
 */
export class DabPlanner {
  private rand: () => number;
  private travelled = 0;
  private last: { x: number; y: number } | null = null;
  private dir = { x: 1, y: 0 };
  constructor(private d: Dynamics, private baseSize: number, seed: number) { this.rand = seeded(seed); }

  next(x: number, y: number, pressure = 1, pen = false): Dab | null {
    const d = this.d;
    if (this.last) {
      const dx = x - this.last.x, dy = y - this.last.y;
      const step = Math.hypot(dx, dy);
      if (step > 0) { this.dir = { x: dx / step, y: dy / step }; this.travelled += step; }
      this.last = { x, y };
      if (this.travelled < Math.max(1, d.spacing)) return null;
      this.travelled = 0;
    } else this.last = { x, y };

    // Draw every random number every time, so a setting changing doesn't change the rest of the pattern.
    const r = [this.rand(), this.rand(), this.rand(), this.rand(), this.rand(), this.rand(), this.rand(), this.rand()];
    if (r[0] * 100 >= d.density) return null;
    const ang = r[1] * Math.PI * 2, rad = Math.sqrt(r[2]) * d.scatter;
    let size = this.baseSize * (1 - (d.sizeJitter / 100) * r[3]);
    if (d.pressureSize && pen) size *= Math.max(0.05, Math.min(1, pressure));
    let quarter = 0;
    if (d.rotate === 'random') quarter = Math.floor(r[4] * 4) % 4;
    else if (d.rotate === 'direction') quarter = ((Math.round(Math.atan2(this.dir.y, this.dir.x) / (Math.PI / 2)) % 4) + 4) % 4;
    return {
      x: Math.round(x + Math.cos(ang) * rad), y: Math.round(y + Math.sin(ang) * rad),
      size: Math.max(1, Math.round(size)), quarter, flip: d.flip && r[5] < 0.5,
      hue: (r[6] * 2 - 1) * d.hueJitter, value: (r[7] * 2 - 1) * d.valueJitter,
    };
  }
}

/** Turns brush offsets (around the brush centre) by quarter turns and an optional mirror. Exact: no resampling. */
export function turnOffsets<T extends { x: number; y: number }>(offs: T[], quarter: number, flip: boolean): T[] {
  if (!quarter && !flip) return offs;
  return offs.map((o) => {
    let x = flip ? -o.x : o.x, y = o.y;
    for (let i = 0; i < quarter; i++) { const t = x; x = -y; y = t; }
    return { ...o, x, y };
  });
}

/** Shifts a colour's hue and brightness, keeping its alpha. */
export function shiftColor(c: number, hue: number, value: number): number {
  if (!hue && !value) return c;
  const [h, s, v] = rgbToHsv(R(c), G(c), B(c));
  const [r, g, b] = hsvToRgb(h + hue, s, Math.max(0, Math.min(1, v + value / 100)));
  return rgba(r, g, b, A(c));
}
