// The dockable panels: colour, palette, layers, canvas settings, preview and history.
import { useEffect, useRef, useState } from 'react';
import { A, B, G, R, fromHex, hsvToRgb, nearestIndex, rgba, rgbToHsv, toCss, toHex } from '../core/color';
import { blendModeLabel } from '../core/compose';
import { layerRows } from '../core/doc';
import { PALETTE_PRESETS, makeRamp, parsePaletteFile, paletteToGpl, paletteToHex } from '../core/palette';
import { BLEND_MODES, type Layer } from '../core/types';
import { runCommand } from '../editor/commands';
import { ed, savePref, useEd } from '../editor/editor';
import { pickFiles, saveBytes } from '../editor/files';
import { Icon } from './icons';
import { display } from './Viewport';

export function Btn({ icon, title, onClick, on, disabled, label }: { icon?: string; title: string; onClick: () => void; on?: boolean; disabled?: boolean; label?: string }) {
  return (
    <button className={'btn' + (on ? ' on' : '')} title={title} aria-label={title} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {icon && <Icon name={icon} />}{label}
    </button>
  );
}

export function Num({ value, onChange, min, max, step = 1, width = 54, title }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; width?: number; title?: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = (s: string) => {
    setText(null);
    let n = Number(s);
    if (!Number.isFinite(n) || s.trim() === '') return;
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    onChange(n);
  };
  return (
    <input className="num" style={{ width }} title={title} type="number" min={min} max={max} step={step}
      value={text ?? value}
      onChange={(e) => {
        setText(e.target.value);
        // Spinner clicks and typed values apply live when they are valid.
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }} />
  );
}

// ---- Colour picker

function SvPicker({ h, s, v, onChange }: { h: number; s: number; v: number; onChange: (s: number, v: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!, g = c.getContext('2d')!;
    const w = c.width, hh = c.height;
    const [r, gg, b] = hsvToRgb(h, 1, 1);
    g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(0, 0, w, hh);
    const a = g.createLinearGradient(0, 0, w, 0); a.addColorStop(0, '#fff'); a.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = a; g.fillRect(0, 0, w, hh);
    const d = g.createLinearGradient(0, 0, 0, hh); d.addColorStop(0, 'rgba(0,0,0,0)'); d.addColorStop(1, '#000');
    g.fillStyle = d; g.fillRect(0, 0, w, hh);
  }, [h]);
  const set = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  };
  return (
    <div className="sv" onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); set(e); }} onPointerMove={(e) => { if (e.buttons) set(e); }}>
      <canvas ref={ref} width={200} height={120} />
      <i style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
    </div>
  );
}

function Strip({ value, max, background, onChange, label }: { value: number; max: number; background: string; onChange: (n: number) => void; label: string }) {
  const set = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onChange(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * max));
  };
  return (
    <div className="strip" style={{ background }} title={label} role="slider" aria-label={label} aria-valuenow={value} aria-valuemax={max}
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); set(e); }} onPointerMove={(e) => { if (e.buttons) set(e); }}>
      <i style={{ left: `${(value / max) * 100}%` }} />
    </div>
  );
}

const CHECK = 'repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0/8px 8px';

export function ColorPanel() {
  useEd();
  const c = ed.fg;
  // Hue and saturation are kept apart from the colour so they survive passing through black, white or grey.
  const memo = useRef({ h: 0, s: 0, c: -1 });
  const [h0, s0, v] = rgbToHsv(R(c), G(c), B(c));
  if (memo.current.c !== c) { memo.current = { h: s0 > 0 && v > 0 ? h0 : memo.current.h, s: v > 0 ? s0 : memo.current.s, c }; }
  const { h, s } = memo.current;
  const setHsv = (nh: number, ns: number, nv: number) => {
    const [r, g, b] = hsvToRgb(nh, ns, nv);
    const nc = rgba(r, g, b, A(c));
    memo.current = { h: nh, s: ns, c: ed.doc.colorMode === 'indexed' ? -1 : nc };
    ed.setFg(nc);
  };
  const [hex, setHex] = useState<string | null>(null);
  const channel = (k: 'r' | 'g' | 'b' | 'a', val: number) => ed.setFg(rgba(k === 'r' ? val : R(c), k === 'g' ? val : G(c), k === 'b' ? val : B(c), k === 'a' ? val : A(c)));
  return (
    <div className="color-panel">
      <SvPicker h={h} s={s} v={v} onChange={(ns, nv) => setHsv(h, ns, nv)} />
      <Strip label="Hue" value={Math.round(h)} max={360} background="linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" onChange={(n) => setHsv(n, s, v)} />
      <Strip label="Opacity" value={A(c)} max={255} background={`linear-gradient(90deg,transparent,${toHex(c)}), ${CHECK}`} onChange={(n) => channel('a', n)} />
      <div className="row">
        <div className="chips">
          <button className="chip bg" title="Background colour" style={{ background: toCss(ed.bg) }} onClick={() => ed.swapColors()} />
          <button className="chip fg" title="Foreground colour" style={{ background: toCss(c) }} />
        </div>
        <Btn icon="swap" title="Swap colours (X)" onClick={() => ed.swapColors()} />
        <input className="hex" aria-label="Colour code" value={hex ?? toHex(c, true)} spellCheck={false}
          onChange={(e) => { setHex(e.target.value); const n = fromHex(e.target.value); if (n !== null) ed.setFg(n); }}
          onBlur={() => setHex(null)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </div>
      <div className="rgb">
        {(['r', 'g', 'b'] as const).map((k) => <label key={k}>{k.toUpperCase()}<Num value={k === 'r' ? R(c) : k === 'g' ? G(c) : B(c)} min={0} max={255} width={46} onChange={(n) => channel(k, n)} /></label>)}
      </div>
    </div>
  );
}

// ---- Palette

export function PalettePanel() {
  useEd();
  const d = ed.doc, pal = d.palette;
  const fgI = pal.indexOf(ed.fg);
  const addFg = () => { if (!pal.includes(ed.fg)) ed.setPalette([...pal, (ed.fg | 0xff000000) >>> 0], 'Add colour'); };
  const del = () => {
    const i = fgI >= 0 ? fgI : nearestIndex(ed.fg, pal);
    if (i < 0 || pal.length <= 1) return;
    ed.setPalette(pal.filter((_, n) => n !== i), 'Remove colour');
    ed.setFg(ed.doc.palette[Math.min(i, ed.doc.palette.length - 1)]);
  };
  const sort = (key: 'hue' | 'light') => {
    const val = (c: number) => { const [h, s, v] = rgbToHsv(R(c), G(c), B(c)); return key === 'hue' ? (s < 0.08 ? -1 : h) * 1000 + v : (R(c) * 0.3 + G(c) * 0.59 + B(c) * 0.11); };
    ed.setPalette([...pal].sort((a, b) => val(a) - val(b)), 'Sort palette');
  };
  const load = async () => {
    const [f] = await pickFiles('.gpl,.pal,.hex,.txt');
    if (!f) return;
    try { ed.setPalette(parsePaletteFile(await f.text()), 'Load palette'); ed.toast(`Loaded ${ed.doc.palette.length} colours.`); }
    catch (e: any) { ed.toast(e.message); }
  };
  return (
    <div className="palette-panel">
      <div className="row wrap">
        <select aria-label="Palette presets" value="" onChange={(e) => { const p = PALETTE_PRESETS[+e.target.value]; if (p) ed.setPalette([...p.colors], `Palette: ${p.name}`); }}>
          <option value="">Palettes…</option>
          {PALETTE_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name} ({p.colors.length})</option>)}
        </select>
        <Btn icon="plus" title="Add the foreground colour" onClick={addFg} />
        <Btn icon="minus" title="Remove the selected colour" onClick={del} disabled={pal.length <= 1} />
      </div>
      <div className="swatches" role="listbox" aria-label="Palette">
        {pal.map((c, i) => (
          <button key={i} className={'swatch' + (c === ed.fg ? ' fg' : '') + (c === ed.bg ? ' bg' : '')} title={`${i}: ${toHex(c, true)}. Click: foreground, right-click: background, double-click: edit`}
            style={{ background: toCss(c) }}
            onClick={() => ed.setFg(c)}
            onContextMenu={(e) => { e.preventDefault(); ed.setBg(c); }}
            onDoubleClick={() => ed.openDialog('color', { index: i })} />
        ))}
      </div>
      <div className="row wrap small">
        <button className="link" onClick={() => ed.openDialog('ramp')}>Make ramp…</button>
        <button className="link" onClick={() => ed.openDialog('extract')}>From image…</button>
        <button className="link" onClick={() => sort('hue')}>Sort by hue</button>
        <button className="link" onClick={() => sort('light')}>Sort by light</button>
        <button className="link" onClick={load}>Load…</button>
        <button className="link" onClick={() => saveBytes(`${d.name}.gpl`, paletteToGpl(pal, d.name), 'GIMP palette')}>Save .gpl…</button>
        <button className="link" onClick={() => saveBytes(`${d.name}.hex`, paletteToHex(pal), 'HEX palette')}>Save .hex…</button>
      </div>
      <label className="check"><input type="checkbox" checked={d.colorMode === 'indexed'} onChange={(e) => ed.setColorMode(e.target.checked ? 'indexed' : 'rgba')} /> Indexed: lock art to this palette</label>
    </div>
  );
}

// ---- Layers

function LayerRow({ layer, depth }: { layer: Layer; depth: number }) {
  const s = ed.s;
  const [editing, setEditing] = useState(false);
  const active = s.layerId === layer.id;
  return (
    <div className={'layer-row' + (active ? ' active' : '') + (layer.visible ? '' : ' hidden')} style={{ paddingLeft: 4 + depth * 12 }} draggable={!editing}
      onClick={() => ed.selectLayer(layer.id)}
      onDragStart={(e) => { e.dataTransfer.setData('text/x-layer', layer.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-layer')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } }}
      onDragLeave={(e) => e.currentTarget.classList.remove('drop')}
      onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('drop'); const id = e.dataTransfer.getData('text/x-layer'); if (id && id !== layer.id) ed.dropLayer(id, layer.id); }}>
      <button className="mini" title={layer.visible ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); ed.patchLayer(layer.id, { visible: !layer.visible }, layer.visible ? 'Hide layer' : 'Show layer'); }}><Icon name={layer.visible ? 'eye' : 'eyeoff'} size={14} /></button>
      <button className="mini" title={layer.locked ? 'Unlock' : 'Lock'} onClick={(e) => { e.stopPropagation(); ed.patchLayer(layer.id, { locked: !layer.locked }, layer.locked ? 'Unlock layer' : 'Lock layer'); }}><Icon name={layer.locked ? 'lock' : 'unlock'} size={14} /></button>
      {layer.kind === 'group' && <button className="mini" title={layer.collapsed ? 'Open group' : 'Close group'} onClick={(e) => { e.stopPropagation(); ed.patchLayer(layer.id, { collapsed: !layer.collapsed }, 'Fold group'); }}>{layer.collapsed ? '▸' : '▾'}</button>}
      {layer.kind === 'group' && <Icon name="folder" size={14} />}
      {layer.clip && <span className="tagmark" title="Clipped to the layer below">⤵</span>}
      {editing
        ? <input autoFocus defaultValue={layer.name} className="rename" aria-label="Layer name" onClick={(e) => e.stopPropagation()}
          onBlur={(e) => { setEditing(false); if (e.target.value.trim() && e.target.value !== layer.name) ed.patchLayer(layer.id, { name: e.target.value.trim() }, 'Rename layer'); }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); }} />
        : <span className="name" onDoubleClick={() => setEditing(true)} title={`${layer.name}. Double-click to rename, drag to reorder. Drop on a group to put it inside.`}>{layer.name}{layer.kind === 'reference' ? ' (reference)' : ''}</span>}
      {layer.alphaLock && <span className="tagmark" title="Alpha locked"><Icon name="alpha" size={12} /></span>}
      {layer.mask && (
        <button className={'mini maskchip' + (active && s.editMask ? ' on' : '') + (layer.maskEnabled ? '' : ' off')} title="Layer mask: click to paint on it. Painting hides the layer, erasing reveals it."
          onClick={(e) => { e.stopPropagation(); ed.selectLayer(layer.id); ed.s.editMask = !(active && s.editMask); ed.notify(); }}><Icon name="mask" size={14} /></button>
      )}
    </div>
  );
}

export function LayersPanel() {
  useEd();
  const l = ed.layer, s = ed.s;
  const rows = layerRows(ed.doc);
  return (
    <div className="layers-panel">
      <div className="row">
        <select aria-label="Blend mode" title="Blend mode" value={l?.blend ?? 'normal'} disabled={!l} onChange={(e) => ed.setBlend(l!.id, e.target.value as any)}>
          {BLEND_MODES.map((m) => <option key={m} value={m}>{blendModeLabel(m)}</option>)}
        </select>
        <label className="opacity" title="Layer opacity">
          <input type="range" min={0} max={255} value={l?.opacity ?? 255} disabled={!l} onChange={(e) => {
            // One drag is one undo step: only the first change of a drag records history.
            const v = +e.target.value;
            if (!opacityDrag.active) { opacityDrag.active = true; ed.patchLayer(l!.id, { opacity: v }, 'Change opacity'); }
            else { ed.s.doc = { ...ed.doc, layers: ed.doc.layers.map((x) => (x.id === l!.id ? { ...x, opacity: v } : x)) }; ed.invalidate(); ed.notify(); }
          }} onPointerUp={() => { opacityDrag.active = false; }} onKeyUp={() => { opacityDrag.active = false; }} />
          <span>{Math.round(((l?.opacity ?? 255) / 255) * 100)}%</span>
        </label>
      </div>
      <div className="row">
        <Btn icon="alpha" title="Alpha lock: painting keeps the existing transparency" on={l?.alphaLock} disabled={!l || l.kind !== 'image'} onClick={() => ed.patchLayer(l!.id, { alphaLock: !l!.alphaLock }, 'Alpha lock')} />
        <Btn icon="clip" title="Clipping mask: show only where the layer below has pixels" on={l?.clip} disabled={!l || l.kind !== 'image'} onClick={() => ed.patchLayer(l!.id, { clip: !l!.clip }, 'Clipping mask')} />
        <Btn icon="mask" title={l?.mask ? 'Turn the layer mask on or off' : 'Add a layer mask'} on={l?.mask && l.maskEnabled} disabled={!l || l.kind !== 'image'} onClick={() => { if (l!.mask) ed.patchLayer(l!.id, { maskEnabled: !l!.maskEnabled }, 'Toggle layer mask'); else ed.addMask(); }} />
        {l?.mask && <>
          <button className="link" onClick={() => ed.removeMask(true)}>Apply</button>
          <button className="link" onClick={() => ed.removeMask(false)}>Delete</button>
        </>}
        {s.editMask && <span className="maskhint">Painting on mask</span>}
      </div>
      <div className="layer-list" role="list">
        {rows.map(({ layer, depth }) => <LayerRow key={layer.id} layer={layer} depth={depth} />)}
      </div>
      <div className="row bar">
        <Btn icon="plus" title="New layer" onClick={() => ed.addLayer()} />
        <Btn icon="folder" title="New group" onClick={() => ed.addLayer('group')} />
        <Btn icon="copy" title="Duplicate layer" onClick={() => ed.duplicateLayer()} />
        <Btn icon="trash" title="Delete layer" onClick={() => ed.removeLayer()} disabled={ed.doc.layers.length <= 1} />
        <Btn icon="up" title="Move up" onClick={() => ed.moveLayer(s.layerId, 1)} />
        <Btn icon="down" title="Move down" onClick={() => ed.moveLayer(s.layerId, -1)} />
        <button className="btn" title="Merge down" onClick={() => ed.mergeDown()}>Merge</button>
      </div>
    </div>
  );
}
const opacityDrag = { active: false };

// ---- Canvas settings

export function CanvasPanel() {
  useEd();
  const d = ed.doc, g = d.grid, sym = ed.sym, o = ed.onion;
  const setGrid = (patch: Partial<typeof g>) => { ed.s.doc = { ...ed.doc, grid: { ...g, ...patch } }; ed.notify(); };
  const setOnion = (patch: Partial<typeof o>) => { ed.onion = { ...o, ...patch }; savePref('onion', ed.onion); ed.notify(); };
  const setGuides = (guides: typeof d.guides) => { ed.s.doc = { ...ed.doc, guides }; ed.notify(); };
  return (
    <div className="canvas-panel">
      <h4>Grids</h4>
      <label className="check"><input type="checkbox" checked={g.pixelGrid} onChange={(e) => setGrid({ pixelGrid: e.target.checked })} /> Pixel grid (at 8× and closer)</label>
      <label className="check"><input type="checkbox" checked={g.showTile} onChange={(e) => setGrid({ showTile: e.target.checked })} /> Tile grid</label>
      <div className="row indent">
        <label>W<Num value={g.tileW} min={1} max={1024} width={46} onChange={(n) => setGrid({ tileW: n })} /></label>
        <label>H<Num value={g.tileH} min={1} max={1024} width={46} onChange={(n) => setGrid({ tileH: n })} /></label>
        <label>X<Num value={g.offX} width={42} onChange={(n) => setGrid({ offX: n })} /></label>
        <label>Y<Num value={g.offY} width={42} onChange={(n) => setGrid({ offY: n })} /></label>
      </div>
      <label className="field">Isometric
        <select value={g.iso} onChange={(e) => setGrid({ iso: e.target.value as any })}>
          <option value="off">Off</option>
          <option value="iso">2:1 isometric</option>
          <option value="diamond">1:1 diamond</option>
        </select>
        <Num title="Cell width" value={g.isoW} min={2} max={512} width={50} onChange={(n) => setGrid({ isoW: n })} />
      </label>
      <label className="check"><input type="checkbox" checked={g.snap} onChange={(e) => setGrid({ snap: e.target.checked })} /> Snap: shapes to the tile grid, lines to iso angles</label>
      <h4>Symmetry</h4>
      <div className="row">
        <Btn label="Left / right" title="Mirror across a vertical axis" on={sym.x} onClick={() => { ed.sym = { ...sym, x: !sym.x }; ed.notify(); }} />
        <Btn label="Top / bottom" title="Mirror across a horizontal axis" on={sym.y} onClick={() => { ed.sym = { ...sym, y: !sym.y }; ed.notify(); }} />
      </div>
      <div className="row indent">
        <label>Axis X<Num value={sym.cx} min={0} max={d.width} step={0.5} width={58} onChange={(n) => { ed.sym = { ...ed.sym, cx: n }; ed.notify(); }} /></label>
        <label>Y<Num value={sym.cy} min={0} max={d.height} step={0.5} width={58} onChange={(n) => { ed.sym = { ...ed.sym, cy: n }; ed.notify(); }} /></label>
      </div>
      <h4>Guides</h4>
      {d.guides.map((gd, i) => (
        <div className="row indent" key={i}>
          <span className="dim">{gd.axis === 'x' ? 'Vertical at' : 'Horizontal at'}</span>
          <Num value={gd.pos} min={0} max={gd.axis === 'x' ? d.width : d.height} width={56} onChange={(n) => setGuides(d.guides.map((q, k) => (k === i ? { ...q, pos: n } : q)))} />
          <Btn icon="minus" title="Remove guide" onClick={() => setGuides(d.guides.filter((_, k) => k !== i))} />
        </div>
      ))}
      <div className="row">
        <button className="link" onClick={() => setGuides([...d.guides, { axis: 'x', pos: Math.floor(d.width / 2) }])}>Add vertical</button>
        <button className="link" onClick={() => setGuides([...d.guides, { axis: 'y', pos: Math.floor(d.height / 2) }])}>Add horizontal</button>
      </div>
      <h4>Onion skin</h4>
      <label className="check"><input type="checkbox" checked={o.on} onChange={(e) => { setOnion({ on: e.target.checked }); }} /> Show nearby frames</label>
      <div className="row indent">
        <label>Before<Num value={o.before} min={0} max={8} width={42} onChange={(n) => setOnion({ before: n })} /></label>
        <label>After<Num value={o.after} min={0} max={8} width={42} onChange={(n) => setOnion({ after: n })} /></label>
      </div>
      <label className="field">Strength<input type="range" min={20} max={200} value={o.opacity} onChange={(e) => setOnion({ opacity: +e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={o.tint} onChange={(e) => setOnion({ tint: e.target.checked })} /> Red for before, blue for after</label>
    </div>
  );
}

// ---- Preview

export function PreviewPanel() {
  useEd();
  const ref = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(2);
  const [tiled, setTiled] = useState(false);
  const d = ed.doc;
  useEffect(() => {
    const c = ref.current!, g = c.getContext('2d')!;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const src = display.canvas;
      if (!src) return;
      const rep = tiled ? 3 : 1;
      const w = src.width * zoom * rep, h = src.height * zoom * rep;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, w, h);
      for (let y = 0; y < rep; y++) for (let x = 0; x < rep; x++) g.drawImage(src, x * src.width * zoom, y * src.height * zoom, src.width * zoom, src.height * zoom);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [zoom, tiled, d.width, d.height]);
  return (
    <div className="preview-panel">
      <div className="row">
        <select aria-label="Preview zoom" value={zoom} onChange={(e) => setZoom(+e.target.value)}>
          {[1, 2, 3, 4, 6, 8].map((z) => <option key={z} value={z}>{z}×</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={tiled} onChange={(e) => setTiled(e.target.checked)} /> Tiled</label>
        <Btn icon={ed.playing ? 'stop' : 'play'} title="Play / stop" onClick={() => ed.togglePlay()} />
      </div>
      <div className="preview-box"><canvas ref={ref} /></div>
    </div>
  );
}

// ---- History

export function HistoryPanel() {
  useEd();
  const s = ed.s;
  const undo = s.undo, redo = s.redo;
  const stepTo = (n: number) => { for (let i = 0; i < n; i++) ed.undo(); };
  return (
    <div className="history-panel">
      <div className="hist cur faint" onClick={() => stepTo(undo.length)}>Start</div>
      {undo.map((u, i) => <div key={i} className={'hist' + (i === undo.length - 1 ? ' cur' : '')} onClick={() => stepTo(undo.length - 1 - i)}>{u.label}</div>)}
      {[...redo].reverse().map((u, i) => <div key={'r' + i} className="hist redo" onClick={() => { for (let k = 0; k <= i; k++) ed.redo(); }}>{u.label}</div>)}
    </div>
  );
}

export { makeRamp, runCommand };
