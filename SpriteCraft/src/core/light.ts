// Phase 4: the Lighting Studio. Normal maps made from the art (no grey painting needed) and 2D lights that shade pixel
// art in bands, so the result still looks drawn. Plain data and pure functions, no DOM.
//
// Normal maps are stored as ordinary layer pixels in the common "OpenGL" encoding: red = right, green = up, blue = out
// of the screen, each mapped from -1..1 to 0..255. A flat surface facing the viewer is (128, 128, 255).
import { A, B, G, R, nearestIndex, rgba } from './color';
import { liveKeys, sampleKeys, type Key } from './anim';
import { ditherThreshold } from './raster';
import type { Doc } from './types';

// ---- Normals

export interface NormalSettings {
  /** How far in from the edge a shape rounds off, in pixels. */
  bevel: number;
  /** How steep the result is: higher makes stronger relief. */
  strength: number;
  /** 0..100: how much brighter pixels are raised (adds surface detail from the drawing itself). */
  detail: number;
  /** Invert the detail: darker pixels raised (for art where dark lines are ridges). */
  invertDetail: boolean;
}

export const defaultNormalSettings = (): NormalSettings => ({ bevel: 4, strength: 2, detail: 15, invertDetail: false });

/** Distance (8-neighbour chamfer, pixels) from each solid pixel to the nearest empty pixel or the edge of the image. */
function edgeDistance(solid: (i: number) => boolean, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = solid(i) ? 1e9 : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  const S = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + S, at(x + 1, y - 1) + S);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + S, at(x - 1, y + 1) + S);
  }
  return d;
}

/**
 * A height map (0..1 per pixel) from one or more images of the same size: each image is its own shape rounded off at
 * its edges, the highest shape wins (so each layer reads as its own raised piece), plus detail from brightness.
 */
export function heightFrom(shapes: Uint32Array[], w: number, h: number, s: NormalSettings): Float32Array {
  const out = new Float32Array(w * h);
  const bevel = Math.max(0.5, s.bevel);
  shapes.forEach((img, layer) => {
    const d = edgeDistance((i) => A(img[i]) > 0, w, h);
    // Later (upper) layers sit a little higher, so overlapping pieces separate.
    const lift = layer * 0.04;
    for (let i = 0; i < out.length; i++) {
      if (!A(img[i])) continue;
      const t = Math.min(1, (d[i] - 0.5) / bevel);
      // A quarter circle from the edge in: rounded like a pillow, flat on top.
      const v = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))) * 0.8 + lift;
      if (v > out[i]) out[i] = v;
    }
  });
  if (s.detail > 0) {
    const k = (s.detail / 100) * 0.25;
    // Brightness from the top-most shape that covers each pixel.
    for (let i = 0; i < out.length; i++) {
      for (let l = shapes.length - 1; l >= 0; l--) {
        const c = shapes[l][i];
        if (!A(c)) continue;
        const lum = (0.3 * R(c) + 0.59 * G(c) + 0.11 * B(c)) / 255;
        out[i] += k * (s.invertDetail ? 1 - lum : lum);
        break;
      }
    }
  }
  return out;
}

/** Encodes a unit normal (screen x right, y down, z out) as a pixel. */
export const encodeNormal = (nx: number, ny: number, nz: number, a = 255) =>
  rgba(Math.round((nx * 0.5 + 0.5) * 255), Math.round((-ny * 0.5 + 0.5) * 255), Math.round((nz * 0.5 + 0.5) * 255), a);

/** Decodes a normal pixel back to a unit vector (screen x right, y down, z out). Empty pixels face the viewer. */
export function decodeNormal(p: number): [number, number, number] {
  if (!A(p)) return [0, 0, 1];
  const x = (R(p) / 255) * 2 - 1, y = -((G(p) / 255) * 2 - 1), z = (B(p) / 255) * 2 - 1;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** A normal map from a height map (Sobel slopes). Only pixels inside `mask` are written. */
export function normalsFromHeight(height: Float32Array, mask: Uint32Array[], w: number, h: number, strength: number): Uint32Array {
  const out = new Uint32Array(w * h);
  const at = (x: number, y: number) => height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask.some((m) => A(m[i]))) continue;
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    let nx = -dx * strength, ny = -dy * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    out[i] = encodeNormal(nx, ny, nz);
  }
  return out;
}

/** The normal pixel for a direction picked on a sphere: (u, v) in -1..1 across the picker, y down. */
export function normalFromPicker(u: number, v: number): number | null {
  const r2 = u * u + v * v;
  if (r2 > 1) return null;
  return encodeNormal(u, v, Math.sqrt(1 - r2));
}

// ---- Lights

export type LightKind = 'point' | 'spot' | 'directional';

export interface Light {
  id: string;
  name: string;
  kind: LightKind;
  on: boolean;
  colour: string;
  /** 0..4 */
  intensity: number;
  /** Position in canvas pixels; z is the height above the picture. Directional lights ignore position. */
  x: number; y: number; z: number;
  /** Point and spot: the light fades to nothing at this distance. */
  radius: number;
  /** Spot and directional: the direction it shines across the picture, degrees (0 = right, 90 = down). */
  angle: number;
  /** Directional: how high the light is above the picture, degrees (90 = straight down onto it). */
  elevation: number;
  /** Spot: the cone's full width in degrees, and how soft its edge is (0..1). */
  cone: number;
  softness: number;
  /** 0..1: shiny highlights. */
  specular: number;
  /** 0..1: random dimming per frame, like a flame. */
  flicker: number;
}

export interface Lighting {
  normalLayer: string | null;
  ambient: string;
  /** 0..1 */
  ambientIntensity: number;
  lights: Light[];
  /** Brightness steps the light is snapped to, like a pixel artist's shading ramp. 0 = smooth. */
  bands: number;
  /** Mix neighbouring bands with an ordered dither at their edges. */
  dither: boolean;
  /** Pixels cast shadows on themselves from the height map. */
  shadows: boolean;
  /** Snap lit colours to the sprite's palette. */
  usePalette: boolean;
  normals: NormalSettings;
  /** Keyframes per light: x, y, z, intensity. */
  tracks: Record<string, Partial<Record<LightProp, Key[]>>>;
}

export type LightProp = 'x' | 'y' | 'z' | 'intensity';

export const defaultLighting = (w: number, h: number): Lighting => ({
  normalLayer: null, ambient: '#8a8fb0', ambientIntensity: 0.5, bands: 4, dither: false, shadows: false, usePalette: false,
  normals: defaultNormalSettings(), tracks: {},
  lights: [newLight('l_key', 'Key light', w, h)],
});

export function newLight(id: string, name: string, w: number, h: number, kind: LightKind = 'point'): Light {
  return { id, name, kind, on: true, colour: '#fff1d0', intensity: 1, x: Math.round(w * 0.2), y: Math.round(h * 0.2), z: Math.max(8, Math.round(Math.max(w, h) * 0.4)),
    radius: Math.round(Math.max(w, h) * 1.2), angle: 45, elevation: 45, cone: 60, softness: 0.4, specular: 0.25, flicker: 0 };
}

const hex = (s: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** A repeatable 0..1 noise per light and frame, for flicker. */
function noise(seed: string, frame: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ frame, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The lights as they are on a frame: keyed values applied, flicker rolled. */
export function lightsAt(doc: Doc, l: Lighting, frame: number): Light[] {
  return l.lights.map((li) => {
    const t = l.tracks[li.id] ?? {};
    const v = (p: LightProp, base: number) => sampleKeys(liveKeys(doc, t[p]), frame, base);
    const flick = li.flicker > 0 ? 1 - li.flicker * noise(li.id, frame) : 1;
    return { ...li, x: v('x', li.x), y: v('y', li.y), z: v('z', li.z), intensity: v('intensity', li.intensity) * flick };
  });
}

/** Sets a light property at a frame (adding the key there, and a resting key on frame 1 for a property's first key). */
export function setLightKey(doc: Doc, l: Lighting, lightId: string, prop: LightProp, frame: number, value: number): Lighting {
  const li = l.lights.find((x) => x.id === lightId);
  if (!li) return l;
  const f = doc.frames[frame].id;
  const keys = [...(l.tracks[lightId]?.[prop] ?? [])];
  if (!liveKeys(doc, keys).length && frame !== 0) keys.push({ f: doc.frames[0].id, v: li[prop], ease: 'in-out-sine' });
  const at = keys.findIndex((k) => k.f === f);
  if (at >= 0) keys[at] = { ...keys[at], v: value }; else keys.push({ f, v: value, ease: 'in-out-sine' });
  return { ...l, tracks: { ...l.tracks, [lightId]: { ...(l.tracks[lightId] ?? {}), [prop]: keys } } };
}

export interface LightInput {
  /** The art to light, canvas-sized. */
  base: Uint32Array;
  /** Its normal map, canvas-sized (empty pixels face the viewer). */
  normals: Uint32Array | null;
  w: number; h: number;
  palette: number[];
}

/**
 * Lights an image. Each light's contribution (diffuse from the normal, a highlight, falloff, spot cone) is added up per
 * colour channel, then snapped to `bands` steps, optionally dithered at band edges, and multiplied with the art. Every
 * pixel keeps its alpha; empty pixels stay empty.
 */
export function shade(input: LightInput, l: Lighting, lights: Light[]): Uint32Array {
  const { base, normals, w, h } = input;
  const out = new Uint32Array(w * h);
  const amb = hex(l.ambient).map((c) => c * l.ambientIntensity);
  const live = lights.filter((li) => li.on && li.intensity > 0).map((li) => {
    const rad = (li.angle * Math.PI) / 180, el = (li.elevation * Math.PI) / 180;
    return { li, col: hex(li.colour), dir: [Math.cos(rad), Math.sin(rad)], sun: [Math.cos(el) * -Math.cos(rad), Math.cos(el) * -Math.sin(rad), Math.sin(el)] };
  });
  // Height for shadows, rebuilt from the normal map's slopes, so painted normals cast shadows too.
  const height = l.shadows && normals ? heightFromNormals(normals, w, h) : null;
  const bands = Math.max(0, Math.round(l.bands));
  const palCache = new Map<number, number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, c = base[i];
    if (!A(c)) continue;
    const [nx, ny, nz] = normals ? decodeNormal(normals[i]) : [0, 0, 1];
    let lr = amb[0], lg = amb[1], lb = amb[2], sr = 0, sg = 0, sb = 0;
    for (const { li, col, dir, sun } of live) {
      let Lx: number, Ly: number, Lz: number, att = li.intensity;
      if (li.kind === 'directional') { Lx = sun[0]; Ly = sun[1]; Lz = sun[2]; }
      else {
        Lx = li.x - (x + 0.5); Ly = li.y - (y + 0.5); Lz = li.z;
        const dist = Math.hypot(Lx, Ly, Lz);
        Lx /= dist; Ly /= dist; Lz /= dist;
        // Full strength near the light, easing off to nothing at its reach.
        const q = Math.min(1, Math.hypot(li.x - x - 0.5, li.y - y - 0.5) / Math.max(1, li.radius));
        att *= 1 - q * q;
        if (li.kind === 'spot') {
          // How far this pixel is from the spot's centre line, against the cone's half-width.
          const px = x + 0.5 - li.x, py = y + 0.5 - li.y, pl = Math.hypot(px, py) || 1;
          const cos = (px * dir[0] + py * dir[1]) / pl;
          const half = ((li.cone / 2) * Math.PI) / 180, inner = half * (1 - li.softness);
          const a = Math.acos(Math.max(-1, Math.min(1, cos)));
          att *= a <= inner ? 1 : a >= half ? 0 : 1 - (a - inner) / Math.max(1e-6, half - inner);
        }
      }
      if (att <= 0) continue;
      const ndl = nx * Lx + ny * Ly + nz * Lz;
      if (ndl <= 0) continue;
      if (height && marchShadow(height, w, h, x, y, Lx, Ly, Lz)) continue;
      lr += col[0] * ndl * att; lg += col[1] * ndl * att; lb += col[2] * ndl * att;
      if (li.specular > 0) {
        // Blinn-Phong with the viewer straight in front.
        const hx = Lx, hy = Ly, hz = Lz + 1, hl = Math.hypot(hx, hy, hz) || 1;
        const s = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), 24) * li.specular * att;
        sr += col[0] * s; sg += col[1] * s; sb += col[2] * s;
      }
    }
    const step = (v: number) => {
      if (!bands) return v;
      const t = v * bands, lo = Math.floor(t), f = t - lo;
      // Mix two bands only within a narrow strip at their edge, with a fixed ordered dither.
      const up = l.dither ? (f > 0.65 ? 1 : f < 0.35 ? 0 : (f - 0.35) / 0.3 > ditherThreshold('bayer4', x, y) ? 1 : 0) : f >= 0.5 ? 1 : 0;
      return (lo + up) / bands;
    };
    // Bands step the brightness of the light, not each channel apart, so a coloured light still gives one clean ramp.
    const lm = Math.max(lr, lg, lb), lk = lm > 0 ? step(lm) / lm : 0;
    const sm = Math.max(sr, sg, sb), sk = sm > 0 ? step(sm) / sm : 0;
    const r = Math.min(255, R(c) * lr * lk + 255 * sr * sk), g = Math.min(255, G(c) * lg * lk + 255 * sg * sk), b = Math.min(255, B(c) * lb * lk + 255 * sb * sk);
    let o = rgba(Math.round(r), Math.round(g), Math.round(b), A(c));
    if (l.usePalette && input.palette.length) {
      let p = palCache.get(o);
      if (p === undefined) { p = ((input.palette[nearestIndex(o, input.palette)] & 0xffffff) | (A(c) << 24)) >>> 0; palCache.set(o, p); }
      o = p;
    }
    out[i] = o;
  }
  return out;
}

/**
 * A height map (pixels) rebuilt from a normal map: the slopes are added up across each row and column from the shape's
 * edges, in all four directions, and averaged. Rough, but it follows whatever the normals say, painted or generated.
 */
export function heightFromNormals(normals: Uint32Array, w: number, h: number): Float32Array {
  const sx = new Float32Array(w * h), sy = new Float32Array(w * h), solid = new Uint8Array(w * h);
  for (let i = 0; i < normals.length; i++) {
    if (!A(normals[i])) continue;
    const [nx, ny, nz] = decodeNormal(normals[i]);
    const z = Math.max(0.2, nz);
    solid[i] = 1; sx[i] = -nx / z; sy[i] = -ny / z;
  }
  const out = new Float32Array(w * h), run = new Float32Array(w * h);
  // Left to right and right to left.
  for (let y = 0; y < h; y++) {
    let a = 0;
    for (let x = 0; x < w; x++) { const i = y * w + x; a = solid[i] ? a + sx[i] : 0; run[i] = a; }
    a = 0;
    for (let x = w - 1; x >= 0; x--) { const i = y * w + x; a = solid[i] ? a - sx[i] : 0; out[i] += (run[i] + a) / 4; }
  }
  // Top to bottom and bottom to top.
  for (let x = 0; x < w; x++) {
    let a = 0;
    for (let y = 0; y < h; y++) { const i = y * w + x; a = solid[i] ? a + sy[i] : 0; run[i] = a; }
    a = 0;
    for (let y = h - 1; y >= 0; y--) { const i = y * w + x; a = solid[i] ? a - sy[i] : 0; out[i] += (run[i] + a) / 4; }
  }
  for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0;
  return out;
}

/** Whether higher pixels between this one and the light block it. */
function marchShadow(height: Float32Array, w: number, h: number, x: number, y: number, Lx: number, Ly: number, Lz: number): boolean {
  const flat = Math.hypot(Lx, Ly);
  if (flat < 1e-3) return false;
  const sx = Lx / flat, sy = Ly / flat, rise = Lz / flat;
  let z = height[y * w + x];
  for (let t = 1; t < 48; t++) {
    const px = Math.round(x + sx * t), py = Math.round(y + sy * t);
    if (px < 0 || py < 0 || px >= w || py >= h) return false;
    z += rise;
    if (height[py * w + px] > z + 0.5) return true;
  }
  return false;
}
