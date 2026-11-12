// The link to the other Craft apps. They all read one shared exchange folder; a baked flipbook (craft.vfx, kind "baked")
// is the form GameCraft and LogicCraft already import as an animated sprite, so sprites made here arrive through the
// import dialogs those apps already have, and WorldCraft lists them with its effects.
import { buildSheet, docFromFrames, sliceSheet } from './sheet';
import { decodePng, encodePng } from './png';
import { newId, type Doc } from '../core/types';

export const VFX_FORMAT = 'craft.vfx';
export const VFX_SCHEMA = 1;

/** GameCraft and LogicCraft read flipbooks as one row, and textures this wide are the limit ParticleCraft already uses. */
export const MAX_STRIP = 8192;

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export const exchangeFileName = (name: string) => `${name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'sprite'}.vfx.json`;

export interface FlipbookOptions { from: number; to: number; scale: number; loop: boolean; name?: string; now?: string }

/** The largest playable rate of the frames: per-frame timing does not exist in a flipbook, only one fps. */
export function flipbookFps(doc: Doc, from: number, to: number): number {
  let t = 0;
  for (let i = from; i <= to; i++) t += doc.frames[i].duration;
  return Math.max(1, Math.round((1000 * (to - from + 1)) / Math.max(1, t)));
}

export function makeFlipbook(doc: Doc, o: FlipbookOptions) {
  const count = o.to - o.from + 1;
  const width = doc.width * o.scale, height = doc.height * o.scale;
  if (width * count > MAX_STRIP) {
    throw new Error(`The strip would be ${width * count} pixels wide; the limit is ${MAX_STRIP}. Send fewer frames, or a smaller scale.`);
  }
  const sheet = buildSheet(doc, { layout: 'horizontal', padding: 0, scale: o.scale, from: o.from, to: o.to });
  const png = encodePng(sheet.image);
  const t = o.now ?? new Date().toISOString();
  const durations = doc.frames.slice(o.from, o.to + 1).map((f) => f.duration);
  const notes: string[] = [];
  if (new Set(durations).size > 1) notes.push('Frames had different durations here; a flipbook has one speed, so the average is used.');
  return {
    format: VFX_FORMAT, schemaVersion: VFX_SCHEMA, id: newId('vfx'), name: o.name ?? doc.name, kind: 'baked' as const,
    category: 'Sprites', description: `Sprite animation from SpriteCraft: ${count} frame${count === 1 ? '' : 's'}, ${width}×${height}.`,
    created: t, modified: t,
    flipbook: { image: 'data:image/png;base64,' + b64(png), frames: count, fps: flipbookFps(doc, o.from, o.to), loop: o.loop, width, height, pixelArt: true },
    compatibility: { gamecraft: notes, logiccraft: notes },
  };
}

/** Reads a baked effect from the exchange folder into frames, for retouching here and sending back. */
export function readFlipbook(text: string): Doc {
  const a = JSON.parse(text);
  if (a?.format !== VFX_FORMAT) throw new Error('This is not a Craft effect file');
  if (a.kind !== 'baked' || !a.flipbook) throw new Error('Only baked flipbooks can be opened as frames. In ParticleCraft, bake the effect first.');
  const fb = a.flipbook;
  const raw = atob(String(fb.image).split(',')[1] ?? '');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const img = decodePng(bytes);
  const frameW = fb.width || Math.floor(img.w / fb.frames), frameH = fb.height || img.h;
  const frames = sliceSheet(img, { frameW, frameH, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0, count: fb.frames });
  const doc = docFromFrames(frames, frameW, frameH, a.name ?? 'Effect', frames.map(() => Math.round(1000 / (fb.fps || 10))));
  return doc;
}
