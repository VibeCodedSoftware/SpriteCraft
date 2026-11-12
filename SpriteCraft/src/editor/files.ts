// Getting files in and out of the app.
import { rgba } from '../core/color';
import { newLayer, trimToCel } from '../core/doc';
import { extractPalette } from '../core/palette';
import { readAseprite, writeAseprite } from '../io/aseprite';
import { readFlipbook } from '../io/craft';
import { decodeGif } from '../io/gif';
import { InterlacedPng, decodePng, type Image32 } from '../io/png';
import { readProject, writeProject } from '../io/project';
import { docFromFrames } from '../io/sheet';
import { ed } from './editor';

export const IMAGE_ACCEPT = '.png,.gif,.jpg,.jpeg,.webp,.bmp';
export const OPEN_ACCEPT = `.spritecraft,.ase,.aseprite,.vfx.json,.json,${IMAGE_ACCEPT}`;

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

const MIME: Record<string, string> = { png: 'image/png', gif: 'image/gif', json: 'application/json', zip: 'application/zip', gpl: 'text/plain', hex: 'text/plain' };

/**
 * Saves with the system's save dialog where it exists, and otherwise as a normal download.
 * Returns false when the user cancelled.
 */
export async function saveBytes(name: string, data: Uint8Array | string, description?: string): Promise<boolean> {
  const ext = name.split('.').pop()!.toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const blob = new Blob([data as any], { type });
  const picker = (window as any).showSaveFilePicker;
  if (picker) {
    try {
      const h = await picker({ suggestedName: name, types: [{ description: description ?? ext.toUpperCase(), accept: { [type]: ['.' + ext] } }] });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e: any) {
      if (e?.name === 'AbortError') return false;
      // Anything else (a blocked picker) falls through to a download so the work is not lost.
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return true;
}

/** Decodes any still image. PNG stays pixel exact; other types go through the browser's decoder. */
export async function decodeImage(file: Blob): Promise<Image32> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 137 && bytes[1] === 80) {
    try { return decodePng(bytes); } catch (e) { if (!(e instanceof InterlacedPng)) throw e; }
  }
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const id = g.getImageData(0, 0, bmp.width, bmp.height);
  return { w: bmp.width, h: bmp.height, data: new Uint32Array(id.data.buffer.slice(0)) };
}

const baseName = (n: string) => n.replace(/\.vfx\.json$/i, '').replace(/\.[^.]+$/, '');

/** Opens any supported file as a new tab, and reports anything the format could not carry. */
export async function openFile(file: File) {
  const name = file.name.toLowerCase();
  const title = baseName(file.name);
  try {
    if (name.endsWith('.spritecraft')) {
      const { doc } = readProject(new Uint8Array(await file.arrayBuffer()));
      ed.openDoc(doc);
    } else if (name.endsWith('.ase') || name.endsWith('.aseprite')) {
      const { doc, warnings } = readAseprite(new Uint8Array(await file.arrayBuffer()), title);
      ed.openDoc(doc);
      if (warnings.length) ed.openDialog('notice', { title: `Opened ${file.name}`, lines: warnings });
    } else if (name.endsWith('.json')) {
      ed.openDoc(readFlipbook(await file.text()));
    } else if (name.endsWith('.gif')) {
      const g = decodeGif(new Uint8Array(await file.arrayBuffer()));
      ed.openDoc(docFromFrames(g.frames.map((f) => f.data), g.w, g.h, title, g.frames.map((f) => f.delay)));
    } else {
      const img = await decodeImage(file);
      ed.openDoc(docFromFrames([img.data], img.w, img.h, title));
    }
    ed.toast(`Opened ${file.name}.`);
  } catch (e: any) {
    ed.openDialog('notice', { title: `Could not open ${file.name}`, lines: [e.message ?? String(e)] });
  }
}

/** Bundled starting points: base art on a locked layer, with an empty layer above it to draw on. */
export async function openTemplate(file: string, name: string, tile: number) {
  try {
    const r = await fetch(`./assets/templates/${file}`);
    if (!r.ok) throw new Error(`The template file is missing (${file})`);
    const img = decodePng(new Uint8Array(await r.arrayBuffer()));
    const base = docFromFrames([img.data], img.w, img.h, name);
    base.layers[0] = { ...base.layers[0], name: 'Base tiles (locked)', locked: true };
    const draw = newLayer('Draw here');
    const colors = extractPalette([img.data], 32);
    const doc = { ...base, layers: [...base.layers, draw], palette: [...colors, ...base.palette.filter((c) => !colors.includes(c))], grid: { ...base.grid, showTile: true, tileW: tile, tileH: tile, snap: false } };
    const s = ed.openDoc(doc);
    s.layerId = draw.id;
    ed.notify();
    ed.toast('Draw on the "Draw here" layer. Hide or delete the base layer before exporting if you only want your drawing.');
  } catch (e: any) { ed.openDialog('notice', { title: 'Could not open that template', lines: [e.message ?? String(e)] }); }
}

/** Several images become frames, in name order. */
export async function openSequence(files: File[]) {
  if (!files.length) return;
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  try {
    const images = await Promise.all(sorted.map(decodeImage));
    const w = Math.max(...images.map((i) => i.w)), h = Math.max(...images.map((i) => i.h));
    const frames = images.map((img) => {
      if (img.w === w && img.h === h) return img.data;
      const out = new Uint32Array(w * h);
      for (let y = 0; y < img.h; y++) out.set(img.data.subarray(y * img.w, (y + 1) * img.w), y * w);
      return out;
    });
    ed.openDoc(docFromFrames(frames, w, h, baseName(sorted[0].name).replace(/[-_ ]?\d+$/, '') || 'Sequence'));
    if (images.some((i) => i.w !== w || i.h !== h)) ed.toast(`The images differ in size; the canvas fits the largest (${w}×${h}).`);
    else ed.toast(`Opened ${files.length} images as frames.`);
  } catch (e: any) { ed.openDialog('notice', { title: 'Could not open those images', lines: [e.message ?? String(e)] }); }
}

/** Adds an image to the current sprite as a new layer, or a reference layer that is never exported. */
export async function importAsLayer(file: File, kind: 'image' | 'reference') {
  try {
    const img = await decodeImage(file);
    const cel = trimToCel(img.data, img.w, img.h, 0, 0) ?? undefined;
    ed.addLayer(kind, baseName(file.name), cel);
    if (img.w > ed.doc.width || img.h > ed.doc.height) ed.toast(`The image is larger than the canvas (${img.w}×${img.h}); use the Move tool to position it.`);
  } catch (e: any) { ed.openDialog('notice', { title: `Could not read ${file.name}`, lines: [e.message ?? String(e)] }); }
}

/** Reads an image off the system clipboard into the paste flow. */
export async function pasteFromSystem(ev: ClipboardEvent) {
  const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const f = item?.getAsFile();
  if (!f) return false;
  const img = await decodeImage(f);
  ed.paste(false, { w: img.w, h: img.h, x: -1, y: -1, data: img.data });
  return true;
}

export function saveProjectAs() {
  ed.endActiveEdit();
  return saveBytes(`${ed.doc.name}.spritecraft`, writeProject(ed.doc), 'SpriteCraft project');
}

export function saveAseprite() {
  ed.endActiveEdit();
  const { bytes, warnings } = writeAseprite(ed.doc);
  return saveBytes(`${ed.doc.name}.aseprite`, bytes, 'Aseprite file').then((ok) => {
    if (ok && warnings.length) ed.openDialog('notice', { title: 'Saved, with changes the format requires', lines: warnings });
    return ok;
  });
}

export const opaqueBlack = rgba(0, 0, 0);
