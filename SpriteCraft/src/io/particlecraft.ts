// Particle systems to and from ParticleCraft. A real-time craft.vfx carries both the node graph ParticleCraft edits and
// the compiled layers GameCraft and LogicCraft play, so an effect made here opens in ParticleCraft as ordinary blocks, and
// one made there plays here as pixel particles (its sizes and speeds converted from metres at PX_PER_M pixels a metre).
import { PX_PER_M, fromCraft, newSystem, toCraft, type CraftEmitter, type Emitter, type ParticleSystem } from '../core/particles';
import { newId } from '../core/types';
import { decodePng, encodePng } from './png';
import { VFX_FORMAT } from './craft';

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (url: string) => {
  const raw = atob(url.split(',')[1] ?? '');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** Reads a real-time ParticleCraft effect as a particle system for a canvas of this size. */
export function readParticleVfx(text: string, w: number, h: number, scale = PX_PER_M): { system: ParticleSystem; notes: string[] } {
  const a = JSON.parse(text);
  if (a?.format !== VFX_FORMAT) throw new Error('This is not a ParticleCraft effect (craft.vfx)');
  if (a.schemaVersion > 2) throw new Error('This effect was made by a newer ParticleCraft');
  if (a.kind === 'baked') throw new Error('This is a baked flipbook. Open it with File > Import from the Craft apps to edit its frames.');
  const layers: { name: string; params: Partial<CraftEmitter> }[] = Array.isArray(a.layers) ? a.layers : [];
  if (!layers.length) throw new Error('This effect has no particle layers. Save it once in ParticleCraft, then try again.');
  const notes: string[] = [];
  const system = { ...newSystem(w, h), name: String(a.name ?? 'Particles') };
  system.looping = layers.some((l) => l.params.looping !== false);
  for (const [i, l] of layers.entries()) {
    const p = l.params;
    let sprite: Emitter['sprite'];
    if (typeof p.textureImage === 'string' && p.textureImage.startsWith('data:image/png')) {
      try {
        const img = decodePng(unb64(p.textureImage));
        // Pictures are shrunk by whole steps, to about the particle's own size in pixels (3 to 16), keeping their pixels.
        const target = Math.max(3, Math.min(16, Math.round((p.sizeStart ?? 0.25) * scale * 1.5)));
        const k = Math.max(1, Math.ceil(Math.max(img.w, img.h) / target));
        const sw = Math.max(1, Math.floor(img.w / k)), sh = Math.max(1, Math.floor(img.h / k));
        const fr: number[] = [];
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) fr.push(img.data[y * k * img.w + x * k]);
        sprite = { w: sw, h: sh, frames: [fr] };
        if (k > 1) notes.push(`${l.name}: its picture was ${img.w}×${img.h}, shown at ${sw}×${sh}`);
      } catch { notes.push(`${l.name}: its picture could not be read, so a built-in shape is used`); }
    }
    if (p.shape === 'mesh' || p.shape === 'path' || p.shape === 'cone') notes.push(`${l.name}: the "${p.shape}" emitter shape is drawn as a point`);
    if (Array.isArray(p.forces) && p.forces.length) notes.push(`${l.name}: extra forces and attractors are not brought across`);
    system.emitters.push(fromCraft(p, `pe${i}_${newId('e').slice(-4)}`, l.name || `Emitter ${i + 1}`, scale, sprite));
  }
  return { system, notes };
}

const block = (type: string, props: Record<string, unknown>) => ({ id: newId('vb'), type, enabled: true, props });

/** A particle system as a real-time ParticleCraft effect (graph and compiled layers). */
export function writeParticleVfx(sys: ParticleSystem, loopSeconds: number, scale = PX_PER_M, now = new Date().toISOString()) {
  const layers: { name: string; params: CraftEmitter }[] = [];
  const systems: unknown[] = [];
  for (const [i, e] of sys.emitters.filter((x) => x.on).entries()) {
    const p = toCraft(e, sys.looping, loopSeconds, scale);
    if (e.sprite?.frames.length) {
      p.textureImage = 'data:image/png;base64,' + b64(encodePng({ w: e.sprite.w, h: e.sprite.h, data: Uint32Array.from(e.sprite.frames[0]) }));
    }
    layers.push({ name: e.name, params: p });
    const life0 = e.lifetime * (1 - e.lifetimeVar), life1 = e.lifetime * (1 + e.lifetimeVar);
    const out = [
      block('render', { texture: p.texture, image: p.textureImage ?? '', blending: p.blending, space: 'world' }),
      block('colorOverLife', { start: p.colorStart, useMid: !!p.colorMid, mid: p.colorMid || '#ffffff', end: p.colorEnd }),
      block('alphaOverLife', { start: p.alphaStart, end: p.alphaEnd, fadeIn: 0 }),
      block('sizeOverLife', { end: p.sizeStart > 0 ? p.sizeEnd / p.sizeStart : 1 }),
      ...(p.trail > 0 ? [block('trail', { length: p.trail })] : []),
    ];
    const update = [
      ...(p.gravity ? [block('gravity', { strength: p.gravity })] : []),
      ...(p.drag ? [block('drag', { amount: p.drag })] : []),
      ...(p.acceleration[0] ? [block('force', { force: p.acceleration })] : []),
      ...(p.turbulence ? [block('turbulence', { strength: p.turbulence, frequency: p.turbulenceFreq })] : []),
      ...(p.vortex || p.vortexPull ? [block('vortex', { strength: p.vortex, pull: p.vortexPull })] : []),
      ...(p.collideFloor ? [block('collide', { floor: p.floorY, bounce: p.bounce })] : []),
    ];
    systems.push({
      id: newId('vs'), name: e.name, enabled: true, x: i * 330, y: 0,
      contexts: {
        spawn: [...(p.rate ? [block('rate', { rate: p.rate })] : []), ...(p.burst ? [block('burst', { count: p.burst })] : []), block('duration', { loop: p.looping, duration: p.duration })],
        init: [
          block('lifetime', { min: life0, max: life1 }),
          block('shape', { shape: p.shape === 'line' || p.shape === 'ring' ? 'box' : p.shape, size: p.shape === 'line' ? [p.shapeSize[0], 0, 0] : p.shapeSize }),
          block('velocity', { direction: p.direction, speed: p.speed, random: p.speedVar, spread: p.spread }),
          ...(p.radialSpeed ? [block('radialVelocity', { speed: p.radialSpeed })] : []),
          block('size', { size: p.sizeStart, random: p.sizeVar }),
          ...(p.rotationSpeed ? [block('rotation', { angle: 0, spin: Math.abs(p.rotationSpeed) })] : []),
          block('seed', { seed: p.seed }),
        ],
        update, output: out,
      },
    });
  }
  return {
    format: VFX_FORMAT, schemaVersion: 2, id: newId('vfx'), name: sys.name, kind: 'realtime' as const, category: 'SpriteCraft',
    description: `Pixel particles from SpriteCraft (${PX_PER_M === scale ? '' : `${scale} px a metre, `}${layers.length} emitter${layers.length === 1 ? '' : 's'}).`,
    created: now, modified: now, graph: { systems, params: [] }, layers,
    compatibility: { gamecraft: [] as string[], logiccraft: [] as string[] },
  };
}
