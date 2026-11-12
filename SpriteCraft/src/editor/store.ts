// Storage. Uses the same local file API as the other Craft apps (dev server in a browser, craft:// in the desktop app):
// projects under %LOCALAPPDATA%\CraftApps\SpriteCraft, and the exchange folder they all share.
import { composeFrame } from '../core/compose';
import type { Doc } from '../core/types';
import { encodePng } from '../io/png';
import { readProject, writeProject } from '../io/project';
import { ed, type Session } from './editor';

const BASE = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'http://craft.localhost' : '';

async function req(path: string, init?: RequestInit) {
  const r = await fetch(BASE + path, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error ?? msg; } catch { /* keep the status text */ }
    throw new Error(msg || `Request failed: ${path}`);
  }
  return r;
}

export interface ProjectInfo { id: string; name: string; modified: number; hasNewerAutosave?: boolean; error?: boolean }

const fileUrl = (id: string, name: string) => `/api/projects/${encodeURIComponent(id)}/files/${name}`;
const SAVE_FILE = 'sprite.spritecraft', AUTO_FILE = 'autosave.spritecraft';

/** A small picture for the project list. */
function thumbnail(doc: Doc): string {
  const data = composeFrame(doc, 0, { skipReference: true });
  const step = Math.max(1, Math.ceil(Math.max(doc.width, doc.height) / 64));
  const w = Math.max(1, Math.floor(doc.width / step)), h = Math.max(1, Math.floor(doc.height / step));
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = data[y * step * doc.width + x * step];
  const png = encodePng({ w, h, data: out });
  let s = '';
  for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(s);
}

const meta = (doc: Doc, extra: object = {}) => JSON.stringify({ app: 'spritecraft', name: doc.name, width: doc.width, height: doc.height, frames: doc.frames.length, thumbnail: thumbnail(doc), ...extra });

export const api = {
  list: async (): Promise<(ProjectInfo & { thumbnail?: string })[]> => {
    const list: ProjectInfo[] = await (await req('/api/projects')).json();
    return Promise.all(list.map(async (p) => {
      try { return { ...p, thumbnail: (await (await req(`/api/projects/${encodeURIComponent(p.id)}`)).json()).thumbnail }; } catch { return p; }
    }));
  },
  save: async (s: Session) => {
    const doc = s.doc;
    await req(fileUrl(s.projectId, SAVE_FILE), { method: 'PUT', body: writeProject(doc) as any });
    // This write also clears the autosave marker, so it comes after the pixels are safe.
    await req(`/api/projects/${encodeURIComponent(s.projectId)}`, { method: 'PUT', body: meta(doc) });
    s.savedDoc = doc; s.autosavedDoc = doc; s.neverSaved = false;
  },
  /** Saves a recovery copy without touching the real save. */
  autosave: async (s: Session) => {
    const doc = s.doc;
    // A never-saved sprite needs an entry so recovery can list it. Writing it first keeps the autosave marker newer.
    if (s.neverSaved && s.autosavedDoc !== doc && !registered.has(s.projectId)) {
      await req(`/api/projects/${encodeURIComponent(s.projectId)}`, { method: 'PUT', body: meta(doc, { neverSaved: true }) });
      registered.add(s.projectId);
    }
    await req(fileUrl(s.projectId, AUTO_FILE), { method: 'PUT', body: writeProject(doc) as any });
    await req(`/api/projects/${encodeURIComponent(s.projectId)}/autosave`, { method: 'PUT', body: JSON.stringify({ modified: Date.now() }) });
    s.autosavedDoc = doc;
  },
  open: async (id: string, fromAutosave: boolean): Promise<Doc> => {
    const r = await req(fileUrl(id, fromAutosave ? AUTO_FILE : SAVE_FILE));
    return readProject(new Uint8Array(await r.arrayBuffer())).doc;
  },
  /** True when the project has a real save, not only a recovery copy. */
  hasSave: async (id: string) => { try { await req(fileUrl(id, SAVE_FILE)); return true; } catch { return false; } },
  remove: async (id: string) => { await req(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  discardAutosave: async (id: string) => { await req(`/api/projects/${encodeURIComponent(id)}/autosave`, { method: 'DELETE' }); },
  exchangeList: async (): Promise<{ path: string; modified: number }[]> => (await req('/api/exchange')).json(),
  exchangeGet: async (name: string) => (await req(`/api/exchange/${encodeURIComponent(name)}`)).text(),
  exchangePut: async (name: string, body: string) => (await req(`/api/exchange/${encodeURIComponent(name)}`, { method: 'PUT', body })).json(),
};

const registered = new Set<string>();

/** Keeps a recovery copy of everything with unsaved changes. */
export function startAutosave(ms = 30_000) {
  return setInterval(async () => {
    for (const s of ed.sessions) {
      if (s.doc === s.autosavedDoc || s.doc === s.savedDoc || !ed.isDirty(s)) continue;
      try { await api.autosave(s); }
      catch (e: any) { ed.toast(`Autosave failed: ${e.message ?? e}`); }
    }
  }, ms);
}

export async function saveCurrent() {
  ed.endActiveEdit();
  try {
    await api.save(ed.s);
    ed.toast(`Saved "${ed.doc.name}".`);
  } catch (e: any) { ed.toast(`Could not save: ${e.message ?? e}`); }
}
