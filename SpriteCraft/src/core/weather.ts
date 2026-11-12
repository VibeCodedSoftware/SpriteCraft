// Phase 7: procedural pixel weather (rain and snow). Like particles, weather is a live layer shader ('weather') with no
// state between frames: every drop or flake is worked out from its number and the time. Each one falls a whole number of
// times per loop, so the animation loops exactly, and on each fall it picks a new column, so the pattern doesn't repeat
// within the loop. Drops stop on the ground row, on solid art in the layers below (if asked) and on pixels painted on
// the weather layer itself, which act as puddles: there they make ripples instead of splashes. Snow can settle on top of
// surfaces, steadily (it loops) or building up over the animation.
import { A, B, G, R, fromHex, nearestIndex, rgba } from './color';
import { registerEffect, type EffectContext } from './effects';
import { ditherThreshold } from './raster';
import { hash3, noise2 } from './shaders';

export type WeatherKind = 'rain' | 'snow';
export type Depth = 'far' | 'mid' | 'near';

export interface Weather {
  kind: WeatherKind;
  /** Drops or flakes per 1000 pixels of canvas, per depth layer. */
  amount: number;
  /** Falling speed of the nearest layer, pixels per second, and how much each one varies (0..1). */
  speed: number; speedVar: number;
  /** Wind as a slant in degrees (positive blows right). */
  wind: number;
  /** Side-to-side sway in pixels (snow drift, or rain flutter). */
  sway: number;
  /** Rain streak length in pixels (nearest layer). */
  length: number;
  /** Largest snowflake size (1 to 4 pixels). */
  size: number;
  /** Which depth layers fall: far ones are smaller, slower and fainter. */
  depths: Record<Depth, boolean>;
  /** 0..1: drops fan out from above the middle, as if looking up into the rain. */
  perspective: number;
  near: string; far: string; splash: string; settle: string; shade: string;
  splashes: boolean;
  /** Rows of the canvas below which drops stop (null: the bottom edge). */
  ground: number | null;
  /** Drops and flakes stop on solid art in the layers below. */
  hitArt: boolean;
  /** Which layers below count as surfaces (layer ids); unset means all but full-canvas backgrounds. */
  surfaces?: string[];
  /** Snow: settled depth in pixels, and whether it builds up over the animation (not looping) or stays steady. */
  settleDepth: number; settleMode: 'steady' | 'build';
  /** Snow: seconds a flake stays where it lands. */
  linger: number;
  palette: boolean;
  /** A picture to use as the snowflake (frames play while it falls). */
  sprite?: { w: number; h: number; frames: number[][] };
  seed: number;
}

export const newWeather = (kind: WeatherKind = 'rain'): Weather => kind === 'rain'
  ? { kind, amount: 6, speed: 220, speedVar: 0.25, wind: 12, sway: 0, length: 6, size: 1, depths: { far: true, mid: true, near: true }, perspective: 0,
    near: '#c0d8ff', far: '#5a6c96', splash: '#e0ecff', settle: '#ffffff', shade: '#a8c0e0', splashes: true, ground: null, hitArt: true,
    settleDepth: 0, settleMode: 'steady', linger: 0, palette: false, seed: 1 }
  : { kind, amount: 4, speed: 22, speedVar: 0.3, wind: 8, sway: 3, length: 0, size: 3, depths: { far: true, mid: true, near: true }, perspective: 0,
    near: '#ffffff', far: '#8fa3c4', splash: '#ffffff', settle: '#f4f8ff', shade: '#a8bcd8', splashes: false, ground: null, hitArt: true,
    settleDepth: 2, settleMode: 'steady', linger: 0.6, palette: false, seed: 1 };

/** Moods from the brief, ready to start from. */
export const WEATHER_PRESETS: { name: string; w: Partial<Weather> & { kind: WeatherKind } }[] = [
  { name: 'Drizzle', w: { kind: 'rain', amount: 3, speed: 150, length: 3, wind: 6, splashes: false, depths: { far: true, mid: true, near: false } } },
  { name: 'Light rain', w: { kind: 'rain', amount: 4, speed: 200, length: 5, wind: 10 } },
  { name: 'Heavy rain', w: { kind: 'rain', amount: 10, speed: 260, length: 8, wind: 14 } },
  { name: 'Storm', w: { kind: 'rain', amount: 14, speed: 320, length: 10, wind: 35, speedVar: 0.35, sway: 1, near: '#d0e0ff', far: '#46506e' } },
  { name: 'Looking up into rain', w: { kind: 'rain', amount: 8, speed: 240, length: 7, wind: 0, perspective: 0.8 } },
  { name: 'Light snow', w: { kind: 'snow', amount: 2, speed: 16, sway: 3, size: 2, settleDepth: 1 } },
  { name: 'Snowfall', w: { kind: 'snow', amount: 4, speed: 22, sway: 3, size: 3, settleDepth: 2 } },
  { name: 'Blizzard', w: { kind: 'snow', amount: 9, speed: 45, wind: 50, sway: 5, size: 3, settleDepth: 3, settleMode: 'build', speedVar: 0.5 } },
  { name: 'Big flakes', w: { kind: 'snow', amount: 1.5, speed: 14, sway: 5, size: 4, settleDepth: 2, linger: 1 } },
];

const DEPTH: Record<Depth, { speed: number; len: number; count: number; size: number }> = {
  far: { speed: 0.45, len: 0.4, count: 1.4, size: 0.34 },
  mid: { speed: 0.7, len: 0.7, count: 1, size: 0.67 },
  near: { speed: 1, len: 1, count: 0.6, size: 1 },
};
const DEPTHS: Depth[] = ['far', 'mid', 'near'];

const col = (s: string) => fromHex(s) ?? 0xffffffff;
const mix = (a: number, b: number, k: number) => rgba(Math.round(R(a) + (R(b) - R(a)) * k), Math.round(G(a) + (G(b) - G(a)) * k), Math.round(B(a) + (B(b) - B(a)) * k));

export interface WeatherCtx { below?: Uint32Array; palette: EffectContext['palette'] }

/** Draws the weather at `time` seconds (looping every `loop` seconds) over `own` (the weather layer's pixels). */
export function drawWeather(wt: Weather, own: Uint32Array, w: number, h: number, time: number, loop: number, ctx: WeatherCtx, progress = 0): Uint32Array {
  const out = own.slice();
  loop = Math.max(0.05, loop);
  time = ((time % loop) + loop) % loop;
  const ground = Math.min(h, Math.max(0, wt.ground ?? h));
  const below = ctx.below;
  const art = (x: number, y: number) => wt.hitArt && !!below && A(below[y * w + x]) > 200;
  const puddle = (x: number, y: number) => A(own[y * w + x]) > 0;
  const solid = (x: number, y: number, far: boolean) => y >= ground || (!far && (art(x, y) || puddle(x, y)));
  const pal = wt.palette && ctx.palette.length ? ctx.palette : null;
  const snap = (c: number) => (pal ? pal[nearestIndex(c, pal)] : c);
  let behindArt = false;
  const plot = (x: number, y: number, c: number, alpha = 1) => {
    x = Math.floor(x); y = Math.floor(y);
    x = ((x % w) + w) % w;
    if (y < 0 || y >= h) return;
    // Far weather is behind everything solid: hidden by the art and the ground.
    if (behindArt && (y >= ground || art(x, y))) return;
    if (alpha < 1 && alpha <= ditherThreshold('bayer4', x, y)) return;
    out[y * w + x] = (snap(c) | 0xff000000) >>> 0;
  };
  const wx = Math.tan((Math.max(-75, Math.min(75, wt.wind)) * Math.PI) / 180);
  const nearC = col(wt.near), farC = col(wt.far), splashC = col(wt.splash);

  if (wt.kind === 'snow' && wt.settleDepth > 0) drawSettled(wt, out, w, h, ground, art, puddle, snap, wt.settleMode === 'build' ? progress : 1);

  for (const dname of DEPTHS) {
    if (!wt.depths[dname]) continue;
    const D = DEPTH[dname], far = dname === 'far', di = DEPTHS.indexOf(dname);
    behindArt = far;
    const colour = dname === 'near' ? nearC : dname === 'far' ? farC : mix(farC, nearC, 0.6);
    const n = Math.round((wt.amount * (w * h)) / 1000 * D.count);
    const len = Math.max(1, Math.round(wt.length * D.len));
    const size = Math.max(1, Math.round(wt.size * D.size));
    for (let k = 0; k < n; k++) {
      const r = (i: number, c = 0) => hash3(k * 7 + di, i + c * 31, wt.seed * 977 + 5);
      const v = Math.max(1, wt.speed * D.speed * (1 + (r(1) * 2 - 1) * wt.speedVar));
      const span = h + len + 2;
      const fallT = span / v;
      const linger = wt.kind === 'snow' ? wt.linger : 0.25;
      // A whole number of falls per loop, so the loop is exact.
      const falls = Math.max(1, Math.round(loop / (fallT + linger)));
      const T = loop / falls, fallFrac = fallT / (fallT + linger);
      const u = time / T + r(2), c = Math.floor(u) % falls, ph = u - Math.floor(u);
      const x0 = r(3, c) * w;
      const slant = wx + wt.perspective * ((x0 - w / 2) / Math.max(1, h)) * 1.5;
      const phase0 = r(4, c) * Math.PI * 2, swings = 1 + Math.floor(r(5, c) * 2);
      const pathX = (y: number, p: number) => x0 + slant * y + (wt.sway ? wt.sway * D.size * Math.sin(phase0 + p * Math.PI * 2 * swings) : 0);
      const yAt = (p: number) => -len + (p / fallFrac) * span;
      // Where this fall ends: the first solid pixel on its path.
      let hitY = h + len, hitX = 0;
      for (let y = 0; y < h; y++) {
        const p = Math.min(fallFrac, ((y + len) / span) * fallFrac);
        const x = ((Math.floor(pathX(y, p)) % w) + w) % w;
        if (solid(x, y, far)) { hitY = y; hitX = x; break; }
      }
      const phHit = ((hitY + len) / span) * fallFrac;
      // Depth shows through colour, not see-through pixels: dithered streaks break up into specks.
      const alpha = 1;
      const tail = mix(colour, farC, dname === 'far' ? 0.4 : 0.5);
      if (ph < phHit) {
        const y = yAt(ph);
        if (wt.kind === 'rain') {
          // A streak from the head back along the slant, stopping above the surface.
          for (let i = 0; i < len; i++) {
            const yy = y - i;
            if (yy >= hitY || yy < 0) continue;
            plot(pathX(yy, ph), yy, len > 2 && i >= len - Math.max(1, Math.floor(len / 3)) ? tail : colour, alpha);
          }
        } else drawFlake(wt, plot, pathX(y, ph), y, size, colour, alpha, ph, hitY);
      } else if (hitY < h + len) {
        const since = (ph - phHit) * T;
        if (wt.kind === 'snow') {
          if (since < wt.linger) drawFlake(wt, plot, hitX, hitY - 1, Math.max(1, size - 1), colour, alpha, 1, h + 1);
        } else if (!far && hitY < h && !(hitY > 0 && solid(hitX, hitY - 1, false))) {
          // Only on tops of things: a drop blown into the side of a wall just stops.
          if (puddle(hitX, hitY) && hitY < ground) ripple(plot, own, w, h, hitX, hitY, since, splashC);
          else if (wt.splashes) splash(plot, hitX, hitY, since, splashC, dname === 'near', (i) => r(10 + i, c));
        }
      }
    }
  }
  return out;
}

function drawFlake(wt: Weather, plot: (x: number, y: number, c: number, a?: number) => void, x: number, y: number, size: number, c: number, a: number, ph: number, hitY: number) {
  const fx = Math.floor(x), fy = Math.floor(y);
  const put = (dx: number, dy: number, cc = c) => { if (fy + dy < hitY) plot(fx + dx, fy + dy, cc, a); };
  if (wt.sprite?.frames.length) {
    const fr = wt.sprite.frames[Math.min(wt.sprite.frames.length - 1, Math.floor(ph * wt.sprite.frames.length))];
    const { w: sw, h: sh } = wt.sprite;
    for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) { const p = fr[yy * sw + xx]; if (p && p >>> 24) put(xx - (sw >> 1), yy - (sh >> 1), p >>> 0); }
    return;
  }
  put(0, 0);
  if (size >= 2) { put(1, 0); put(0, 1); put(1, 1); }
  if (size >= 3) { put(-1, 0); put(0, -1); put(2, 1); put(1, 2); }
  if (size >= 4) { put(-1, -1); put(2, -1); put(-1, 2); put(2, 2); }
}

function splash(plot: (x: number, y: number, c: number, a?: number) => void, x: number, y: number, t: number, c: number, big: boolean, r: (i: number) => number) {
  if (t > 0.22) return;
  // A crown on the first instant, then droplets thrown up and out, falling back.
  if (t < 0.05) { plot(x - 1, y - 1, c); plot(x + 1, y - 1, c); if (big) { plot(x - 2, y - 2, c); plot(x + 2, y - 2, c); } return; }
  const drops = big ? 3 : 2;
  for (let i = 0; i < drops; i++) {
    const side = i % 2 ? 1 : -1, vx = side * (12 + r(i) * 18), vy = -(28 + r(i + 5) * 22);
    const px = x + vx * t, py = y - 1 + vy * t + 0.5 * 300 * t * t;
    if (py <= y - 1) plot(px, py, c);
  }
}

function ripple(plot: (x: number, y: number, c: number, a?: number) => void, own: Uint32Array, w: number, h: number, x: number, y: number, t: number, c: number) {
  if (t > 0.45) return;
  const rx = 1 + t * 10, ry = Math.max(0.6, rx / 3);
  // An ellipse ring on the puddle's own pixels only.
  for (let a = 0; a < 24; a++) {
    const th = (a / 24) * Math.PI * 2;
    const px = Math.round(x + Math.cos(th) * rx), py = Math.round(y + Math.sin(th) * ry);
    if (px < 0 || py < 0 || px >= w || py >= h || !(own[py * w + px] >>> 24)) continue;
    plot(px, py, c, t < 0.3 ? 1 : 0.5);
  }
}

/** Snow lying on every top surface open to the sky, uneven, with a shaded edge. */
function drawSettled(wt: Weather, out: Uint32Array, w: number, h: number, ground: number, art: (x: number, y: number) => boolean, puddle: (x: number, y: number) => boolean,
  snap: (c: number) => number, grow: number) {
  const top = snap(col(wt.settle)) | 0xff000000, shade = snap(col(wt.shade)) | 0xff000000;
  // Puddles take the snow without holding it, and nothing settles on top of them.
  const isSolid = (x: number, y: number) => y >= ground || art(x, y);
  const wet = (x: number, y: number) => puddle(x, y);
  const depthAt = (x: number) => Math.round(wt.settleDepth * Math.max(0, Math.min(1, grow)) * (0.55 + 0.45 * noise2(x / 5, 0.5, wt.seed)));
  const cap = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const d = depthAt(x);
    if (d <= 0) continue;
    // Surfaces: a solid pixel with open space above, including the ground row.
    for (let y = 1; y <= Math.min(ground, h); y++) {
      if (!(isSolid(x, y) || y === ground) || isSolid(x, y - 1) || wet(x, y - 1)) continue;
      // Is it open to the sky? Snow only lands where nothing is overhead.
      let open = true;
      for (let yy = y - 1; yy >= 0; yy--) if (isSolid(x, yy)) { open = false; break; }
      if (!open) continue;
      for (let i = 1; i <= d && y - i >= 0; i++) cap[(y - i) * w + x] = 1;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!cap[y * w + x]) continue;
    const edge = (x > 0 && !cap[y * w + x - 1] && !isSolid(x - 1, y)) || (x < w - 1 && !cap[y * w + x + 1] && !isSolid(x + 1, y));
    const lowest = y + 1 < h && !cap[(y + 1) * w + x];
    out[y * w + x] = (edge && lowest ? shade : top) >>> 0;
  }
}

registerEffect({
  id: 'weather', name: 'Weather', liveOnly: true, params: [],
  apply(src, w, h, p, ctx) {
    const wt = p.weather as Weather | undefined;
    if (!wt) return src.slice();
    const loop = Math.max(0.05, ctx.loopSeconds ?? 1);
    const time = ctx.seconds ?? (ctx.t ?? 0) * loop;
    const frames = ctx.frames ?? 1;
    // What it lands on: the chosen layers, or every layer under it except full-canvas backgrounds (a sky).
    const below = wt.hitArt && ctx.belowWhere ? ctx.belowWhere((l, backdrop) => (wt.surfaces ? wt.surfaces.includes(l.id) : !backdrop && !l.bakedFrom && !l.fx?.some((f) => f.on && (f.effect === 'weather' || f.effect === 'particles')))) : ctx.below;
    return drawWeather(wt, src, w, h, time, loop, { palette: ctx.palette, below }, frames > 1 ? (ctx.frame ?? 0) / (frames - 1) : 1);
  },
});
