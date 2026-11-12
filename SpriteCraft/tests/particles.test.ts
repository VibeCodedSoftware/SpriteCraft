import { describe, expect, it } from 'vitest';
import { A, fromHex, rgba } from '../src/core/color';
import { composeFrame } from '../src/core/compose';
import { addLayer, newDoc, newLayer, setCel, trimToCel } from '../src/core/doc';
import { effectById } from '../src/core/effects';
import { PARTICLE_PRESETS, drawSystem, fromCraft, newEmitter, newSystem, particlesAt, toCraft, type ParticleSystem } from '../src/core/particles';
import { celKey } from '../src/core/types';
import { readParticleVfx, writeParticleVfx } from '../src/io/particlecraft';
import { encodePng } from '../src/io/png';

const W = 32, H = 32;
const sys = (patch: Partial<ParticleSystem> = {}, em: Parameters<typeof newEmitter>[1] | undefined = undefined, e: Partial<ReturnType<typeof newEmitter>> = {}): ParticleSystem =>
  ({ ...newSystem(W, H), x: 16, y: 16, emitters: [{ ...newEmitter('a', em), ...e }], ...patch });
const draw = (s: ParticleSystem, time: number, loop = 1, base = new Uint32Array(W * H), palette: number[] = []) => drawSystem(s, base, W, H, time, loop, { palette }, base);
const count = (img: Uint32Array) => img.reduce((n, c) => n + (A(c) ? 1 : 0), 0);
const colours = (img: Uint32Array) => new Set([...img].filter((c) => A(c)));

describe('particle simulation', () => {
  it('is the same every time for the same frame (no state between frames)', () => {
    const s = sys({}, undefined, { rate: 30, speed: 25, spread: 60, turbulence: 40, gravity: 30 });
    expect(draw(s, 0.37)).toEqual(draw(s, 0.37));
  });
  it('loops exactly: the time one loop later looks the same', () => {
    const s = sys({}, undefined, { rate: 25, lifetime: 1.6, lifetimeVar: 0.3, speed: 20, spread: 40, gravity: 20, swirl: 40 });
    for (const t of [0, 0.25, 0.6]) expect(draw(s, t + 1, 1)).toEqual(draw(s, t, 1));
    // And the first frame is already full (particles from the loop before are still alive).
    expect(count(draw(s, 0))).toBeGreaterThan(5);
  });
  it('a one-shot system starts empty and ends empty', () => {
    const s = sys({ looping: false }, undefined, { rate: 0, burst: 20, lifetime: 0.5, lifetimeVar: 0 });
    expect(count(draw(s, 0.2))).toBeGreaterThan(0);
    expect(count(draw(s, 0.9))).toBe(0);
  });
  it('gravity pulls particles down and direction sends them up', () => {
    const up = sys({}, undefined, { rate: 0, burst: 10, lifetime: 2, lifetimeVar: 0, speed: 30, speedVar: 0, angle: -90, spread: 0 });
    const ps = particlesAt(up.emitters[0], up, 0.3, 2, null);
    expect(ps.every((p) => p.y < 16)).toBe(true);
    const fall = { ...up, emitters: [{ ...up.emitters[0], speed: 0, gravity: 100 }] };
    expect(particlesAt(fall.emitters[0], fall, 0.3, 2, null).every((p) => p.y > 16)).toBe(true);
  });
  it('bounces off a floor', () => {
    const s = sys({}, undefined, { rate: 0, burst: 5, lifetime: 3, lifetimeVar: 0, speed: 0, gravity: 200, floor: 24, bounce: 0.5 });
    for (const t of [0.2, 0.5, 1, 2]) for (const p of particlesAt(s.emitters[0], s, t, 3, null)) expect(p.y).toBeLessThanOrEqual(24.01);
  });
  it('bounces off solid art below', () => {
    const below = new Uint32Array(W * H);
    for (let x = 0; x < W; x++) for (let y = 22; y < H; y++) below[y * W + x] = rgba(90, 90, 90);
    const s = sys({}, undefined, { rate: 0, burst: 6, lifetime: 3, lifetimeVar: 0, speed: 0, gravity: 200, collideArt: true });
    const img = drawSystem(s, new Uint32Array(W * H), W, H, 1.5, 3, { palette: [], below }, null);
    for (let y = 23; y < H; y++) for (let x = 0; x < W; x++) expect(A(img[y * W + x])).toBe(0);
  });
});

describe('pixel drawing', () => {
  it('uses only the ramp colours, stepped rather than blended', () => {
    const ramp = ['#ffffff', '#ffcd75', '#b13e53'];
    const img = draw(sys({}, undefined, { rate: 40, lifetime: 1, speed: 20, spread: 90, colours: ramp, alphaStart: 1, alphaEnd: 0, fade: 'dither', sizeStart: 2, sizeEnd: 1 }), 0.5);
    const allowed = new Set(ramp.map((c) => fromHex(c)!));
    expect(count(img)).toBeGreaterThan(0);
    for (const c of colours(img)) expect(allowed.has(c)).toBe(true);
  });
  it('snaps to the palette when asked', () => {
    const pal = [rgba(0, 0, 0), rgba(255, 0, 0)];
    const img = draw(sys({ palette: true }, undefined, { rate: 30, colours: ['#f01010'] }), 0.5, 1, new Uint32Array(W * H), pal);
    for (const c of colours(img)) expect(c).toBe(pal[1]);
  });
  it('keeps particles inside a mask', () => {
    const mask = new Uint32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < 16; x++) mask[y * W + x] = rgba(1, 1, 1);
    const s = sys({ mask: 'inside', keepArt: false }, undefined, { rate: 60, speed: 30, spread: 180, colours: ['#ff0000'] });
    const img = effectById('particles')!.apply(mask, W, H, { system: s }, { palette: [], seconds: 0.5, loopSeconds: 1 });
    expect(count(img)).toBeGreaterThan(0);
    for (let y = 0; y < H; y++) for (let x = 16; x < W; x++) expect(A(img[y * W + x])).toBe(0);
    // The mask's own pixels are not shown.
    expect([...colours(img)]).toEqual([fromHex('#ff0000')]);
  });
  it('draws a picture particle with its own pixels', () => {
    const s = sys({}, undefined, { rate: 0, burst: 1, lifetime: 5, speed: 0, look: 'sprite', sprite: { w: 2, h: 1, frames: [[rgba(1, 2, 3), rgba(4, 5, 6)]] } });
    const img = draw(s, 0.1, 5);
    expect(colours(img)).toEqual(new Set([rgba(1, 2, 3), rgba(4, 5, 6)]));
  });
  it('every preset draws something within a second', () => {
    for (const p of PARTICLE_PRESETS) {
      const s: ParticleSystem = { ...newSystem(W, H), emitters: p.emitters.map((e, i) => ({ ...newEmitter('p' + i), ...e })) };
      const any = [0.1, 0.3, 0.5].some((t) => count(draw(s, t)) > 0);
      expect(any, p.name).toBe(true);
    }
  });
});

describe('live on a layer', () => {
  it('shows in the composed frame and moves between frames', () => {
    let d = newDoc(W, H, 'p', 8);
    const l = { ...newLayer('Particles'), fx: [{ id: 'f', effect: 'particles', on: true, params: { system: sys({}, undefined, { rate: 30, speed: 20, colours: ['#00ff00'] }) } }] };
    d = addLayer(d, l, null);
    const a = composeFrame(d, 0), b = composeFrame(d, 3);
    expect([...a].some((c) => c === fromHex('#00ff00'))).toBe(true);
    expect(a).not.toEqual(b);
  });
  it('keeps the layer art underneath', () => {
    let d = newDoc(W, H, 'p', 2);
    const l = { ...newLayer('Particles'), fx: [{ id: 'f', effect: 'particles', on: true, params: { system: sys({}, undefined, { rate: 0 }) } }] };
    d = addLayer(d, l, null);
    const art = new Uint32Array(W * H); art[0] = rgba(9, 9, 9);
    d = setCel(d, celKey(l.id, d.frames[0].id), trimToCel(art, W, H, 0, 0));
    expect(composeFrame(d, 0)[0]).toBe(rgba(9, 9, 9));
  });
});

describe('ParticleCraft exchange', () => {
  it('converts units both ways', () => {
    const e = { ...newEmitter('a'), rate: 12, speed: 32, angle: -90, gravity: 48, sizeStart: 4, sizeEnd: 2, colours: ['#ff0000', '#00ff00', '#0000ff'] };
    const c = toCraft(e, true, 1);
    expect(c.speed).toBeCloseTo(2);
    expect(c.direction[1]).toBeCloseTo(1); // up
    expect(c.gravity).toBeCloseTo(-3); // negative falls
    expect(c.colorMid).toBe('#00ff00');
    const back = fromCraft(c, 'b', 'B');
    expect(back.speed).toBeCloseTo(32);
    expect(back.angle).toBeCloseTo(-90);
    expect(back.gravity).toBeCloseTo(48);
    expect(back.sizeStart).toBeCloseTo(4);
    expect(back.colours).toEqual(['#ff0000', '#00ff00', '#0000ff']);
  });
  it('writes a real-time effect with a graph and layers, and reads it back', () => {
    const s = sys({ name: 'Sparks' }, 'Sparks', { rate: 20, burst: 5, gravity: 80, trail: 0.05, look: 'spark', turbulence: 16 });
    const a = writeParticleVfx(s, 1);
    expect(a.format).toBe('craft.vfx');
    expect(a.kind).toBe('realtime');
    expect(a.layers).toHaveLength(1);
    const types = (a.graph.systems[0] as any).contexts;
    expect(types.spawn.map((b: any) => b.type)).toEqual(['rate', 'burst', 'duration']);
    expect(types.update.map((b: any) => b.type)).toEqual(['gravity', 'turbulence']);
    expect(types.output.map((b: any) => b.type)).toContain('trail');
    const { system } = readParticleVfx(JSON.stringify(a), W, H);
    const e = system.emitters[0];
    expect(e.rate).toBe(20); expect(e.burst).toBe(5); expect(e.gravity).toBeCloseTo(80); expect(e.look).toBe('spark');
  });
  it('reads a ParticleCraft layer with its own picture', () => {
    const png = encodePng({ w: 2, h: 2, data: new Uint32Array([rgba(255, 0, 0), 0, 0, rgba(0, 0, 255)]) });
    let s = ''; for (const b of png) s += String.fromCharCode(b);
    const asset = { format: 'craft.vfx', schemaVersion: 2, name: 'Pic', kind: 'realtime', layers: [{ name: 'L', params: { rate: 5, textureImage: 'data:image/png;base64,' + btoa(s) } }] };
    const e = readParticleVfx(JSON.stringify(asset), W, H).system.emitters[0];
    expect(e.look).toBe('sprite');
    expect(e.sprite).toEqual({ w: 2, h: 2, frames: [[rgba(255, 0, 0), 0, 0, rgba(0, 0, 255)]] });
  });
  it('refuses files it cannot use', () => {
    expect(() => readParticleVfx('{"format":"other"}', W, H)).toThrow();
    expect(() => readParticleVfx('{"format":"craft.vfx","schemaVersion":9,"kind":"realtime","layers":[]}', W, H)).toThrow(/newer/);
    expect(() => readParticleVfx('{"format":"craft.vfx","schemaVersion":1,"kind":"baked"}', W, H)).toThrow(/flipbook/);
  });
});
