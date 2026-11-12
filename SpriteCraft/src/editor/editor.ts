// Editor state: open documents, history, the active edit, tool settings. No DOM drawing here; the viewport watches this
// and paints. Panels call methods on `ed` and re-render through `useEd`.
import { useSyncExternalStore } from 'react';
import { composeFrame, composeRegion, layerPixels, layersBelow, type ComposeOptions } from '../core/compose';
import { nearestIndex, rgba } from '../core/color';
import * as D from '../core/doc';
import * as M from '../core/anim';
import { defaultDynamics, type Dynamics } from '../core/dynamics';
import * as Rg from '../core/rig';
import * as Lt from '../core/light';
import { effectById, lerpParams, type EffectContext } from '../core/effects';
import { combine, fromMask, growSelection, invertSelection, selectAll, toFullMask, isSelected, type SelectMode } from '../core/selection';
import { Surface } from '../core/surface';
import { placedBounds, renderPlaced, upscale8, type Bitmap, type Placement, type RotateQuality } from '../core/transform';
import { celKey, maskKey, newId, rectIntersect, rectUnion, type BlendMode, type Cel, type Doc, type Layer, type LayerKind, type LoopDir, type Pixel, type Rect, type Selection, type Tag } from '../core/types';
import type { DitherKind } from '../core/raster';

export interface HistoryEntry { doc: Doc; label: string }
export interface View { zoom: number; x: number; y: number }

export interface FloatState {
  src: Bitmap;
  big: Bitmap | null;
  place: Placement;
  start: Placement;
  /** Cut from a selection (so the selection follows it) rather than a whole cel or a paste. */
  hadSelection: boolean;
  isPaste: boolean;
  label: string;
}

export interface Session {
  doc: Doc;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  frame: number;
  layerId: string;
  editMask: boolean;
  view: View | null;
  /** Where the app keeps it. Set for every document, so autosave can always recover it. */
  projectId: string;
  neverSaved: boolean;
  savedDoc: Doc | null;
  autosavedDoc: Doc | null;
  surface: Surface | null;
  float: FloatState | null;
  /** A cel shown moved during a drag, before it is committed. */
  preview: { layerId: string; cel: Cel } | null;
  /** Frames selected in the timeline, inclusive. */
  range: [number, number] | null;
}

export interface BrushSettings {
  size: number;
  shape: 'square' | 'circle';
  /** 0..255 */
  opacity: number;
  pixelPerfect: boolean;
  custom: Bitmap | null;
  /** The custom brush paints its own colours, or just its shape in the current colour. */
  customColors: boolean;
  pattern: Bitmap | null;
  ditherKind: DitherKind;
  /** How much of the pattern is filled, 0..1. */
  density: number;
  /** Fill the pattern's gaps with the background colour rather than leaving them alone. */
  ditherBg: boolean;
  shadeStep: number;
  /** An animated brush: images it steps through while painting. `custom` holds the first one. */
  anim: Bitmap[] | null;
  /** 'dab' advances every `animEvery` dabs along a stroke; 'frame' uses the image matching the frame being painted. */
  animMode: 'dab' | 'frame';
  animEvery: number;
  /** Live brush: spacing, scatter, size and colour variation, pressure, turning. */
  dyn: Dynamics;
}

export interface FillSettings { tolerance: number; contiguous: boolean; sampleAll: boolean }
export interface ShapeSettings { filled: boolean }
export interface GradientSettings { kind: 'linear' | 'radial'; dither: DitherKind; end: 'background' | 'transparent' | 'palette'; }
export interface SelectSettings { mode: SelectMode; tolerance: number; contiguous: boolean; sampleAll: boolean }
export interface Symmetry { x: boolean; y: boolean; cx: number; cy: number }
export interface OnionSettings { on: boolean; before: number; after: number; opacity: number; tint: boolean }

export interface DialogState { kind: string; props?: any }

const MAX_UNDO = 400;
const MAX_UNDO_BYTES = 768 * 1024 * 1024;

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem('spritecraft.' + key);
    if (!v) return fallback;
    const parsed = JSON.parse(v);
    // Settings objects pick up new defaults; lists and plain values come back as they were saved.
    const plain = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
    return plain(fallback) && plain(parsed) ? { ...fallback, ...parsed } : (parsed ?? fallback);
  } catch { return fallback; }
};
export const savePref = (key: string, v: unknown) => { try { localStorage.setItem('spritecraft.' + key, JSON.stringify(v)); } catch { /* preferences are a convenience */ } };
export const loadPref = load;

export class Editor {
  sessions: Session[] = [];
  active = 0;
  private listeners = new Set<() => void>();
  version = 0;

  fg: Pixel = rgba(26, 28, 44);
  bg: Pixel = rgba(255, 255, 255);
  toolId = 'pencil';
  /** A tool held for a moment, such as Space for the hand. */
  tempTool: string | null = null;
  brush: BrushSettings = (() => {
    const saved = load('brush', {}) as Partial<BrushSettings>;
    // Saved settings may come from an older version, so dynamics are merged over the defaults key by key.
    return { size: 1, shape: 'circle', opacity: 255, pixelPerfect: true, custom: null, customColors: true, pattern: null, ditherKind: 'bayer4', density: 0.5, ditherBg: false, shadeStep: 1, animMode: 'dab', animEvery: 4,
      ...saved, anim: null, dyn: { ...defaultDynamics(), ...(saved.dyn ?? {}) } } as BrushSettings;
  })();
  fill: FillSettings = { tolerance: 0, contiguous: true, sampleAll: false, ...load('fill', {}) as object };
  shape: ShapeSettings = { filled: false };
  gradient: GradientSettings = { kind: 'linear', dither: 'bayer4', end: 'background' };
  select: SelectSettings = { mode: 'replace', tolerance: 0, contiguous: true, sampleAll: false };
  sym: Symmetry = { x: false, y: false, cx: 0, cy: 0 };
  onion: OnionSettings = load('onion', { on: false, before: 1, after: 1, opacity: 90, tint: true });
  rotateQuality: RotateQuality = 'smooth-edges';
  clip: { w: number; h: number; x: number; y: number; data: Uint32Array } | null = null;
  dialog: DialogState | null = null;
  message = '';
  private messageTimer: any = 0;
  playing = false;
  private playState = { dir: 1, last: 0, left: 0, repeats: 0 };
  loopRange: 'all' | 'tag' = 'tag';
  /** Pixel coordinates under the mouse, for the status bar. */
  hover: { x: number; y: number } | null = null;
  /** Canvas area waiting to be redrawn. 'full' redraws everything. */
  pendingDirty: Rect | 'full' | null = 'full';
  /** Set by the tools module. */
  onToolChange: (() => void) | null = null;

  constructor() { this.openDoc(D.newDoc(64, 64, 'Untitled'), true); }

  get s(): Session { return this.sessions[this.active]; }
  get doc(): Doc { return this.s.doc; }
  get layer(): Layer | undefined { return D.layerById(this.doc, this.s.layerId); }
  get frameId(): string { return this.doc.frames[this.s.frame].id; }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  notify() { this.version++; for (const l of this.listeners) l(); }
  toast(msg: string) {
    this.message = msg;
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => { this.message = ''; this.notify(); }, 5000);
    this.notify();
  }
  openDialog(kind: string, props?: any) { this.dialog = { kind, props }; this.notify(); }
  closeDialog() { this.dialog = null; this.notify(); }
  invalidate(rect: Rect | 'full' = 'full') {
    if (rect === 'full' || this.pendingDirty === 'full') this.pendingDirty = 'full';
    else this.pendingDirty = rectUnion(this.pendingDirty, rect);
  }

  // ---- documents

  openDoc(doc: Doc, neverSaved = true, projectId: string = newId('p')): Session {
    const top = D.layerRows(doc).find((r) => r.layer.kind === 'image')?.layer ?? doc.layers[doc.layers.length - 1];
    const s: Session = { doc, undo: [], redo: [], frame: 0, layerId: top.id, editMask: false, view: null, projectId, neverSaved, savedDoc: neverSaved ? null : doc, autosavedDoc: doc, surface: null, float: null, preview: null, range: null };
    // A fresh empty tab that was never touched gives way to the document being opened.
    if (this.sessions.length === 1 && this.sessions[0].neverSaved && !this.sessions[0].undo.length && !Object.keys(this.sessions[0].doc.cels).length) this.sessions[0] = s;
    else this.sessions.push(s);
    this.active = this.sessions.indexOf(s);
    this.sym = { ...this.sym, cx: doc.width / 2, cy: doc.height / 2 };
    this.invalidate();
    this.notify();
    return s;
  }

  switchTo(i: number) {
    if (i === this.active || !this.sessions[i]) return;
    this.endActiveEdit();
    this.stop();
    this.active = i;
    this.sym = { ...this.sym, cx: this.doc.width / 2, cy: this.doc.height / 2 };
    this.invalidate(); this.notify();
  }

  isDirty(s: Session = this.s) { return s.doc !== s.savedDoc && (s.undo.length > 0 || !s.neverSaved || Object.keys(s.doc.cels).length > 0); }

  closeSession(i: number) {
    this.stop();
    this.sessions.splice(i, 1);
    if (!this.sessions.length) this.openDoc(D.newDoc(64, 64, 'Untitled'));
    this.active = Math.min(this.active, this.sessions.length - 1);
    this.invalidate(); this.notify();
  }

  // ---- history

  /** Records a finished edit. Every change to a document goes through here. */
  commit(label: string, doc: Doc, dirty: Rect | 'full' = 'full') {
    const s = this.s;
    if (doc === s.doc) return;
    doc = this.syncMotions(s.doc, doc);
    s.undo.push({ doc: s.doc, label });
    s.redo = [];
    s.doc = doc;
    this.trimHistory(s);
    // Layers and frames may have gone away with the edit.
    if (!D.layerById(doc, s.layerId)) s.layerId = D.layerRows(doc)[0]?.layer.id ?? doc.layers[0].id;
    s.frame = Math.min(s.frame, doc.frames.length - 1);
    this.invalidate(dirty);
    this.notify();
  }

  /**
   * Keeps tweens in step with the document: re-bakes a motion when its source art changed, or when frames, size or
   * palette changed under it, and drops motions whose layer went away (merge, flatten).
   */
  private syncMotions(prev: Doc, doc: Doc): Doc {
    if (!doc.motions?.length) return doc;
    doc = M.pruneMotions(doc);
    const ids = (d: Doc) => d.frames.map((f) => f.id).join();
    const all = ids(prev) !== ids(doc) || prev.palette !== doc.palette || prev.colorMode !== doc.colorMode || prev.width !== doc.width || prev.height !== doc.height;
    for (const m of M.motionsOf(doc)) {
      const k = M.srcKey(m.layerId, m.id);
      if (m.editing) continue;
      if (all || prev.cels[k] !== doc.cels[k]) doc = M.bakeMotion(doc, m.id).doc;
    }
    return doc;
  }

  private trimHistory(s: Session) {
    while (s.undo.length > MAX_UNDO) s.undo.shift();
    if (s.undo.length % 16 === 0) {
      while (s.undo.length > 8 && D.celBytes([s.doc, ...s.undo.map((u) => u.doc)]) > MAX_UNDO_BYTES) s.undo.splice(0, 8);
    }
  }

  undo() {
    if (this.endEditWithoutCommit()) return;
    const s = this.s, e = s.undo.pop();
    if (!e) return;
    s.redo.push({ doc: s.doc, label: e.label });
    this.restore(s, e.doc);
    this.toast(`Undid: ${e.label}`);
  }

  redo() {
    if (this.endEditWithoutCommit()) return;
    const s = this.s, e = s.redo.pop();
    if (!e) return;
    s.undo.push({ doc: s.doc, label: e.label });
    this.restore(s, e.doc);
    this.toast(`Redid: ${e.label}`);
  }

  private restore(s: Session, doc: Doc) {
    s.doc = doc;
    if (!D.layerById(doc, s.layerId)) s.layerId = D.layerRows(doc)[0]?.layer.id ?? doc.layers[0].id;
    const l = D.layerById(doc, s.layerId);
    if (l && !l.mask) s.editMask = false;
    s.frame = Math.min(s.frame, doc.frames.length - 1);
    s.range = null;
    this.invalidate(); this.notify();
  }

  // ---- the working surface

  editKey(): string { return this.s.editMask ? maskKey(this.s.layerId, this.frameId) : celKey(this.s.layerId, this.frameId); }

  /** Why the active layer cannot be painted on, or null when it can. */
  editBlock(): string | null {
    const l = this.layer;
    if (!l) return 'Select a layer first.';
    if (l.kind === 'group') return 'A group has no pixels of its own. Choose a layer inside it.';
    if (l.kind === 'reference') return 'Reference layers are not painted on.';
    if (l.locked) return `"${l.name}" is locked.`;
    if (!l.visible) return `"${l.name}" is hidden. Show it to paint on it.`;
    return null;
  }

  beginSurface(opts: { ignoreSelection?: boolean; ignoreAlphaLock?: boolean } = {}): Surface | null {
    const s = this.s;
    const block = this.editBlock();
    if (block) { this.toast(block); return null; }
    if (s.surface) return s.surface;
    s.surface = new Surface(this.doc.cels[this.editKey()], {
      canvasW: this.doc.width, canvasH: this.doc.height,
      selection: opts.ignoreSelection ? null : this.doc.selection,
      alphaLock: !opts.ignoreAlphaLock && !s.editMask && !!this.layer?.alphaLock,
    });
    return s.surface;
  }

  /** Commits the surface as one undo step. */
  endSurface(label: string, extra?: (d: Doc) => Doc) {
    const s = this.s, surf = s.surface;
    if (!surf) return;
    s.surface = null;
    const dirty = rectUnion(surf.touched, surf.dirty);
    if (!surf.changed() && !extra) { if (dirty) this.invalidate(dirty); this.notify(); return; }
    let doc = D.setCel(this.doc, this.editKey(), surf.finish());
    if (extra) doc = extra(doc);
    this.commit(label, doc, dirty && !extra ? dirty : 'full');
  }

  cancelSurface() {
    const s = this.s, surf = s.surface;
    if (!surf) return;
    s.surface = null;
    this.invalidate();
    this.notify();
  }

  /** The compositor's view of the current edit in progress. */
  override(): ComposeOptions['override'] {
    const s = this.s;
    if (s.surface) return { layerId: s.layerId, cel: s.surface.cel, isMask: s.editMask };
    if (s.preview) return { layerId: s.preview.layerId, cel: s.preview.cel };
    return undefined;
  }

  /** Canvas area to redraw now, and clears the request. */
  takeDirty(): Rect | 'full' | null {
    let d = this.pendingDirty;
    this.pendingDirty = null;
    const sd = this.s.surface?.takeDirty() ?? null;
    if (sd && d !== 'full') d = rectUnion(d, sd);
    return d;
  }

  /** Finishes anything half-done before another action. */
  endActiveEdit() {
    if (this.s.float) this.commitFloat();
    this.toolFinish?.();
    if (this.s.surface) this.endSurface('Edit');
  }

  /** Set by the tools module: commits a multi-step tool such as the polygon. */
  toolFinish: (() => void) | null = null;

  private endEditWithoutCommit(): boolean {
    if (this.s.float) { this.cancelFloat(); return true; }
    if (this.s.surface) { this.cancelSurface(); return true; }
    return false;
  }

  // ---- colours

  setFg(c: Pixel) { this.fg = this.snap(c); this.notify(); }
  setBg(c: Pixel) { this.bg = this.snap(c); this.notify(); }
  swapColors() { const t = this.fg; this.fg = this.bg; this.bg = t; this.notify(); }
  /** In indexed mode every drawing colour comes from the palette. */
  snap(c: Pixel): Pixel {
    const d = this.doc;
    if (d.colorMode !== 'indexed' || !d.palette.length) return c;
    return d.palette[nearestIndex(c, d.palette)];
  }

  setPalette(palette: Pixel[], label = 'Change palette') {
    let d: Doc = { ...this.doc, palette };
    if (d.colorMode === 'indexed') d = D.toIndexed(d);
    this.commit(label, d);
  }

  /** Editing an entry in indexed mode recolours the art that uses it. */
  setPaletteColor(i: number, c: Pixel) {
    const old = this.doc.palette[i];
    const palette = [...this.doc.palette];
    palette[i] = c;
    let d: Doc = { ...this.doc, palette };
    if (d.colorMode === 'indexed') d = D.mapPixels(d, (p) => (p === old ? c : p));
    this.commit('Edit palette colour', d);
    if (this.fg === old) this.fg = c;
    if (this.bg === old) this.bg = c;
    this.notify();
  }

  setColorMode(mode: 'rgba' | 'indexed') {
    if (mode === this.doc.colorMode) return;
    this.commit(mode === 'indexed' ? 'Convert to indexed' : 'Convert to RGB', mode === 'indexed' ? D.toIndexed(this.doc) : { ...this.doc, colorMode: 'rgba' });
    this.fg = this.snap(this.fg); this.bg = this.snap(this.bg);
    this.notify();
  }

  // ---- layers

  selectLayer(id: string) {
    this.endActiveEdit();
    this.s.layerId = id;
    if (!this.layer?.mask) this.s.editMask = false;
    this.notify();
  }

  addLayer(kind: LayerKind = 'image', name?: string, cel?: Cel) {
    this.endActiveEdit();
    const n = this.doc.layers.filter((l) => l.kind === kind).length + 1;
    const l = D.newLayer(name ?? (kind === 'group' ? `Group ${n}` : kind === 'reference' ? `Reference ${n}` : `Layer ${n}`), kind);
    if (kind === 'reference') l.opacity = 128;
    let d = D.addLayer(this.doc, l, this.s.layerId);
    if (cel) d = { ...d, cels: { ...d.cels, [celKey(l.id, this.frameId)]: cel } };
    this.s.layerId = l.id;
    this.s.editMask = false;
    this.commit(kind === 'group' ? 'Add group' : 'Add layer', d);
    return l.id;
  }

  removeLayer(id = this.s.layerId) {
    this.endActiveEdit();
    const d = D.removeLayer(this.doc, id);
    if (!d.layers.some((l) => l.kind !== 'group')) { this.toast('A sprite needs at least one layer.'); return; }
    this.commit('Delete layer', d);
  }

  duplicateLayer(id = this.s.layerId) {
    this.endActiveEdit();
    const r = D.duplicateLayer(this.doc, id);
    this.s.layerId = r.id;
    this.commit('Duplicate layer', r.doc);
  }

  moveLayer(id: string, delta: number) { this.endActiveEdit(); this.commit('Reorder layers', D.moveLayer(this.doc, id, delta)); }
  /** Drag and drop: onto a group puts it inside, onto a layer places it just above that layer. */
  dropLayer(id: string, target: string) {
    this.endActiveEdit();
    const t = D.layerById(this.doc, target);
    if (!t) return;
    this.commit('Reorder layers', t.kind === 'group' ? D.setLayerParent(this.doc, id, t.id) : D.placeLayerAbove(this.doc, id, t.id));
  }
  setLayerParent(id: string, parent: string | null) { this.endActiveEdit(); this.commit('Move layer to group', D.setLayerParent(this.doc, id, parent)); }

  /** A new empty layer carrying a live particle system (one undo step). */
  addParticleLayer(system: unknown, name = 'Particles') {
    return this.addLiveLayer('particles', { system }, name, this.layer?.id ?? null);
  }

  /** A new empty layer carrying one live effect (particles, weather), above `above` (null: at the top). One undo step. */
  addLiveLayer(effect: string, params: Record<string, unknown>, name: string, above: string | null, at: 'above' | 'bottom' = 'above') {
    this.endActiveEdit();
    const l = { ...D.newLayer(name), fx: [{ id: newId('fx'), effect, on: true, params }] };
    let d = D.addLayer(this.doc, l, above);
    if (at === 'bottom') d = { ...d, layers: [l, ...d.layers.filter((x) => x.id !== l.id)] };
    this.s.layerId = l.id;
    this.s.editMask = false;
    this.commit(effect === 'weather' ? 'Add weather layer' : 'Add particle layer', d);
    return l.id;
  }

  /**
   * Turns a layer's live particles into ordinary pixels on every frame (and removes the system from its stack), so they
   * can be retouched. Shaders stacked after the particles stay live.
   */
  /**
   * One layer's pixels on every frame with its shaders up to and including the first live `effect`, drawn alone (but
   * with the layers under it to bounce off and land on). Null when the layer has no such effect.
   */
  liveLayerFrames(id: string, effect: string): { images: Uint32Array[]; fxAt: number } | null {
    const d = this.doc;
    const at = d.layers.findIndex((l) => l.id === id), layer = d.layers[at];
    const fxAt = layer?.fx?.findIndex((f) => f.effect === effect && f.on) ?? -1;
    if (!layer || fxAt < 0) return null;
    const rect = { x: 0, y: 0, w: d.width, h: d.height };
    const under = { ...d, layers: d.layers.map((l, k) => (k >= at ? { ...l, visible: false } : l)) };
    const loopSeconds = d.frames.reduce((s, f) => s + f.duration / 1000, 0);
    let seconds = 0;
    const images = d.frames.map((fr, i) => {
      let img = D.celToBuffer(d.cels[celKey(id, fr.id)], rect);
      const ctx: EffectContext = { palette: d.palette, t: i / d.frames.length, frame: i, frames: d.frames.length, seconds, loopSeconds, below: composeFrame(under, i, { skipReference: true }),
        belowWhere: (keep) => layersBelow(d, id, i, keep), layerPixels: (lid) => layerPixels(d, lid, fr.id) };
      for (const f of layer.fx!.slice(0, fxAt + 1)) { const fe = effectById(f.effect); if (f.on && fe) img = fe.apply(img, d.width, d.height, f.params, ctx); }
      seconds += fr.duration / 1000;
      return img;
    });
    return { images, fxAt };
  }

  bakeParticles(id: string, effect: 'particles' | 'weather' | 'nodes' = 'particles') {
    this.endActiveEdit();
    let d = this.doc;
    const what = effect === 'weather' ? 'weather' : effect === 'nodes' ? 'node graph' : 'particles';
    const layer = d.layers.find((l) => l.id === id);
    const res = this.liveLayerFrames(id, effect);
    if (!layer || !res) { this.toast(`This layer has no ${what} to bake.`); return; }
    const { images, fxAt } = res;
    const cels = { ...d.cels };
    d.frames.forEach((fr, i) => {
      const c = D.trimToCel(images[i], d.width, d.height, 0, 0);
      const key = celKey(id, fr.id);
      if (c) cels[key] = c; else delete cels[key];
    });
    const rest = layer.fx!.filter((_, k) => k >= fxAt + 1);
    d = D.updateLayer({ ...d, cels }, id, { fx: rest.length ? rest : undefined, bakedFrom: effect === 'nodes' ? undefined : effect });
    if (d.colorMode === 'indexed') d = D.toIndexed(d);
    this.commit(`Bake ${what}`, d);
    this.toast(`Baked the ${what} on "${layer.name}" into ${d.frames.length} frame${d.frames.length === 1 ? '' : 's'} of pixels.`);
  }

  patchLayer(id: string, patch: Partial<Layer>, label = 'Change layer') {
    this.commit(label, D.updateLayer(this.doc, id, patch));
  }

  setBlend(id: string, blend: BlendMode) { this.patchLayer(id, { blend }, 'Change blend mode'); }

  addMask() {
    const l = this.layer;
    if (!l || l.kind !== 'image') { this.toast('Only image layers can have a mask.'); return; }
    this.patchLayer(l.id, { mask: true, maskEnabled: true }, 'Add layer mask');
    this.s.editMask = true;
    this.notify();
  }

  removeMask(apply: boolean) {
    const l = this.layer;
    if (!l?.mask) return;
    this.endActiveEdit();
    const cels = { ...this.doc.cels };
    for (const f of this.doc.frames) {
      const k = celKey(l.id, f.id), mk = maskKey(l.id, f.id);
      const c = cels[k], m = cels[mk];
      if (apply && c && m) {
        const data = new Uint32Array(c.data);
        for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
          const mx = c.x + x - m.x, my = c.y + y - m.y;
          if (mx < 0 || my < 0 || mx >= m.w || my >= m.h) continue;
          const i = y * c.w + x, a = data[i] >>> 24;
          const na = Math.round((a * (255 - (m.data[my * m.w + mx] >>> 24))) / 255);
          data[i] = na ? ((data[i] & 0xffffff) | (na << 24)) >>> 0 : 0;
        }
        const t = D.trimToCel(data, c.w, c.h, c.x, c.y, c.opacity);
        if (t) cels[k] = t; else delete cels[k];
      }
      delete cels[mk];
    }
    this.s.editMask = false;
    this.commit(apply ? 'Apply layer mask' : 'Delete layer mask', D.updateLayer({ ...this.doc, cels }, l.id, { mask: false }));
  }

  mergeDown() {
    this.endActiveEdit();
    const d = this.doc, l = this.layer;
    if (!l || l.kind !== 'image') return;
    const sibs = d.layers.filter((x) => x.parentId === l.parentId);
    const below = sibs[sibs.indexOf(l) - 1];
    if (!below || below.kind !== 'image') { this.toast('There is no image layer directly below to merge with.'); return; }
    const pair = (cl: Layer, patch: Partial<Layer>): Layer => ({ ...cl, ...patch, parentId: null, visible: true });
    const mini: Doc = { ...d, layers: [pair(below, { blend: 'normal', opacity: 255, clip: false }), pair(l, { clip: false })] };
    const cels = { ...d.cels };
    d.frames.forEach((f, i) => {
      const data = composeFrame(mini, i);
      const c = D.trimToCel(data, d.width, d.height, 0, 0);
      const k = celKey(below.id, f.id);
      if (c) cels[k] = c; else delete cels[k];
      delete cels[celKey(l.id, f.id)];
    });
    this.s.layerId = below.id;
    this.commit('Merge down', { ...d, cels, layers: d.layers.filter((x) => x !== l) });
  }

  flatten() {
    this.endActiveEdit();
    const d = this.doc;
    const flat = D.newLayer('Flattened');
    const cels: Record<string, Cel> = {};
    d.frames.forEach((f, i) => {
      const c = D.trimToCel(composeFrame(d, i, { skipReference: true }), d.width, d.height, 0, 0);
      if (c) cels[celKey(flat.id, f.id)] = c;
    });
    this.s.layerId = flat.id;
    this.s.editMask = false;
    this.commit('Flatten', { ...d, layers: [flat], cels });
  }

  // ---- frames

  setFrame(i: number) {
    const n = this.doc.frames.length;
    if (!n) return;
    const f = ((i % n) + n) % n;
    if (f === this.s.frame) return;
    this.endActiveEdit();
    this.s.frame = f;
    this.invalidate(); this.notify();
  }

  addFrame() { this.endActiveEdit(); const at = this.s.frame + 1; this.s.frame = at; this.commit('Add frame', D.insertFrame(this.doc, at)); }
  duplicateFrame(link = false) { this.endActiveEdit(); const at = this.s.frame; this.s.frame = at + 1; this.commit(link ? 'Duplicate frame (linked)' : 'Duplicate frame', D.duplicateFrame(this.doc, at, link)); }

  removeFrames() {
    this.endActiveEdit();
    const [a, b] = this.s.range ?? [this.s.frame, this.s.frame];
    if (b - a + 1 >= this.doc.frames.length) { this.toast('A sprite needs at least one frame.'); return; }
    let d = this.doc;
    for (let i = b; i >= a; i--) d = D.removeFrame(d, i);
    this.s.range = null;
    this.commit(a === b ? 'Delete frame' : 'Delete frames', d);
  }

  moveFrame(from: number, to: number) { this.endActiveEdit(); if (to < 0 || to >= this.doc.frames.length) return; this.s.frame = to; this.commit('Move frame', D.moveFrame(this.doc, from, to)); }

  setDuration(ms: number, range = this.s.range ?? [this.s.frame, this.s.frame] as [number, number]) {
    const frames = this.doc.frames.map((f, i) => (i >= range[0] && i <= range[1] ? { ...f, duration: Math.max(1, Math.round(ms)) } : f));
    this.commit('Change frame duration', { ...this.doc, frames });
  }

  addTag(from: number, to: number, name = 'Tag') {
    const colors = ['#e5683a', '#4e9fe0', '#6fbf5a', '#c76ad6', '#e0b13a', '#47c6b5'];
    const t: Tag = { id: newId('t'), name, from, to, dir: 'forward', repeat: 0, color: colors[this.doc.tags.length % colors.length] };
    this.commit('Add tag', { ...this.doc, tags: [...this.doc.tags, t] });
    return t;
  }
  patchTag(id: string, patch: Partial<Tag>) { this.commit('Change tag', { ...this.doc, tags: this.doc.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)) }); }
  removeTag(id: string) { this.commit('Delete tag', { ...this.doc, tags: this.doc.tags.filter((t) => t.id !== id) }); }

  placeCel(fromLayer: string, fromFrame: number, toLayer: string, toFrame: number, mode: 'move' | 'copy' | 'link') {
    this.endActiveEdit();
    const d = this.doc;
    this.commit(mode === 'move' ? 'Move cel' : mode === 'copy' ? 'Copy cel' : 'Link cel', D.placeCel(d, celKey(fromLayer, d.frames[fromFrame].id), celKey(toLayer, d.frames[toFrame].id), mode));
  }

  clearCel(layerId = this.s.layerId, frame = this.s.frame) {
    this.endActiveEdit();
    this.commit('Clear cel', D.setCel(this.doc, celKey(layerId, this.doc.frames[frame].id), null));
  }

  unlinkCel(layerId = this.s.layerId, frame = this.s.frame) {
    const k = celKey(layerId, this.doc.frames[frame].id);
    const c = this.doc.cels[k];
    if (c) this.commit('Unlink cel', { ...this.doc, cels: { ...this.doc.cels, [k]: { ...c, id: newId('c') } } });
  }

  // ---- motion tweens

  /** Motion chosen in the Animate panel. */
  motionPick: string | null = null;
  /** Set by the main window: shows a panel if it is closed or folded. */
  showPanel: ((id: string) => void) | null = null;

  /** The motion the Animate panel works on: the picked one if it is on this layer, else one covering this frame. */
  get motion(): M.Motion | undefined {
    const d = this.doc, list = M.motionsOnLayer(d, this.s.layerId);
    const covers = (m: M.Motion) => { const r = M.motionRange(d, m); return !!r && this.s.frame >= r[0] && this.s.frame <= r[1]; };
    const picked = list.find((m) => m.id === this.motionPick);
    // A tween that was chosen stays open off its range, so a key there extends it.
    if (picked) return picked;
    return list.find((m) => m.editing) ?? list.find(covers);
  }

  newMotion(from: number, to: number) {
    this.endActiveEdit();
    const block = this.editBlock();
    if (block) { this.toast(block); return; }
    if (from === to) { this.toast('A tween needs at least two frames. Add frames, or choose a longer range.'); return; }
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const clash = M.motionsOnLayer(this.doc, this.s.layerId).find((m) => { const r = M.motionRange(this.doc, m); return r && r[0] <= hi && r[1] >= lo; });
    if (clash) { this.toast(`"${clash.name}" already animates some of these frames on this layer. Use another layer, or other frames.`); return; }
    const r = M.createMotion(this.doc, this.s.layerId, this.s.frame, from, to, `Motion ${M.motionsOf(this.doc).length + 1}`);
    if (!r) { this.toast('Draw something on this frame first: the tween moves the art on the current frame.'); return; }
    this.motionPick = r.id;
    this.commit('New tween', r.doc);
    this.showPanel?.('animate');
    this.toast(`Tween over frames ${Math.min(from, to) + 1} to ${Math.max(from, to) + 1}. Change a value on another frame to add a key.`);
  }

  /** Sets a property at the current frame, adding a key there if there isn't one. */
  setMotionValue(prop: M.Prop, v: number) {
    const m = this.motion;
    if (!m || m.editing) return;
    this.commit('Set key', M.setKey(this.doc, m.id, prop, this.s.frame, v));
  }

  toggleMotionKey(prop: M.Prop) {
    const m = this.motion;
    if (!m || m.editing) return;
    const d = this.doc, f = d.frames[this.s.frame].id;
    const has = (m.tracks[prop] ?? []).some((k) => k.f === f);
    if (has) this.commit('Delete key', M.removeKey(d, m.id, prop, this.s.frame));
    else this.commit('Add key', M.setKey(d, m.id, prop, this.s.frame, M.sampleMotion(d, m, this.s.frame)[prop]));
  }

  setMotionEase(ease: M.Ease, prop?: M.Prop) {
    const m = this.motion;
    if (m) this.commit('Change easing', M.setEase(this.doc, m.id, this.s.frame, ease, prop));
  }

  patchMotion(patch: Partial<M.Motion>, label = 'Change tween') {
    const m = this.motion;
    if (m) this.commit(label, M.updateMotion(this.doc, m.id, patch));
  }

  removeMotion(keepFrames: boolean) {
    const m = this.motion;
    if (!m) return;
    this.endActiveEdit();
    if (m.editing) this.endSourceEdit();
    this.commit(keepFrames ? 'Convert tween to frames' : 'Delete tween', M.removeMotion(this.doc, m.id, keepFrames));
    this.motionPick = null;
  }

  /** Lays the untouched source art out on the current frame to paint on. `endSourceEdit` takes it back. */
  beginSourceEdit() {
    const m = this.motion;
    if (!m || m.editing) return;
    this.endActiveEdit();
    const d = this.doc, f = d.frames[this.s.frame].id, k = celKey(m.layerId, f);
    const src = d.cels[M.srcKey(m.layerId, m.id)];
    const cels = { ...d.cels };
    if (src) cels[k] = { ...src, id: newId('c'), gen: undefined };
    const motions = M.motionsOf(d).map((x) => (x.id === m.id ? { ...x, editing: f } : x));
    this.commit('Edit tween art', { ...d, cels, motions });
    this.toast('This frame now shows the original art. Paint on it, then press Done in the Animate panel.');
  }

  endSourceEdit() {
    const m = M.motionsOf(this.doc).find((x) => x.editing && x.layerId === this.s.layerId) ?? M.motionsOf(this.doc).find((x) => x.editing);
    if (!m) return;
    this.endActiveEdit();
    const d = this.doc, k = celKey(m.layerId, m.editing!);
    const art = d.cels[k];
    const cels = { ...d.cels };
    delete cels[k];
    if (art) cels[M.srcKey(m.layerId, m.id)] = { ...art, id: newId('c') };
    const motions = M.motionsOf(d).map((x) => (x.id === m.id ? { ...x, editing: undefined } : x));
    this.commit('Update tween art', M.bakeMotion({ ...d, cels, motions }, m.id).doc);
  }

  resetCelToTween(layerId = this.s.layerId, frame = this.s.frame) {
    this.endActiveEdit();
    this.commit('Reset frame to tween', M.resetToTween(this.doc, layerId, frame));
  }

  // ---- playback

  /** The frames playback runs over: the tag under the current frame when there is one. */
  playRange(): { from: number; to: number; dir: LoopDir; repeat: number } {
    const d = this.doc;
    const tag = this.loopRange === 'tag' ? d.tags.find((t) => this.s.frame >= t.from && this.s.frame <= t.to) : undefined;
    return tag ? { from: tag.from, to: tag.to, dir: tag.dir, repeat: tag.repeat } : { from: 0, to: d.frames.length - 1, dir: 'forward', repeat: 0 };
  }

  play() {
    if (this.playing || this.doc.frames.length < 2) return;
    this.endActiveEdit();
    this.playing = true;
    const r = this.playRange();
    this.playState = { dir: r.dir === 'reverse' || r.dir === 'pingpong-reverse' ? -1 : 1, last: performance.now(), left: this.doc.frames[this.s.frame].duration, repeats: 0 };
    const tick = (now: number) => {
      if (!this.playing) return;
      const st = this.playState;
      st.left -= now - st.last;
      st.last = now;
      let guard = 0;
      while (st.left <= 0 && this.playing && guard++ < 512) {
        this.stepPlayback();
        st.left += this.doc.frames[this.s.frame].duration;
      }
      this.notify();
      requestAnimationFrame(tick);
    };
    this.notify();
    requestAnimationFrame(tick);
  }

  private stepPlayback() {
    const r = this.playRange(), st = this.playState, s = this.s;
    let next = s.frame + st.dir;
    if (r.dir === 'pingpong' || r.dir === 'pingpong-reverse') {
      if (next > r.to || next < r.from) { st.dir = -st.dir; next = r.from === r.to ? r.from : s.frame + st.dir; }
    } else if (next > r.to) next = r.from;
    else if (next < r.from) next = r.to;
    s.frame = next;
    this.invalidate();
  }

  stop() { if (this.playing) { this.playing = false; this.notify(); } }
  togglePlay() { if (this.playing) this.stop(); else this.play(); }

  // ---- selection

  setSelection(sel: Selection | null, label = 'Change selection') {
    this.commit(label, { ...this.doc, selection: sel });
  }
  selectAll() { this.endActiveEdit(); this.setSelection(selectAll(this.doc.width, this.doc.height), 'Select all'); }
  deselect() { this.endActiveEdit(); if (this.doc.selection) this.setSelection(null, 'Deselect'); }
  invertSelection() { this.endActiveEdit(); this.setSelection(invertSelection(this.doc.selection, this.doc.width, this.doc.height), 'Invert selection'); }
  growSelection(n: number) { if (this.doc.selection) { this.endActiveEdit(); this.setSelection(growSelection(this.doc.selection, n, this.doc.width, this.doc.height), n > 0 ? 'Expand selection' : 'Contract selection'); } }

  applySelectionMask(mask: Uint8Array, mode: SelectMode) {
    const d = this.doc;
    this.setSelection(combine(d.selection, mask, d.width, d.height, mode));
  }

  deleteSelected() {
    const s = this.s;
    if (s.float) { this.deleteFloat(); return; }
    const surf = this.beginSurface();
    if (!surf) return;
    const { width: W, height: H, selection } = this.doc;
    const b = selection ?? { x: 0, y: 0, w: W, h: H };
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) surf.erase(x, y);
    this.endSurface('Delete');
  }

  fillSelected(color = this.fg) {
    const surf = this.beginSurface();
    if (!surf) return;
    const { width: W, height: H, selection } = this.doc;
    const b = selection ?? { x: 0, y: 0, w: W, h: H };
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) surf.paint(x, y, color);
    this.endSurface('Fill');
  }

  // ---- clipboard

  /** Pixels of the current selection (or the whole cel) on the active layer. */
  grabPixels(): { w: number; h: number; x: number; y: number; data: Uint32Array } | null {
    const d = this.doc;
    const key = celKey(this.s.layerId, this.frameId);
    const c = d.cels[key];
    if (!c) return null;
    const sel = d.selection;
    if (!sel) return { x: c.x, y: c.y, w: c.w, h: c.h, data: c.data.slice() };
    const data = D.celToBuffer(c, sel);
    for (let y = 0; y < sel.h; y++) for (let x = 0; x < sel.w; x++) if (!sel.mask[y * sel.w + x]) data[y * sel.w + x] = 0;
    return { x: sel.x, y: sel.y, w: sel.w, h: sel.h, data };
  }

  copy() {
    this.endActiveEdit();
    const g = this.grabPixels();
    if (!g) { this.toast('Nothing to copy on this layer.'); return false; }
    this.clip = g;
    this.toast(`Copied ${g.w}×${g.h}.`);
    return true;
  }

  cut() { if (this.copy()) this.deleteSelected(); }

  paste(asNewLayer = false, clip = this.clip) {
    if (!clip) { this.toast('The clipboard is empty.'); return; }
    this.endActiveEdit();
    if (asNewLayer) this.addLayer('image');
    const inView = clip.x >= 0 && clip.y >= 0 && clip.x + clip.w <= this.doc.width && clip.y + clip.h <= this.doc.height;
    const cx = inView ? clip.x + clip.w / 2 : Math.floor(this.doc.width / 2), cy = inView ? clip.y + clip.h / 2 : Math.floor(this.doc.height / 2);
    this.startFloat({ w: clip.w, h: clip.h, data: clip.data.slice() }, { cx, cy, sw: clip.w, sh: clip.h, angle: 0 }, { isPaste: true, label: 'Paste', hadSelection: false });
    this.setTool('transform');
  }

  // ---- floating pixels: move, scale and rotate with live preview

  private startFloat(src: Bitmap, place: Placement, o: { isPaste: boolean; label: string; hadSelection: boolean }) {
    const surf = this.beginSurface({ ignoreSelection: true, ignoreAlphaLock: true });
    if (!surf) return false;
    this.s.float = { src, big: null, place, start: { ...place }, ...o };
    this.renderFloat();
    return true;
  }

  /** Lifts the selected pixels (or the whole cel) off the layer. */
  liftFloat(label = 'Transform'): boolean {
    const s = this.s;
    if (s.float) return true;
    const block = this.editBlock();
    if (block) { this.toast(block); return false; }
    if (s.editMask) { this.toast('Transforms work on layer pixels. Switch from the mask to the layer first.'); return false; }
    const g = this.grabPixels();
    const sel = this.doc.selection;
    if (!g && !sel) { this.toast('Nothing on this layer to transform.'); return false; }
    const bmp: Bitmap = g ? { w: g.w, h: g.h, data: g.data } : { w: sel!.w, h: sel!.h, data: new Uint32Array(sel!.w * sel!.h) };
    const box = g ?? sel!;
    const surf = this.beginSurface({ ignoreSelection: true, ignoreAlphaLock: true })!;
    if (sel) { for (let y = 0; y < sel.h; y++) for (let x = 0; x < sel.w; x++) if (sel.mask[y * sel.w + x]) surf.erase(sel.x + x, sel.y + y); }
    else surf.buf.fill(0);
    if (!sel) surf.dirty = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    surf.rebase();
    const place = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, sw: box.w, sh: box.h, angle: 0 };
    s.float = { src: bmp, big: null, place, start: { ...place }, hadSelection: !!sel, isPaste: false, label };
    this.renderFloat();
    return true;
  }

  renderFloat() {
    const s = this.s, f = s.float, surf = s.surface;
    if (!f || !surf) return;
    surf.reset();
    const turned = Math.abs(f.place.angle) > 1e-6 && this.rotateQuality === 'smooth-edges';
    if (turned && !f.big) f.big = upscale8(f.src);
    renderPlaced(f.src, f.place, (x, y, c) => surf.paint(x, y, c), turned ? f.big! : f.src, turned ? 8 : 1);
    const b = placedBounds(f.place);
    this.invalidate(rectUnion(b, surf.takeDirty()) ?? 'full');
    this.notify();
  }

  commitFloat() {
    const s = this.s, f = s.float;
    if (!f) return;
    s.float = null;
    const d = this.doc;
    let selection = d.selection;
    if (f.hadSelection) {
      const m = new Uint8Array(d.width * d.height);
      renderPlaced(f.src, f.place, (x, y) => { if (x >= 0 && y >= 0 && x < d.width && y < d.height) m[y * d.width + x] = 255; });
      selection = fromMask(m, { x: 0, y: 0, w: d.width, h: d.height });
    }
    this.endSurface(f.label, f.hadSelection ? (nd) => ({ ...nd, selection }) : undefined);
  }

  cancelFloat() {
    const s = this.s;
    if (!s.float) return;
    s.float = null;
    this.cancelSurface();
  }

  deleteFloat() {
    const s = this.s, f = s.float, surf = s.surface;
    if (!f || !surf) return;
    surf.reset();
    s.float = null;
    this.endSurface('Delete', (nd) => ({ ...nd, selection: null }));
  }

  // ---- whole-sprite operations

  applyToSprite(label: string, fn: (d: Doc) => Doc) { this.endActiveEdit(); this.commit(label, fn(this.doc)); this.sym = { ...this.sym, cx: this.doc.width / 2, cy: this.doc.height / 2 }; this.notify(); }

  cropToSelection() {
    const sel = this.doc.selection;
    if (!sel) { this.toast('Select an area to crop to first.'); return; }
    this.applyToSprite('Crop', (d) => D.cropTo(d, sel));
  }

  trimCanvas() {
    const b = D.contentBounds(this.doc);
    if (!b) { this.toast('The sprite is empty.'); return; }
    this.applyToSprite('Trim', (d) => D.cropTo(d, rectIntersect(b, { x: 0, y: 0, w: d.width, h: d.height }) ?? b));
  }

  /** Runs an effect on the current cel, or on every frame of the layer. */
  applyEffect(id: string, params: Record<string, any>, allFrames: boolean) {
    const fx = effectById(id);
    if (!fx) return;
    const block = this.editBlock();
    if (block) { this.toast(block); return; }
    this.endActiveEdit();
    const d = this.doc;
    let out = d;
    const ctx: EffectContext = { palette: d.palette };
    const canvas = { x: 0, y: 0, w: d.width, h: d.height };
    const frames = allFrames ? d.frames : [d.frames[this.s.frame]];
    const seen = new Set<Cel>();
    for (const f of frames) {
      const k = celKey(this.s.layerId, f.id);
      const c = out.cels[k];
      if (c && seen.has(c)) continue;
      const src = D.celToBuffer(c, canvas);
      const res = fx.apply(src, d.width, d.height, params, ctx);
      if (d.selection) for (let i = 0; i < res.length; i++) if (!isSelected(d.selection, i % d.width, Math.floor(i / d.width))) res[i] = src[i];
      const nc = D.trimToCel(res, d.width, d.height, 0, 0, c?.opacity ?? 255);
      if (nc) seen.add(nc);
      out = D.setCel(out, k, nc);
    }
    if (d.colorMode === 'indexed') out = D.toIndexed(out);
    this.commit(fx.name, out);
  }

  /**
   * Runs an effect over a run of frames with its settings moving from `start` to `end` along an easing curve, and its
   * time input advancing so waves and other cyclic effects loop. With `fromCurrent`, the art on the current frame is the
   * input for every frame (a still flag becomes a waving one); otherwise each frame's own art is used.
   */
  applyEffectAnimated(id: string, start: Record<string, any>, end: Record<string, any>, ease: M.Ease, from: number, to: number, fromCurrent: boolean) {
    const fx = effectById(id);
    if (!fx) return;
    const block = this.editBlock();
    if (block) { this.toast(block); return; }
    this.endActiveEdit();
    const d = this.doc;
    const canvas = { x: 0, y: 0, w: d.width, h: d.height };
    const base = d.cels[celKey(this.s.layerId, this.frameId)];
    if (fromCurrent && !base) { this.toast('This frame of the layer is empty.'); return; }
    const n = to - from + 1, curve = M.easeFn(ease);
    let out = d, changed = 0;
    for (let i = from; i <= to; i++) {
      const k = celKey(this.s.layerId, d.frames[i].id);
      const c = fromCurrent ? base : d.cels[k];
      if (!c) continue;
      const u = n > 1 ? (i - from) / (n - 1) : 0;
      const params = lerpParams(fx, start, end, curve(u));
      const src = D.celToBuffer(c, canvas);
      const res = fx.apply(src, d.width, d.height, params, { palette: d.palette, t: (i - from) / n });
      if (d.selection) for (let j = 0; j < res.length; j++) if (!isSelected(d.selection, j % d.width, Math.floor(j / d.width))) res[j] = src[j];
      // Each frame gets its own cel: linked cels would all show the last result.
      out = D.setCel(out, k, D.trimToCel(res, d.width, d.height, 0, 0, c.opacity), false);
      changed++;
    }
    if (!changed) { this.toast('No art on this layer in those frames.'); return; }
    if (d.colorMode === 'indexed') out = D.toIndexed(out);
    this.commit(`${fx.name} (animated)`, out);
    this.toast(`${fx.name} applied to ${changed} frame${changed === 1 ? '' : 's'}.`);
  }

  // ---- lighting (Phase 4)

  get lighting(): Lt.Lighting { return this.doc.lighting ?? Lt.defaultLighting(this.doc.width, this.doc.height); }

  patchLighting(l: Lt.Lighting, label = 'Change lighting') {
    if (JSON.stringify(l) === JSON.stringify(this.doc.lighting)) return;
    this.commit(label, { ...this.doc, lighting: l });
  }

  /** A layer's pixels on a frame, holding its latest drawing on frames where it has none. */
  heldBuffer(layerId: string, frame: number): Uint32Array | null {
    const d = this.doc, canvas = { x: 0, y: 0, w: d.width, h: d.height };
    let c = d.cels[celKey(layerId, d.frames[frame].id)];
    for (let i = frame - 1; !c && i >= 0; i--) c = d.cels[celKey(layerId, d.frames[i].id)];
    return c ? D.celToBuffer(c, canvas) : null;
  }

  /** The art lighting applies to on a frame: every visible layer except the normal map. */
  lightBase(frame: number): Uint32Array {
    const d = this.doc, nl = this.lighting.normalLayer;
    const view = nl ? { ...d, layers: d.layers.map((l) => (l.id === nl ? { ...l, visible: false } : l)) } : d;
    return composeFrame(view, frame, { skipReference: true });
  }

  /** Builds normal maps from the visible layers (each its own shape) on every frame, onto the normal layer. */
  generateNormals() {
    this.endActiveEdit();
    let d = this.doc;
    let l = this.lighting;
    const shapes = D.layerRows(d).map((r) => r.layer).filter((x) => x.kind === 'image' && x.visible && x.id !== l.normalLayer).reverse();
    if (!shapes.length) { this.toast('Nothing visible to make normals from.'); return; }
    let nl = l.normalLayer ? D.layerById(d, l.normalLayer) : undefined;
    if (!nl) {
      nl = { ...D.newLayer('Normals'), visible: false };
      d = D.addLayer(d, nl);
      l = { ...l, normalLayer: nl.id };
    }
    const cels = { ...d.cels };
    for (let f = 0; f < d.frames.length; f++) {
      const imgs = shapes.map((x) => this.heldBuffer(x.id, f)).filter((x): x is Uint32Array => !!x);
      const height = Lt.heightFrom(imgs, d.width, d.height, l.normals);
      const n = Lt.normalsFromHeight(height, imgs, d.width, d.height, l.normals.strength);
      const c = D.trimToCel(n, d.width, d.height, 0, 0);
      const k = celKey(nl.id, d.frames[f].id);
      if (c) cels[k] = c; else delete cels[k];
    }
    this.commit('Generate normals', { ...d, cels, lighting: l });
    this.toast(`Normals made for ${d.frames.length} frame${d.frames.length === 1 ? '' : 's'} on "${nl.name}". It stays hidden; show it to paint on it.`);
  }

  /** The lit image of a frame. */
  litFrame(frame: number): Uint32Array {
    const d = this.doc, l = this.lighting;
    const normals = l.normalLayer ? this.heldBuffer(l.normalLayer, frame) : null;
    return Lt.shade({ base: this.lightBase(frame), normals, w: d.width, h: d.height, palette: d.palette }, l, Lt.lightsAt(d, l, frame));
  }

  /** Renders lit frames onto a new layer and hides the layers it was made from. */
  renderLit(from: number, to: number) {
    const imgs: Uint32Array[] = [];
    for (let i = from; i <= to; i++) imgs.push(this.litFrame(i));
    const nl = this.lighting.normalLayer;
    const hide = this.doc.layers.filter((x) => x.kind === 'image' && x.visible && x.id !== nl).map((x) => x.id);
    this.placeRendered(imgs, from === to ? 'Lit' : `Lit ${from + 1}–${to + 1}`, from, hide);
  }

  // ---- paper rig (Phase 3)

  /**
   * Each layer's pixels on a frame, for the rig renderer. A part with nothing drawn on that frame holds its most recent
   * drawing (or the next one, before its first), so a rig drawn once animates across every frame.
   */
  rigImages(frame = this.s.frame): Map<string, Rg.PartImage> {
    const d = this.doc, canvas = { x: 0, y: 0, w: d.width, h: d.height };
    const out = new Map<string, Rg.PartImage>();
    for (const l of d.layers) {
      if (l.kind !== 'image') continue;
      let c = d.cels[celKey(l.id, d.frames[frame].id)];
      for (let i = frame - 1; !c && i >= 0; i--) c = d.cels[celKey(l.id, d.frames[i].id)];
      for (let i = frame + 1; !c && i < d.frames.length; i++) c = d.cels[celKey(l.id, d.frames[i].id)];
      if (!c) continue;
      const box = rectIntersect(c, canvas);
      if (box) out.set(l.id, { data: D.celToBuffer(c, canvas), box });
    }
    return out;
  }

  makeRig() {
    this.endActiveEdit();
    const d = this.doc, imgs = this.rigImages();
    const layers = D.layerRows(d).map((r) => r.layer).filter((l) => l.kind === 'image' && l.visible && imgs.has(l.id)).reverse();
    if (!layers.length) { this.toast('Draw each body part on its own layer first: the rig hangs one layer on each bone.'); return; }
    const rig = Rg.rigFromLayers(layers, new Map(layers.map((l) => [l.id, imgs.get(l.id)!.box])), newId);
    this.commit('Make rig', { ...d, rig });
    this.toast(`Rig made: ${rig.parts.length} parts, each on its own bone. Set each bone's parent and joint in the Rig panel.`);
  }

  patchRig(rig: Rg.Rig, label = 'Change rig') {
    // A field that commits on typing and again on leaving would otherwise record the same change twice.
    if (JSON.stringify(rig) === JSON.stringify(this.doc.rig)) return;
    this.commit(label, { ...this.doc, rig });
  }

  removeRig() { this.commit('Delete rig', { ...this.doc, rig: undefined }); }

  /** Renders the rig over a run of frames (the keyed animation) onto a new layer, hiding the part layers. */
  renderRigFrames(from: number, to: number) {
    const rig = this.doc.rig;
    if (!rig) return;
    const imgs: Uint32Array[] = [];
    const cache = new Map();
    for (let i = from; i <= to; i++) imgs.push(Rg.renderRig(rig, Rg.poseAt(this.doc, rig, i), this.rigImages(i), this.doc.width, this.doc.height, cache).image);
    this.placeRendered(imgs, from === to ? 'Rig render' : `Rig render ${from + 1}–${to + 1}`, from, this.rigLayerIds());
  }

  /** A full turn of the camera around the character in its current pose, as frames from the current one. */
  renderTurnaround(frames: number, tilt = 0) {
    const rig = this.doc.rig;
    if (!rig) return;
    const base = Rg.poseAt(this.doc, rig, this.s.frame), imgs = this.rigImages(), cache = new Map();
    const shots = Rg.turnaround(frames).map((a) => Rg.renderRig(rig, { ...base, [Rg.VIEW_BONE]: { rx: base[Rg.VIEW_BONE].rx + tilt, ry: base[Rg.VIEW_BONE].ry + a, rz: 0 } }, imgs, this.doc.width, this.doc.height, cache).image);
    this.placeRendered(shots, `Turnaround (${frames})`, this.s.frame, this.rigLayerIds());
  }

  /** Part and view layers of the rig. */
  rigLayerIds(): string[] {
    const rig = this.doc.rig;
    return rig ? [...new Set(rig.parts.flatMap((p) => [p.layerId, ...Object.values(p.views).filter(Boolean) as string[]]))] : [];
  }

  /**
   * Puts rendered images (canvas-sized) on a new layer, one per frame from `start`, adding frames at the end if needed.
   * The result is ordinary pixels, editable like anything drawn by hand.
   */
  placeRendered(images: Uint32Array[], name: string, start = this.s.frame, hide: string[] = []) {
    this.endActiveEdit();
    let d = this.doc;
    // Layers the result replaces (a rig's parts) are hidden, so the render isn't drawn twice. Showing them is one click.
    if (hide.length) d = { ...d, layers: d.layers.map((l) => (hide.includes(l.id) ? { ...l, visible: false } : l)) };
    while (d.frames.length < start + images.length) d = D.insertFrame(d, d.frames.length);
    const layer = D.newLayer(name);
    d = D.addLayer(d, layer, this.layer?.id ?? null);
    const cels = { ...d.cels };
    images.forEach((img, i) => {
      const c = D.trimToCel(img, d.width, d.height, 0, 0);
      if (c) cels[celKey(layer.id, d.frames[start + i].id)] = c;
    });
    d = { ...d, cels };
    if (d.colorMode === 'indexed') d = D.toIndexed(d);
    this.s.layerId = layer.id;
    this.s.editMask = false;
    this.commit(images.length > 1 ? `Render ${images.length} frames` : 'Render frame', d);
    this.toast(images.length > 1 ? `Made ${images.length} frames on "${name}", from frame ${start + 1}.` : `Put the view on "${name}".`);
  }

  /** Replaces one colour with another across a chosen part of the sprite. */
  replaceColor(from: Pixel, to: Pixel, tolerance: number, scope: 'cel' | 'layer' | 'sprite') {
    this.endActiveEdit();
    const near = (p: number) => {
      if (p === from) return true;
      if (tolerance === 0) return false;
      return Math.abs((p & 255) - (from & 255)) <= tolerance && Math.abs(((p >>> 8) & 255) - ((from >>> 8) & 255)) <= tolerance
        && Math.abs(((p >>> 16) & 255) - ((from >>> 16) & 255)) <= tolerance && Math.abs((p >>> 24) - (from >>> 24)) <= tolerance;
    };
    const sel = this.doc.selection;
    const d = this.doc;
    const curKey = celKey(this.s.layerId, this.frameId);
    const cels = { ...d.cels };
    const done = new Map<Cel, Cel>();
    let changed = 0;
    for (const [k, c] of Object.entries(d.cels)) {
      if (k.endsWith(':m')) continue;
      if (scope === 'cel' && c !== d.cels[curKey]) continue;
      if (scope === 'layer' && !k.startsWith(this.s.layerId + ':')) continue;
      let n = done.get(c);
      if (!n) {
        const data = new Uint32Array(c.data);
        for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
          const i = y * c.w + x;
          if (data[i] >>> 24 === 0 && (from >>> 24) !== 0) continue;
          if (near(data[i]) && (!sel || isSelected(sel, c.x + x, c.y + y))) { data[i] = to; changed++; }
        }
        n = { ...c, data };
        done.set(c, n);
      }
      cels[k] = n;
    }
    if (!changed) { this.toast('No pixels had that colour.'); return; }
    this.commit('Replace colour', { ...d, cels });
    this.toast(`Replaced ${changed} pixel${changed === 1 ? '' : 's'}.`);
  }

  // ---- reading pixels

  /** Merged image of the current frame at a point (or the layer's own pixel). */
  sample(x: number, y: number, merged: boolean): Pixel {
    if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return 0;
    if (!merged) {
      const c = this.doc.cels[celKey(this.s.layerId, this.frameId)];
      if (!c || x < c.x || y < c.y || x >= c.x + c.w || y >= c.y + c.h) return 0;
      return c.data[(y - c.y) * c.w + (x - c.x)];
    }
    return composeRegion(this.doc, this.s.frame, { x, y, w: 1, h: 1 }, { override: this.override() })[0];
  }

  /** Canvas-sized pixels for flood-based tools. */
  sampleBuffer(all: boolean): Uint32Array {
    const d = this.doc;
    if (all) return composeFrame(d, this.s.frame);
    return D.celToBuffer(d.cels[celKey(this.s.layerId, this.frameId)], { x: 0, y: 0, w: d.width, h: d.height });
  }

  // Tools live in their own module and register here, which keeps this file free of pointer handling.
  setTool: (id: string) => void = (id) => { this.toolId = id; this.notify(); };
}

export const ed = new Editor();
export function useEd() { useSyncExternalStore(ed.subscribe, ed.getVersion); return ed; }

/** Mask helper shared by selection tools. */
export const emptyMask = (d: Doc) => new Uint8Array(d.width * d.height);
export { toFullMask };
