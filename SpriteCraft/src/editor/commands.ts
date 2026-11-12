// Every action in the app is a command with an id, a label and an optional shortcut. Menus and the keyboard both run
// commands, and the shortcut editor edits this one table.
import { effects } from '../core/effects';
// The shader library registers its effects on load, before the Effects menu is built.
import '../core/shaders';
import '../core/particles';
import '../core/weather';
import '../core/nodes';
import * as D from '../core/doc';
import { celKey, rectUnion } from '../core/types';
import { ed, loadPref, savePref, useEd } from './editor';
import { importAsLayer, openFile, openSequence, openTemplate, pickFiles, saveAseprite, saveProjectAs, IMAGE_ACCEPT, OPEN_ACCEPT } from './files';
import { saveCurrent } from './store';
import { flipFloat, nudge, rotateFloat, tools, activeTool } from './tools';
import { fitView, zoomStep } from '../ui/viewMath';

export interface Command { id: string; label: string; key?: string; run(): void; group: string }

export const commands: Command[] = [];
const byId = new Map<string, Command>();
const add = (group: string, id: string, label: string, key: string | undefined, run: () => void) => {
  const c = { id, label, key, run, group };
  commands.push(c);
  byId.set(id, c);
};
export const runCommand = (id: string) => byId.get(id)?.run();
export const commandById = (id: string) => byId.get(id);

// File
add('File', 'new', 'New sprite…', 'ctrl+n', () => ed.openDialog('new'));
add('File', 'template-iso', 'New isometric tileset (from base tiles)', undefined, () => { openTemplate('isometric-base-tileset.png', 'Isometric tileset', 32); });
add('File', 'open', 'Open file…', 'ctrl+o', async () => { const [f] = await pickFiles(OPEN_ACCEPT); if (f) openFile(f); });
add('File', 'open-sequence', 'Open images as frames…', undefined, async () => openSequence(await pickFiles(IMAGE_ACCEPT, true)));
add('File', 'open-sheet', 'Open sprite sheet…', undefined, async () => { const [f] = await pickFiles(IMAGE_ACCEPT); if (f) ed.openDialog('sheet', { file: f }); });
add('File', 'projects', 'My projects…', 'ctrl+shift+o', () => ed.openDialog('projects'));
add('File', 'save', 'Save', 'ctrl+s', () => { saveCurrent(); });
add('File', 'save-as', 'Save project file…', 'ctrl+shift+s', () => { saveProjectAs(); });
add('File', 'save-ase', 'Save as .aseprite…', undefined, () => { saveAseprite(); });
add('File', 'import-layer', 'Import image as layer…', undefined, async () => { const [f] = await pickFiles(IMAGE_ACCEPT); if (f) importAsLayer(f, 'image'); });
add('File', 'import-ref', 'Import reference image…', undefined, async () => { const [f] = await pickFiles(IMAGE_ACCEPT); if (f) importAsLayer(f, 'reference'); });
add('File', 'export', 'Export…', 'ctrl+e', () => { ed.endActiveEdit(); ed.openDialog('export'); });
add('File', 'send', 'Send to GameCraft / LogicCraft…', 'ctrl+shift+e', () => { ed.endActiveEdit(); ed.openDialog('send'); });
add('File', 'receive', 'Open from the Craft exchange folder…', undefined, () => ed.openDialog('receive'));

// Edit
add('Edit', 'undo', 'Undo', 'ctrl+z', () => ed.undo());
add('Edit', 'redo', 'Redo', 'ctrl+y', () => ed.redo());
add('Edit', 'redo2', 'Redo (alternate key)', 'ctrl+shift+z', () => ed.redo());
add('Edit', 'cut', 'Cut', 'ctrl+x', () => ed.cut());
add('Edit', 'copy', 'Copy', 'ctrl+c', () => { ed.copy(); });
add('Edit', 'paste', 'Paste', 'ctrl+v', () => ed.paste());
add('Edit', 'paste-layer', 'Paste as new layer', 'ctrl+shift+v', () => ed.paste(true));
add('Edit', 'delete', 'Delete', 'delete', () => ed.deleteSelected());
add('Edit', 'delete2', 'Delete (alternate key)', 'backspace', () => ed.deleteSelected());
add('Edit', 'fill', 'Fill with foreground colour', 'alt+backspace', () => ed.fillSelected());
add('Edit', 'flip-h', 'Flip horizontal', 'shift+h', () => flipFloat('h'));
add('Edit', 'flip-v', 'Flip vertical', 'shift+v', () => flipFloat('v'));
add('Edit', 'rot-90', 'Rotate 90° right', undefined, () => rotateFloat(Math.PI / 2));
add('Edit', 'rot-m90', 'Rotate 90° left', undefined, () => rotateFloat(-Math.PI / 2));
add('Edit', 'transform', 'Transform', 'ctrl+t', () => { if (ed.liftFloat()) ed.setTool('transform'); });
add('Edit', 'brush-from-sel', 'Set brush from selection', 'ctrl+b', () => {
  const g = ed.grabPixels();
  if (!g) { ed.toast('Select some pixels to make a brush.'); return; }
  ed.brush.custom = { w: g.w, h: g.h, data: g.data };
  ed.brush.anim = null;
  if (!tools.find((t) => t.id === ed.toolId)?.showsBrush) ed.setTool('pencil');
  ed.deselect();
  ed.toast(`Brush set (${g.w}×${g.h}). The options bar returns to a round or square brush.`);
});
add('Edit', 'brush-anim-from-sel', 'Set animated brush from selection (selected frames)', undefined, () => {
  // The selected frames, or the tag under this frame, or every frame: one brush image per frame with art.
  const d = ed.doc, s = ed.s;
  const tag = d.tags.find((t) => s.frame >= t.from && s.frame <= t.to);
  const [a, b] = s.range ?? (tag ? [tag.from, tag.to] : [0, d.frames.length - 1]);
  const sel = d.selection;
  let box = sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : null;
  if (!box) {
    for (let i = a; i <= b; i++) {
      const c = d.cels[celKey(s.layerId, d.frames[i].id)];
      if (c) box = rectUnion(box, { x: c.x, y: c.y, w: c.w, h: c.h });
    }
  }
  if (!box) { ed.toast('Nothing on this layer in those frames to make a brush from.'); return; }
  const frames: { w: number; h: number; data: Uint32Array }[] = [];
  for (let i = a; i <= b; i++) {
    const data = D.celToBuffer(d.cels[celKey(s.layerId, d.frames[i].id)], box);
    if (sel) for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) if (!sel.mask[y * sel.w + x]) data[y * box.w + x] = 0;
    if (data.some((p) => p >>> 24)) frames.push({ w: box.w, h: box.h, data });
  }
  if (frames.length < 2) { ed.toast('An animated brush needs art on at least two frames. Shift-click frames to choose them.'); return; }
  ed.brush = { ...ed.brush, custom: frames[0], anim: frames };
  if (!tools.find((t) => t.id === ed.toolId)?.showsBrush) ed.setTool('pencil');
  ed.deselect();
  ed.toast(`Animated brush set: ${frames.length} images of ${box.w}×${box.h}.`);
});
add('Edit', 'pattern-from-sel', 'Set pattern from selection', undefined, () => {
  const g = ed.grabPixels();
  if (!g) { ed.toast('Select some pixels to make a pattern.'); return; }
  ed.brush.pattern = { w: g.w, h: g.h, data: g.data };
  ed.setTool('pattern');
  ed.deselect();
  ed.toast(`Pattern set (${g.w}×${g.h}).`);
});
add('Edit', 'shortcuts', 'Keyboard shortcuts…', undefined, () => ed.openDialog('shortcuts'));

// Select
add('Select', 'select-all', 'Select all', 'ctrl+a', () => ed.selectAll());
add('Select', 'deselect', 'Deselect', 'ctrl+d', () => ed.deselect());
add('Select', 'invert', 'Invert', 'ctrl+shift+i', () => ed.invertSelection());
add('Select', 'grow', 'Expand by 1', undefined, () => ed.growSelection(1));
add('Select', 'shrink', 'Contract by 1', undefined, () => ed.growSelection(-1));

// Sprite
add('Sprite', 'canvas-size', 'Canvas size…', undefined, () => ed.openDialog('canvas'));
add('Sprite', 'scale', 'Scale sprite…', undefined, () => ed.openDialog('scale'));
add('Sprite', 'crop', 'Crop to selection', undefined, () => ed.cropToSelection());
add('Sprite', 'trim', 'Trim empty space', undefined, () => ed.trimCanvas());
add('Sprite', 'rotate-90', 'Rotate sprite 90° right', undefined, () => ed.applyToSprite('Rotate sprite', (d) => D.rotateSprite(d, 1)));
add('Sprite', 'rotate-270', 'Rotate sprite 90° left', undefined, () => ed.applyToSprite('Rotate sprite', (d) => D.rotateSprite(d, 3)));
add('Sprite', 'rotate-180', 'Rotate sprite 180°', undefined, () => ed.applyToSprite('Rotate sprite', (d) => D.rotateSprite(d, 2)));
add('Sprite', 'flip-sprite-h', 'Flip sprite horizontal', undefined, () => ed.applyToSprite('Flip sprite', (d) => D.flipSprite(d, 'h')));
add('Sprite', 'flip-sprite-v', 'Flip sprite vertical', undefined, () => ed.applyToSprite('Flip sprite', (d) => D.flipSprite(d, 'v')));
add('Sprite', 'mode-rgb', 'Colour mode: RGB', undefined, () => ed.setColorMode('rgba'));
add('Sprite', 'mode-indexed', 'Colour mode: Indexed (locked to palette)', undefined, () => ed.setColorMode('indexed'));
add('Sprite', 'replace-color', 'Replace colour…', undefined, () => ed.openDialog('replace'));
add('Sprite', 'rig', 'Rig: turn a character in 3D…', 'ctrl+shift+3', () => ed.showPanel?.('rig'));
add('Sprite', 'lighting', 'Lighting: normal maps and lights…', 'ctrl+shift+4', () => ed.showPanel?.('light'));
add('Sprite', 'shaders', 'Shaders: live effects and water…', 'ctrl+shift+5', () => ed.showPanel?.('shaders'));
add('Sprite', 'particles', 'Particles: fire, sparks, magic…', 'ctrl+shift+6', () => ed.showPanel?.('particles'));
add('Sprite', 'weather', 'Weather: rain and snow…', 'ctrl+shift+7', () => ed.showPanel?.('weather'));
add('Sprite', 'nodes', 'Node editor…', 'ctrl+shift+8', () => ed.showPanel?.('nodes'));
add('View', 'performance', 'Performance…', undefined, () => ed.showPanel?.('perf'));
add('View', 'tutorials', 'Tutorials…', undefined, () => ed.showPanel?.('tutorials'));
add('Sprite', 'rename', 'Rename sprite…', undefined, () => ed.openDialog('rename'));

// Layer
add('Layer', 'layer-new', 'New layer', 'ctrl+shift+n', () => ed.addLayer());
add('Layer', 'layer-group', 'New group', undefined, () => ed.addLayer('group'));
add('Layer', 'layer-dup', 'Duplicate layer', 'ctrl+j', () => ed.duplicateLayer());
add('Layer', 'layer-del', 'Delete layer', undefined, () => ed.removeLayer());
add('Layer', 'merge', 'Merge down', 'ctrl+m', () => ed.mergeDown());
add('Layer', 'flatten', 'Flatten', undefined, () => ed.flatten());
add('Layer', 'mask-add', 'Add layer mask', undefined, () => ed.addMask());
add('Layer', 'mask-apply', 'Apply layer mask', undefined, () => ed.removeMask(true));
add('Layer', 'mask-del', 'Delete layer mask', undefined, () => ed.removeMask(false));

// Frame
add('Frame', 'frame-new', 'New frame', 'alt+n', () => ed.addFrame());
add('Frame', 'frame-dup', 'Duplicate frame', 'alt+d', () => ed.duplicateFrame());
add('Frame', 'frame-link', 'Duplicate frame (linked cels)', 'alt+shift+d', () => ed.duplicateFrame(true));
add('Frame', 'frame-del', 'Delete frame', 'alt+delete', () => ed.removeFrames());
add('Frame', 'frame-prev', 'Previous frame', ',', () => ed.setFrame(ed.s.frame - 1));
add('Frame', 'frame-next', 'Next frame', '.', () => ed.setFrame(ed.s.frame + 1));
add('Frame', 'frame-first', 'First frame', 'home', () => ed.setFrame(0));
add('Frame', 'frame-last', 'Last frame', 'end', () => ed.setFrame(ed.doc.frames.length - 1));
add('Frame', 'play', 'Play / stop', 'enter', () => {
  // Enter finishes a transform or polygon when one is under way, and otherwise plays.
  if (ed.s.float) { ed.commitFloat(); return; }
  if (ed.toolFinish) { ed.toolFinish(); return; }
  ed.togglePlay();
});
add('Frame', 'onion', 'Onion skin', 'ctrl+shift+k', () => { ed.onion = { ...ed.onion, on: !ed.onion.on }; savePref('onion', ed.onion); ed.invalidate(); ed.notify(); });
add('Frame', 'tag-new', 'New tag from selected frames', undefined, () => {
  const [a, b] = ed.s.range ?? [ed.s.frame, ed.s.frame];
  const t = ed.addTag(a, b, `Tag ${ed.doc.tags.length + 1}`);
  ed.openDialog('tag', { id: t.id });
});
add('Frame', 'tween-new', 'New tween from this frame', 'ctrl+alt+t', () => {
  const [a, b] = ed.s.range ?? [ed.s.frame, ed.doc.frames.length - 1];
  ed.newMotion(a, b);
});
add('Frame', 'tween-reset', 'Reset frame to the tween', undefined, () => ed.resetCelToTween());
add('Frame', 'tween-panel', 'Animate panel', undefined, () => ed.showPanel?.('animate'));

// View
add('View', 'zoom-in', 'Zoom in', '=', () => zoomStep(1));
add('View', 'zoom-out', 'Zoom out', '-', () => zoomStep(-1));
add('View', 'zoom-fit', 'Fit to window', 'ctrl+0', () => fitView());
add('View', 'swap', 'Swap colours', 'x', () => ed.swapColors());
add('View', 'grid-pixel', 'Pixel grid', "ctrl+'", () => patchGrid({ pixelGrid: !ed.doc.grid.pixelGrid }));
add('View', 'grid-tile', 'Tile grid', 'ctrl+shift+g', () => patchGrid({ showTile: !ed.doc.grid.showTile }));
add('View', 'grid-iso', 'Isometric grid', undefined, () => patchGrid({ iso: ed.doc.grid.iso === 'iso' ? 'off' : 'iso' }));
add('View', 'sym-x', 'Mirror left and right', undefined, () => { ed.sym = { ...ed.sym, x: !ed.sym.x }; ed.notify(); });
add('View', 'sym-y', 'Mirror top and bottom', undefined, () => { ed.sym = { ...ed.sym, y: !ed.sym.y }; ed.notify(); });
add('View', 'brush-up', 'Larger brush', ']', () => setBrush(ed.brush.size + 1));
add('View', 'brush-down', 'Smaller brush', '[', () => setBrush(ed.brush.size - 1));
add('View', 'about', "What's in this version", 'f1', () => ed.openDialog('about'));

export const setBrush = (size: number) => { ed.brush = { ...ed.brush, size: Math.max(1, Math.min(64, size)) }; savePref('brush', { ...ed.brush, custom: null, pattern: null, anim: null }); ed.notify(); };
const patchGrid = (g: Partial<typeof ed.doc.grid>) => { ed.s.doc = { ...ed.doc, grid: { ...ed.doc.grid, ...g } }; ed.notify(); };

// Effects are menu items by being registered, whoever registered them.
export function registerEffectCommands() {
  for (const fx of effects()) if (!fx.liveOnly) add('Effects', 'fx-' + fx.id, fx.name + (fx.params.length ? '…' : ''), undefined, () => ed.openDialog('effect', { id: fx.id }));
}

// ---- Shortcuts

/** The user's changes on top of the defaults. An empty string means no key. */
let userKeys: Record<string, string> = loadPref('keys', {});

export const keyOf = (id: string) => (id in userKeys ? userKeys[id] : commandById(id)?.key ?? toolKey(id) ?? '');
const toolKey = (id: string) => (id.startsWith('tool:') ? tools.find((t) => 'tool:' + t.id === id)?.key : undefined);
export function setKey(id: string, key: string) { userKeys = { ...userKeys, [id]: key }; savePref('keys', userKeys); rebuild(); ed.notify(); }
export function resetKeys() { userKeys = {}; try { localStorage.removeItem('spritecraft.keys'); } catch { /* fine */ } rebuild(); ed.notify(); }

let lookup = new Map<string, string>();
function rebuild() {
  lookup = new Map();
  for (const t of tools) { const k = keyOf('tool:' + t.id); if (k) lookup.set(k, 'tool:' + t.id); }
  for (const c of commands) { const k = keyOf(c.id); if (k) lookup.set(k, c.id); }
}

export function keyName(e: KeyboardEvent): string {
  const k = e.key === ' ' ? 'space' : e.key.toLowerCase();
  if (['control', 'shift', 'alt', 'meta'].includes(k)) return '';
  return (e.ctrlKey || e.metaKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey && (k.length > 1 || /[a-z]/.test(k)) ? 'shift+' : '') + k;
}

export const prettyKey = (k: string) => k.split('+').map((p) => p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)).join('+');

export function handleKey(e: KeyboardEvent): boolean {
  const name = keyName(e);
  if (!name) return false;
  // The canvas keys work unless the user is typing into a field.
  if (e.key === 'Escape') { activeTool().cancel?.(); ed.cancelFloat(); ed.stop(); return true; }
  if (name.startsWith('arrow') && (ed.s.float || ed.toolId === 'move')) {
    const n = 1;
    nudge(name === 'arrowleft' ? -n : name === 'arrowright' ? n : 0, name === 'arrowup' ? -n : name === 'arrowdown' ? n : 0);
    return true;
  }
  if (name === 'arrowleft') { ed.setFrame(ed.s.frame - 1); return true; }
  if (name === 'arrowright') { ed.setFrame(ed.s.frame + 1); return true; }
  const id = lookup.get(name);
  if (!id) return false;
  if (id.startsWith('tool:')) ed.setTool(id.slice(5));
  else runCommand(id);
  return true;
}

export function initCommands() { registerEffectCommands(); rebuild(); }
export { useEd };
