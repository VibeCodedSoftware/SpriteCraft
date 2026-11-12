// The .spritecraft project file: a zip with project.json (the document) and one raw pixel file per cel. It keeps
// everything other formats lose (masks, clipping, reference layers, guides) and is versioned so later phases can add
// to it: readers keep unknown fields in `extra` and pass them back on save.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { newId, type Cel, type Doc } from '../core/types';

export const PROJECT_FORMAT = 'spritecraft.project';
export const PROJECT_VERSION = 1;

export function writeProject(doc: Doc, extra: Record<string, unknown> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const ids = new Map<Cel, string>();
  const cels: Record<string, { file: string; x: number; y: number; w: number; h: number; opacity: number; gen?: string }> = {};
  for (const [key, c] of Object.entries(doc.cels)) {
    // Identity of the object, not its id field, is what makes cels linked.
    let file = ids.get(c);
    if (!file) {
      file = `cels/${ids.size}.rgba`;
      ids.set(c, file);
      files[file] = new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    }
    cels[key] = { file, x: c.x, y: c.y, w: c.w, h: c.h, opacity: c.opacity, ...(c.gen ? { gen: c.gen } : {}) };
  }
  const { cels: _c, selection: _s, ...rest } = doc;
  const json = { format: PROJECT_FORMAT, version: PROJECT_VERSION, doc: rest, cels, extra };
  files['project.json'] = strToU8(JSON.stringify(json));
  return zipSync(files, { level: 6 });
}

export function readProject(bytes: Uint8Array): { doc: Doc; extra: Record<string, unknown> } {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error('This is not a SpriteCraft project file'); }
  if (!files['project.json']) throw new Error('This is not a SpriteCraft project file');
  const json = JSON.parse(strFromU8(files['project.json']));
  if (json.format !== PROJECT_FORMAT) throw new Error('This is not a SpriteCraft project file');
  if (json.version > PROJECT_VERSION) throw new Error(`This project was saved by a newer SpriteCraft (format ${json.version}). Please update the app.`);
  const made = new Map<string, Cel>();
  const cels: Record<string, Cel> = {};
  for (const [key, c] of Object.entries<any>(json.cels)) {
    let cel = made.get(c.file);
    if (!cel) {
      const raw = files[c.file];
      if (!raw) throw new Error(`This project file is damaged: ${c.file} is missing`);
      // Copied, because a zip entry's bytes may not be aligned for a 32-bit view.
      const data = new Uint32Array(raw.slice().buffer);
      if (data.length !== c.w * c.h) throw new Error(`This project file is damaged: ${c.file} has the wrong size`);
      cel = { id: newId('c'), x: c.x, y: c.y, w: c.w, h: c.h, opacity: c.opacity, data, ...(c.gen ? { gen: c.gen } : {}) };
      made.set(c.file, cel);
    }
    cels[key] = cel;
  }
  return { doc: { ...json.doc, cels, selection: null } as Doc, extra: json.extra ?? {} };
}
