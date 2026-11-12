import { describe, expect, it } from 'vitest';
import { rgba } from '../src/core/color';
import { composeFrame, composeRegion } from '../src/core/compose';
import { addLayer, newDoc, newLayer, setCel } from '../src/core/doc';
import { defaultParams, effectById } from '../src/core/effects';
import { compileFormula, contacts } from '../src/core/shaders';
import { celKey, type Doc } from '../src/core/types';

const W = 16, H = 16;
const RED = rgba(220, 40, 40), BLUE = rgba(40, 60, 220), GREEN = rgba(40, 200, 60), SKY = rgba(10, 10, 10);
const fx = (id: string) => effectById(id)!;
const img = (fill: (x: number, y: number) => number) => { const a = new Uint32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = fill(x, y); return a; };

describe('custom formula', () => {
  it('does maths with precedence, functions and variables', () => {
    expect(compileFormula('1 + 2 * 3 ^ 2')({})).toBe(19);
    expect(compileFormula('clamp(x * 2, 0, 5) + floor(-1.5)')({ x: 4 })).toBe(3);
    expect(compileFormula('x > 3 ? 10 : 20')({ x: 4 })).toBe(10);
    expect(compileFormula('7 % 3 + -2')({})).toBe(-1);
    expect(compileFormula('1 / 0')({})).toBe(0);
  });
  it('rejects anything outside its small language, so formulas from files are safe', () => {
    for (const bad of ['alert(1)', 'x; y', 'window', '"text"', '1 +', 'constructor', 'constructor(1)', 'toString()', '__proto__', 'x.y']) expect(() => compileFormula(bad), bad).toThrow();
  });
  it('a broken formula leaves the image unchanged instead of failing', () => {
    const src = img((x) => (x < 8 ? RED : 0));
    expect(fx('formula').apply(src, W, H, { ...defaultParams(fx('formula')), dx: 'nonsense(', dy: '0' }, { palette: [] })).toEqual(src);
  });
  it('moves and recolours pixels', () => {
    const src = img((x, y) => (x === 2 && y === 2 ? RED : 0));
    const out = fx('formula').apply(src, W, H, { dx: '3', dy: '0', r: '255 - r', g: 'g', b: 'b', a: 'a' }, { palette: [] });
    expect(out[2 * W + 5]).toBe(rgba(35, 40, 40));
  });
});

describe('shaders', () => {
  const art = img((x, y) => (x > 3 && x < 12 && y > 3 && y < 12 ? (x < 8 ? RED : BLUE) : 0));
  it('distortions only move pixels: no new colours', () => {
    for (const id of ['heat-haze', 'wobble', 'noise-displace']) {
      for (const t of [0, 0.3, 0.7]) {
        const out = fx(id).apply(art, W, H, defaultParams(fx(id)), { palette: [], t, frame: Math.round(t * 8) });
        for (const c of out) expect([0, RED, BLUE]).toContain(c);
      }
    }
  });
  it('palette cycling rotates colours along a palette run', () => {
    const pal = [RED, GREEN, BLUE];
    const out = fx('palette-cycle').apply(art, W, H, { from: 0, count: 3, steps: 3 }, { palette: pal, t: 1 / 3 });
    expect(out[5 * W + 5]).toBe(GREEN);
    expect(out[5 * W + 10]).toBe(RED);
  });
  it('dissolve removes more as the amount rises', () => {
    const n = (amt: number) => fx('dissolve').apply(art, W, H, { ...defaultParams(fx('dissolve')), amount: amt }, { palette: [] }).filter((c) => c).length;
    expect(n(0)).toBe(64); expect(n(50)).toBeLessThan(64); expect(n(100)).toBe(0);
  });
  it('the glow surrounds bright art and leaves the art itself alone', () => {
    const out = fx('glow').apply(art, W, H, { ...defaultParams(fx('glow')), threshold: 50 }, { palette: [] });
    expect(out[5 * W + 5]).toBe(RED);
    expect(out[5 * W + 3] >>> 24).toBeGreaterThan(0);
  });
});

describe('water', () => {
  // Water fills rows 10-15. Above it, a red block sits on rows 6-9 at x 4..6 (part of the scene below the water layer),
  // and a green post stands in the water at x 11 (drawn above it).
  const waterLayer = img((_x, y) => (y >= 10 ? BLUE : 0));
  const below = img((x, y) => (y < 10 && x >= 4 && x <= 6 && y >= 6 ? RED : y < 10 ? SKY : 0));
  const above = img((x, y) => (x === 11 && y >= 7 && y <= 11 ? GREEN : 0));
  const run = (patch: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) =>
    fx('water').apply(waterLayer, W, H, { ...defaultParams(fx('water')), amp: 0, sparkle: 0, foamWidth: 0, ...patch }, { palette: [], below, above, t: 0, frame: 0, frames: 4, ...ctx });

  it('only colours the water and keeps its shape', () => {
    const out = run();
    for (let i = 0; i < out.length; i++) expect(!!(out[i] >>> 24)).toBe(!!(waterLayer[i] >>> 24));
  });
  it('reflects the scene above the waterline: the red block shows mirrored in the water', () => {
    const plain = run({ reflect: 0 }), reflected = run({ reflect: 100 });
    // Row 10 mirrors row 9 (red at x 4..6). With reflection on, those pixels lean red.
    const redness = (c: number) => (c & 255) - ((c >>> 16) & 255);
    expect(redness(reflected[10 * W + 5])).toBeGreaterThan(redness(plain[10 * W + 5]));
    expect(reflected[10 * W + 9]).not.toBe(reflected[10 * W + 5]);
  });
  it('finds where something stands in the water', () => {
    expect(contacts(waterLayer, above, W, H)).toEqual([[11, 10]]);
  });
  it('rings spread from the contact, and trails follow where it was on earlier frames', () => {
    const still = run({ ripples: false }), rippled = run({ ripples: true, trails: false });
    expect(rippled.filter((c, i) => c !== still[i]).length).toBeGreaterThan(0);
    // On earlier frames the post stood at x 3: with trails on, rings appear near there too.
    const earlier = img((x, y) => (x === 3 && y >= 7 && y <= 11 ? GREEN : 0));
    const trails = run({ ripples: true, trails: true }, { aboveAt: () => earlier });
    const near3 = (o: Uint32Array) => [...o].filter((c, i) => c !== still[i] && Math.abs((i % W) - 3) <= 2).length;
    expect(near3(trails)).toBeGreaterThan(near3(rippled));
  });
  it('typed ripple points add rings where they say', () => {
    const still = run({ ripples: false });
    const out = run({ ripples: false, points: '8,13' }, { t: 0.5 });
    expect(out.filter((c, i) => c !== still[i]).length).toBeGreaterThan(0);
  });
});

describe('live shader stacks', () => {
  function scene(): Doc {
    let d = newDoc(W, H, 'T', 4);
    d = { ...d, layers: [] };
    const bg = newLayer('Sky'), wl = { ...newLayer('Water'), fx: [{ id: 'f1', effect: 'water', on: true, params: { ...defaultParams(fx('water')), sparkle: 0 } }] };
    d = addLayer(d, bg); d = addLayer(d, wl);
    for (const f of d.frames) {
      d = setCel(d, celKey(bg.id, f.id), { id: 'b' + f.id, x: 0, y: 0, w: W, h: 10, opacity: 255, data: new Uint32Array(W * 10).fill(SKY) }, false);
      d = setCel(d, celKey(wl.id, f.id), { id: 'w' + f.id, x: 0, y: 10, w: W, h: 6, opacity: 255, data: new Uint32Array(W * 6).fill(BLUE) }, false);
    }
    return d;
  }
  it('run when the frame is drawn, and animate from frame to frame', () => {
    const d = scene();
    const f0 = composeFrame(d, 0), f1 = composeFrame(d, 1);
    expect(f0[12 * W + 5]).not.toBe(BLUE);
    expect(f0).not.toEqual(f1);
  });
  it('a part of the canvas drawn alone matches the same part of the whole frame', () => {
    const d = scene(), all = composeFrame(d, 2), part = composeRegion(d, 2, { x: 4, y: 8, w: 6, h: 6 });
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) expect(part[y * 6 + x]).toBe(all[(8 + y) * W + 4 + x]);
  });
  it('a switched-off shader does nothing; keyed settings change over frames', () => {
    let d = scene();
    const water = d.layers[1];
    const off = { ...d, layers: d.layers.map((l) => (l.id === water.id ? { ...l, fx: l.fx!.map((f) => ({ ...f, on: false })) } : l)) };
    expect(composeFrame(off, 0)[12 * W + 5]).toBe(BLUE);
    d = { ...d, layers: d.layers.map((l) => (l.id === water.id ? { ...l, fx: [{ id: 'g', effect: 'dissolve', on: true, params: { ...defaultParams(fx('dissolve')), edgeWidth: 0 }, keys: { amount: [{ f: d.frames[0].id, v: 0, ease: 'linear' as const }, { f: d.frames[3].id, v: 100, ease: 'linear' as const }] } }] } : l)) };
    const count = (i: number) => composeFrame(d, i).filter((c) => c === BLUE).length;
    expect(count(0)).toBe(W * 6);
    expect(count(3)).toBe(0);
    expect(count(1)).toBeLessThan(count(0));
  });
});
