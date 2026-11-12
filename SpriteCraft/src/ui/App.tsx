// The main window: menus, tabs, the options bar, the toolbox, docked panels and the status bar.
import { useEffect, useRef, useState } from 'react';
import { type Command, commands, handleKey, initCommands, keyOf, prettyKey, runCommand, setBrush } from '../editor/commands';
import { ed, loadPref, savePref, useEd } from '../editor/editor';
import { openFile, openSequence, pasteFromSystem } from '../editor/files';
import { api, startAutosave } from '../editor/store';
import { activeTool, tools } from '../editor/tools';
import { ContextMenuHost } from './ContextMenu';
import { DialogHost } from './Dialogs';
import { Icon } from './icons';
import { Btn, CanvasPanel, ColorPanel, HistoryPanel, LayersPanel, Num, PalettePanel, PreviewPanel } from './Panels';
import { Timeline } from './Timeline';
import { AnimatePanel } from './Animate';
import { BrushPanel, setDynamics } from './BrushPanel';
import { RigPanel } from './RigPanel';
import { LightPanel } from './LightPanel';
import { ShaderPanel } from './ShaderPanel';
import { ParticlePanel } from './ParticlePanel';
import { WeatherPanel } from './WeatherPanel';
import { NodePanel } from './NodePanel';
import { PerfPanel } from './PerfPanel';
import { PanelBoundary, TutorialPanel } from './Tutorials';
import { fxSettings } from '../core/compose';
import { display, Viewport } from './Viewport';
import { fitView, zoomStep } from './viewMath';

initCommands();
void display;
// Performance settings chosen in the Performance panel.
Object.assign(fxSettings, loadPref('performance', {}));

// ---- Menus

const MENU_ORDER = ['File', 'Edit', 'Select', 'Sprite', 'Layer', 'Frame', 'Effects', 'View'];
const HIDDEN = new Set(['redo2', 'delete2', 'swap', 'brush-up', 'brush-down', 'frame-first', 'frame-last', 'frame-prev', 'frame-next']);

function MenuBar({ workspaces }: { workspaces: React.ReactNode }) {
  useEd();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const run = (c: Command) => { setOpen(null); c.run(); };
  return (
    <div className="menubar" ref={ref} role="menubar">
      <span className="brand"><img src="./icon.png" alt="" width={18} height={18} />SpriteCraft</span>
      {MENU_ORDER.map((m) => (
        <div className="menu" key={m}>
          <button role="menuitem" className={'menu-btn' + (open === m ? ' on' : '')} onClick={() => setOpen(open === m ? null : m)} onPointerEnter={() => { if (open && open !== m) setOpen(m); }}>{m}</button>
          {open === m && (
            <div className="menu-pop" onClick={(e) => { if ((e.target as HTMLElement).closest('button')) setOpen(null); }}>
              {commands.filter((c) => c.group === m && !HIDDEN.has(c.id)).map((c) => (
                <button key={c.id} className="menu-item" onClick={() => run(c)}><span>{c.label}</span><kbd>{keyOf(c.id) ? prettyKey(keyOf(c.id)) : ''}</kbd></button>
              ))}
              {m === 'View' && workspaces}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Tabs() {
  useEd();
  return (
    <div className="tabs" role="tablist">
      {ed.sessions.map((s, i) => (
        <div key={s.projectId} role="tab" aria-selected={i === ed.active} className={'tab' + (i === ed.active ? ' on' : '')} onClick={() => ed.switchTo(i)} title={`${s.doc.name}, ${s.doc.width} × ${s.doc.height}`}>
          <span>{s.doc.name}{ed.isDirty(s) ? ' •' : ''}</span>
          <button className="mini" aria-label={`Close ${s.doc.name}`} onClick={(e) => { e.stopPropagation(); if (ed.isDirty(s)) ed.openDialog('close', { index: i }); else ed.closeSession(i); }}>×</button>
        </div>
      ))}
      <button className="mini addtab" title="New sprite (Ctrl+N)" onClick={() => runCommand('new')}><Icon name="plus" size={13} /></button>
    </div>
  );
}

// ---- Tool options

function Options() {
  useEd();
  const t = activeTool();
  const b = ed.brush, f = ed.fill;
  const setB = (patch: Partial<typeof b>) => { ed.brush = { ...b, ...patch }; savePref('brush', { ...ed.brush, custom: null, pattern: null, anim: null }); ed.notify(); };
  const setF = (patch: Partial<typeof f>) => { ed.fill = { ...f, ...patch }; savePref('fill', ed.fill); ed.notify(); };
  const has = (k: string) => t.options.includes(k);
  return (
    <div className="options">
      <b className="toolname">{t.label}</b>
      {has('brush') && (b.custom
        ? <>
          <span className="dim">{b.anim ? `Animated brush, ${b.anim.length} images of` : 'Custom brush'} {b.custom.w}×{b.custom.h}</span>
          <label className="check"><input type="checkbox" checked={b.customColors} onChange={(e) => setB({ customColors: e.target.checked })} /> Own colours</label>
          {b.anim && <>
            <select aria-label="Animated brush steps" title="When the brush moves to its next image" value={b.animMode} onChange={(e) => setB({ animMode: e.target.value as 'dab' | 'frame' })}>
              <option value="dab">Next image along the stroke</option>
              <option value="frame">Image matching this frame</option>
            </select>
            {b.animMode === 'dab' && <label title="Dabs (pixels of stroke) before the next image">every<Num value={b.animEvery} min={1} max={64} width={40} onChange={(n) => setB({ animEvery: n })} /></label>}
          </>}
          <button className="btn" onClick={() => setB({ custom: null, anim: null })}>Clear</button>
        </>
        : <>
          <label title="Brush size ([ and ])">Size
            <input type="range" min={1} max={64} value={b.size} onChange={(e) => setBrush(+e.target.value)} />
            <Num value={b.size} min={1} max={64} width={44} onChange={setBrush} />
          </label>
          <Btn label="Round" title="Round brush" on={b.shape === 'circle'} onClick={() => setB({ shape: 'circle' })} />
          <Btn label="Square" title="Square brush" on={b.shape === 'square'} onClick={() => setB({ shape: 'square' })} />
        </>)}
      {has('brush') && <Btn label="Live" title="Live brush: spacing, scatter, size and colour variation, turning. Settings are in the Brush panel." on={b.dyn.on} onClick={() => { setDynamics({ on: !b.dyn.on }); if (!b.dyn.on) ed.showPanel?.('brush'); }} />}
      {has('opacity') && ed.doc.colorMode !== 'indexed' && <label title="Opacity of what this tool lays down">Opacity
        <input type="range" min={1} max={255} value={b.opacity} onChange={(e) => setB({ opacity: +e.target.value })} />
        <span className="val">{Math.round((b.opacity / 255) * 100)}%</span>
      </label>}
      {has('pixelPerfect') && !b.custom && <label className="check" title="Cleans L-shaped corners as you draw. Works at size 1."><input type="checkbox" checked={b.pixelPerfect} disabled={b.size !== 1} onChange={(e) => setB({ pixelPerfect: e.target.checked })} /> Pixel perfect</label>}
      {has('filled') && <label className="check"><input type="checkbox" checked={ed.shape.filled} onChange={(e) => { ed.shape = { ...ed.shape, filled: e.target.checked }; ed.notify(); }} /> Filled</label>}
      {has('dither') && <label>Pattern
        <select value={b.ditherKind} onChange={(e) => setB({ ditherKind: e.target.value as any })}>
          <option value="checker">Checker</option><option value="bayer2">Bayer 2×2</option><option value="bayer4">Bayer 4×4</option><option value="bayer8">Bayer 8×8</option>
        </select></label>}
      {has('density') && <>
        <label>Density<input type="range" min={0} max={100} value={Math.round(b.density * 100)} onChange={(e) => setB({ density: +e.target.value / 100 })} /><span className="val">{Math.round(b.density * 100)}%</span></label>
        <label className="check"><input type="checkbox" checked={b.ditherBg} onChange={(e) => setB({ ditherBg: e.target.checked })} /> Fill gaps</label>
      </>}
      {has('patternPick') && <>
        <span className="dim">{b.pattern ? `Pattern ${b.pattern.w}×${b.pattern.h}` : 'No pattern yet'}</span>
        <button className="btn" onClick={() => runCommand('pattern-from-sel')}>Set from selection</button>
      </>}
      {has('shade') && <label>Step<Num value={b.shadeStep} min={1} max={16} width={44} onChange={(n) => setB({ shadeStep: n })} /></label>}
      {has('tolerance') && <label title="How far from the clicked colour still counts as the same">Tolerance<input type="range" min={0} max={128} value={f.tolerance} onChange={(e) => setF({ tolerance: +e.target.value })} /><span className="val">{f.tolerance}</span></label>}
      {has('contiguous') && <label className="check"><input type="checkbox" checked={f.contiguous} onChange={(e) => setF({ contiguous: e.target.checked })} /> Contiguous</label>}
      {has('sampleAll') && <label className="check"><input type="checkbox" checked={f.sampleAll} onChange={(e) => setF({ sampleAll: e.target.checked })} /> All layers</label>}
      {has('gradient') && <>
        <label>Shape<select value={ed.gradient.kind} onChange={(e) => { ed.gradient = { ...ed.gradient, kind: e.target.value as any }; ed.notify(); }}><option value="linear">Linear</option><option value="radial">Radial</option></select></label>
        <label>To<select value={ed.gradient.end} onChange={(e) => { ed.gradient = { ...ed.gradient, end: e.target.value as any }; ed.notify(); }}><option value="background">Background colour</option><option value="transparent">Transparent</option><option value="palette">Palette entries</option></select></label>
        <label>Dither<select value={ed.gradient.dither} onChange={(e) => { ed.gradient = { ...ed.gradient, dither: e.target.value as any }; ed.notify(); }}><option value="none">None (bands)</option><option value="checker">Checker</option><option value="bayer2">Bayer 2×2</option><option value="bayer4">Bayer 4×4</option><option value="bayer8">Bayer 8×8</option></select></label>
      </>}
      {has('selectMode') && <div className="seg" role="group" aria-label="Selection mode">
        {([['replace', 'New'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']] as const).map(([m, label]) => <Btn key={m} label={label} title={`${label} selection`} on={ed.select.mode === m} onClick={() => { ed.select = { ...ed.select, mode: m }; ed.notify(); }} />)}
      </div>}
      {has('selectFlood') && <>
        <label>Tolerance<input type="range" min={0} max={128} value={ed.select.tolerance} onChange={(e) => { ed.select = { ...ed.select, tolerance: +e.target.value }; ed.notify(); }} /><span className="val">{ed.select.tolerance}</span></label>
        <label className="check"><input type="checkbox" checked={ed.select.contiguous} onChange={(e) => { ed.select = { ...ed.select, contiguous: e.target.checked }; ed.notify(); }} /> Contiguous</label>
        <label className="check"><input type="checkbox" checked={ed.select.sampleAll} onChange={(e) => { ed.select = { ...ed.select, sampleAll: e.target.checked }; ed.notify(); }} /> All layers</label>
      </>}
      {has('rotateQuality') && <label title="How rotated pixels are chosen">Rotation
        <select value={ed.rotateQuality} onChange={(e) => { ed.rotateQuality = e.target.value as any; ed.renderFloat(); ed.notify(); }}>
          <option value="smooth-edges">Clean edges</option><option value="nearest">Nearest</option>
        </select></label>}
      {has('transformActions') && ed.s.float && <>
        <Btn label="Flip H" title="Flip horizontal" onClick={() => runCommand('flip-h')} />
        <Btn label="Flip V" title="Flip vertical" onClick={() => runCommand('flip-v')} />
        <Btn label="90° ↷" title="Rotate 90° right" onClick={() => runCommand('rot-90')} />
        <button className="btn primary" onClick={() => ed.commitFloat()}>Apply</button>
        <button className="btn" onClick={() => ed.cancelFloat()}>Cancel</button>
      </>}
      {t.hint && <span className="hint" title={t.hint}>{t.hint}</span>}
    </div>
  );
}

// ---- Toolbox

function Toolbox() {
  useEd();
  const groups = ['draw', 'shape', 'fill', 'select', 'view'] as const;
  return (
    <div className="toolbox" role="toolbar" aria-label="Tools">
      {groups.map((g) => (
        <div className="toolgroup" key={g}>
          {tools.filter((t) => t.group === g).map((t) => {
            const k = keyOf('tool:' + t.id);
            return (
              <button key={t.id} data-tool={t.id} aria-label={t.label} aria-pressed={ed.toolId === t.id} className={'tool' + (ed.toolId === t.id ? ' on' : '')} title={`${t.label}${k ? ` (${prettyKey(k)})` : ''}`} onClick={() => ed.setTool(t.id)}>
                <Icon name={t.id} size={18} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---- Docking

interface FloatPanel { id: string; x: number; y: number; w: number; h: number }
interface Layout {
  left: string[]; right: string[]; bottom: string[];
  floating: FloatPanel[];
  leftW: number; rightW: number; bottomH: number;
  weights: Record<string, number>;
  collapsed: Record<string, boolean>;
}

const PANELS: Record<string, { title: string; el: () => JSX.Element }> = {
  color: { title: 'Colour', el: ColorPanel },
  palette: { title: 'Palette', el: PalettePanel },
  layers: { title: 'Layers', el: LayersPanel },
  canvas: { title: 'Canvas', el: CanvasPanel },
  preview: { title: 'Preview', el: PreviewPanel },
  history: { title: 'History', el: HistoryPanel },
  timeline: { title: 'Timeline', el: Timeline },
  animate: { title: 'Animate', el: AnimatePanel },
  brush: { title: 'Brush', el: BrushPanel },
  rig: { title: 'Rig (3D)', el: RigPanel },
  light: { title: 'Lighting', el: LightPanel },
  shaders: { title: 'Shaders', el: ShaderPanel },
  particles: { title: 'Particles', el: ParticlePanel },
  weather: { title: 'Weather', el: WeatherPanel },
  nodes: { title: 'Nodes', el: NodePanel },
  perf: { title: 'Performance', el: PerfPanel },
  tutorials: { title: 'Tutorials', el: TutorialPanel },
};

const pixelArtLayout: Layout = { left: [], right: ['color', 'palette', 'layers'], bottom: ['timeline'], floating: [], leftW: 250, rightW: 268, bottomH: 170, weights: { color: 0, palette: 1, layers: 1.3 }, collapsed: {} };
const animationLayout: Layout = { left: ['preview', 'animate', 'canvas'], right: ['color', 'palette', 'layers'], bottom: ['timeline'], floating: [], leftW: 268, rightW: 268, bottomH: 250, weights: { preview: 0.7, animate: 1.6, canvas: 0.8, color: 0, palette: 1, layers: 1.3 }, collapsed: { canvas: true } };
const rigLayout: Layout = { left: ['rig'], right: ['palette', 'layers'], bottom: ['timeline'], floating: [], leftW: 300, rightW: 268, bottomH: 170, weights: { rig: 1, palette: 0.7, layers: 1.2 }, collapsed: {} };
const lightLayout: Layout = { left: ['light'], right: ['palette', 'layers'], bottom: ['timeline'], floating: [], leftW: 300, rightW: 268, bottomH: 170, weights: { light: 1, palette: 0.7, layers: 1.2 }, collapsed: {} };
const shaderLayout: Layout = { left: ['shaders'], right: ['palette', 'layers'], bottom: ['timeline'], floating: [], leftW: 300, rightW: 268, bottomH: 170, weights: { shaders: 1, palette: 0.7, layers: 1.2 }, collapsed: {} };
const weatherLayout: Layout = { left: ['weather', 'shaders'], right: ['palette', 'layers'], bottom: ['timeline'], floating: [], leftW: 310, rightW: 268, bottomH: 170, weights: { weather: 1.4, shaders: 1, palette: 0.7, layers: 1.2 }, collapsed: { shaders: true }, };
const nodeLayout: Layout = { left: [], right: ['palette', 'layers'], bottom: ['nodes'], floating: [], leftW: 250, rightW: 268, bottomH: 400, weights: { nodes: 1, palette: 0.7, layers: 1.2 }, collapsed: {} };
const particleLayout: Layout ={ left: ['particles'], right: ['palette', 'layers'], bottom: ['timeline'], floating: [], leftW: 310, rightW: 268, bottomH: 170, weights: { particles: 1, palette: 0.7, layers: 1.2 }, collapsed: {} };
const BUILT_IN: Record<string, Layout> = { 'Pixel Art Editor': pixelArtLayout, 'Animation Studio': animationLayout, 'SpriteCraft 3D (rig)': rigLayout, 'Lighting Studio': lightLayout, 'Shader Studio': shaderLayout, ParticleCraft: particleLayout, 'Water & Weather Studio': weatherLayout, 'Node Editor': nodeLayout };

/** Drops panels this version doesn't have from a saved layout, so an old or renamed panel can't break the window. */
const knownPanels = (l: Layout): Layout => ({
  ...l,
  left: l.left.filter((id) => PANELS[id]), right: l.right.filter((id) => PANELS[id]), bottom: l.bottom.filter((id) => PANELS[id]),
  floating: l.floating.filter((f) => PANELS[f.id]),
});

const allDocked = (l: Layout) => [...l.left, ...l.right, ...l.bottom, ...l.floating.map((f) => f.id)];

function PanelFrame({ id, onDragStart, onFloat, onClose, collapsed, onCollapse, floating }: { id: string; onDragStart: (e: React.PointerEvent) => void; onFloat: () => void; onClose: () => void; collapsed?: boolean; onCollapse?: () => void; floating?: boolean }) {
  const P = PANELS[id];
  return (
    <section className={'panel' + (collapsed ? ' collapsed' : '')} data-panel={id} aria-label={P.title}>
      <header onPointerDown={onDragStart}>
        {onCollapse && <button className="mini" aria-label={collapsed ? 'Open panel' : 'Fold panel'} onPointerDown={(e) => e.stopPropagation()} onClick={onCollapse}>{collapsed ? '▸' : '▾'}</button>}
        <span>{P.title}</span>
        <i className="grow" />
        <button className="mini" title={floating ? 'Dock' : 'Float'} aria-label={floating ? 'Dock panel' : 'Float panel'} onPointerDown={(e) => e.stopPropagation()} onClick={onFloat}>{floating ? '⇲' : '⇱'}</button>
        <button className="mini" title="Close (reopen from the View menu)" aria-label={`Close ${P.title}`} onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>×</button>
      </header>
      {!collapsed && <div className="panel-body"><PanelBoundary name={P.title}><P.el /></PanelBoundary></div>}
    </section>
  );
}

function Splitter({ dir, onDrag }: { dir: 'x' | 'y'; onDrag: (delta: number) => void }) {
  return (
    <div className={'splitter ' + dir} role="separator" onPointerDown={(e) => {
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      let last = dir === 'x' ? e.clientX : e.clientY;
      const move = (ev: PointerEvent) => { const v = dir === 'x' ? ev.clientX : ev.clientY; onDrag(v - last); last = v; };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    }} />
  );
}

export function App() {
  useEd();
  const [layout, setLayoutRaw] = useState<Layout>(() => {
    const saved = loadPref<any>('layout', null);
    return saved?.right ? knownPanels({ ...pixelArtLayout, ...saved }) : pixelArtLayout;
  });
  const [workspaceName, setWorkspaceName] = useState<string>(() => { try { return localStorage.getItem('spritecraft.workspace') ?? 'Pixel Art Editor'; } catch { return 'Pixel Art Editor'; } });
  const [custom, setCustom] = useState<Record<string, Layout>>(() => loadPref<Record<string, Layout>>('workspaces', {}));
  const [dropZone, setDropZone] = useState<string | null>(null);
  const setLayout = (l: Layout) => { setLayoutRaw(l); savePref('layout', l); };
  const lref = useRef(layout); lref.current = layout;

  // Global wiring: keys, paste, drop, autosave, recovery.
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes((t as HTMLInputElement).type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (typing || ed.dialog) return;
      // Ctrl+V is left to the browser's paste event so images from other apps come through.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'v') return;
      if (handleKey(e)) e.preventDefault();
    };
    const paste = async (e: ClipboardEvent) => {
      if (ed.dialog) return;
      const t = e.target as HTMLElement;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      // A fresh image in the system clipboard wins over an older internal copy.
      if (!(await pasteFromSystem(e))) ed.paste();
    };
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      if (files.length > 1 && files.every((f) => /\.(png|jpe?g|webp|bmp)$/i.test(f.name))) openSequence(files);
      else for (const f of files) await openFile(f);
    };
    const unload = (e: BeforeUnloadEvent) => { if (ed.sessions.some((s) => ed.isDirty(s) && s.doc !== s.autosavedDoc)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', keydown);
    window.addEventListener('paste', paste);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('beforeunload', unload);
    const timer = startAutosave();
    api.list().then((list) => {
      const items = list.filter((p) => p.hasNewerAutosave);
      if (items.length && !ed.dialog) ed.openDialog('recovery', { items });
    }).catch(() => { /* Storage problems are reported when the user saves. */ });
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('paste', paste);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('beforeunload', unload);
      clearInterval(timer);
    };
  }, []);

  const removeFrom = (l: Layout, id: string): Layout => ({ ...l, left: l.left.filter((x) => x !== id), right: l.right.filter((x) => x !== id), bottom: l.bottom.filter((x) => x !== id), floating: l.floating.filter((f) => f.id !== id) });
  const makeFloat = (id: string, x = 200, y = 120) => {
    const h = id === 'timeline' ? 300 : 340, w = id === 'timeline' ? 700 : 280;
    setLayout({ ...removeFrom(lref.current, id), floating: [...lref.current.floating.filter((f) => f.id !== id), { id, x, y, w, h }] });
  };
  const dockTo = (id: string, zone: 'left' | 'right' | 'bottom') => {
    const l = removeFrom(lref.current, id);
    setLayout({ ...l, [zone]: [...(l as any)[zone], id], weights: { ...l.weights, [id]: l.weights[id] ?? 1 } });
  };
  // Lets actions elsewhere (such as the timeline's Tween button) bring a panel into view.
  ed.showPanel = (id: string) => {
    const l = lref.current;
    if (allDocked(l).includes(id)) { if (l.collapsed[id]) setLayout({ ...l, collapsed: { ...l.collapsed, [id]: false } }); return; }
    dockTo(id, 'left');
  };
  // The first time SpriteCraft opens, offer the tutorials.
  useEffect(() => {
    if (loadPref('tutorialsOffered', false)) return;
    savePref('tutorialsOffered', true);
    ed.showPanel?.('tutorials');
  }, []);

  const zoneAt = (x: number, y: number): 'left' | 'right' | 'bottom' | null => {
    const m = 70;
    if (x < m + 44) return 'left';
    if (x > window.innerWidth - m) return 'right';
    if (y > window.innerHeight - m) return 'bottom';
    return null;
  };

  /** Dragging a panel by its header: docked ones float after a short move; dropping at an edge docks. */
  const startDrag = (id: string) => (e: React.PointerEvent) => {
    if (e.button) return;
    const sx = e.clientX, sy = e.clientY;
    const fl = lref.current.floating.find((f) => f.id === id);
    const ox = fl?.x ?? sx - 100, oy = fl?.y ?? sy - 12;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!moved) { moved = true; if (!fl) makeFloat(id, ox, oy); }
      const nx = ox + ev.clientX - sx, ny = oy + ev.clientY - sy;
      setLayoutRaw((l) => ({ ...l, floating: l.floating.map((f) => (f.id === id ? { ...f, x: Math.max(0, Math.min(window.innerWidth - 80, nx)), y: Math.max(0, Math.min(window.innerHeight - 40, ny)) } : f)) }));
      setDropZone(zoneAt(ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDropZone(null);
      if (!moved) return;
      const z = zoneAt(ev.clientX, ev.clientY);
      if (z) dockTo(id, z); else savePref('layout', lref.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const closePanel = (id: string) => setLayout(removeFrom(lref.current, id));
  const toggleCollapse = (id: string) => setLayout({ ...lref.current, collapsed: { ...lref.current.collapsed, [id]: !lref.current.collapsed[id] } });

  const column = (ids: string[]) => ids.map((id, i) => {
    const weight = layout.weights[id] ?? 1;
    const col = layout.collapsed[id];
    return (
      <div key={id} className="dock-item" style={{ flex: col ? '0 0 auto' : weight ? `${weight} 1 0` : '0 0 auto' }}>
        <PanelFrame id={id} collapsed={col} onCollapse={() => toggleCollapse(id)} onDragStart={startDrag(id)} onFloat={() => makeFloat(id)} onClose={() => closePanel(id)} />
        {i < ids.length - 1 && !col && weight > 0 && (layout.weights[ids[i + 1]] ?? 1) > 0 && <Splitter dir="y" onDrag={(dy) => {
          const nextId = ids[i + 1];
          const a = lref.current.weights[id] ?? 1, b = lref.current.weights[nextId] ?? 1;
          const k = dy / 200;
          const na = Math.max(0.2, a + k), nb = Math.max(0.2, b - k);
          setLayout({ ...lref.current, weights: { ...lref.current.weights, [id]: na, [nextId]: nb } });
        }} />}
      </div>
    );
  });

  const applyWorkspace = (name: string, l: Layout) => { setLayout(l); setWorkspaceName(name); try { localStorage.setItem('spritecraft.workspace', name); } catch { /* fine */ } };

  const workspaces = (
    <>
      <div className="menu-sep">Workspaces</div>
      {[...Object.entries(BUILT_IN), ...Object.entries(custom)].map(([name, l]) => (
        <button key={name} className="menu-item" onClick={() => applyWorkspace(name, knownPanels(l))}><span>{name === workspaceName ? '● ' : ''}{name}</span>
          {custom[name] && <kbd role="button" aria-label={`Delete ${name}`} onClick={(e) => { e.stopPropagation(); const c = { ...custom }; delete c[name]; setCustom(c); savePref('workspaces', c); try { const raw = { ...c }; localStorage.setItem('spritecraft.workspaces', JSON.stringify(raw)); } catch { /* fine */ } }}>×</kbd>}
        </button>
      ))}
      <button className="menu-item" onClick={() => {
        const name = window.prompt('Name for this workspace:', 'My workspace');
        if (!name?.trim()) return;
        const c = { ...custom, [name.trim()]: lref.current };
        setCustom(c); savePref('workspaces', c);
        setWorkspaceName(name.trim());
      }}><span>Save current as…</span></button>
      <div className="menu-sep">Panels</div>
      {Object.entries(PANELS).map(([id, P]) => {
        const shown = allDocked(layout).includes(id);
        return <button key={id} className="menu-item" onClick={() => { if (shown) closePanel(id); else if (id === 'timeline') dockTo(id, 'bottom'); else dockTo(id, 'right'); }}><span>{shown ? '✓ ' : ''}{P.title}</span></button>;
      })}
    </>
  );

  const s = ed.s, d = s.doc;
  const zoomPct = s.view ? Math.round((s.view.zoom / (window.devicePixelRatio || 1)) * 100) : 100;
  return (
    <div className="app">
      <MenuBar workspaces={workspaces} />
      <Tabs />
      <Options />
      <div className="main">
        <Toolbox />
        {layout.left.length > 0 && <><aside className="dock" style={{ width: layout.leftW }}>{column(layout.left)}</aside><Splitter dir="x" onDrag={(dx) => setLayout({ ...lref.current, leftW: Math.max(160, Math.min(520, lref.current.leftW + dx)) })} /></>}
        <div className="center">
          <Viewport />
          {layout.bottom.length > 0 && <>
            <Splitter dir="y" onDrag={(dy) => setLayout({ ...lref.current, bottomH: Math.max(90, Math.min(window.innerHeight - 220, lref.current.bottomH - dy)) })} />
            <div className="dock bottom" style={{ height: layout.bottomH }}>{column(layout.bottom)}</div>
          </>}
        </div>
        {layout.right.length > 0 && <><Splitter dir="x" onDrag={(dx) => setLayout({ ...lref.current, rightW: Math.max(180, Math.min(520, lref.current.rightW - dx)) })} /><aside className="dock" style={{ width: layout.rightW }}>{column(layout.right)}</aside></>}
      </div>
      <footer className="status">
        <span id="status-pos" className="pos" />
        <span>{d.width} × {d.height}</span>
        <span>{d.colorMode === 'indexed' ? `Indexed, ${d.palette.length} colours` : 'RGB'}</span>
        {d.selection && <span>Selection {d.selection.w} × {d.selection.h}</span>}
        <span className="msg" role="status">{ed.message}</span>
        <span className="grow" />
        <span>{workspaceName}</span>
        <button className="mini" aria-label="Zoom out" onClick={() => zoomStep(-1)}><Icon name="minus" size={12} /></button>
        <button className="linkish" title="Fit to window (Ctrl+0)" onClick={() => fitView()}>{zoomPct}%</button>
        <button className="mini" aria-label="Zoom in" onClick={() => zoomStep(1)}><Icon name="plus" size={12} /></button>
      </footer>
      {layout.floating.map((f) => (
        <div key={f.id} className="floating" style={{ left: f.x, top: f.y, width: f.w, height: f.h }}>
          <PanelFrame id={f.id} floating onDragStart={startDrag(f.id)} onFloat={() => dockTo(f.id, f.id === 'timeline' ? 'bottom' : 'right')} onClose={() => closePanel(f.id)} />
        </div>
      ))}
      {dropZone && <div className={'dropzone ' + dropZone} />}
      <DialogHost />
      <ContextMenuHost />
    </div>
  );
}
