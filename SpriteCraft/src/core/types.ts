// The SpriteCraft document model. Everything here is plain data with no DOM dependency.
//
// A document is treated as immutable: an edit builds a new Doc that shares every untouched Cel with the old one.
// Undo is then just "go back to the previous Doc", and history costs only the cels that really changed.

/** One pixel: 0xAABBGGRR, which is RGBA bytes on a little-endian machine (the same layout as ImageData). */
export type Pixel = number;

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity'
  | 'addition' | 'subtract' | 'divide';

/** The order matches the blend mode numbers in the .aseprite format. */
export const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'addition', 'subtract', 'divide'];

export interface Rect { x: number; y: number; w: number; h: number }

/** A trimmed image placed on the canvas. Immutable once it is in a Doc. May extend beyond the canvas. */
export interface Cel {
  id: string;
  x: number; y: number; w: number; h: number;
  data: Uint32Array;
  /** 0..255, multiplied with the layer's opacity. */
  opacity: number;
  /** Made by a motion tween (its id). Painting on it makes an ordinary cel without this mark. */
  gen?: string;
}

export type LayerKind = 'image' | 'group' | 'reference';

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  /** Group this layer belongs to, or null at the top level. Siblings draw in array order, first = bottom. */
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  /** Painting keeps the existing transparency. */
  alphaLock: boolean;
  /** Clipping mask: only shows where the nearest non-clipped layer below has pixels. */
  clip: boolean;
  /** A layer mask exists. Mask cels are per frame; a pixel's alpha is how much of the layer it hides. */
  mask: boolean;
  maskEnabled: boolean;
  collapsed: boolean;
  /** Live shaders on this layer (Phase 5), run in order each time the frame is drawn. */
  fx?: LayerFx[];
  /** Pixels baked from live weather or particles: never counted as something rain and snow land on. */
  bakedFrom?: 'weather' | 'particles';
}

/** One shader in a layer's stack: a registered effect, its settings, and optional keyframes per numeric setting. */
export interface LayerFx {
  id: string;
  effect: string;
  on: boolean;
  params: Record<string, any>;
  keys?: Record<string, import('./anim').Key[]>;
}

export interface Frame { id: string; duration: number }

export type LoopDir = 'forward' | 'reverse' | 'pingpong' | 'pingpong-reverse';

export interface Tag { id: string; name: string; from: number; to: number; dir: LoopDir; repeat: number; color: string }

/** Selected pixels: a byte mask (0 or 255) over a bounding box, in canvas coordinates. */
export interface Selection { x: number; y: number; w: number; h: number; mask: Uint8Array }

export type ColorMode = 'rgba' | 'indexed';

export interface Guide { axis: 'x' | 'y'; pos: number }

export type IsoStyle = 'off' | 'iso' | 'diamond';

export interface GridSettings {
  /** Lines between single pixels, shown when zoomed in. */
  pixelGrid: boolean;
  showTile: boolean;
  tileW: number; tileH: number; offX: number; offY: number;
  iso: IsoStyle;
  /** Width of one iso cell in pixels; its height is half of this (the 2:1 pixel art angle). */
  isoW: number;
  snap: boolean;
}

export interface Doc {
  id: string;
  name: string;
  width: number;
  height: number;
  colorMode: ColorMode;
  palette: Pixel[];
  layers: Layer[];
  frames: Frame[];
  /** Key: celKey(layerId, frameId) or maskKey(layerId, frameId). Linked cels share the same Cel object. */
  cels: Record<string, Cel>;
  tags: Tag[];
  selection: Selection | null;
  guides: Guide[];
  grid: GridSettings;
  /** Frames sent to other Craft apps use this rate when the frame durations differ. */
  fpsHint: number;
  /** Motion tweens (Phase 2). Missing in documents from 0.1. */
  motions?: import('./anim').Motion[];
  /** The paper rig (Phase 3): parts on a 3D skeleton. Missing in older documents. */
  rig?: import('./rig').Rig;
  /** Lighting (Phase 4): the normal layer, lights and shading settings. Missing in older documents. */
  lighting?: import('./light').Lighting;
}

export const celKey = (layerId: string, frameId: string) => `${layerId}:${frameId}`;
export const maskKey = (layerId: string, frameId: string) => `${layerId}:${frameId}:m`;

let counter = 0;
const session = Math.random().toString(36).slice(2, 7);
export const newId = (prefix = 'id') => `${prefix}_${session}${(counter++).toString(36)}`;

export const defaultGrid = (): GridSettings => ({ pixelGrid: true, showTile: false, tileW: 16, tileH: 16, offX: 0, offY: 0, iso: 'off', isoW: 32, snap: false });

export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
