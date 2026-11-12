import { describe, expect, it } from 'vitest';
import { A, B, G, R, rgba } from '../src/core/color';
import { newDoc } from '../src/core/doc';
import {
  decodeNormal, defaultLighting, encodeNormal, heightFrom, lightsAt, newLight, normalFromPicker, normalsFromHeight, setLightKey, shade,
  type Lighting,
} from '../src/core/light';

const W = 16, H = 16;
const GREY = rgba(200, 200, 200);
/** A 10×10 grey square in the middle. */
const square = () => { const a = new Uint32Array(W * H); for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) a[y * W + x] = GREY; return a; };
const normalsOf = (img: Uint32Array) => normalsFromHeight(heightFrom([img], W, H, { bevel: 3, strength: 3, detail: 0, invertDetail: false }), [img], W, H, 3);
const lighting = (patch: Partial<Lighting> = {}): Lighting => ({ ...defaultLighting(W, H), ambientIntensity: 0, bands: 0, dither: false, lights: [], ...patch });

describe('normal maps', () => {
  it('encode and decode round-trip; a flat pixel faces the viewer', () => {
    const [x, y, z] = decodeNormal(encodeNormal(0.6, -0.48, 0.64));
    expect(x).toBeCloseTo(0.6, 1); expect(y).toBeCloseTo(-0.48, 1); expect(z).toBeCloseTo(0.64, 1);
    expect(decodeNormal(0)).toEqual([0, 0, 1]);
    expect(encodeNormal(0, 0, 1) & 0xffffff).toBe(rgba(128, 128, 255) & 0xffffff);
  });

  it('a shape rounds off at its edges: left edge leans left, right edge right, top edge up, middle flat', () => {
    const n = normalsOf(square());
    expect(decodeNormal(n[8 * W + 3])[0]).toBeLessThan(-0.3);
    expect(decodeNormal(n[8 * W + 12])[0]).toBeGreaterThan(0.3);
    expect(decodeNormal(n[3 * W + 8])[1]).toBeLessThan(-0.3);
    expect(decodeNormal(n[8 * W + 8])[2]).toBeGreaterThan(0.95);
    expect(n[0]).toBe(0);
  });

  it('each layer is its own raised shape', () => {
    const top = new Uint32Array(W * H);
    for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) top[y * W + x] = GREY;
    const both = normalsFromHeight(heightFrom([square(), top], W, H, { bevel: 3, strength: 3, detail: 0, invertDetail: false }), [square(), top], W, H, 3);
    // The small layer's left edge leans left, inside the big square's flat middle.
    expect(decodeNormal(both[7 * W + 6])[0]).toBeLessThan(-0.1);
  });

  it('the picker gives the normal under the point, and nothing outside the sphere', () => {
    expect(normalFromPicker(1.2, 0)).toBeNull();
    expect(decodeNormal(normalFromPicker(0, 0)!)[2]).toBeCloseTo(1, 1);
    expect(decodeNormal(normalFromPicker(0.7, 0)!)[0]).toBeCloseTo(0.7, 1);
  });
});

describe('lights', () => {
  const art = square(), n = normalsOf(art);
  const lum = (c: number) => R(c) + G(c) + B(c);

  it('a light on the left brightens the left edge and leaves the right edge darker', () => {
    const li = { ...newLight('a', 'A', W, H), x: -10, y: 8, z: 6, radius: 100, specular: 0 };
    const out = shade({ base: art, normals: n, w: W, h: H, palette: [] }, lighting(), [li]);
    expect(lum(out[8 * W + 3])).toBeGreaterThan(lum(out[8 * W + 12]));
    expect(out[0]).toBe(0);
    expect(A(out[8 * W + 8])).toBe(255);
  });

  it('ambient alone tints evenly; no light leaves art dark', () => {
    const out = shade({ base: art, normals: n, w: W, h: H, palette: [] }, lighting({ ambient: '#ffffff', ambientIntensity: 0.5 }), []);
    expect(R(out[8 * W + 8])).toBe(100);
  });

  it('bands limit the shades: four bands give at most five brightness levels', () => {
    const li = { ...newLight('a', 'A', W, H), x: -10, y: 8, z: 6, radius: 100, specular: 0 };
    const out = shade({ base: art, normals: n, w: W, h: H, palette: [] }, lighting({ bands: 4 }), [li]);
    expect(new Set(out.filter((c) => c)).size).toBeLessThanOrEqual(5);
  });

  it('a spot only lights inside its cone', () => {
    const spot = { ...newLight('s', 'S', W, H), kind: 'spot' as const, x: 8, y: -4, z: 4, angle: 90, cone: 20, softness: 0, radius: 100, specular: 0 };
    const out = shade({ base: art, normals: null, w: W, h: H, palette: [] }, lighting(), [spot]);
    expect(lum(out[8 * W + 8])).toBeGreaterThan(0);
    expect(lum(out[8 * W + 3])).toBe(0);
  });

  it('a directional light from the right lights the right edge most', () => {
    const sun = { ...newLight('d', 'D', W, H), kind: 'directional' as const, angle: 180, elevation: 30, specular: 0 };
    const out = shade({ base: art, normals: n, w: W, h: H, palette: [] }, lighting(), [sun]);
    expect(lum(out[8 * W + 12])).toBeGreaterThan(lum(out[8 * W + 3]));
  });

  it('palette mode only uses palette colours', () => {
    const pal = [rgba(0, 0, 0), rgba(90, 90, 90), rgba(255, 255, 255)];
    const li = { ...newLight('a', 'A', W, H), x: -10, y: 8, z: 6, radius: 100 };
    const out = shade({ base: art, normals: n, w: W, h: H, palette: pal }, lighting({ usePalette: true }), [li]);
    for (const c of out) if (c) expect(pal).toContain(c);
  });

  it('shadows: a ridge blocks a low light from the flat ground behind it', () => {
    // A flat 16×16 plate with a ridge down column 10: its left face leans left, its right face leans right.
    const base = new Uint32Array(W * H).fill(GREY), nm = new Uint32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) nm[y * W + x] = x >= 7 && x <= 9 ? encodeNormal(-0.9, 0, 0.44) : x >= 10 && x <= 12 ? encodeNormal(0.9, 0, 0.44) : encodeNormal(0, 0, 1);
    const li = { ...newLight('a', 'A', W, H), x: 60, y: 8, z: 8, radius: 200, specular: 0 };
    const lit = shade({ base, normals: nm, w: W, h: H, palette: [] }, lighting(), [li]);
    const shadowed = shade({ base, normals: nm, w: W, h: H, palette: [] }, lighting({ shadows: true }), [li]);
    // Flat ground just left of the ridge is lit without shadows, dark with them; ground right of it stays lit.
    expect(lum(lit[8 * W + 5])).toBeGreaterThan(0);
    expect(lum(shadowed[8 * W + 5])).toBe(0);
    expect(lum(shadowed[8 * W + 14])).toBeGreaterThan(0);
  });

  it('light keys animate position; flicker varies by frame but repeats', () => {
    const doc = newDoc(W, H, 'T', 5);
    let l = lighting({ lights: [{ ...newLight('a', 'A', W, H), x: 0, flicker: 0.5 }] });
    l = setLightKey(doc, l, 'a', 'x', 4, 16);
    expect(lightsAt(doc, l, 0)[0].x).toBe(0);
    expect(lightsAt(doc, l, 4)[0].x).toBe(16);
    const i0 = lightsAt(doc, l, 1)[0].intensity, i1 = lightsAt(doc, l, 2)[0].intensity;
    expect(i0).not.toBe(i1);
    expect(lightsAt(doc, l, 1)[0].intensity).toBe(i0);
  });
});
