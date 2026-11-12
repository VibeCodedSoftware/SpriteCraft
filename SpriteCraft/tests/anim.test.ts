import { describe, expect, it } from 'vitest';
import {
  EASE_PRESETS, bakeMotion, createMotion, cubicBezier, easeFn, keyFrames, motionById, motionRange, removeKey, removeMotion,
  resetToTween, sampleKeys, sampleMotion, setEase, setKey, srcKey, updateMotion, type Key,
} from '../src/core/anim';
import { rgba } from '../src/core/color';
import { composeFrame } from '../src/core/compose';
import { contentBounds, insertFrame, newDoc, removeFrame, removeLayer, setCel } from '../src/core/doc';
import { defaultParams, effectById, lerpParams } from '../src/core/effects';
import { celKey, type Doc } from '../src/core/types';
import { readProject, writeProject } from '../src/io/project';

const RED = rgba(255, 0, 0), BLUE = rgba(0, 0, 255);

/** 32×32, `frames` frames, a 2×2 red square at (4,4) on frame 0 of the only layer. */
function squareDoc(frames = 5): Doc {
  let d = newDoc(32, 32, 'T', frames);
  const l = d.layers[0].id;
  d = setCel(d, celKey(l, d.frames[0].id), { id: 'sq', x: 4, y: 4, w: 2, h: 2, opacity: 255, data: new Uint32Array(4).fill(RED) });
  return d;
}
const cel = (d: Doc, f: number) => d.cels[celKey(d.layers[0].id, d.frames[f].id)];

describe('easing', () => {
  it('every preset starts at 0 and ends at 1', () => {
    for (const e of EASE_PRESETS) {
      expect(easeFn(e)(0), e).toBeCloseTo(0, 5);
      expect(easeFn(e)(1), e).toBeCloseTo(1, 5);
    }
  });
  it('in-quad is slow then fast, out-quad the reverse', () => {
    expect(easeFn('in-quad')(0.5)).toBeCloseTo(0.25);
    expect(easeFn('out-quad')(0.5)).toBeCloseTo(0.75);
  });
  it('out-back overshoots, hold steps', () => {
    expect(Math.max(...[0.6, 0.7, 0.8].map(easeFn('out-back')))).toBeGreaterThan(1);
    expect(easeFn('hold')(0.99)).toBe(0);
  });
  it('steps quantise', () => {
    expect(easeFn({ steps: 4 })(0.3)).toBe(0.25);
  });
  it('a bezier with linear handles is linear, and an ease curve matches known values', () => {
    const lin = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    for (const x of [0.1, 0.5, 0.9]) expect(lin(x)).toBeCloseTo(x, 5);
    // CSS "ease" (0.25, 0.1, 0.25, 1) at x=0.5 is about 0.8024.
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
  });
});

describe('keyframes', () => {
  const keys = (pairs: [number, number][]): (Key & { i: number })[] => pairs.map(([i, v]) => ({ f: 'f' + i, i, v, ease: 'linear' }));
  it('holds before the first and after the last key, interpolates between', () => {
    const k = keys([[2, 10], [6, 30]]);
    expect(sampleKeys(k, 0, 0)).toBe(10);
    expect(sampleKeys(k, 4, 0)).toBe(20);
    expect(sampleKeys(k, 9, 0)).toBe(30);
  });
  it('no keys gives the base value', () => {
    expect(sampleKeys([], 3, 100)).toBe(100);
  });
});

describe('motion tweens', () => {
  it('moves art across frames and marks the frames as generated', () => {
    let d = squareDoc(5);
    const r = createMotion(d, d.layers[0].id, 0, 0, 4)!;
    d = setKey(r.doc, r.id, 'x', 4, 8);
    expect(motionRange(d, motionById(d, r.id)!)).toEqual([0, 4]);
    expect([0, 1, 2, 3, 4].map((f) => cel(d, f).x)).toEqual([4, 6, 8, 10, 12]);
    expect(cel(d, 2).gen).toBe(r.id);
    // What is drawn really is the moved square.
    expect(composeFrame(d, 4)[4 * 32 + 12]).toBe(RED);
    expect(composeFrame(d, 4)[4 * 32 + 4]).toBe(0);
  });

  it('keeps the original art under its own key, outside every frame and the content bounds', () => {
    const d0 = squareDoc(3);
    const r = createMotion(d0, d0.layers[0].id, 0, 0, 2)!;
    const d = setKey(r.doc, r.id, 'x', 2, 20);
    expect(d.cels[srcKey(d.layers[0].id, r.id)].x).toBe(4);
    expect(contentBounds(d)).toEqual({ x: 4, y: 4, w: 22, h: 2 });
  });

  it('easing changes the timing', () => {
    let d = squareDoc(5);
    const r = createMotion(d, d.layers[0].id, 0, 0, 4)!;
    d = setKey(r.doc, r.id, 'x', 4, 8);
    d = setEase(d, r.id, 0, 'in-quad');
    // in-quad at t=0.5 is 0.25 of the way: 2px moved.
    expect(cel(d, 2).x).toBe(6);
  });

  it('a frame the artist painted is kept on re-bake, and can be reset to the tween', () => {
    let d = squareDoc(5);
    const r = createMotion(d, d.layers[0].id, 0, 0, 4)!;
    d = setKey(r.doc, r.id, 'x', 4, 8);
    const mine = { id: 'mine', x: 0, y: 0, w: 1, h: 1, opacity: 255, data: new Uint32Array([BLUE]) };
    d = setCel(d, celKey(d.layers[0].id, d.frames[2].id), mine);
    const b = bakeMotion(d, r.id);
    expect(b.kept).toBe(1);
    expect(cel(b.doc, 2)).toBe(mine);
    d = resetToTween(b.doc, d.layers[0].id, 2);
    expect(cel(d, 2).gen).toBe(r.id);
    expect(cel(d, 2).x).toBe(8);
  });

  it('rotation keeps the colours and the pixel count of a square turned 90°', () => {
    let d = newDoc(32, 32, 'T', 3);
    const l = d.layers[0].id;
    d = setCel(d, celKey(l, d.frames[0].id), { id: 'bar', x: 10, y: 14, w: 6, h: 2, opacity: 255, data: new Uint32Array(12).fill(RED) });
    const r = createMotion(d, l, 0, 0, 2)!;
    d = setKey(r.doc, r.id, 'rotation', 2, 90);
    const c = cel(d, 2);
    expect(c.w).toBe(2); expect(c.h).toBe(6);
    expect([...c.data].every((p) => p === RED)).toBe(true);
  });

  it('opacity and scale tween', () => {
    let d = squareDoc(3);
    const r = createMotion(d, d.layers[0].id, 0, 0, 2)!;
    d = setKey(r.doc, r.id, 'opacity', 2, 0);
    d = setKey(d, r.id, 'opacity', 0, 100);
    d = setKey(d, r.id, 'scaleX', 2, 200);
    d = setKey(d, r.id, 'scaleX', 0, 100);
    expect(cel(d, 1).opacity).toBe(128);
    // Opacity 0 at the last key leaves the cel fully transparent but present; the width doubled.
    expect(cel(d, 2).w).toBe(4);
  });

  it("a property's first key animates from the resting value at the tween's start", () => {
    let d = squareDoc(5);
    const r = createMotion(d, d.layers[0].id, 0, 0, 4)!;
    d = setKey(r.doc, r.id, 'rotation', 4, 90);
    const m = motionById(d, r.id)!;
    expect(sampleMotion(d, m, 0).rotation).toBe(0);
    expect(sampleMotion(d, m, 2).rotation).toBe(45);
  });

  it('removing a key and keyFrames agree', () => {
    let d = squareDoc(5);
    const r = createMotion(d, d.layers[0].id, 0, 0, 4)!;
    d = setKey(r.doc, r.id, 'y', 2, 6);
    expect([...keyFrames(d, motionById(d, r.id)!)].sort()).toEqual([0, 2, 4]);
    d = removeKey(d, r.id, 'y', 2);
    d = removeKey(d, r.id, 'x', 2);
    expect([...keyFrames(d, motionById(d, r.id)!)].sort()).toEqual([0, 4]);
  });

  it('a curved path passes through the keys but bends between them', () => {
    let d = squareDoc(9);
    const r = createMotion(d, d.layers[0].id, 0, 0, 8)!;
    d = setKey(r.doc, r.id, 'x', 4, 8); d = setKey(d, r.id, 'y', 4, -8);
    d = setKey(d, r.id, 'x', 8, 16); d = setKey(d, r.id, 'y', 8, 0);
    const m = motionById(d, r.id)!;
    const straight = sampleMotion(d, m, 2).y;
    const curved = sampleMotion(d, { ...m, curvedPath: true }, 2).y;
    expect(sampleMotion(d, { ...m, curvedPath: true }, 4).y).toBe(-8);
    expect(curved).toBeLessThan(straight);
  });

  it('squash and stretch widens the art along fast horizontal travel', () => {
    let d = squareDoc(5);
    const r = createMotion(d, d.layers[0].id, 0, 0, 4)!;
    d = setKey(r.doc, r.id, 'x', 4, 24);
    const plain = cel(d, 2).w;
    d = updateMotion(d, r.id, { squash: 100 });
    expect(cel(d, 2).w).toBeGreaterThan(plain);
  });

  it('inserting a frame inside the tween re-times it once re-baked, deleting a frame drops its key', () => {
    let d = squareDoc(5);
    const r = createMotion(d, d.layers[0].id, 0, 0, 4)!;
    d = setKey(r.doc, r.id, 'x', 4, 8);
    d = bakeMotion(insertFrame(d, 2), r.id).doc;
    expect(motionRange(d, motionById(d, r.id)!)).toEqual([0, 5]);
    expect(cel(d, 5).x).toBe(12);
    // Deleting the frame with the end key leaves only the start key: the tween shrinks to that one frame.
    d = bakeMotion(removeFrame(d, 5), r.id).doc;
    expect(motionRange(d, motionById(d, r.id)!)).toEqual([0, 0]);
  });

  it('converting to frames keeps the pixels as ordinary cels; deleting puts the art back', () => {
    let d = squareDoc(3);
    const r = createMotion(d, d.layers[0].id, 0, 0, 2)!;
    d = setKey(r.doc, r.id, 'x', 2, 4);
    const kept = removeMotion(d, r.id, true);
    expect(cel(kept, 2).gen).toBeUndefined();
    expect(cel(kept, 2).x).toBe(8);
    expect(kept.motions).toEqual([]);
    const back = removeMotion(d, r.id, false);
    expect(cel(back, 0).x).toBe(4);
    expect(cel(back, 2)).toBeUndefined();
  });

  it('removing the layer removes its motions and source art', () => {
    let d = squareDoc(3);
    const r = createMotion(d, d.layers[0].id, 0, 0, 2)!;
    d = { ...r.doc, layers: [...r.doc.layers, { ...r.doc.layers[0], id: 'other', name: 'Other' }] };
    const gone = removeLayer(d, d.layers[0].id);
    expect(gone.motions).toEqual([]);
    expect(Object.keys(gone.cels).some((k) => k.includes(':src:'))).toBe(false);
  });

  it('survives a project save and load', () => {
    let d = squareDoc(4);
    const r = createMotion(d, d.layers[0].id, 0, 0, 3)!;
    d = setKey(r.doc, r.id, 'x', 3, 9);
    const back = readProject(writeProject(d)).doc;
    expect(back.motions?.[0].tracks.x?.length).toBe(2);
    expect(cel(back, 2).gen).toBe(r.id);
    expect(back.cels[srcKey(back.layers[0].id, r.id)].x).toBe(4);
    // Re-baking the loaded copy gives the same frames.
    const again = bakeMotion(back, r.id).doc;
    expect(cel(again, 3).x).toBe(cel(d, 3).x);
  });

  it('indexed sprites stay on the palette after a hue tween', () => {
    let d: Doc = { ...squareDoc(3), colorMode: 'indexed', palette: [RED, BLUE] };
    const r = createMotion(d, d.layers[0].id, 0, 0, 2)!;
    d = setKey(r.doc, r.id, 'hue', 2, 200);
    for (const p of cel(d, 2).data) expect([RED, BLUE]).toContain(p);
  });
});

describe('wave warp', () => {
  const fx = effectById('wave-warp')!;
  const W = 16, H = 16;
  const stripe = () => { const a = new Uint32Array(W * H); for (let y = 0; y < H; y++) a[y * W + 8] = RED; return a; };

  it('adds no new colours and shifts rows sideways', () => {
    const out = fx.apply(stripe(), W, H, { ...defaultParams(fx), amp: 3, length: 8 }, { palette: [] });
    expect(new Set(out)).toEqual(new Set([0, RED]));
    const cols = new Set<number>();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (out[y * W + x]) cols.add(x);
    expect(cols.size).toBeGreaterThan(1);
  });
  it('a whole number of cycles loops: t=0 and t=1 match', () => {
    const p = { ...defaultParams(fx), amp: 3, length: 8, cycles: 2 };
    expect(fx.apply(stripe(), W, H, p, { palette: [], t: 0 })).toEqual(fx.apply(stripe(), W, H, p, { palette: [], t: 1 }));
    expect(fx.apply(stripe(), W, H, p, { palette: [], t: 0 })).not.toEqual(fx.apply(stripe(), W, H, p, { palette: [], t: 0.25 }));
  });
  it('zero amplitude is the identity; outside the radius nothing moves', () => {
    const src = stripe();
    expect(fx.apply(src, W, H, { ...defaultParams(fx), amp: 0 }, { palette: [] })).toEqual(src);
    const local = fx.apply(src, W, H, { ...defaultParams(fx), amp: 4, radius: 3, cx: 50, cy: 0 }, { palette: [] });
    expect(local[15 * W + 8]).toBe(RED);
  });
  it('settings interpolate for animation', () => {
    const p = lerpParams(fx, { ...defaultParams(fx), amp: 0 }, { ...defaultParams(fx), amp: 10, mode: 'Ripple' }, 0.5);
    expect(p.amp).toBe(5);
    expect(p.mode).toBe('Horizontal');
  });
});
