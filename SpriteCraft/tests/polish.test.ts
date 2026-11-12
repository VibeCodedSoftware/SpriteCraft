import { afterEach, describe, expect, it } from 'vitest';
import { A, rgba } from '../src/core/color';
import { clearFxCache, composeFrame, fxErrors, fxSettings, fxStats } from '../src/core/compose';
import { addLayer, newDoc, newLayer, setCel, trimToCel } from '../src/core/doc';
import { registerEffect } from '../src/core/effects';
import { NODE_PRESETS } from '../src/core/nodes';
import { celKey, type Doc } from '../src/core/types';
import { newWeather } from '../src/core/weather';
import { readAseprite, writeAseprite } from '../src/io/aseprite';
import { readProject, writeProject } from '../src/io/project';
import { renderFrames } from '../src/io/sheet';
import '../src/core/shaders';

const W = 24, H = 24;
/** A sprite with art, a rain layer and a node-graph layer, over 4 frames. */
function scene(): Doc {
  let d = newDoc(W, H, 's', 4);
  const art = new Uint32Array(W * H);
  for (let y = 16; y < H; y++) for (let x = 0; x < W; x++) art[y * W + x] = rgba(90, 70, 50);
  for (let y = 6; y < 12; y++) for (let x = 8; x < 14; x++) art[y * W + x] = rgba(200, 80, 60);
  for (const fr of d.frames) d = setCel(d, celKey(d.layers[0].id, fr.id), trimToCel(art, W, H, 0, 0), false);
  d = addLayer(d, { ...newLayer('Rain'), fx: [{ id: 'r', effect: 'weather', on: true, params: { weather: newWeather('rain') } }] }, null);
  const lit = { ...newLayer('Lit'), fx: [{ id: 'n', effect: 'nodes', on: true, params: { graph: NODE_PRESETS[0].build() } }] };
  d = addLayer(d, lit, null);
  const blob = new Uint32Array(W * H); for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) blob[y * W + x] = rgba(60, 200, 90);
  for (const fr of d.frames) d = setCel(d, celKey(lit.id, fr.id), trimToCel(blob, W, H, 0, 0), false);
  return d;
}

afterEach(() => { Object.assign(fxSettings, { cache: true, deferWhileDrawing: true, budgetMB: 192, showOnCanvas: true }); clearFxCache(); });

describe('live-effect cache', () => {
  it('gives the same pixels with and without kept results, and reuses them', () => {
    const d = scene();
    fxSettings.cache = false;
    const plain = [0, 1, 2, 3].map((i) => composeFrame(d, i));
    fxSettings.cache = true; clearFxCache();
    const first = [0, 1, 2, 3].map((i) => composeFrame(d, i));
    const hits = fxStats.hits;
    const again = [0, 1, 2, 3].map((i) => composeFrame(d, i));
    expect(first).toEqual(plain);
    expect(again).toEqual(plain);
    expect(fxStats.hits).toBeGreaterThan(hits);
  });
  it('a changed document is drawn afresh', () => {
    const d = scene();
    const a = composeFrame(d, 1);
    const moved = { ...d, layers: d.layers.map((l) => (l.name === 'Rain' ? { ...l, fx: [{ ...l.fx![0], params: { weather: { ...newWeather('rain'), seed: 77 } } }] } : l)) };
    expect(composeFrame(moved, 1)).not.toEqual(a);
  });
  it('while drawing on another layer, shaded layers can show as they were before the stroke', () => {
    const d = scene();
    const before = composeFrame(d, 0);
    // A stroke on the art layer that paints the whole top-left corner.
    const stroke = new Uint32Array(W * H).fill(rgba(255, 255, 255));
    const cel = trimToCel(stroke, W, H, 0, 0)!;
    const o = { override: { layerId: d.layers[0].id, cel } };
    const deferred = fxStats.deferred;
    composeFrame(d, 0, o);
    expect(fxStats.deferred).toBeGreaterThan(deferred);
    fxSettings.deferWhileDrawing = false;
    const live = composeFrame(d, 0, o);
    expect(live).not.toEqual(before);
  });
  it('a live effect that fails is passed over instead of breaking the frame', () => {
    registerEffect({ id: 'test-broken', name: 'Broken', liveOnly: true, params: [], apply() { throw new Error('boom'); } });
    let d = newDoc(W, H, 'b', 1);
    const art = new Uint32Array(W * H).fill(rgba(9, 9, 9));
    d = setCel(d, celKey(d.layers[0].id, d.frames[0].id), trimToCel(art, W, H, 0, 0));
    d = { ...d, layers: d.layers.map((l) => ({ ...l, fx: [{ id: 'x', effect: 'test-broken', on: true, params: {} }] })) };
    expect(composeFrame(d, 0)[0]).toBe(rgba(9, 9, 9));
    expect([...fxErrors.values()]).toContain('boom');
  });
  it('fills in settings missing from older files', () => {
    let d = newDoc(W, H, 'w', 2);
    const water = new Uint32Array(W * H); for (let y = 16; y < H; y++) for (let x = 0; x < W; x++) water[y * W + x] = rgba(40, 80, 160);
    d = { ...d, layers: d.layers.map((l) => ({ ...l, fx: [{ id: 'w', effect: 'water', on: true, params: {} }] })) };
    d = setCel(d, celKey(d.layers[0].id, d.frames[0].id), trimToCel(water, W, H, 0, 0));
    fxErrors.clear();
    expect(() => composeFrame(d, 0)).not.toThrow();
    expect(fxErrors.size).toBe(0);
  });
});

describe('export compatibility with live effects', () => {
  it('.aseprite keeps what you see: live layers are drawn into their pixels, with a note', () => {
    const d = scene();
    const { bytes, warnings } = writeAseprite(d);
    expect(warnings.join(' ')).toMatch(/Live effects/);
    const back = readAseprite(bytes, 's').doc;
    for (let i = 0; i < 4; i++) expect(composeFrame(back, i)).toEqual(composeFrame(d, i));
  });
  it('.spritecraft keeps live effects live', () => {
    const d = scene();
    const back = readProject(writeProject(d)).doc;
    expect(back.layers.map((l) => l.fx?.[0]?.effect ?? null)).toEqual(d.layers.map((l) => l.fx?.[0]?.effect ?? null));
    for (let i = 0; i < 4; i++) expect(composeFrame(back, i)).toEqual(composeFrame(d, i));
  });
  it('PNG, GIF and sheet exports draw the live effects', () => {
    const d = scene();
    const frames = renderFrames(d, 0, 3);
    frames.forEach((f, i) => expect(f).toEqual(composeFrame(d, i, { skipReference: true })));
    expect(frames.some((f, i) => f.some((c, k) => A(c) && c !== composeFrame({ ...d, layers: d.layers.map((l) => ({ ...l, fx: undefined })) }, i)[k]))).toBe(true);
  });
});
