// Every dialog in the app. `ed.openDialog(kind, props)` chooses which one shows.
import { useEffect, useMemo, useRef, useState } from 'react';
import { strToU8, zipSync } from 'fflate';
import { fromHex, rgba, toCss, toHex } from '../core/color';
import { composeFrame } from '../core/compose';
import { celToBuffer, newDoc, resizeCanvas, scaleSprite } from '../core/doc';
import { defaultParams, effectById, lerpParams } from '../core/effects';
import { EASE_PRESETS, easeFn, easeLabel, type Ease } from '../core/anim';
import { extractPalette, makeRamp } from '../core/palette';
import { celKey, type LoopDir } from '../core/types';
import { commands, keyOf, prettyKey, resetKeys, setKey, keyName } from '../editor/commands';
import { ed, useEd } from '../editor/editor';
import { decodeImage, openSequence, pickFiles, saveAseprite, saveBytes, IMAGE_ACCEPT } from '../editor/files';
import { api, saveCurrent } from '../editor/store';
import { tools } from '../editor/tools';
import { MAX_STRIP, exchangeFileName, flipbookFps, makeFlipbook, readFlipbook } from '../io/craft';
import { readParticleVfx } from '../io/particlecraft';
import { encodeGif } from '../io/gif';
import { encodePng, type Image32 } from '../io/png';
import { buildSheet, detectGrid, docFromFrames, renderFrames, sheetGrid, sliceSheet, type SheetLayout } from '../io/sheet';
import { Num } from './Panels';

function Modal({ title, children, foot, wide, onClose }: { title: string; children: React.ReactNode; foot?: React.ReactNode; wide?: boolean; onClose?: () => void }) {
  const close = onClose ?? (() => ed.closeDialog());
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-label={title}>
        <div className="modal-head"><b>{title}</b><button className="mini" aria-label="Close" onClick={close}>×</button></div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

const CancelBtn = () => <button className="btn" onClick={() => ed.closeDialog()}>Cancel</button>;

const SIZES = [[16, 16], [32, 32], [48, 48], [64, 64], [128, 128], [256, 256], [320, 180], [640, 360]];

function NewDialog() {
  const [w, setW] = useState(64), [h, setH] = useState(64), [name, setName] = useState('Untitled'), [frames, setFrames] = useState(1);
  return (
    <Modal title="New sprite" foot={<><CancelBtn /><button className="btn primary" onClick={() => {
      ed.closeDialog();
      ed.openDoc(newDoc(w, h, name.trim() || 'Untitled', frames));
    }}>Create</button></>}>
      <label className="field">Name<input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
      <div className="row"><label>Width<Num value={w} min={1} max={8192} onChange={setW} /></label><label>Height<Num value={h} min={1} max={8192} onChange={setH} /></label><label>Frames<Num value={frames} min={1} max={9999} onChange={setFrames} /></label></div>
      <div className="row wrap">{SIZES.map(([a, b]) => <button key={a + 'x' + b} className={'btn' + (w === a && h === b ? ' on' : '')} onClick={() => { setW(a); setH(b); }}>{a}×{b}</button>)}</div>
      {w * h > 4096 * 4096 && <p className="warn">A canvas this large can be slow and memory hungry.</p>}
    </Modal>
  );
}

function CanvasDialog() {
  const d = ed.doc;
  const [w, setW] = useState(d.width), [h, setH] = useState(d.height), [ax, setAx] = useState(0.5), [ay, setAy] = useState(0.5);
  return (
    <Modal title="Canvas size" foot={<><CancelBtn /><button className="btn primary" onClick={() => { ed.closeDialog(); ed.applyToSprite('Canvas size', (doc) => resizeCanvas(doc, w, h, ax, ay)); }}>Apply</button></>}>
      <div className="row"><label>Width<Num value={w} min={1} max={8192} onChange={setW} /></label><label>Height<Num value={h} min={1} max={8192} onChange={setH} /></label></div>
      <p className="dim">Anchor: where the existing art stays. Pixels pushed off the canvas are kept and come back if you enlarge it again.</p>
      <div className="anchor">
        {[0, 0.5, 1].map((y) => [0, 0.5, 1].map((x) => <button key={x + ':' + y} aria-label={`Anchor ${x},${y}`} className={'btn' + (ax === x && ay === y ? ' on' : '')} onClick={() => { setAx(x); setAy(y); }} />))}
      </div>
    </Modal>
  );
}

function ScaleDialog() {
  const d = ed.doc;
  const [w, setW] = useState(d.width), [h, setH] = useState(d.height), [lock, setLock] = useState(true);
  const aspect = d.height / d.width;
  return (
    <Modal title="Scale sprite" foot={<><CancelBtn /><button className="btn primary" onClick={() => { ed.closeDialog(); ed.applyToSprite('Scale sprite', (doc) => scaleSprite(doc, w, h)); }}>Scale</button></>}>
      <div className="row">
        <label>Width<Num value={w} min={1} max={8192} onChange={(n) => { setW(n); if (lock) setH(Math.max(1, Math.round(n * aspect))); }} /></label>
        <label>Height<Num value={h} min={1} max={8192} onChange={(n) => { setH(n); if (lock) setW(Math.max(1, Math.round(n / aspect))); }} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Keep proportions</label>
      <div className="row">{[0.5, 2, 3, 4].map((k) => <button key={k} className="btn" onClick={() => { setW(Math.max(1, Math.round(d.width * k))); setH(Math.max(1, Math.round(d.height * k))); }}>{k}×</button>)}</div>
      <p className="dim">Uses nearest-neighbour sampling: no new colours, no blur. Whole-number factors look cleanest.</p>
    </Modal>
  );
}

function RenameDialog() {
  const [name, setName] = useState(ed.doc.name);
  const go = () => { ed.closeDialog(); if (name.trim()) ed.commit('Rename sprite', { ...ed.doc, name: name.trim() }); };
  return (
    <Modal title="Rename sprite" foot={<><CancelBtn /><button className="btn primary" onClick={go}>Rename</button></>}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') go(); }} />
    </Modal>
  );
}

// ---- Export

/** Frames chosen by a dialog: everything, one tag, or the current frame. */
function useRange() {
  const d = ed.doc;
  const [choice, setChoice] = useState('all');
  const r = choice === 'all' ? { from: 0, to: d.frames.length - 1 }
    : choice === 'current' ? { from: ed.s.frame, to: ed.s.frame }
      : (() => { const t = d.tags.find((x) => x.id === choice)!; return { from: t.from, to: t.to }; })();
  const el = (
    <label className="field">Frames
      <select value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="all">All ({d.frames.length})</option>
        <option value="current">Current frame only</option>
        {d.tags.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.to - t.from + 1})</option>)}
      </select>
    </label>
  );
  return { ...r, el, tagName: d.tags.find((x) => x.id === choice)?.name };
}

type ExportKind = 'png' | 'sequence' | 'sheet' | 'gif' | 'aseprite';

function ExportDialog() {
  const d = ed.doc;
  const [kind, setKind] = useState<ExportKind>(d.frames.length > 1 ? 'sheet' : 'png');
  const [scale, setScale] = useState(1), [layout, setLayout] = useState<SheetLayout>('horizontal'), [cols, setCols] = useState(4), [pad, setPad] = useState(0), [json, setJson] = useState(true);
  const [loop, setLoop] = useState(true), [matte, setMatte] = useState(false), [matteColor, setMatteColor] = useState('#ffffff');
  const [busy, setBusy] = useState('');
  const r = useRange();
  const count = r.to - r.from + 1;
  const stem = d.name + (r.tagName ? `-${r.tagName}` : '');
  const pad3 = (n: number) => String(n).padStart(Math.max(3, String(r.to).length), '0');

  const sizeNote = kind === 'sheet'
    ? (() => { const c = layout === 'horizontal' ? count : layout === 'vertical' ? 1 : cols; const rows = Math.ceil(count / c); return `${c * d.width * scale + (c - 1) * pad} × ${rows * d.height * scale + (rows - 1) * pad} pixels`; })()
    : kind === 'aseprite' ? '' : `${d.width * scale} × ${d.height * scale} pixels`;

  const run = async () => {
    setBusy('Working…');
    // Lets "Working…" reach the screen before a long export begins.
    await new Promise((res) => setTimeout(res, 30));
    try {
      let ok = true;
      if (kind === 'png') {
        const [data] = renderFrames(d, r.from, r.from, scale);
        ok = await saveBytes(`${stem}.png`, encodePng({ w: d.width * scale, h: d.height * scale, data }), 'PNG image');
      } else if (kind === 'sequence') {
        const frames = renderFrames(d, r.from, r.to, scale);
        const files: Record<string, Uint8Array> = {};
        frames.forEach((data, i) => { files[`${stem}_${pad3(i + r.from)}.png`] = encodePng({ w: d.width * scale, h: d.height * scale, data }); });
        ok = await saveBytes(`${stem}_frames.zip`, zipSync(files, { level: 0 }), 'Zip of PNG images');
      } else if (kind === 'sheet') {
        const sheet = buildSheet(d, { layout, columns: cols, padding: pad, scale, from: r.from, to: r.to }, `${stem}.png`);
        const png = encodePng(sheet.image);
        if (json) {
          ok = await saveBytes(`${stem}_sheet.zip`, zipSync({ [`${stem}.png`]: png, [`${stem}.json`]: strToU8(JSON.stringify(sheet.json, null, 1)) }, { level: 0 }), 'Zip of sheet and JSON');
        } else ok = await saveBytes(`${stem}.png`, png, 'PNG image');
      } else if (kind === 'gif') {
        const frames = renderFrames(d, r.from, r.to, scale).map((data, i) => ({ data, delay: d.frames[r.from + i].duration }));
        const gif = encodeGif(frames, d.width * scale, d.height * scale, { loop, matte: matte ? fromHex(matteColor) ?? rgba(255, 255, 255) : null, palette: d.colorMode === 'indexed' ? d.palette.map((c) => (c | 0xff000000) >>> 0) : undefined });
        ok = await saveBytes(`${stem}.gif`, gif, 'GIF animation');
      } else {
        ok = await saveAseprite();
        if (ok) return;
      }
      if (ok) { ed.closeDialog(); ed.toast('Exported.'); }
      else setBusy('');
    } catch (e: any) { setBusy(`Export failed: ${e.message ?? e}`); }
  };
  return (
    <Modal title="Export" foot={<><span className="dim grow">{busy || sizeNote}</span><CancelBtn /><button className="btn primary" onClick={run}>Export…</button></>}>
      <div className="row wrap">
        {([['png', 'PNG image'], ['sequence', 'PNG frames (zip)'], ['sheet', 'Sprite sheet'], ['gif', 'GIF'], ['aseprite', '.aseprite']] as [ExportKind, string][]).map(([k, label]) =>
          <button key={k} className={'btn' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>{label}</button>)}
      </div>
      {kind !== 'aseprite' && <>
        {kind !== 'png' && r.el}
        <label className="field">Scale
          <select value={scale} onChange={(e) => setScale(+e.target.value)}>{[1, 2, 3, 4, 5, 6, 8, 10, 16].map((n) => <option key={n} value={n}>{n}×</option>)}</select>
        </label>
      </>}
      {kind === 'sheet' && <>
        <label className="field">Layout
          <select value={layout} onChange={(e) => setLayout(e.target.value as SheetLayout)}>
            <option value="horizontal">One row</option>
            <option value="vertical">One column</option>
            <option value="grid">Grid</option>
          </select>
        </label>
        {layout === 'grid' && <label className="field">Columns<Num value={cols} min={1} max={999} onChange={setCols} /></label>}
        <label className="field">Gap between frames<Num value={pad} min={0} max={64} onChange={setPad} /></label>
        <label className="check"><input type="checkbox" checked={json} onChange={(e) => setJson(e.target.checked)} /> Include JSON with frame positions, durations and tags (zip)</label>
      </>}
      {kind === 'gif' && <>
        <label className="check"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop forever</label>
        <label className="check"><input type="checkbox" checked={matte} onChange={(e) => setMatte(e.target.checked)} /> Blend soft edges onto a background colour
          {matte && <input className="colorin" type="color" value={matteColor} onChange={(e) => setMatteColor(e.target.value)} />}</label>
        <p className="dim">GIF allows 256 colours and pixels that are either solid or clear. {matte ? '' : 'Pixels under 50% opacity become clear.'} Frame times are rounded to 1/100 s, with a shortest of 2/100 s.</p>
      </>}
      {kind === 'aseprite' && <p className="dim">Keeps layers, groups, frames, tags, linked cels and palette. Masks are applied to the pixels and clipping is not kept, since the format has neither. Reference layers stay reference layers.</p>}
    </Modal>
  );
}

// ---- The other Craft apps

function SendDialog() {
  const d = ed.doc;
  const r = useRange();
  const [scale, setScale] = useState(1), [loop, setLoop] = useState(true), [name, setName] = useState(d.name), [done, setDone] = useState(''), [err, setErr] = useState('');
  const count = r.to - r.from + 1;
  const stripW = d.width * scale * count;
  const uneven = new Set(d.frames.slice(r.from, r.to + 1).map((f) => f.duration)).size > 1;
  const send = async () => {
    setErr('');
    try {
      const asset = makeFlipbook(d, { from: r.from, to: r.to, scale, loop, name: name.trim() || d.name });
      const file = exchangeFileName(asset.name);
      await api.exchangePut(file, JSON.stringify(asset));
      setDone(file);
    } catch (e: any) { setErr(e.message ?? String(e)); }
  };
  return (
    <Modal title="Send to the other Craft apps" foot={<>{done ? <button className="btn primary" onClick={() => ed.closeDialog()}>Done</button> : <><CancelBtn /><button className="btn primary" disabled={stripW > MAX_STRIP} onClick={send}>Send</button></>}</>}>
      {done ? <>
        <p>Sent <b>{done}</b> to the shared exchange folder.</p>
        <ul className="plain">
          <li><b>GameCraft:</b> Particles panel › Import from ParticleCraft. It arrives as an animated sprite.</li>
          <li><b>LogicCraft:</b> Objects › + ParticleCraft… › Import. It arrives as an animated sprite.</li>
          <li><b>WorldCraft:</b> listed under Place effect, as a reference. WorldCraft doesn't draw flipbooks in its view yet.</li>
        </ul>
        <p className="dim">Sending again with the same name replaces this file. Copies already imported into a project do not update by themselves: import again.</p>
      </> : <>
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
        {r.el}
        <label className="field">Scale<select value={scale} onChange={(e) => setScale(+e.target.value)}>{[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}×</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop</label>
        <p className="dim">Goes as a one-row strip, {stripW} × {d.height * scale} pixels, at {flipbookFps(d, r.from, r.to)} fps.{uneven ? ' Your frames have different durations; the other apps play one steady speed, so they use the average.' : ''}</p>
        {stripW > MAX_STRIP && <p className="warn">That is wider than the {MAX_STRIP}-pixel limit. Choose fewer frames or a smaller scale.</p>}
        {err && <p className="warn">{err}</p>}
      </>}
    </Modal>
  );
}

function ReceiveDialog() {
  const [items, setItems] = useState<{ path: string; modified: number }[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.exchangeList().then((l) => setItems(l.filter((f) => /\.vfx\.json$/i.test(f.path)).sort((a, b) => b.modified - a.modified))).catch((e) => setErr(e.message ?? String(e)));
  }, []);
  const open = async (p: string) => {
    try {
      const text = await api.exchangeGet(p);
      if (JSON.parse(text)?.kind === 'realtime') {
        // A live effect becomes pixel particles on a new layer of this sprite.
        const { system, notes } = readParticleVfx(text, ed.doc.width, ed.doc.height);
        ed.closeDialog();
        ed.addParticleLayer(system, system.name);
        ed.showPanel?.('particles');
        ed.toast(`Added "${system.name}" as particles${notes.length ? ` (${notes.join('; ')})` : ''}.`);
        return;
      }
      const doc = readFlipbook(text);
      ed.closeDialog();
      ed.openDoc(doc);
    } catch (e: any) { setErr(`${p}: ${e.message ?? e}`); }
  };
  return (
    <Modal title="Open from the Craft exchange folder" foot={<button className="btn" onClick={() => ed.closeDialog()}>Close</button>}>
      <p className="dim">Baked flipbooks, from ParticleCraft or sent from here, open as frames you can edit and send back. Real-time effects are added to this sprite as live pixel particles on a new layer.</p>
      {items === null && !err && <p className="dim">Loading…</p>}
      {items?.length === 0 && <p className="dim">Nothing there yet.</p>}
      <div className="file-list">{items?.map((f) => <button key={f.path} className="btn" onClick={() => open(f.path)}>{f.path}</button>)}</div>
      {err && <p className="warn">{err}</p>}
    </Modal>
  );
}

// ---- Import a sheet

function SheetDialog({ file }: { file: File }) {
  const [img, setImg] = useState<Image32 | null>(null);
  const [fw, setFw] = useState(32), [fh, setFh] = useState(32), [mx, setMx] = useState(0), [my, setMy] = useState(0), [gx, setGx] = useState(0), [gy, setGy] = useState(0), [dur, setDur] = useState(100);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    decodeImage(file).then((i) => {
      setImg(i);
      const g = detectGrid(i);
      setFw(g.frameW); setFh(g.frameH); setGx(g.spacingX); setGy(g.spacingY);
    }).catch((e) => setErr(e.message ?? String(e)));
  }, [file]);
  const opts = { frameW: Math.max(1, fw), frameH: Math.max(1, fh), marginX: mx, marginY: my, spacingX: gx, spacingY: gy };
  const grid = img ? sheetGrid(img.w, img.h, opts) : { cols: 0, rows: 0 };
  useEffect(() => {
    if (!img || !ref.current) return;
    const c = ref.current, z = Math.max(1, Math.floor(420 / Math.max(img.w, img.h)));
    c.width = img.w * z; c.height = img.h * z;
    const g = c.getContext('2d')!;
    const t = document.createElement('canvas'); t.width = img.w; t.height = img.h;
    t.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer.slice(0)), img.w, img.h), 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(t, 0, 0, c.width, c.height);
    g.strokeStyle = '#ffcf4a';
    for (let r = 0; r < grid.rows; r++) for (let q = 0; q < grid.cols; q++) g.strokeRect((mx + q * (fw + gx)) * z + 0.5, (my + r * (fh + gy)) * z + 0.5, fw * z - 1, fh * z - 1);
  }, [img, fw, fh, mx, my, gx, gy]);
  const total = grid.cols * grid.rows;
  return (
    <Modal wide title={`Open sprite sheet: ${file.name}`} foot={<><span className="dim grow">{img ? `${img.w} × ${img.h}, ${total} frame${total === 1 ? '' : 's'}` : ''}</span><CancelBtn /><button className="btn primary" disabled={!img || !total} onClick={() => {
      const frames = sliceSheet(img!, opts);
      ed.closeDialog();
      ed.openDoc(docFromFrames(frames, opts.frameW, opts.frameH, file.name.replace(/\.[^.]+$/, ''), frames.map(() => dur)));
    }}>Open</button></>}>
      <div className="split">
        <div className="sheet-preview"><canvas ref={ref} /></div>
        <div>
          <div className="row"><label>Frame W<Num value={fw} min={1} max={8192} onChange={setFw} /></label><label>H<Num value={fh} min={1} max={8192} onChange={setFh} /></label></div>
          <div className="row"><label>Margin X<Num value={mx} min={0} onChange={setMx} /></label><label>Y<Num value={my} min={0} onChange={setMy} /></label></div>
          <div className="row"><label>Gap X<Num value={gx} min={0} onChange={setGx} /></label><label>Y<Num value={gy} min={0} onChange={setGy} /></label></div>
          <label className="field">Frame time (ms)<Num value={dur} min={1} max={65535} onChange={setDur} /></label>
          <div className="row wrap">
            {[2, 3, 4, 6, 8, 12].map((n) => <button key={n} className="btn" title={`${n} columns`} onClick={() => { if (img) { setFw(Math.floor(img.w / n)); setGx(0); setMx(0); } }}>{n} cols</button>)}
          </div>
        </div>
      </div>
      {err && <p className="warn">{err}</p>}
    </Modal>
  );
}

// ---- Effects

function EffectDialog({ id }: { id: string }) {
  const fx = effectById(id)!;
  const [params, setParams] = useState<Record<string, any>>(() => defaultParams(fx));
  const [endParams, setEndParams] = useState<Record<string, any>>(() => defaultParams(fx));
  const [endTouched, setEndTouched] = useState<Set<string>>(() => new Set());
  const [all, setAll] = useState(false);
  // Animated: settings move from start to end across a run of frames, and the effect's time input advances.
  const [anim, setAnim] = useState(id === 'wave-warp' && ed.doc.frames.length > 1);
  const [ease, setEase] = useState<Ease>('linear');
  const [fromCurrent, setFromCurrent] = useState(true);
  const [span, setSpan] = useState<string>(ed.s.range ? 'selected' : 'all');
  const [tick, setTick] = useState(0);
  const d = ed.doc;
  const ref = useRef<HTMLCanvasElement>(null);
  const canvas = { x: 0, y: 0, w: d.width, h: d.height };
  const layerId = ed.s.layerId;
  const src = useMemo(() => celToBuffer(d.cels[celKey(layerId, ed.frameId)], canvas), []);
  const [from, to] = span === 'all' ? [0, d.frames.length - 1]
    : span === 'selected' && ed.s.range ? ed.s.range
      : (() => { const t = d.tags.find((x) => x.id === span); return t ? [t.from, t.to] : [0, d.frames.length - 1]; })();
  const n = to - from + 1;
  const animated = anim && n > 1;

  // The preview plays the animated result at the sprite's own frame timing.
  useEffect(() => {
    if (!animated) return;
    let alive = true, i = 0;
    const step = () => {
      if (!alive) return;
      i = (i + 1) % n;
      setTick(i);
      setTimeout(step, d.frames[from + i]?.duration ?? 100);
    };
    const h = setTimeout(step, d.frames[from]?.duration ?? 100);
    return () => { alive = false; clearTimeout(h); };
  }, [animated, from, to]);

  useEffect(() => {
    let out: Uint32Array;
    if (animated) {
      const i = Math.min(tick, n - 1);
      const input = fromCurrent ? src : celToBuffer(d.cels[celKey(layerId, d.frames[from + i].id)], canvas);
      const p = lerpParams(fx, params, endParams, easeFn(ease)(n > 1 ? i / (n - 1) : 0));
      out = fx.apply(input, d.width, d.height, p, { palette: d.palette, t: i / n });
    } else out = fx.apply(src, d.width, d.height, params, { palette: d.palette });
    const c = ref.current!;
    c.width = d.width; c.height = d.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.buffer.slice(0)), d.width, d.height), 0, 0);
    const z = Math.max(1, Math.floor(220 / Math.max(d.width, d.height)));
    c.style.width = d.width * z + 'px'; c.style.height = d.height * z + 'px';
  }, [params, endParams, tick, animated, ease, fromCurrent, from, to]);

  const control = (p: (typeof fx.params)[number], vals: Record<string, any>, set: (v: Record<string, any>) => void, suffix = '') => (
    <label key={p.key + suffix} className={p.type === 'bool' ? 'check' : 'field'}>
      {p.type === 'bool' && <input type="checkbox" checked={vals[p.key]} onChange={(e) => set({ ...vals, [p.key]: e.target.checked })} />}
      {p.label}
      {p.type === 'number' && <><input type="range" aria-label={p.label + suffix} min={p.min} max={p.max} step={p.step ?? 1} value={vals[p.key]} onChange={(e) => set({ ...vals, [p.key]: +e.target.value })} /><span className="val">{vals[p.key]}</span></>}
      {p.type === 'color' && <input className="colorin" type="color" value={vals[p.key]} onChange={(e) => set({ ...vals, [p.key]: e.target.value })} />}
      {p.type === 'choice' && <select value={vals[p.key]} onChange={(e) => set({ ...vals, [p.key]: e.target.value })}>{p.options.map((o) => <option key={o}>{o}</option>)}</select>}
      {p.type === 'text' && <input aria-label={p.label + suffix} value={vals[p.key]} onChange={(e) => set({ ...vals, [p.key]: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />}
    </label>
  );
  const apply = () => {
    ed.closeDialog();
    if (animated) ed.applyEffectAnimated(id, params, endParams, ease, from, to, fromCurrent);
    else ed.applyEffect(id, params, all);
  };
  const tweenable = fx.params.filter((p) => p.type === 'number' || p.type === 'color');

  return (
    <Modal wide={animated} title={fx.name} foot={<><CancelBtn /><button className="btn primary" onClick={apply}>Apply{animated ? ` to ${n} frames` : ''}</button></>}>
      <div className="split">
        <div>
          <div className="sheet-preview small"><canvas ref={ref} className="pixelated" /></div>
          {animated && <p className="dim mid">Frame {from + Math.min(tick, n - 1) + 1} of {from + 1}–{to + 1}</p>}
        </div>
        <div>
          {animated && <h4>Start</h4>}
          {fx.params.map((p) => control(p, params, (v) => {
            setParams(v);
            // An end value follows the start until it has been set on its own.
            const e = { ...endParams };
            for (const k of Object.keys(v)) if (!endTouched.has(k)) e[k] = v[k];
            setEndParams(e);
          }))}
          {animated && tweenable.length > 0 && (
            <>
              <h4>End (blends from the start over the frames)</h4>
              <button className="btn" onClick={() => { setEndParams({ ...params }); setEndTouched(new Set()); }}>Same as start</button>
              {tweenable.map((p) => control(p, endParams, (v) => { setEndParams(v); setEndTouched(new Set([...endTouched, p.key])); }, ' (end)'))}
              <label className="field">Easing<select value={typeof ease === 'string' ? ease : 'linear'} onChange={(e) => setEase(e.target.value as Ease)}>{EASE_PRESETS.map((p) => <option key={p} value={p}>{easeLabel(p)}</option>)}</select></label>
            </>
          )}
          <h4>Frames</h4>
          {d.frames.length > 1 && <label className="check"><input type="checkbox" checked={anim} onChange={(e) => setAnim(e.target.checked)} /> Animate across frames</label>}
          {animated || anim ? (
            <>
              <label className="field">Over<select value={span} onChange={(e) => setSpan(e.target.value)}>
                <option value="all">All frames ({d.frames.length})</option>
                {ed.s.range && <option value="selected">Selected frames ({ed.s.range[0] + 1}–{ed.s.range[1] + 1})</option>}
                {d.tags.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.to - t.from + 1})</option>)}
              </select></label>
              <label className="check" title="On: a still image becomes an animation. Off: each frame's own art is changed."><input type="checkbox" checked={fromCurrent} onChange={(e) => setFromCurrent(e.target.checked)} /> Use this frame's art on every frame</label>
              {id === 'wave-warp' && <p className="dim">A whole number of cycles makes the animation loop with no jump.</p>}
              {n < 2 && <p className="warn">Choose at least two frames.</p>}
            </>
          ) : (
            <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All frames of this layer, same settings</label>
          )}
          {d.selection && <p className="dim">Only the selected pixels change.</p>}
        </div>
      </div>
    </Modal>
  );
}

// ---- Colours

function ReplaceDialog() {
  const [from, setFrom] = useState(toHex(ed.fg)), [to, setTo] = useState(toHex(ed.bg)), [tol, setTol] = useState(0), [scope, setScope] = useState<'cel' | 'layer' | 'sprite'>('layer');
  return (
    <Modal title="Replace colour" foot={<><CancelBtn /><button className="btn primary" onClick={() => { ed.closeDialog(); ed.replaceColor(fromHex(from)!, fromHex(to)!, tol, scope); }}>Replace</button></>}>
      <div className="row"><label>From<input className="colorin" type="color" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>To<input className="colorin" type="color" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      <label className="field">Tolerance<input type="range" min={0} max={128} value={tol} onChange={(e) => setTol(+e.target.value)} /><span className="val">{tol}</span></label>
      <label className="field">Where<select value={scope} onChange={(e) => setScope(e.target.value as any)}><option value="cel">This cel</option><option value="layer">This layer, every frame</option><option value="sprite">Whole sprite</option></select></label>
    </Modal>
  );
}

function RampDialog() {
  const [a, setA] = useState(toHex(ed.fg)), [b, setB] = useState(toHex(ed.bg)), [n, setN] = useState(6), [shift, setShift] = useState(20);
  const ramp = makeRamp(fromHex(a)!, fromHex(b)!, n, shift);
  return (
    <Modal title="Make a colour ramp" foot={<><CancelBtn /><button className="btn primary" onClick={() => { ed.closeDialog(); ed.setPalette([...ed.doc.palette, ...ramp], 'Add ramp'); }}>Add to palette</button></>}>
      <div className="row"><label>From<input className="colorin" type="color" value={a} onChange={(e) => setA(e.target.value)} /></label><label>To<input className="colorin" type="color" value={b} onChange={(e) => setB(e.target.value)} /></label><label>Steps<Num value={n} min={2} max={32} onChange={setN} /></label></div>
      <label className="field">Hue shift<input type="range" min={-60} max={60} value={shift} onChange={(e) => setShift(+e.target.value)} /><span className="val">{shift}°</span></label>
      <div className="ramp">{ramp.map((c, i) => <i key={i} style={{ background: toCss(c) }} title={toHex(c)} />)}</div>
      <p className="dim">Hue shift bends the colours in between, which tends to make shading feel richer than a straight blend.</p>
    </Modal>
  );
}

function ExtractDialog() {
  const d = ed.doc;
  const [n, setN] = useState(32), [from, setFrom] = useState<'sprite' | 'frame' | 'file'>('sprite'), [mode, setMode] = useState<'replace' | 'add'>('replace');
  const [msg, setMsg] = useState('');
  const go = async () => {
    let bufs: Uint32Array[];
    if (from === 'file') {
      const [f] = await pickFiles(IMAGE_ACCEPT);
      if (!f) return;
      try { bufs = [(await decodeImage(f)).data]; } catch (e: any) { setMsg(e.message ?? String(e)); return; }
    } else if (from === 'frame') bufs = [composeFrame(d, ed.s.frame, { skipReference: true })];
    else bufs = d.frames.map((_, i) => composeFrame(d, i, { skipReference: true }));
    const colors = extractPalette(bufs, n);
    if (!colors.length) { setMsg('No visible pixels to read colours from.'); return; }
    ed.closeDialog();
    ed.setPalette(mode === 'add' ? [...d.palette, ...colors.filter((c) => !d.palette.includes(c))] : colors, 'Palette from image');
    ed.toast(`Palette: ${ed.doc.palette.length} colours.`);
  };
  return (
    <Modal title="Palette from image" foot={<><CancelBtn /><button className="btn primary" onClick={go}>{from === 'file' ? 'Choose image…' : 'Make palette'}</button></>}>
      <label className="field">Read from<select value={from} onChange={(e) => setFrom(e.target.value as any)}><option value="sprite">This sprite, all frames</option><option value="frame">This frame</option><option value="file">An image file</option></select></label>
      <label className="field">Up to<Num value={n} min={2} max={256} onChange={setN} /> colours</label>
      <label className="field">Result<select value={mode} onChange={(e) => setMode(e.target.value as any)}><option value="replace">Replace the palette</option><option value="add">Add to the palette</option></select></label>
      {msg && <p className="warn">{msg}</p>}
    </Modal>
  );
}

function ColorDialog({ index }: { index: number }) {
  const [hex, setHex] = useState(toHex(ed.doc.palette[index], true));
  const valid = fromHex(hex) !== null;
  return (
    <Modal title={`Palette colour ${index}`} foot={<><CancelBtn /><button className="btn primary" disabled={!valid} onClick={() => { ed.closeDialog(); ed.setPaletteColor(index, fromHex(hex)!); }}>Apply</button></>}>
      <div className="row"><input className="colorin big" type="color" value={hex.slice(0, 7)} onChange={(e) => setHex(e.target.value)} /><input aria-label="Colour code" value={hex} onChange={(e) => setHex(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
      {ed.doc.colorMode === 'indexed' && <p className="dim">In indexed mode, pixels using this colour change with it.</p>}
    </Modal>
  );
}

function TagDialog({ id }: { id: string }) {
  const d = ed.doc;
  const t = d.tags.find((x) => x.id === id);
  if (!t) return null;
  return (
    <Modal title="Tag" foot={<><button className="btn danger" onClick={() => { ed.closeDialog(); ed.removeTag(id); }}>Delete tag</button><span className="grow" /><button className="btn primary" onClick={() => ed.closeDialog()}>Done</button></>}>
      <label className="field">Name<input autoFocus defaultValue={t.name} onBlur={(e) => { if (e.target.value !== t.name) ed.patchTag(id, { name: e.target.value }); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
      <div className="row">
        <label>First frame<Num value={t.from + 1} min={1} max={t.to + 1} onChange={(n) => ed.patchTag(id, { from: n - 1 })} /></label>
        <label>Last frame<Num value={t.to + 1} min={t.from + 1} max={d.frames.length} onChange={(n) => ed.patchTag(id, { to: n - 1 })} /></label>
        <label>Colour<input className="colorin" type="color" value={t.color} onChange={(e) => ed.patchTag(id, { color: e.target.value })} /></label>
      </div>
      <label className="field">Playback<select value={t.dir} onChange={(e) => ed.patchTag(id, { dir: e.target.value as LoopDir })}>
        <option value="forward">Forward</option>
        <option value="reverse">Reverse</option>
        <option value="pingpong">Ping-pong</option>
        <option value="pingpong-reverse">Ping-pong, reversed</option>
      </select></label>
    </Modal>
  );
}

// ---- Projects and recovery

function ProjectsDialog() {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.list>> | null>(null);
  const [err, setErr] = useState('');
  const refresh = () => api.list().then(setList).catch((e) => setErr(e.message ?? String(e)));
  useEffect(() => { refresh(); }, []);
  const open = async (id: string, auto: boolean) => {
    const already = ed.sessions.findIndex((s) => s.projectId === id);
    if (already >= 0 && !auto) { ed.closeDialog(); ed.switchTo(already); return; }
    try {
      const doc = await api.open(id, auto);
      ed.closeDialog();
      const hasSave = await api.hasSave(id);
      const s = ed.openDoc(doc, !hasSave, id);
      // A recovered copy is unsaved work.
      if (auto) { s.savedDoc = null; s.autosavedDoc = doc; }
    } catch (e: any) { setErr(e.message ?? String(e)); }
  };
  return (
    <Modal wide title="My projects" foot={<button className="btn" onClick={() => ed.closeDialog()}>Close</button>}>
      {!list && !err && <p className="dim">Loading…</p>}
      {list?.length === 0 && <p className="dim">Nothing saved yet. Save a sprite with Ctrl+S and it will be here.</p>}
      <div className="project-list">
        {list?.map((p) => (
          <div className="project" key={p.id}>
            <button className="thumb" onClick={() => open(p.id, !!p.hasNewerAutosave && (p as any).neverSaved)} title="Open">
              {p.thumbnail ? <img src={p.thumbnail} alt="" /> : null}
            </button>
            <div className="grow">
              <b>{p.name}</b>
              <div className="dim">{new Date(p.modified).toLocaleString()}</div>
              {p.hasNewerAutosave && <div className="warn">Has unsaved recovered changes</div>}
            </div>
            <button className="btn" onClick={async () => { try { await open(p.id, false); } catch { /* reported inside */ } }}>Open</button>
            {p.hasNewerAutosave && <button className="btn" onClick={() => open(p.id, true)}>Recover</button>}
            <button className="btn danger" title="Moves it to a trash folder inside the projects folder" onClick={async () => { await api.remove(p.id); refresh(); }}>Delete</button>
          </div>
        ))}
      </div>
      {err && <p className="warn">{err}</p>}
    </Modal>
  );
}

function RecoveryDialog({ items }: { items: { id: string; name: string; modified: number }[] }) {
  return (
    <Modal title="Recover unsaved work?" foot={<button className="btn" onClick={() => ed.closeDialog()}>Not now</button>}>
      <p>These were still open with unsaved changes when SpriteCraft last closed:</p>
      {items.map((p) => (
        <div className="row" key={p.id}>
          <b className="grow">{p.name}</b>
          <button className="btn primary" onClick={async () => {
            try {
              const doc = await api.open(p.id, true);
              const hasSave = await api.hasSave(p.id);
              const s = ed.openDoc(doc, !hasSave, p.id);
              s.savedDoc = null; s.autosavedDoc = doc;
              const rest = items.filter((x) => x.id !== p.id);
              if (rest.length) ed.openDialog('recovery', { items: rest }); else ed.closeDialog();
            } catch (e: any) { ed.toast(`Could not recover: ${e.message ?? e}`); }
          }}>Recover</button>
          <button className="btn" onClick={async () => {
            await api.discardAutosave(p.id);
            const rest = items.filter((x) => x.id !== p.id);
            if (rest.length) ed.openDialog('recovery', { items: rest }); else ed.closeDialog();
          }}>Discard</button>
        </div>
      ))}
    </Modal>
  );
}

function CloseDialog({ index }: { index: number }) {
  const s = ed.sessions[index];
  return (
    <Modal title="Unsaved changes" foot={<>
      <button className="btn danger" onClick={() => { const id = s.projectId, never = s.neverSaved; ed.closeDialog(); ed.closeSession(index); api.discardAutosave(id).catch(() => {}); if (never) api.remove(id).catch(() => {}); }}>Don't save</button>
      <span className="grow" /><CancelBtn />
      <button className="btn primary" onClick={async () => { ed.switchTo(index); ed.closeDialog(); await saveCurrent(); ed.closeSession(ed.active); }}>Save</button>
    </>}>
      <p>Save the changes to “{s.doc.name}” before closing?</p>
    </Modal>
  );
}

// ---- Shortcuts

function ShortcutsDialog() {
  useEd();
  const [capture, setCapture] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!capture) return;
    const k = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setCapture(null); return; }
      const n = keyName(e);
      if (n) { setKey(capture, n); setCapture(null); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [capture]);
  const rows = [
    ...tools.map((t) => ({ id: 'tool:' + t.id, group: 'Tools', label: t.label })),
    ...commands.map((c) => ({ id: c.id, group: c.group, label: c.label })),
  ].filter((r) => !filter || r.label.toLowerCase().includes(filter.toLowerCase()));
  const used = new Map<string, number>();
  for (const r of rows) { const k = keyOf(r.id); if (k) used.set(k, (used.get(k) ?? 0) + 1); }
  return (
    <Modal wide title="Keyboard shortcuts" foot={<><button className="btn" onClick={resetKeys}>Reset all</button><span className="grow" /><button className="btn primary" onClick={() => ed.closeDialog()}>Done</button></>}>
      <input placeholder="Search…" aria-label="Search shortcuts" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="keys">
        {rows.map((r) => {
          const k = keyOf(r.id);
          return (
            <div className="key-row" key={r.id}>
              <span className="dim">{r.group}</span><span className="grow">{r.label}</span>
              {k && (used.get(k) ?? 0) > 1 && <span className="warn" title="Another action uses this key">clash</span>}
              <button className={'btn keycap' + (capture === r.id ? ' on' : '')} onClick={() => setCapture(r.id)}>{capture === r.id ? 'Press a key…' : k ? prettyKey(k) : 'None'}</button>
              {k && <button className="mini" aria-label={`Clear shortcut for ${r.label}`} onClick={() => setKey(r.id, '')}>×</button>}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function AboutDialog() {
  return (
    <Modal wide title="SpriteCraft 1.0: what's in this version" foot={<button className="btn primary" onClick={() => ed.closeDialog()}>Close</button>}>
      <p>The pixel editor at the core of SpriteCraft (Phase 1), plus the first part of the Animation Studio (Phase 2). Everything you can see in the app works.</p>
      <h4>Here now</h4>
      <p className="dim">Drawing tools, shapes, fills, dithering, selections, transforms, layers with groups, masks, clipping and blend modes, palettes and indexed colour, frames, tags and onion skin, grids including isometric, PNG, GIF, sprite sheet and .aseprite files, autosave and recovery, and sending sprites to GameCraft and LogicCraft.</p>
      <p className="dim"><b>New in 0.2:</b> tweens with keyframes for position, rotation, scale, opacity, hue and brightness; easing presets, steps and a custom curve editor; curved motion paths; squash and stretch; generated frames you can paint over. Wave warp, animating any effect's settings across frames, animated brushes made from several frames, and a live brush (spacing, scatter, size and colour variation, pen pressure, turning).</p>
      <p className="dim"><b>New in 0.3:</b> the Rig (Sprite › Rig, Ctrl+Shift+3). Hang a character drawn in parts on a 3D skeleton and turn it in real time. Parts are balls, tubes, boxes or cards, or carved from your front and side drawings; ¾ and back views are used when drawn. Arms and legs bend at elbows and knees you add. Drag the bones in the preview to pose and key them. Render a frame, a keyed animation or a turnaround as ordinary pixels.</p>
      <p className="dim"><b>New in 0.4:</b> Lighting (Sprite › Lighting, Ctrl+Shift+4). Make normal maps from your art, with each layer as its own rounded shape, or paint them with the normal picker. Add point, spot and sun lights, drag them around, key and flicker them, shade in clean steps, and render lit frames.</p>
      <p className="dim"><b>New in 0.5:</b> Shaders (Sprite › Shaders, Ctrl+Shift+5). Stack live effects on a layer: water with reflections, ripples and trails, heat haze, wobble, palette and hue cycling, gradient maps, dissolve, glitch, glow, halftone and your own formulas. Key their settings, save presets and share them as files.</p>
      <p className="dim"><b>New in 0.6:</b> Particles (Sprite › Particles, Ctrl+Shift+6). Pixel particle systems on their own layer: fire, smoke, sparks, magic, explosions and more, drawn in whole pixels with stepped colours and dithered fades, looping perfectly over the animation. Several emitters, emitter shapes, gravity, wind, drag, turbulence, swirl, pull points, floors and bouncing off your art, masks, your own art as the particle, bake to frames, and import and export of ParticleCraft real-time effects.</p>
      <p className="dim"><b>New in 0.7:</b> Weather (Sprite › Weather, Ctrl+Shift+7, or the Water &amp; Weather Studio workspace). Pixel rain and snow on a layer, looping over the animation: moods from drizzle to storm and light snow to blizzard, density, speed, wind, streak length, perspective, far, middle and near layers (split into front and back layers), splashes, ripples on puddles you paint, landing on your art, snow that settles or builds up, and your own flake pictures. Bake it, or save it alone as transparent PNG frames.</p>
      <p className="dim"><b>New in 0.8:</b> the Node editor (Sprite › Node editor, Ctrl+Shift+8, or the Node Editor workspace). Wire nodes together on a layer: this layer, other layers (hidden ones too), everything below, colours, noise and gradients; every shader and effect; normal maps, height maps and lights; masks, blending, silhouettes and moving; particles and weather; animated by Time and Maths feeding any number setting. Each node previews its result. Start from presets, save your own, share them as files, and bake. It's optional: every panel still works on its own.</p>
      <p className="dim"><b>New in 1.0</b> (the polish release, completing all nine planned parts): Tutorials (View › Tutorials): five hands-on lessons that tick off each step as you do it. Live effects are kept once drawn, so playback and redraws with shaders, particles, weather and nodes are many times faster; View › Performance shows what each costs and has settings for slower machines. A live effect or panel that fails no longer stops the rest of SpriteCraft. .aseprite export now keeps what you see from live effects. And an installer: per user, no administrator rights, with Start menu and desktop shortcuts and an uninstaller in Apps &amp; features.</p>
      <h4>Not here yet</h4>
      <p className="dim">Tilemap editing, an on-canvas gizmo for warp regions, smooth skinned bends and painted depth for the rig, per-layer normal maps, GPU shaders, the shader and water systems, the pixel particle editor, weather, the node editor and plugins. These are planned as later phases.</p>
    </Modal>
  );
}

function NoticeDialog({ title, lines }: { title: string; lines: string[] }) {
  return (
    <Modal title={title} foot={<button className="btn primary" onClick={() => ed.closeDialog()}>OK</button>}>
      {lines.map((l, i) => <p key={i}>{l}</p>)}
    </Modal>
  );
}

export function DialogHost() {
  useEd();
  const dlg = ed.dialog;
  if (!dlg) return null;
  const p = dlg.props ?? {};
  switch (dlg.kind) {
    case 'new': return <NewDialog />;
    case 'canvas': return <CanvasDialog />;
    case 'scale': return <ScaleDialog />;
    case 'rename': return <RenameDialog />;
    case 'export': return <ExportDialog />;
    case 'send': return <SendDialog />;
    case 'receive': return <ReceiveDialog />;
    case 'sheet': return <SheetDialog file={p.file} />;
    case 'effect': return <EffectDialog key={p.id} id={p.id} />;
    case 'replace': return <ReplaceDialog />;
    case 'ramp': return <RampDialog />;
    case 'extract': return <ExtractDialog />;
    case 'color': return <ColorDialog index={p.index} />;
    case 'tag': return <TagDialog id={p.id} />;
    case 'projects': return <ProjectsDialog />;
    case 'recovery': return <RecoveryDialog items={p.items} />;
    case 'close': return <CloseDialog index={p.index} />;
    case 'shortcuts': return <ShortcutsDialog />;
    case 'about': return <AboutDialog />;
    case 'notice': return <NoticeDialog title={p.title} lines={p.lines} />;
    default: return null;
  }
}

export { openSequence };
