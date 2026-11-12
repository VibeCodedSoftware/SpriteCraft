import { describe, expect, it } from 'vitest';
import { A, fromHex, rgba } from '../src/core/color';
import { composeFrame, layersBelow } from '../src/core/compose';
import { addLayer, newDoc, newLayer, setCel, trimToCel } from '../src/core/doc';
import { effectById } from '../src/core/effects';
import { celKey } from '../src/core/types';
import { WEATHER_PRESETS, drawWeather, newWeather, type Weather } from '../src/core/weather';

const W = 48, H = 48;
const blank = () => new Uint32Array(W * H);
const count = (img: Uint32Array) => img.reduce((n, c) => n + (A(c) ? 1 : 0), 0);
const colours = (img: Uint32Array) => new Set([...img].filter((c) => A(c)));
const rain = (p: Partial<Weather> = {}): Weather => ({ ...newWeather('rain'), ...p });
const snow = (p: Partial<Weather> = {}): Weather => ({ ...newWeather('snow'), ...p });
const draw = (wt: Weather, t: number, loop = 1, own = blank(), below?: Uint32Array, progress = 1) => drawWeather(wt, own, W, H, t, loop, { palette: [], below }, progress);
/** Solid art filling every row from `y` down. */
const floorAt = (y: number) => { const b = blank(); for (let yy = y; yy < H; yy++) for (let x = 0; x < W; x++) b[yy * W + x] = rgba(80, 60, 40); return b; };

describe('rain', () => {
  it('draws the same frame the same way every time, and loops exactly', () => {
    const wt = rain({ speedVar: 0.4, sway: 1 });
    expect(draw(wt, 0.3)).toEqual(draw(wt, 0.3));
    for (const t of [0, 0.4, 0.75]) expect(draw(wt, t + 1)).toEqual(draw(wt, t));
    expect(draw(wt, 0.1)).not.toEqual(draw(wt, 0.2));
  });
  it('more density gives more rain', () => {
    expect(count(draw(rain({ amount: 12 }), 0.5))).toBeGreaterThan(count(draw(rain({ amount: 2 }), 0.5)) * 2);
  });
  it('wind slants the streaks', () => {
    const streakDx = (wind: number) => {
      const img = draw(rain({ amount: 1, wind, length: 12, depths: { far: false, mid: false, near: true }, splashes: false }), 0.5);
      // For each lit pixel, a lit pixel diagonally below-right (wind right) or below-left.
      let right = 0, left = 0;
      for (let y = 0; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (A(img[y * W + x])) { if (A(img[(y + 1) * W + x + 1])) right++; if (A(img[(y + 1) * W + x - 1])) left++; }
      return right - left;
    };
    expect(streakDx(40)).toBeGreaterThan(0);
    expect(streakDx(-40)).toBeLessThan(0);
  });
  it('stops at the ground row and on the art below', () => {
    const wt = rain({ amount: 10, ground: 30, splashes: false });
    for (const t of [0.1, 0.5, 0.9]) { const img = draw(wt, t); for (let y = 30; y < H; y++) for (let x = 0; x < W; x++) expect(A(img[y * W + x])).toBe(0); }
    const below = floorAt(36);
    const onArt = rain({ amount: 10, splashes: false, depths: { far: false, mid: true, near: true } });
    for (const t of [0.2, 0.6]) { const img = draw(onArt, t, 1, blank(), below); for (let y = 36; y < H; y++) for (let x = 0; x < W; x++) expect(A(img[y * W + x])).toBe(0); }
  });
  it('splashes just above where drops land', () => {
    const wt = rain({ amount: 14, ground: 40, depths: { far: false, mid: false, near: true }, splash: '#ff00ff', near: '#00ffff' });
    let splashPx = 0;
    for (let f = 0; f < 10; f++) {
      const img = draw(wt, f / 10);
      for (let i = 0; i < img.length; i++) if (img[i] === fromHex('#ff00ff')) { splashPx++; expect(Math.floor(i / W)).toBeGreaterThan(30); expect(Math.floor(i / W)).toBeLessThan(40); }
    }
    expect(splashPx).toBeGreaterThan(0);
  });
  it('makes ripples on puddles painted on its own layer, inside the puddle', () => {
    const own = blank();
    const PUD = rgba(30, 40, 90);
    for (let x = 0; x < W; x++) own[44 * W + x] = PUD;
    const wt = rain({ amount: 14, depths: { far: false, mid: false, near: true }, splash: '#ff00ff' });
    let ripples = 0;
    for (let f = 0; f < 10; f++) {
      const img = draw(wt, f / 10, 1, own);
      for (let i = 0; i < img.length; i++) if (img[i] === fromHex('#ff00ff')) { ripples++; expect(own[i]).toBe(PUD); }
    }
    expect(ripples).toBeGreaterThan(0);
  });
  it('far drops are drawn in the far colour, as solid pixels', () => {
    const far = draw(rain({ depths: { far: true, mid: false, near: false } }), 0.5);
    expect(count(far)).toBeGreaterThan(0);
    for (const c of colours(far)) expect(A(c)).toBe(255);
    expect(colours(far).has(fromHex('#5a6c96')!)).toBe(true);
  });
  it('fans out with perspective', () => {
    expect(draw(rain({ perspective: 1 }), 0.5)).not.toEqual(draw(rain({ perspective: 0 }), 0.5));
  });
  it('snaps to the palette', () => {
    const pal = [rgba(0, 0, 0), rgba(200, 220, 255)];
    const img = drawWeather(rain({ palette: true }), blank(), W, H, 0.5, 1, { palette: pal }, 1);
    for (const c of colours(img)) expect(pal).toContain(c);
  });
});

describe('snow', () => {
  it('loops exactly, with drift and wind', () => {
    const wt = snow({ wind: 30, sway: 4 });
    for (const t of [0, 0.35, 0.8]) expect(draw(wt, t + 2, 2)).toEqual(draw(wt, t, 2));
  });
  it('has different flake sizes per depth layer', () => {
    const near = count(draw(snow({ amount: 3, size: 4, depths: { far: false, mid: false, near: true }, settleDepth: 0 }), 0.5));
    const far = count(draw(snow({ amount: 3, size: 4, depths: { far: true, mid: false, near: false }, settleDepth: 0 }), 0.5));
    // Far layers have more flakes but each is a single pixel, so they cover less per flake.
    expect(near / (3 * 0.6)).toBeGreaterThan(far / (3 * 1.4));
  });
  it('settles on surfaces open to the sky, and only there', () => {
    const below = blank();
    // A shelf from x 10..30 at row 20, and the ground at row 40.
    for (let x = 10; x <= 30; x++) below[20 * W + x] = rgba(90, 60, 30);
    for (let x = 0; x < W; x++) below[40 * W + x] = rgba(90, 60, 30);
    const wt = snow({ amount: 0, settleDepth: 3, settle: '#ffffff', shade: '#ffffff' });
    const img = draw(wt, 0, 1, blank(), below);
    const white = fromHex('#ffffff');
    expect(img[19 * W + 20]).toBe(white); // on the shelf
    expect(img[39 * W + 5]).toBe(white); // on open ground
    for (let x = 12; x <= 28; x++) expect(img[39 * W + x]).not.toBe(white); // under the shelf: sheltered
  });
  it('can build up over the animation', () => {
    const below = floorAt(40);
    const wt = snow({ amount: 0, settleDepth: 6, settleMode: 'build' });
    expect(count(draw(wt, 0, 1, blank(), below, 0))).toBe(0);
    expect(count(draw(wt, 0, 1, blank(), below, 0.5))).toBeLessThan(count(draw(wt, 0, 1, blank(), below, 1)));
  });
  it('uses a picture for flakes', () => {
    const wt = snow({ amount: 2, settleDepth: 0, sprite: { w: 2, h: 1, frames: [[rgba(1, 2, 3), rgba(4, 5, 6)]] } });
    for (const c of colours(draw(wt, 0.5))) expect([rgba(1, 2, 3), rgba(4, 5, 6)]).toContain(c);
  });
});

describe('weather on a layer', () => {
  it('every mood draws something', () => {
    for (const p of WEATHER_PRESETS) expect(count(draw({ ...newWeather(p.w.kind), ...p.w }, 0.5)), p.name).toBeGreaterThan(0);
  });
  it('falls past a full-canvas sky layer instead of landing on it', () => {
    let d = newDoc(W, H, 'w', 4);
    const sky = d.layers[0];
    const SKY = rgba(20, 20, 40);
    const fill = new Uint32Array(W * H).fill(SKY);
    for (const fr of d.frames) d = setCel(d, celKey(sky.id, fr.id), trimToCel(fill, W, H, 0, 0), false);
    d = addLayer(d, { ...newLayer('Rain'), fx: [{ id: 'f', effect: 'weather', on: true, params: { weather: rain({ splashes: false }) } }] }, null);
    const img = composeFrame(d, 1);
    // Drops show all the way down, not only on the top row.
    let low = 0; for (let y = H / 2; y < H; y++) for (let x = 0; x < W; x++) if (img[y * W + x] !== SKY) low++;
    expect(low).toBeGreaterThan(5);
  });
  it('baking gives the same pixels, and baked weather is never a surface for weather above it', () => {
    let d = newDoc(W, H, 'w', 4);
    const ground = floorAt(40);
    for (const fr of d.frames) d = setCel(d, celKey(d.layers[0].id, fr.id), trimToCel(ground, W, H, 0, 0), false);
    const back = { ...newLayer('Back'), fx: [{ id: 'a', effect: 'weather', on: true, params: { weather: snow({ depths: { far: true, mid: true, near: false } }) } }] };
    const front = { ...newLayer('Front'), fx: [{ id: 'b', effect: 'weather', on: true, params: { weather: snow({ depths: { far: false, mid: false, near: true }, seed: 2, settleDepth: 0 }) } }] };
    d = addLayer(d, back, null); d = addLayer(d, front, null);
    const live = [0, 1, 2, 3].map((i) => composeFrame(d, i));
    // Bake the back layer by hand, the way the editor does.
    let baked = d;
    for (let i = 0; i < 4; i++) {
      const img = effectById('weather')!.apply(new Uint32Array(W * H), W, H, back.fx[0].params, { palette: [], frame: i, frames: 4, seconds: i * 0.1, loopSeconds: 0.4, belowWhere: (keep) => layersBelow(d, back.id, i, keep) });
      baked = setCel(baked, celKey(back.id, d.frames[i].id), trimToCel(img, W, H, 0, 0), false);
    }
    baked = { ...baked, layers: baked.layers.map((l) => (l.id === back.id ? { ...l, fx: undefined, bakedFrom: 'weather' as const } : l)) };
    for (let i = 0; i < 4; i++) expect(composeFrame(baked, i)).toEqual(live[i]);
  });
  it('runs live in the composed frame', () => {
    let d = newDoc(W, H, 'w', 6);
    d = addLayer(d, { ...newLayer('Rain'), fx: [{ id: 'f', effect: 'weather', on: true, params: { weather: rain() } }] }, null);
    const a = composeFrame(d, 0), b = composeFrame(d, 2);
    expect(count(a)).toBeGreaterThan(0);
    expect(a).not.toEqual(b);
  });
});
