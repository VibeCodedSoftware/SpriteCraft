import { describe, expect, it } from 'vitest';
import { DabPlanner, defaultDynamics, seeded, shiftColor, turnOffsets, type Dab } from '../src/core/dynamics';
import { rgba } from '../src/core/color';

const stroke = (p: DabPlanner, len: number, pressure = 1, pen = false) => {
  const out: Dab[] = [];
  for (let x = 0; x < len; x++) { const d = p.next(x, 0, pressure, pen); if (d) out.push(d); }
  return out;
};

describe('live brush dynamics', () => {
  it('the random source repeats for the same seed', () => {
    const a = seeded(42), b = seeded(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('spacing places a dab every n pixels of stroke', () => {
    const dabs = stroke(new DabPlanner({ ...defaultDynamics(), on: true, spacing: 5 }, 3, 1), 21);
    expect(dabs.map((d) => d.x)).toEqual([0, 5, 10, 15, 20]);
  });

  it('with defaults, every pixel gets a plain dab', () => {
    const dabs = stroke(new DabPlanner({ ...defaultDynamics(), on: true }, 3, 1), 10);
    expect(dabs.length).toBe(10);
    expect(dabs.every((d) => d.size === 3 && d.quarter === 0 && !d.flip && d.hue === 0 && d.value === 0 && d.y === 0)).toBe(true);
  });

  it('scatter stays inside its radius, density drops dabs, size jitter only shrinks', () => {
    const dabs = stroke(new DabPlanner({ ...defaultDynamics(), on: true, scatter: 6, density: 50, sizeJitter: 80 }, 10, 7), 400);
    expect(dabs.length).toBeGreaterThan(120);
    expect(dabs.length).toBeLessThan(280);
    expect(dabs.every((d) => Math.abs(d.y) <= 6)).toBe(true);
    expect(dabs.every((d) => d.size >= 1 && d.size <= 10)).toBe(true);
    expect(new Set(dabs.map((d) => d.size)).size).toBeGreaterThan(3);
  });

  it('pressure only shrinks the brush for a pen', () => {
    const d = { ...defaultDynamics(), on: true };
    expect(stroke(new DabPlanner(d, 10, 1), 1, 0.5, false)[0].size).toBe(10);
    expect(stroke(new DabPlanner(d, 10, 1), 1, 0.5, true)[0].size).toBe(5);
  });

  it('turning with the stroke follows its direction in quarter turns', () => {
    const p = new DabPlanner({ ...defaultDynamics(), on: true, rotate: 'direction' }, 1, 1);
    p.next(0, 0); p.next(0, 1); // moving down: a quarter turn clockwise
    expect(p.next(0, 2)!.quarter).toBe(1);
  });

  it('quarter turns and mirrors move offsets exactly', () => {
    const offs = [{ x: 2, y: 0 }, { x: 0, y: 1 }];
    expect(turnOffsets(offs, 1, false)).toEqual([{ x: -0, y: 2 }, { x: -1, y: 0 }]);
    expect(turnOffsets(offs, 4 % 4, true)).toEqual([{ x: -2, y: 0 }, { x: -0, y: 1 }]);
    expect(turnOffsets(turnOffsets(offs, 2, false), 2, false)).toEqual(offs.map((o) => ({ x: o.x === 0 ? 0 : o.x, y: o.y })));
  });

  it('colour shifts keep alpha and do nothing at zero', () => {
    const c = rgba(200, 50, 50, 128);
    expect(shiftColor(c, 0, 0)).toBe(c);
    expect(shiftColor(c, 120, 0) >>> 24).toBe(128);
    expect(shiftColor(c, 120, 0)).not.toBe(c);
  });
});
