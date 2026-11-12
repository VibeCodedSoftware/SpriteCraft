// Phase 6: the pixel particle engine (the ParticleCraft module inside SpriteCraft).
//
// Built for pixel-art loops. A particle is defined entirely by its number: when it is born, where, how fast, what it
// looks like. Looping emitters repeat their emission every loop, so the frame after the last one is the first frame
// again, exactly; and any frame can be drawn on its own, with no state carried between frames. Particles are drawn in
// whole pixels, their colours step along a ramp over their life, and fading can be done with a dither instead of
// see-through pixels. A particle system runs as a live layer shader ('particles'), so it shows on the canvas, in
// playback and in exports, and can be baked into editable frames.
import { A, B, G, R, fromHex, nearestIndex, rgba } from './color';
import { registerEffect, type EffectContext } from './effects';
import { ditherThreshold } from './raster';
import { hash3, noise2 } from './shaders';
import { celToBuffer } from './doc';
import { celKey, type Doc } from './types';

export type EmitShape = 'point' | 'line' | 'circle' | 'ring' | 'box';
export type Look = 'pixel' | 'disc' | 'spark' | 'star' | 'sprite';

export interface Emitter {
  id: string;
  name: string;
  on: boolean;
  /** Offset from the system's position, in pixels. */
  x: number; y: number;
  shape: EmitShape;
  /** Width and height of the shape (circle and ring use the width as the diameter). */
  shapeW: number; shapeH: number;
  /** Particles per second, and a burst of this many at the start of each loop. */
  rate: number; burst: number;
  /** Seconds, and how much it varies (0..1 of itself). */
  lifetime: number; lifetimeVar: number;
  /** Pixels per second, its variation (0..1), the direction in degrees (0 = right, -90 = up) and the half-spread. */
  speed: number; speedVar: number; angle: number; spread: number;
  /** Starting speed outward from the shape's centre (explosions), pixels per second. */
  radial: number;
  /** Forces in pixels per second²: gravity (down), wind (right), turbulence; drag slows (per second). */
  gravity: number; wind: number; drag: number; turbulence: number; turbulenceScale: number;
  /** Swirl around the system's position (degrees per second), and pull towards (+) or push from (-) a point. */
  swirl: number; attract: number; attractX: number; attractY: number;
  /** A floor (canvas row, or null) and solid art in the layers below to bounce off, with how much bounce is kept. */
  floor: number | null; collideArt: boolean; bounce: number;
  /** Size in pixels at birth and death, and its random variation. */
  sizeStart: number; sizeEnd: number; sizeVar: number;
  /** Colours over the particle's life, stepped (not blended), and opacity at birth and death (0..1). */
  colours: string[]; alphaStart: number; alphaEnd: number;
  /** 'dither' fades by dropping pixels in an ordered pattern; 'alpha' uses see-through pixels. */
  fade: 'dither' | 'alpha';
  look: Look;
  /** For look 'sprite': the picture(s), PNG-free raw pixels (frames play over the particle's life). */
  sprite?: { w: number; h: number; frames: number[][] };
  /** Spin of sprites in quarter turns per second (pixel art stays exact). */
  spin: number;
  /** A streak behind each particle, in seconds of its path. */
  trail: number;
  blend: 'normal' | 'additive';
  seed: number;
}

export interface ParticleSystem {
  name: string;
  /** Where the system sits on the canvas. */
  x: number; y: number;
  emitters: Emitter[];
  /** Repeat every loop (the animation's length) so it loops perfectly; off plays once from the first frame. */
  looping: boolean;
  /** Snap every particle colour to the sprite's palette. */
  palette: boolean;
  /** Use this layer's own pixels as a mask: particles only inside them, only outside them, or anywhere. */
  mask: 'none' | 'inside' | 'outside';
  /** Keep the layer's own art under the particles (off when it is only a mask). */
  keepArt: boolean;
}

export const newEmitter = (id: string, name = 'Emitter'): Emitter => ({
  id, name, on: true, x: 0, y: 0, shape: 'point', shapeW: 6, shapeH: 2, rate: 20, burst: 0, lifetime: 0.8, lifetimeVar: 0.3,
  speed: 20, speedVar: 0.3, angle: -90, spread: 20, radial: 0, gravity: 0, wind: 0, drag: 0, turbulence: 0, turbulenceScale: 8,
  swirl: 0, attract: 0, attractX: 0, attractY: 0, floor: null, collideArt: false, bounce: 0.4, sizeStart: 1, sizeEnd: 1, sizeVar: 0,
  colours: ['#ffffff'], alphaStart: 1, alphaEnd: 1, fade: 'dither', look: 'pixel', spin: 0, trail: 0, blend: 'normal', seed: 1,
});

export const newSystem = (w: number, h: number): ParticleSystem => ({
  name: 'Particles', x: Math.round(w / 2), y: Math.round(h * 0.7), emitters: [], looping: true, palette: false, mask: 'none', keepArt: true,
});

// ---- simulation

const DT = 1 / 60;
const rad = (d: number) => (d * Math.PI) / 180;

export interface Particle { x: number; y: number; vx: number; vy: number; f: number; age: number; size: number; path: number[]; k: number }

/** Random numbers for particle k of an emitter: always the same for the same k. */
const rnd = (e: Emitter, k: number, i: number) => hash3(k, i, e.seed * 7919 + 13);

/** Where and how a particle starts. */
function birth(e: Emitter, k: number, ox: number, oy: number) {
  let px = ox + e.x, py = oy + e.y;
  const a = rnd(e, k, 1), b = rnd(e, k, 2);
  if (e.shape === 'line') px += (a - 0.5) * e.shapeW;
  else if (e.shape === 'box') { px += (a - 0.5) * e.shapeW; py += (b - 0.5) * e.shapeH; }
  else if (e.shape === 'circle' || e.shape === 'ring') {
    const t = a * Math.PI * 2, r = (e.shape === 'ring' ? 1 : Math.sqrt(b)) * e.shapeW / 2;
    px += Math.cos(t) * r; py += Math.sin(t) * r * (e.shapeH / Math.max(1, e.shapeW) || 1);
  }
  const dir = rad(e.angle + (rnd(e, k, 3) * 2 - 1) * e.spread);
  const sp = e.speed * (1 + (rnd(e, k, 4) * 2 - 1) * e.speedVar);
  let vx = Math.cos(dir) * sp, vy = Math.sin(dir) * sp;
  if (e.radial) {
    const dx = px - (ox + e.x), dy = py - (oy + e.y), l = Math.hypot(dx, dy);
    const ra = l > 1e-6 ? Math.atan2(dy, dx) : rnd(e, k, 5) * Math.PI * 2;
    vx += Math.cos(ra) * e.radial; vy += Math.sin(ra) * e.radial;
  }
  const life = Math.max(0.02, e.lifetime * (1 + (rnd(e, k, 6) * 2 - 1) * e.lifetimeVar));
  const size = Math.max(0, e.sizeVar * (rnd(e, k, 7) * 2 - 1));
  return { px, py, vx, vy, life, size };
}

/**
 * Moves one particle from birth to `age` seconds in small fixed steps. Every force depends only on the particle and its
 * own age, so the result for a given particle and age is always the same (which keeps loops exact).
 */
function fly(e: Emitter, k: number, age: number, ox: number, oy: number, solid: ((x: number, y: number) => boolean) | null) {
  const b = birth(e, k, ox, oy);
  let { px, py, vx, vy } = b;
  const steps = Math.floor(age / DT), rest = age - steps * DT;
  const path: number[] = [px, py];
  const cx = ox + e.x, cy = oy + e.y;
  const step = (dt: number, s: number) => {
    vy += e.gravity * dt; vx += e.wind * dt;
    if (e.turbulence) {
      const n = noise2(px / e.turbulenceScale, py / e.turbulenceScale + s * dt * 2, k % 97) * Math.PI * 4;
      vx += Math.cos(n) * e.turbulence * dt; vy += Math.sin(n) * e.turbulence * dt;
    }
    if (e.swirl) {
      const dx = px - cx, dy = py - cy, a = rad(e.swirl) * dt;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = cx + dx * ca - dy * sa, ny = cy + dx * sa + dy * ca;
      px = nx; py = ny;
    }
    if (e.attract) {
      const dx = ox + e.attractX - px, dy = oy + e.attractY - py, d = Math.hypot(dx, dy) + 4;
      vx += (dx / d) * e.attract * dt; vy += (dy / d) * e.attract * dt;
    }
    if (e.drag) { const k2 = Math.max(0, 1 - e.drag * dt); vx *= k2; vy *= k2; }
    let nx = px + vx * dt, ny = py + vy * dt;
    if (e.floor !== null && ny >= e.floor && vy > 0) { ny = e.floor - (ny - e.floor) * e.bounce; vy = -vy * e.bounce; vx *= 0.8; }
    if (solid && solid(Math.floor(nx), Math.floor(ny))) {
      // Bounce off art: try reversing each direction, keep what frees the particle.
      if (!solid(Math.floor(px), Math.floor(ny))) { vx = -vx * e.bounce; nx = px; }
      else { vy = -vy * e.bounce; vx *= 0.8; ny = py; }
    }
    px = nx; py = ny;
    path.push(px, py);
  };
  for (let s = 0; s < steps; s++) step(DT, s);
  if (rest > 1e-9) step(rest, steps);
  return { x: px, y: py, vx, vy, life: b.life, size: b.size, path };
}

/** Birth times (seconds into the loop) for every particle number of an emitter. */
function births(e: Emitter, loop: number, looping: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < e.burst; i++) out.push(0);
  if (e.rate > 0) {
    const n = Math.max(0, Math.round(e.rate * loop));
    for (let i = 0; i < n; i++) out.push((i + 0.5) / e.rate);
  }
  void looping;
  return out;
}

/** Every particle alive at `time` seconds, for one emitter. */
export function particlesAt(e: Emitter, sys: ParticleSystem, time: number, loop: number, solid: ((x: number, y: number) => boolean) | null): Particle[] {
  if (!e.on) return [];
  if (sys.looping && loop > 0) time = ((time % loop) + loop) % loop;
  const born = births(e, loop, sys.looping), out: Particle[] = [];
  const maxLife = e.lifetime * (1 + e.lifetimeVar) + 1e-6;
  // A looping emitter also shows particles born in earlier loops that are still alive (so the first frame is full).
  const back = sys.looping ? Math.ceil(maxLife / Math.max(1e-6, loop)) : 0;
  for (let k = 0; k < born.length; k++) {
    for (let n = -back; n <= 0; n++) {
      const age = time - (born[k] + n * loop);
      if (age < 0) continue;
      const life = birth(e, k, sys.x, sys.y).life;
      if (age >= life) continue;
      const p = fly(e, k, age, sys.x, sys.y, solid);
      const f = age / life;
      out.push({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, f, age, size: Math.max(0, e.sizeStart + (e.sizeEnd - e.sizeStart) * f + p.size), path: p.path, k });
    }
  }
  return out;
}

// ---- drawing

const hexCache = new Map<string, number>();
const colourOf = (s: string) => { let c = hexCache.get(s); if (c === undefined) { c = fromHex(s) ?? 0xffffffff; hexCache.set(s, c); } return c; };

/** Draws a system's particles at `time` into an image (canvas-sized), over `base`. */
export function drawSystem(sys: ParticleSystem, base: Uint32Array, w: number, h: number, time: number, loop: number, ctx: Pick<EffectContext, 'palette' | 'below'>, maskSrc: Uint32Array | null): Uint32Array {
  const out = base.slice();
  const below = ctx.below;
  const solid = below ? (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && A(below[y * w + x]) > 200 : null;
  const pal = sys.palette && ctx.palette.length ? ctx.palette : null;
  const palCache = new Map<number, number>();
  const allowed = (x: number, y: number) => {
    if (!maskSrc || sys.mask === 'none') return true;
    const m = A(maskSrc[y * w + x]) > 0;
    return sys.mask === 'inside' ? m : !m;
  };
  const plot = (x: number, y: number, c: number, alpha: number, e: Emitter) => {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= w || y >= h || !allowed(x, y) || !A(c)) return;
    let a = alpha * (A(c) / 255);
    if (e.fade === 'dither') { if (a <= ditherThreshold('bayer4', x, y)) return; a = 1; }
    if (a <= 0) return;
    if (pal) { let p = palCache.get(c); if (p === undefined) { p = pal[nearestIndex(c, pal)]; palCache.set(c, p); } c = p; }
    const i = y * w + x, d = out[i];
    if (e.blend === 'additive' && A(d)) {
      out[i] = rgba(Math.min(255, R(d) + Math.round(R(c) * a)), Math.min(255, G(d) + Math.round(G(c) * a)), Math.min(255, B(d) + Math.round(B(c) * a)), A(d));
    } else if (a >= 1 || !A(d)) out[i] = a >= 1 ? ((c & 0xffffff) | (255 << 24)) >>> 0 : ((c & 0xffffff) | (Math.round(a * 255) << 24)) >>> 0;
    else out[i] = rgba(Math.round(R(d) + (R(c) - R(d)) * a), Math.round(G(d) + (G(c) - G(d)) * a), Math.round(B(d) + (B(c) - B(d)) * a), Math.max(A(d), Math.round(a * 255)));
  };
  for (const e of sys.emitters) {
    const ramp = e.colours.length ? e.colours.map(colourOf) : [0xffffffff];
    for (const p of particlesAt(e, sys, time, loop, e.collideArt ? solid : null)) {
      const c = ramp[Math.min(ramp.length - 1, Math.floor(p.f * ramp.length))];
      const alpha = e.alphaStart + (e.alphaEnd - e.alphaStart) * p.f;
      const s = Math.max(1, Math.round(p.size));
      if (e.trail > 0) {
        // The streak: earlier points on the particle's own path, one per step.
        const n = Math.min(p.path.length / 2 - 1, Math.round(e.trail / DT));
        for (let i = 1; i <= n; i++) {
          const j = p.path.length - 2 - i * 2;
          if (j < 0) break;
          plot(p.path[j], p.path[j + 1], ramp[Math.min(ramp.length - 1, Math.floor(p.f * ramp.length) + 1)] ?? c, alpha * (1 - i / (n + 1)), e);
        }
      }
      if (p.size < 0.5 && e.look !== 'sprite') continue;
      const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
      if (e.look === 'pixel') { for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) plot(x0 + dx - (s >> 1), y0 + dy - (s >> 1), c, alpha, e); }
      else if (e.look === 'disc') {
        const r = s / 2;
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) if ((dx + 0.5) ** 2 + (dy + 0.5) ** 2 <= r * r + 0.5) plot(x0 + dx, y0 + dy, c, alpha, e);
      } else if (e.look === 'star') {
        plot(x0, y0, c, alpha, e);
        for (let i = 1; i <= Math.max(1, Math.floor(s / 2)); i++) { plot(x0 + i, y0, c, alpha, e); plot(x0 - i, y0, c, alpha, e); plot(x0, y0 + i, c, alpha, e); plot(x0, y0 - i, c, alpha, e); }
      } else if (e.look === 'spark') {
        // A short line along the direction of travel, as long as the size.
        const l = Math.hypot(p.vx, p.vy) || 1, ux = p.vx / l, uy = p.vy / l;
        for (let i = 0; i < Math.max(1, s); i++) plot(p.x - ux * i, p.y - uy * i, c, alpha, e);
      } else if (e.look === 'sprite' && e.sprite?.frames.length) {
        const fr = e.sprite.frames[Math.min(e.sprite.frames.length - 1, Math.floor(p.f * e.sprite.frames.length))];
        const q = ((Math.floor(e.spin * p.age) % 4) + 4) % 4; // quarter turns so far
        const { w: sw, h: sh } = e.sprite;
        for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) {
          const sc = fr[yy * sw + xx];
          if (!sc || !(sc >>> 24)) continue;
          let dx = xx - (sw >> 1), dy = yy - (sh >> 1);
          for (let r = 0; r < q; r++) { const t = dx; dx = -dy; dy = t; }
          plot(x0 + dx, y0 + dy, sc >>> 0, alpha, e);
        }
      }
    }
  }
  return out;
}

registerEffect({
  id: 'particles', name: 'Particles', liveOnly: true, params: [],
  apply(src, w, h, p, ctx) {
    const sys = p.system as ParticleSystem | undefined;
    if (!sys) return src.slice();
    const loop = Math.max(0.05, ctx.loopSeconds ?? 1), time = ctx.seconds ?? (ctx.t ?? 0) * loop;
    const base = sys.keepArt || sys.mask === 'none' ? src : new Uint32Array(src.length);
    return drawSystem(sys, base, w, h, time, loop, ctx, src);
  },
});

// ---- exchange with ParticleCraft (craft.vfx real-time layers)

/** The emitter fields ParticleCraft, GameCraft and LogicCraft read, in their units (metres, seconds, Y up). */
export interface CraftEmitter {
  rate: number; burst: number; lifetime: number; lifetimeVar: number; speed: number; speedVar: number;
  direction: [number, number, number]; spread: number; gravity: number; acceleration: [number, number, number]; drag: number;
  sizeStart: number; sizeEnd: number; sizeVar: number; colorStart: string; colorEnd: string; colorMid: string;
  alphaStart: number; alphaEnd: number; rotation: number; rotationSpeed: number;
  shape: string; shapeSize: [number, number, number]; maxParticles: number; texture: string; textureImage?: string;
  blending: 'additive' | 'normal'; space: 'world' | 'local'; looping: boolean; duration: number; seed: number;
  collideFloor: boolean; floorY: number; bounce: number; turbulence: number; turbulenceFreq: number;
  vortex: number; vortexPull: number; trail: number; radialSpeed?: number;
  [k: string]: unknown;
}

/** Pixels per metre when converting between ParticleCraft's 3D units and sprite pixels. */
export const PX_PER_M = 16;

/** One ParticleCraft layer as a SpriteCraft emitter (front view: x across, y up becomes y down). */
export function fromCraft(p: Partial<CraftEmitter>, id: string, name: string, scale = PX_PER_M, sprite?: Emitter['sprite']): Emitter {
  const e = newEmitter(id, name);
  const d = p.direction ?? [0, 1, 0];
  const lifetime = p.lifetime ?? 1;
  const tex = p.texture ?? 'circle';
  return {
    ...e,
    rate: p.rate ?? e.rate, burst: p.burst ?? 0, lifetime, lifetimeVar: Math.min(1, (p.lifetimeVar ?? 0) / Math.max(0.01, lifetime)),
    speed: (p.speed ?? 1) * scale, speedVar: Math.min(1, (p.speedVar ?? 0) / Math.max(0.01, p.speed ?? 1)),
    angle: (Math.atan2(-d[1], d[0]) * 180) / Math.PI, spread: Math.min(180, p.spread ?? 0),
    radial: (p.radialSpeed ?? 0) * scale,
    gravity: -(p.gravity ?? 0) * scale + -((p.acceleration?.[1]) ?? 0) * scale, wind: ((p.acceleration?.[0]) ?? 0) * scale, drag: p.drag ?? 0,
    turbulence: (p.turbulence ?? 0) * scale, turbulenceScale: Math.max(2, scale / Math.max(0.05, p.turbulenceFreq ?? 1)),
    swirl: (p.vortex ?? 0) * 57.3, attract: (p.vortexPull ?? 0) * scale,
    floor: p.collideFloor ? -(p.floorY ?? 0) * scale : null, bounce: p.bounce ?? 0.3,
    shape: p.shape === 'box' ? 'box' : p.shape === 'ring' ? 'ring' : p.shape === 'line' ? 'line' : p.shape === 'circle' || p.shape === 'sphere' || p.shape === 'hemisphere' ? 'circle' : 'point',
    shapeW: Math.max(1, (p.shapeSize?.[0] ?? 0) * scale * (p.shape === 'sphere' || p.shape === 'circle' || p.shape === 'ring' ? 2 : 1)),
    shapeH: Math.max(1, ((p.shape === 'box' ? p.shapeSize?.[1] : p.shapeSize?.[0]) ?? 0) * scale * (p.shape === 'box' ? 1 : 2)),
    sizeStart: Math.max(0, (p.sizeStart ?? 0.1) * scale), sizeEnd: Math.max(0, (p.sizeEnd ?? 0.1) * scale), sizeVar: (p.sizeVar ?? 0) * scale,
    colours: [p.colorStart ?? '#ffffff', ...(p.colorMid ? [p.colorMid] : []), p.colorEnd ?? p.colorStart ?? '#ffffff'],
    alphaStart: p.alphaStart ?? 1, alphaEnd: p.alphaEnd ?? 0,
    look: sprite ? 'sprite' : tex === 'pixel' || tex === 'square' || tex === 'debris' ? 'pixel' : tex === 'spark' || tex === 'drop' ? 'spark' : tex === 'star' || tex === 'flare' ? 'star' : 'disc',
    sprite, spin: (p.rotationSpeed ?? 0) / 90,
    trail: p.trail ?? 0, blend: p.blending === 'additive' ? 'additive' : 'normal', seed: p.seed ?? 1,
  };
}

/** A SpriteCraft emitter as a ParticleCraft layer. */
export function toCraft(e: Emitter, looping: boolean, loopSeconds: number, scale = PX_PER_M): CraftEmitter {
  const a = rad(e.angle);
  return {
    rate: e.rate, burst: e.burst, lifetime: e.lifetime, lifetimeVar: e.lifetime * e.lifetimeVar,
    speed: e.speed / scale, speedVar: (e.speed * e.speedVar) / scale, direction: [Math.cos(a), -Math.sin(a), 0], spread: e.spread,
    gravity: -e.gravity / scale, acceleration: [e.wind / scale, 0, 0], drag: e.drag,
    sizeStart: Math.max(0.01, e.sizeStart / scale), sizeEnd: Math.max(0, e.sizeEnd / scale), sizeVar: e.sizeVar / scale,
    colorStart: e.colours[0] ?? '#ffffff', colorEnd: e.colours[e.colours.length - 1] ?? '#ffffff', colorMid: e.colours.length > 2 ? e.colours[Math.floor(e.colours.length / 2)] : '',
    alphaStart: e.alphaStart, alphaEnd: e.alphaEnd, rotation: 0, rotationSpeed: e.spin * 90,
    shape: e.shape === 'box' ? 'box' : e.shape === 'circle' ? 'circle' : e.shape === 'ring' ? 'ring' : e.shape === 'line' ? 'line' : 'point',
    shapeSize: [e.shape === 'circle' || e.shape === 'ring' ? e.shapeW / 2 / scale : e.shapeW / scale, e.shapeH / scale, e.shape === 'box' ? 0 : e.shapeW / 2 / scale],
    maxParticles: Math.max(50, Math.ceil(e.rate * e.lifetime * 2 + e.burst)),
    texture: e.look === 'pixel' ? 'pixel' : e.look === 'spark' ? 'spark' : e.look === 'star' ? 'star' : 'circle',
    blending: e.blend, space: 'world', looping, duration: loopSeconds, seed: e.seed,
    collideFloor: e.floor !== null, floorY: e.floor !== null ? -e.floor / scale : 0, bounce: e.bounce,
    turbulence: e.turbulence / scale, turbulenceFreq: scale / Math.max(2, e.turbulenceScale), vortex: e.swirl / 57.3, vortexPull: e.attract / scale,
    trail: e.trail, radialSpeed: e.radial / scale,
  };
}

/**
 * A layer's art as a small picture for particles or snowflakes: every distinct frame it has, cropped to their shared
 * bounds (up to 32×32 and 16 frames). Null when the layer is empty.
 */
export function spriteFromLayer(doc: Doc, id: string): { w: number; h: number; frames: number[][] } | null {
  const rect = { x: 0, y: 0, w: doc.width, h: doc.height };
  const seen = new Set<string>(), imgs: Uint32Array[] = [];
  for (const fr of doc.frames) {
    const c = doc.cels[celKey(id, fr.id)];
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id); imgs.push(celToBuffer(c, rect));
  }
  let x0 = doc.width, y0 = doc.height, x1 = -1, y1 = -1;
  for (const img of imgs) for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) if (img[y * doc.width + x] >>> 24) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) return null;
  const w = Math.min(32, x1 - x0 + 1), h = Math.min(32, y1 - y0 + 1);
  const frames = imgs.slice(0, 16).map((img) => { const o: number[] = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o.push(img[(y0 + y) * doc.width + x0 + x]); return o; });
  return { w, h, frames };
}

// ---- presets

const P = (name: string, e: Partial<Emitter>): { name: string; emitters: Partial<Emitter>[] } => ({ name, emitters: [{ name, ...e }] });
/** Ready-made emitters, all in pixels and stepped colours. */
export const PARTICLE_PRESETS: { name: string; emitters: Partial<Emitter>[] }[] = [
  P('Fire', { shape: 'line', shapeW: 8, rate: 40, lifetime: 0.7, lifetimeVar: 0.3, speed: 22, speedVar: 0.4, angle: -90, spread: 12, turbulence: 30, turbulenceScale: 6, sizeStart: 3, sizeEnd: 1, colours: ['#fff1c1', '#ffcd75', '#ef7d57', '#b13e53'], look: 'pixel' }),
  P('Smoke', { shape: 'line', shapeW: 6, rate: 10, lifetime: 1.8, lifetimeVar: 0.3, speed: 12, angle: -90, spread: 15, drag: 0.6, turbulence: 14, sizeStart: 2, sizeEnd: 5, colours: ['#94b0c2', '#566c86', '#333c57'], alphaStart: 0.9, alphaEnd: 0, look: 'disc' }),
  P('Sparks', { rate: 25, lifetime: 0.6, speed: 60, speedVar: 0.4, angle: -90, spread: 60, gravity: 160, sizeStart: 2, sizeEnd: 1, colours: ['#ffffff', '#ffcd75', '#ef7d57'], look: 'spark', trail: 0.05 }),
  P('Magic sparkle', { shape: 'circle', shapeW: 14, shapeH: 14, rate: 18, lifetime: 0.9, speed: 8, spread: 180, gravity: -10, sizeStart: 3, sizeEnd: 1, colours: ['#ffffff', '#a7f0ff', '#73eff7', '#3b5dc9'], look: 'star', swirl: 40 }),
  P('Explosion', { burst: 40, rate: 0, lifetime: 0.7, lifetimeVar: 0.4, speed: 70, speedVar: 0.6, spread: 180, drag: 3, sizeStart: 4, sizeEnd: 1, colours: ['#ffffff', '#fff1c1', '#ffcd75', '#ef7d57', '#5d275d'], look: 'disc' }),
  P('Coin pickup', { burst: 14, rate: 0, lifetime: 0.6, speed: 45, spread: 180, gravity: 120, sizeStart: 2, sizeEnd: 1, colours: ['#fff1c1', '#ffcd75', '#b86f50'], look: 'star' }),
  P('Dust puff', { shape: 'line', shapeW: 8, burst: 8, rate: 0, lifetime: 0.7, speed: 18, angle: -90, spread: 70, drag: 2.5, sizeStart: 2, sizeEnd: 4, colours: ['#c2a385', '#94785f'], alphaStart: 0.9, alphaEnd: 0, look: 'disc' }),
  P('Hit flash', { burst: 12, rate: 0, lifetime: 0.25, speed: 90, spread: 180, sizeStart: 3, sizeEnd: 1, colours: ['#ffffff', '#f4f4f4', '#ffcd75'], look: 'spark', trail: 0.04 }),
  P('Bubbles', { shape: 'line', shapeW: 10, rate: 6, lifetime: 1.6, speed: 18, angle: -90, spread: 8, turbulence: 20, sizeStart: 2, sizeEnd: 3, colours: ['#a7f0ff', '#73eff7'], look: 'disc' }),
  P('Heal', { shape: 'circle', shapeW: 16, shapeH: 6, rate: 12, lifetime: 1, speed: 16, angle: -90, spread: 5, sizeStart: 3, sizeEnd: 1, colours: ['#ffffff', '#a7f070', '#38b764'], look: 'star' }),
  P('Poison', { shape: 'line', shapeW: 10, rate: 8, lifetime: 1.2, speed: 10, angle: -90, spread: 20, turbulence: 18, sizeStart: 2, sizeEnd: 3, colours: ['#a7f070', '#38b764', '#257179'], alphaStart: 1, alphaEnd: 0, look: 'disc' }),
  P('Portal swirl', { shape: 'ring', shapeW: 20, shapeH: 20, rate: 30, lifetime: 1, speed: 0, swirl: 180, attract: 40, sizeStart: 2, sizeEnd: 1, colours: ['#ffffff', '#b2a2ff', '#5d275d'], look: 'pixel', trail: 0.08 }),
];
