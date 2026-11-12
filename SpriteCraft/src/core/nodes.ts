// Phase 8: the node editor's engine. A node graph lives on a layer as a live shader ('nodes'): when the frame is drawn
// the graph is evaluated and its Output node becomes the layer's pixels, so graphs show on the canvas, in playback and
// in exports like every other live effect, and can be baked. Nodes pass images (canvas-sized) along wires; number
// settings can instead be driven by number outputs (time, maths), which is how graphs animate. Every registered effect
// is a node automatically, so shaders, colour adjustments and distortions (and plugin effects) need no extra work.
// The editor is optional: the panels for each feature keep working on their own.
import { A, B, G, R, fromHex, nearestIndex, rgba } from './color';
import { blendPixel } from './compose';
import { defaultParams, effectById, effects, registerEffect, type EffectContext, type EffectParam } from './effects';
import { defaultLighting, heightFrom, newLight, normalsFromHeight, shade, type LightKind } from './light';
import { PARTICLE_PRESETS, drawSystem, newEmitter, newSystem } from './particles';
import { ditherThreshold } from './raster';
import { noise2 } from './shaders';
import { BLEND_MODES, type BlendMode } from './types';
import { WEATHER_PRESETS, drawWeather, newWeather } from './weather';

export type PortType = 'image' | 'number';
export interface Port { key: string; label: string; type: PortType }

export interface NodeCtx extends EffectContext {
  w: number; h: number;
  /** The layer's own pixels (before the graph). */
  own: Uint32Array;
}

export interface NodeDef {
  type: string;
  name: string;
  category: 'Inputs' | 'Animation' | 'Colour' | 'Shaders' | 'Lighting' | 'Masks & compositing' | 'Particles & weather' | 'Output';
  doc: string;
  inputs: Port[];
  outputs: Port[];
  /** Settings. Number settings can also be driven by a number output (a link to the setting's key). */
  params: EffectParam[];
  run(inp: Record<string, any>, p: Record<string, any>, ctx: NodeCtx): Record<string, any>;
}

export interface GNode { id: string; type: string; x: number; y: number; params: Record<string, any> }
/** A wire from one node's output to another node's input (or number setting). */
export interface Link { from: string; out: string; to: string; in: string }
export interface NodeGraph { nodes: GNode[]; links: Link[] }

const img = (o: string = 'image', label = 'Image'): Port => ({ key: o, label, type: 'image' });
const num = (key: string, label: string): Port => ({ key, label, type: 'number' });
const N = (key: string, label: string, min: number, max: number, value: number, step?: number): EffectParam => ({ key, label, type: 'number', min, max, value, step });
const CH = (key: string, label: string, options: string[], value = options[0]): EffectParam => ({ key, label, type: 'choice', options, value });
const CO = (key: string, label: string, value: string): EffectParam => ({ key, label, type: 'color', value });
const BO = (key: string, label: string, value: boolean): EffectParam => ({ key, label, type: 'bool', value });
const TX = (key: string, label: string, value = ''): EffectParam => ({ key, label, type: 'text', value });

const empty = (ctx: NodeCtx) => new Uint32Array(ctx.w * ctx.h);
const col = (s: string) => fromHex(s) ?? 0xffffffff;
const lerpC = (a: number, b: number, k: number) => rgba(Math.round(R(a) + (R(b) - R(a)) * k), Math.round(G(a) + (G(b) - G(a)) * k), Math.round(B(a) + (B(b) - B(a)) * k), Math.round(A(a) + (A(b) - A(a)) * k));
/** A 0..1 value to a colour between a and b in `steps` flat steps (0 = smooth), optionally dithered between steps. */
function ramp(v: number, a: number, b: number, steps: number, dither: boolean, x: number, y: number) {
  v = Math.max(0, Math.min(1, v));
  if (steps >= 2) {
    const s = v * (steps - 1);
    let k = Math.floor(s);
    if (dither && s - k > ditherThreshold('bayer4', x, y)) k++;
    else if (!dither) k = Math.round(s);
    v = Math.min(steps - 1, k) / (steps - 1);
  }
  return lerpC(a, b, v);
}

const BUILT: NodeDef[] = [
  // ---- inputs
  { type: 'this', name: 'This layer', category: 'Inputs', doc: 'The pixels painted on this layer.', inputs: [], outputs: [img()], params: [], run: (_i, _p, c) => ({ image: c.own }) },
  { type: 'layer', name: 'Layer', category: 'Inputs', doc: 'Another layer\'s pixels on this frame (hidden layers work too: a good place to keep masks).', inputs: [], outputs: [img()], params: [TX('layer', 'Layer')],
    run: (_i, p, c) => ({ image: p.layer && c.layerPixels ? c.layerPixels(p.layer) : empty(c) }) },
  { type: 'below', name: 'Everything below', category: 'Inputs', doc: 'All the layers under this one, as drawn.', inputs: [], outputs: [img()], params: [], run: (_i, _p, c) => ({ image: c.below ?? empty(c) }) },
  { type: 'color', name: 'Colour', category: 'Inputs', doc: 'A solid colour over the whole canvas.', inputs: [], outputs: [img()], params: [CO('color', 'Colour', '#3b5dc9'), N('alpha', 'Opacity (%)', 0, 100, 100)],
    run: (_i, p, c) => { const v = col(p.color); return { image: new Uint32Array(c.w * c.h).fill(((v & 0xffffff) | (Math.round((p.alpha / 100) * 255) << 24)) >>> 0) }; } },
  { type: 'noise', name: 'Noise', category: 'Inputs', doc: 'Smooth noise in flat colour steps. "Moves per loop" scrolls it a whole number of times, so it loops.', inputs: [], outputs: [img()],
    params: [N('scale', 'Size (px)', 1, 64, 8), N('octaves', 'Detail', 1, 4, 2), N('move', 'Moves per loop', -4, 4, 1), CH('dir', 'Direction', ['Up', 'Down', 'Left', 'Right']), CO('a', 'Dark', '#1a1c2c'), CO('b', 'Light', '#f4f4f4'), N('steps', 'Steps (0 = smooth)', 0, 8, 4), BO('dither', 'Dither between steps', true), N('seed', 'Seed', 1, 999, 1)],
    run: (_i, p, c) => {
      const out = empty(c), a = col(p.a), b = col(p.b), sc = Math.max(1, p.scale);
      const span = (p.dir === 'Up' || p.dir === 'Down' ? c.h : c.w) / sc, shift = (c.t ?? 0) * Math.round(p.move) * span;
      const dx = p.dir === 'Left' ? shift : p.dir === 'Right' ? -shift : 0, dy = p.dir === 'Up' ? shift : p.dir === 'Down' ? -shift : 0;
      const tileX = c.w / sc, tileY = c.h / sc;
      // Tiled noise (wraps at the canvas edges) so moving a whole canvas per loop is seamless.
      const tn = (x: number, y: number, per: [number, number], seed: number) => {
        const fx = ((x % per[0]) + per[0]) % per[0], fy = ((y % per[1]) + per[1]) % per[1];
        const u = fx / per[0], v = fy / per[1];
        const n00 = noise2(fx, fy, seed), n10 = noise2(fx - per[0], fy, seed), n01 = noise2(fx, fy - per[1], seed), n11 = noise2(fx - per[0], fy - per[1], seed);
        return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
      };
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
        let v = 0, amp = 1, tot = 0, f = 1;
        for (let o = 0; o < Math.round(p.octaves); o++) { v += tn((x / sc) * f + dx * f, (y / sc) * f + dy * f, [tileX * f, tileY * f], p.seed + o * 17) * amp; tot += amp; amp /= 2; f *= 2; }
        out[y * c.w + x] = ramp(v / tot, a, b, Math.round(p.steps), p.dither, x, y);
      }
      return { image: out };
    } },
  { type: 'gradient', name: 'Gradient', category: 'Inputs', doc: 'A linear or radial gradient in flat steps.', inputs: [], outputs: [img()],
    params: [CH('kind', 'Kind', ['Linear', 'Radial']), N('angle', 'Angle (°)', 0, 360, 90), N('cx', 'Centre X (%)', 0, 100, 50), N('cy', 'Centre Y (%)', 0, 100, 50), CO('a', 'From', '#1a1c2c'), CO('b', 'To', '#41a6f6'), N('steps', 'Steps (0 = smooth)', 0, 16, 5), BO('dither', 'Dither between steps', true)],
    run: (_i, p, c) => {
      const out = empty(c), a = col(p.a), b = col(p.b), th = (p.angle * Math.PI) / 180, ux = Math.cos(th), uy = Math.sin(th);
      const cx = (p.cx / 100) * c.w, cy = (p.cy / 100) * c.h, half = (Math.abs(ux) * c.w + Math.abs(uy) * c.h) / 2, rad = Math.hypot(c.w, c.h) / 2;
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
        const v = p.kind === 'Radial' ? Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / rad : ((x + 0.5 - c.w / 2) * ux + (y + 0.5 - c.h / 2) * uy) / (2 * half) + 0.5;
        out[y * c.w + x] = ramp(v, a, b, Math.round(p.steps), p.dither, x, y);
      }
      return { image: out };
    } },

  // ---- animation parameters
  { type: 'time', name: 'Time', category: 'Animation', doc: 'Where this frame is in the loop: progress 0→1, a wave −1…1 that loops, the frame number and seconds.', inputs: [],
    outputs: [num('t', 'Progress 0–1'), num('wave', 'Wave −1…1'), num('frame', 'Frame'), num('seconds', 'Seconds')], params: [N('cycles', 'Waves per loop', 1, 8, 1)],
    run: (_i, p, c) => { const t = c.t ?? 0; return { t, wave: Math.sin(t * Math.PI * 2 * Math.round(p.cycles)), frame: c.frame ?? 0, seconds: c.seconds ?? 0 }; } },
  { type: 'number', name: 'Number', category: 'Animation', doc: 'A number to feed into settings.', inputs: [], outputs: [num('value', 'Value')], params: [N('value', 'Value', -1000, 1000, 1, 0.1)], run: (_i, p) => ({ value: p.value }) },
  { type: 'math', name: 'Maths', category: 'Animation', doc: 'Combines two numbers. Link Time\'s wave into A and set B to scale it.', inputs: [], outputs: [num('value', 'Result')],
    params: [N('a', 'A', -1000, 1000, 0, 0.1), CH('op', 'Operation', ['A × B', 'A + B', 'A − B', 'A ÷ B', 'A × B + C', 'min', 'max', 'sin(A) × B', 'round(A)']), N('b', 'B', -1000, 1000, 1, 0.1), N('c', 'C', -1000, 1000, 0, 0.1)],
    run: (_i, p) => {
      const { a, b, c: cc } = p;
      const v = p.op === 'A + B' ? a + b : p.op === 'A − B' ? a - b : p.op === 'A ÷ B' ? (b ? a / b : 0) : p.op === 'A × B + C' ? a * b + cc : p.op === 'min' ? Math.min(a, b) : p.op === 'max' ? Math.max(a, b)
        : p.op === 'sin(A) × B' ? Math.sin(a) * b : p.op === 'round(A)' ? Math.round(a) : a * b;
      return { value: Number.isFinite(v) ? v : 0 };
    } },

  // ---- lighting
  { type: 'height', name: 'Height map', category: 'Lighting', doc: 'How high each pixel is, as grey: rounded off at the shape\'s edges, with detail from brightness.', inputs: [img('image', 'Shape')], outputs: [img('image', 'Height')],
    params: [N('bevel', 'Edge rounding (px)', 1, 16, 4), N('detail', 'Detail from brightness', 0, 100, 15)],
    run: (i, p, c) => {
      const src: Uint32Array = i.image ?? c.own;
      const hm = heightFrom([src], c.w, c.h, { bevel: p.bevel, strength: 2, detail: p.detail, invertDetail: false });
      const out = empty(c);
      for (let k = 0; k < out.length; k++) if (A(src[k])) { const g = Math.round(Math.max(0, Math.min(1, hm[k])) * 255); out[k] = rgba(g, g, g); }
      return { image: out };
    } },
  { type: 'normals', name: 'Normal map', category: 'Lighting', doc: 'Which way each pixel faces, made from the shape (as in the Lighting panel).', inputs: [img('image', 'Shape')], outputs: [img('image', 'Normals')],
    params: [N('bevel', 'Edge rounding (px)', 1, 16, 4), N('strength', 'Strength', 0.5, 6, 2, 0.1), N('detail', 'Detail from brightness', 0, 100, 15)],
    run: (i, p, c) => {
      const src: Uint32Array = i.image ?? c.own;
      const hm = heightFrom([src], c.w, c.h, { bevel: p.bevel, strength: p.strength, detail: p.detail, invertDetail: false });
      return { image: normalsFromHeight(hm, [src], c.w, c.h, p.strength) };
    } },
  { type: 'light', name: 'Light', category: 'Lighting', doc: 'Lights the image with one light in banded steps. Without a normal map, one is made from the image.', inputs: [img('image', 'Image'), img('normals', 'Normals')], outputs: [img()],
    params: [CH('kind', 'Kind', ['point', 'spot', 'directional']), N('x', 'X (%)', -50, 150, 25), N('y', 'Y (%)', -50, 150, 25), N('z', 'Height', 1, 128, 24), N('angle', 'Direction (°)', 0, 360, 45),
      CO('colour', 'Colour', '#fff1d0'), N('intensity', 'Intensity', 0, 4, 1.2, 0.05), N('radius', 'Reach (px)', 4, 512, 96), CO('ambient', 'Ambient', '#5a6ba0'), N('ambientIntensity', 'Ambient amount', 0, 1, 0.45, 0.05),
      N('bands', 'Steps (0 = smooth)', 0, 8, 4), N('specular', 'Shine', 0, 1, 0.25, 0.05), BO('dither', 'Dither band edges', false)],
    run: (i, p, c) => {
      const base: Uint32Array = i.image ?? c.own;
      let normals: Uint32Array | null = i.normals ?? null;
      if (!normals) normals = normalsFromHeight(heightFrom([base], c.w, c.h, { bevel: 4, strength: 2, detail: 15, invertDetail: false }), [base], c.w, c.h, 2);
      const L = { ...defaultLighting(c.w, c.h), ambient: p.ambient, ambientIntensity: p.ambientIntensity, bands: Math.round(p.bands), dither: p.dither };
      const li = { ...newLight('n', 'n', c.w, c.h, p.kind as LightKind), colour: p.colour, intensity: p.intensity, x: (p.x / 100) * c.w, y: (p.y / 100) * c.h, z: p.z, radius: p.radius, angle: p.angle, specular: p.specular };
      return { image: shade({ base, normals, w: c.w, h: c.h, palette: c.palette }, L, [li]) };
    } },

  // ---- masks & compositing
  { type: 'blend', name: 'Blend', category: 'Masks & compositing', doc: 'Puts Top over Base with a blend mode.', inputs: [img('base', 'Base'), img('top', 'Top')], outputs: [img()],
    params: [CH('mode', 'Mode', BLEND_MODES as string[], 'normal'), N('opacity', 'Opacity (%)', 0, 100, 100)],
    run: (i, p, c) => {
      const out = (i.base ?? empty(c)).slice(), top: Uint32Array | undefined = i.top;
      if (!top) return { image: out };
      const op = Math.max(0, Math.min(100, p.opacity)) / 100;
      for (let k = 0; k < out.length; k++) {
        const s = top[k]; let a = A(s);
        if (!a) continue;
        a = Math.round(a * op);
        if (a) out[k] = blendPixel(p.mode as BlendMode, out[k], R(s), G(s), B(s), a);
      }
      return { image: out };
    } },
  { type: 'mask', name: 'Mask', category: 'Masks & compositing', doc: 'Keeps the image only where the mask has pixels (or only where it doesn\'t). "Brightness" uses light mask pixels as more solid.', inputs: [img('image', 'Image'), img('mask', 'Mask')], outputs: [img()],
    params: [CH('keep', 'Keep', ['Inside the mask', 'Outside the mask']), CH('use', 'Mask by', ['Its pixels', 'Brightness']), N('cut', 'Brightness cut-off (%)', 0, 100, 50)],
    run: (i, p, c) => {
      const src: Uint32Array = i.image ?? c.own, m: Uint32Array | undefined = i.mask;
      if (!m) return { image: src.slice() };
      const out = empty(c), inside = p.keep === 'Inside the mask';
      for (let k = 0; k < out.length; k++) {
        const mv = m[k];
        const on = p.use === 'Brightness' ? A(mv) > 0 && (R(mv) + G(mv) + B(mv)) / 765 >= p.cut / 100 : A(mv) > 0;
        if (on === inside) out[k] = src[k];
      }
      return { image: out };
    } },
  { type: 'silhouette', name: 'Silhouette', category: 'Masks & compositing', doc: 'Every pixel of the image in one colour (shadows, flashes, outlines to blend).', inputs: [img()], outputs: [img()], params: [CO('color', 'Colour', '#ffffff')],
    run: (i, p, c) => { const src: Uint32Array = i.image ?? c.own, v = col(p.color), out = empty(c); for (let k = 0; k < out.length; k++) if (A(src[k])) out[k] = ((v & 0xffffff) | (A(src[k]) << 24)) >>> 0; return { image: out }; } },
  { type: 'offset', name: 'Move', category: 'Masks & compositing', doc: 'Moves the image by whole pixels, wrapping round the edges or not. Link Time into it to scroll.', inputs: [img()], outputs: [img()],
    params: [N('dx', 'X (px)', -256, 256, 0), N('dy', 'Y (px)', -256, 256, 0), BO('wrap', 'Wrap round', false)],
    run: (i, p, c) => {
      const src: Uint32Array = i.image ?? c.own, out = empty(c), dx = Math.round(p.dx), dy = Math.round(p.dy);
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
        let sx = x - dx, sy = y - dy;
        if (p.wrap) { sx = ((sx % c.w) + c.w) % c.w; sy = ((sy % c.h) + c.h) % c.h; } else if (sx < 0 || sy < 0 || sx >= c.w || sy >= c.h) continue;
        out[y * c.w + x] = src[sy * c.w + sx];
      }
      return { image: out };
    } },
  { type: 'palette', name: 'Palette snap', category: 'Colour', doc: 'Every colour to the nearest colour of the sprite\'s palette.', inputs: [img()], outputs: [img()], params: [],
    run: (i, _p, c) => { const src: Uint32Array = i.image ?? c.own; if (!c.palette.length) return { image: src.slice() }; const cache = new Map<number, number>(); return { image: src.map((v) => { if (!A(v)) return v; let o = cache.get(v); if (o === undefined) { o = ((c.palette[nearestIndex(v, c.palette)] & 0xffffff) | (A(v) << 24)) >>> 0; cache.set(v, o); } return o; }) }; } },

  // ---- particles & weather
  { type: 'particles', name: 'Particles', category: 'Particles & weather', doc: 'A particle preset drawn over the image. For full control use the Particles panel on its own layer.', inputs: [img()], outputs: [img()],
    params: [CH('preset', 'Preset', PARTICLE_PRESETS.map((x) => x.name)), N('x', 'X (%)', 0, 100, 50), N('y', 'Y (%)', 0, 100, 70), BO('palette', 'Snap to palette', false), N('seed', 'Seed', 1, 999, 1)],
    run: (i, p, c) => {
      const pre = PARTICLE_PRESETS.find((x) => x.name === p.preset) ?? PARTICLE_PRESETS[0];
      const sys = { ...newSystem(c.w, c.h), x: Math.round((p.x / 100) * c.w), y: Math.round((p.y / 100) * c.h), palette: p.palette, emitters: pre.emitters.map((e, k) => ({ ...newEmitter('n' + k), ...e, seed: p.seed + k })) };
      const loop = Math.max(0.05, c.loopSeconds ?? 1);
      return { image: drawSystem(sys, i.image ?? empty(c), c.w, c.h, c.seconds ?? (c.t ?? 0) * loop, loop, c, null) };
    } },
  { type: 'weather', name: 'Weather', category: 'Particles & weather', doc: 'Rain or snow over the image, landing on what\'s below. For full control use the Weather panel on its own layer.', inputs: [img()], outputs: [img()],
    params: [CH('mood', 'Mood', WEATHER_PRESETS.map((x) => x.name), 'Light rain'), N('wind', 'Wind (°)', -70, 70, 10), BO('land', 'Land on the art below', true), N('seed', 'Seed', 1, 999, 1)],
    run: (i, p, c) => {
      const pre = WEATHER_PRESETS.find((x) => x.name === p.mood) ?? WEATHER_PRESETS[0];
      const wt = { ...newWeather(pre.w.kind), ...pre.w, wind: p.wind, hitArt: p.land, seed: p.seed };
      const loop = Math.max(0.05, c.loopSeconds ?? 1);
      const below = p.land && c.belowWhere ? c.belowWhere((l, bd) => !bd && !l.bakedFrom && !l.fx?.some((f) => f.on && (f.effect === 'weather' || f.effect === 'particles' || f.effect === 'nodes'))) : undefined;
      return { image: drawWeather(wt, i.image ?? empty(c), c.w, c.h, c.seconds ?? (c.t ?? 0) * loop, loop, { palette: c.palette, below }, (c.frames ?? 1) > 1 ? (c.frame ?? 0) / ((c.frames ?? 1) - 1) : 1) };
    } },

  // ---- output
  { type: 'output', name: 'Output', category: 'Output', doc: 'What this layer shows. Nothing linked: the layer\'s own pixels.', inputs: [img()], outputs: [], params: [], run: (i, _p, c) => ({ image: i.image ?? c.own }) },
];

/** Effects that need settings no node can give (their own panels) aren't offered as plain effect nodes. */
const SKIP_FX = new Set(['particles', 'weather', 'nodes']);

/** Every node type: the built-in ones, then one per registered effect (shaders, colour, distortion, plugins). */
export function nodeTypes(): NodeDef[] {
  const fx: NodeDef[] = effects().filter((e) => !SKIP_FX.has(e.id)).map((e) => ({
    type: 'fx:' + e.id, name: e.name, doc: e.liveOnly ? 'A live shader: it can read the layers below.' : 'An effect from the Effects menu.',
    category: /hue|palette|gradient|level|bright|invert|hsv|map/i.test(e.id) ? 'Colour' : 'Shaders',
    inputs: [img()], outputs: [img()], params: e.params,
    run: (i, p, c) => ({ image: e.apply(i.image ?? c.own, c.w, c.h, p, c) }),
  }));
  return [...BUILT, ...fx];
}
export const nodeType = (type: string) => nodeTypes().find((t) => t.type === type);

export function newNode(type: string, id: string, x = 0, y = 0): GNode {
  const def = nodeType(type);
  const params = def ? (type.startsWith('fx:') ? defaultParams(effectById(type.slice(3))!) : Object.fromEntries(def.params.map((q) => [q.key, q.value]))) : {};
  return { id, type, x, y, params };
}

/** Would a link from `from` to `to` make a loop? */
export function makesCycle(g: NodeGraph, from: string, to: string): boolean {
  if (from === to) return true;
  // Is `from` reachable downstream of `to`? Follow links forward from `to`.
  const seen = new Set<string>(), stack = [to];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const l of g.links) if (l.from === n) stack.push(l.to);
  }
  return false;
}

/** Adds a link (replacing whatever fed that input). Returns null if the types don't match or it would make a loop. */
export function connect(g: NodeGraph, link: Link): NodeGraph | null {
  const a = g.nodes.find((n) => n.id === link.from), b = g.nodes.find((n) => n.id === link.to);
  const da = a && nodeType(a.type), db = b && nodeType(b.type);
  if (!da || !db) return null;
  const out = da.outputs.find((o) => o.key === link.out);
  const inImage = db.inputs.find((i) => i.key === link.in);
  const inNum = db.params.find((q) => q.key === link.in && q.type === 'number');
  if (!out || (!inImage && !inNum)) return null;
  if ((inImage && out.type !== 'image') || (inNum && out.type !== 'number')) return null;
  if (makesCycle(g, link.from, link.to)) return null;
  return { ...g, links: [...g.links.filter((l) => !(l.to === link.to && l.in === link.in)), link] };
}

export interface EvalResult { image: Uint32Array; outputs: Map<string, Record<string, any>>; errors: Map<string, string> }

/**
 * Evaluates the graph for one frame. Each node runs once; a node whose inputs fail gets transparent images; a node that
 * throws is passed over (its image input goes straight through) and its message is kept, so one bad node never blanks
 * the whole layer.
 */
export function evaluate(g: NodeGraph, ctx: NodeCtx): EvalResult {
  const outputs = new Map<string, Record<string, any>>(), errors = new Map<string, string>(), busy = new Set<string>();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const defs = new Map(nodeTypes().map((d) => [d.type, d]));
  const run = (id: string): Record<string, any> => {
    const done = outputs.get(id);
    if (done) return done;
    const n = byId.get(id), def = n && defs.get(n.type);
    if (!n || !def || busy.has(id)) return {};
    busy.add(id);
    const inp: Record<string, any> = {};
    const params: Record<string, any> = { ...n.params };
    for (const l of g.links) {
      if (l.to !== id) continue;
      const v = run(l.from)[l.out];
      if (v === undefined) continue;
      if (def.inputs.some((i) => i.key === l.in)) inp[l.in] = v;
      else if (typeof v === 'number') params[l.in] = v;
    }
    let res: Record<string, any>;
    try { res = def.run(inp, params, ctx); }
    catch (e: any) { errors.set(id, String(e?.message ?? e)); res = { image: inp.image ?? ctx.own }; }
    busy.delete(id);
    outputs.set(id, res);
    return res;
  };
  for (const n of g.nodes) run(n.id);
  const out = g.nodes.find((n) => n.type === 'output');
  const image: Uint32Array = out ? (outputs.get(out.id)?.image ?? ctx.own) : ctx.own;
  return { image, outputs, errors };
}

registerEffect({
  id: 'nodes', name: 'Node graph', liveOnly: true, params: [],
  apply(src, w, h, p, ctx) {
    const g = p.graph as NodeGraph | undefined;
    if (!g?.nodes?.length) return src.slice();
    return evaluate(g, { ...ctx, w, h, own: src }).image.slice();
  },
});

// ---- presets: small graphs to start from

let k = 0;
const id = () => 'n' + ++k;
type Spec = { type: string; x: number; y: number; params?: Record<string, any> };
function build(nodes: Spec[], links: [number, string, number, string][]): NodeGraph {
  k = 0;
  const made = nodes.map((s) => { const n = newNode(s.type, id(), s.x, s.y); return { ...n, params: { ...n.params, ...(s.params ?? {}) } }; });
  return { nodes: made, links: links.map(([a, out, b, inn]) => ({ from: made[a].id, out, to: made[b].id, in: inn })) };
}

export const NODE_PRESETS: { name: string; doc: string; build: () => NodeGraph }[] = [
  { name: 'Moving light', doc: 'This layer lit by a light that swings left and right over the loop.', build: () => build(
    [{ type: 'this', x: 20, y: 20 }, { type: 'time', x: 20, y: 130 }, { type: 'math', x: 200, y: 140, params: { op: 'A × B + C', b: 45, c: 50 } }, { type: 'light', x: 380, y: 20 }, { type: 'output', x: 560, y: 40 }],
    [[0, 'image', 3, 'image'], [1, 'wave', 2, 'a'], [2, 'value', 3, 'x'], [3, 'image', 4, 'image']]) },
  { name: 'Noise dissolve', doc: 'The layer breaks up through moving noise.', build: () => build(
    [{ type: 'this', x: 20, y: 20 }, { type: 'noise', x: 20, y: 120, params: { steps: 2, dither: false, a: '#000000', b: '#ffffff' } }, { type: 'mask', x: 220, y: 40, params: { use: 'Brightness', cut: 50 } }, { type: 'output', x: 420, y: 40 }],
    [[0, 'image', 2, 'image'], [1, 'image', 2, 'mask'], [2, 'image', 3, 'image']]) },
  { name: 'Hologram', doc: 'A flickering cyan copy of the layer with scan noise and glow.', build: () => build(
    [{ type: 'this', x: 20, y: 20 }, { type: 'silhouette', x: 200, y: 20, params: { color: '#73eff7' } }, { type: 'fx:glitch', x: 380, y: 20 }, { type: 'fx:glow', x: 560, y: 20 }, { type: 'output', x: 740, y: 40 }],
    [[0, 'image', 1, 'image'], [1, 'image', 2, 'image'], [2, 'image', 3, 'image'], [3, 'image', 4, 'image']]) },
  { name: 'Shadow and outline', doc: 'An outline, then a soft shadow cast down-right, under the art.', build: () => build(
    [{ type: 'this', x: 20, y: 20 }, { type: 'fx:outline', x: 200, y: 20 }, { type: 'silhouette', x: 200, y: 140, params: { color: '#1a1c2c' } }, { type: 'offset', x: 380, y: 140, params: { dx: 2, dy: 2 } },
      { type: 'blend', x: 560, y: 60, params: { opacity: 60 } }, { type: 'blend', x: 740, y: 40 }, { type: 'output', x: 920, y: 40 }],
    [[0, 'image', 1, 'image'], [0, 'image', 2, 'image'], [2, 'image', 3, 'image'], [3, 'image', 4, 'top'], [4, 'image', 5, 'base'], [1, 'image', 5, 'top'], [5, 'image', 6, 'image']]) },
  { name: 'Rainy night', doc: 'Darkens the layer to night colours and adds rain landing on it.', build: () => build(
    [{ type: 'this', x: 20, y: 20 }, { type: 'fx:hsv', x: 200, y: 20, params: { val: -35, sat: -20, hue: 10 } }, { type: 'weather', x: 380, y: 20, params: { mood: 'Heavy rain' } }, { type: 'output', x: 560, y: 40 }],
    [[0, 'image', 1, 'image'], [1, 'image', 2, 'image'], [2, 'image', 3, 'image']]) },
  { name: 'Scrolling sky', doc: 'A stepped sky gradient with clouds of noise drifting across, looping.', build: () => build(
    [{ type: 'gradient', x: 20, y: 20, params: { a: '#29366f', b: '#41a6f6', steps: 5 } }, { type: 'noise', x: 20, y: 160, params: { a: '#94b0c2', b: '#ffffff', dir: 'Left', move: 1, scale: 12, steps: 3 } },
      { type: 'mask', x: 220, y: 160, params: { use: 'Brightness', cut: 60 } }, { type: 'blend', x: 400, y: 40, params: { opacity: 85 } }, { type: 'output', x: 580, y: 40 }],
    [[1, 'image', 2, 'image'], [1, 'image', 2, 'mask'], [0, 'image', 3, 'base'], [2, 'image', 3, 'top'], [3, 'image', 4, 'image']]) },
];

/** A starting graph: this layer straight to the output. */
export const identityGraph = (): NodeGraph => build([{ type: 'this', x: 20, y: 30 }, { type: 'output', x: 240, y: 30 }], [[0, 'image', 1, 'image']]);
