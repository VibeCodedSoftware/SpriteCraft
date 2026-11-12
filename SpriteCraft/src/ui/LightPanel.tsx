// The Lighting panel (Phase 4): make normal maps from the art, place and animate lights, preview them live and render
// lit frames. Lights are dragged around the preview; with "Key on this frame" on, a drag keys the light's position.
import { useEffect, useRef, useState } from 'react';
import * as Lt from '../core/light';
import { newId } from '../core/types';
import { ed, useEd } from '../editor/editor';
import { Num } from './Panels';

function Slider({ label, value, min, max, step = 1, title, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; title?: string; unit?: string; onChange: (n: number) => void }) {
  return (
    <label className="field" title={title}><span className="grow">{label}</span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <Num value={+value.toFixed(2)} min={min} max={max} step={step} width={50} onChange={onChange} />{unit && <span className="dim">{unit}</span>}
    </label>
  );
}

/** A sphere to pick a surface direction: clicking sets the paint colour to that normal. */
function NormalPicker() {
  const ref = useRef<HTMLCanvasElement>(null);
  const S = 56;
  useEffect(() => {
    const c = ref.current!, g = c.getContext('2d')!, img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const p = Lt.normalFromPicker(((x + 0.5) / S) * 2 - 1, ((y + 0.5) / S) * 2 - 1);
      if (p === null) continue;
      const i = (y * S + x) * 4;
      img.data[i] = p & 255; img.data[i + 1] = (p >>> 8) & 255; img.data[i + 2] = (p >>> 16) & 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, []);
  return (
    <canvas ref={ref} width={S} height={S} className="normal-picker" title="Click a direction to paint with it. Paint on the normal layer (show it first)." aria-label="Normal direction picker"
      onClick={(e) => {
        const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
        const p = Lt.normalFromPicker(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
        if (p === null) return;
        ed.fg = p;
        const nl = ed.lighting.normalLayer;
        if (nl) ed.selectLayer(nl);
        ed.toast('Paint colour set to that surface direction.');
        ed.notify();
      }} />
  );
}

export function LightPanel() {
  useEd();
  const d = ed.doc, s = ed.s, l = ed.lighting;
  const canvasRef = useRef<HTMLCanvasElement>(null), overlayRef = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState<string>(l.lights[0]?.id ?? '');
  const [keyMode, setKeyMode] = useState(false);
  const [live, setLive] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<string | null>(null);
  const zoom = Math.max(1, Math.floor(240 / Math.max(d.width, d.height)));
  const lights = Lt.lightsAt(d, l, s.frame).map((li) => (live && li.id === live.id ? { ...li, x: live.x, y: live.y } : li));
  const light = l.lights.find((x) => x.id === sel) ?? l.lights[0];

  useEffect(() => {
    const c = canvasRef.current, o = overlayRef.current;
    if (!c || !o) return;
    c.width = d.width; c.height = d.height;
    const normals = l.normalLayer ? ed.heldBuffer(l.normalLayer, s.frame) : null;
    const out = Lt.shade({ base: ed.lightBase(s.frame), normals, w: d.width, h: d.height, palette: d.palette }, l, lights);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), d.width, d.height), 0, 0);
    c.style.width = d.width * zoom + 'px'; c.style.height = d.height * zoom + 'px';
    o.width = d.width * zoom; o.height = d.height * zoom;
    o.style.width = o.width + 'px'; o.style.height = o.height + 'px';
    const g = o.getContext('2d')!;
    g.clearRect(0, 0, o.width, o.height);
    for (const li of lights) {
      if (li.kind === 'directional') continue;
      const x = li.x * zoom, y = li.y * zoom, on = li.id === light?.id;
      g.fillStyle = li.colour; g.strokeStyle = on ? '#ffb547' : '#000'; g.lineWidth = on ? 3 : 1.5;
      g.beginPath(); g.arc(x, y, on ? 7 : 6, 0, Math.PI * 2); g.fill(); g.stroke();
      if (li.kind === 'spot') {
        const a = (li.angle * Math.PI) / 180;
        g.strokeStyle = on ? '#ffb547' : 'rgba(255,255,255,.8)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 22, y + Math.sin(a) * 22); g.stroke();
      }
    }
  });

  const setL = (patch: Partial<Lt.Lighting>, label = 'Change lighting') => ed.patchLighting({ ...l, ...patch }, label);
  const setLight = (patch: Partial<Lt.Light>, label = 'Change light') => ed.patchLighting({ ...l, lights: l.lights.map((x) => (x.id === light!.id ? { ...x, ...patch } : x)) }, label);
  const hit = (px: number, py: number) => {
    let best: string | null = null, bd = 12;
    for (const li of lights) {
      if (li.kind === 'directional') continue;
      const dd = Math.hypot(px - li.x * zoom, py - li.y * zoom);
      if (dd < bd) { bd = dd; best = li.id; }
    }
    return best;
  };
  const normalsMade = !!(l.normalLayer && d.layers.some((x) => x.id === l.normalLayer));
  const normalLayer = l.normalLayer ? d.layers.find((x) => x.id === l.normalLayer) : undefined;
  const fr = d.frames[s.frame].id;
  const keyedHere = (id: string) => Object.values(l.tracks[id] ?? {}).some((ks) => ks?.some((k) => k.f === fr));

  return (
    <div className="lightpanel">
      <div className="rig-view" title="Drag a light to move it"
        onPointerDown={(e) => {
          const r = canvasRef.current!.getBoundingClientRect();
          const id = hit(e.clientX - r.left, e.clientY - r.top);
          if (!id) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          setSel(id); drag.current = id;
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const r = canvasRef.current!.getBoundingClientRect();
          setLive({ id: drag.current, x: Math.round((e.clientX - r.left) / zoom), y: Math.round((e.clientY - r.top) / zoom) });
        }}
        onPointerUp={() => {
          const id = drag.current; drag.current = null;
          if (!id || !live) return;
          setLive(null);
          if (keyMode) {
            let n = Lt.setLightKey(d, l, id, 'x', s.frame, live.x);
            n = Lt.setLightKey(d, n, id, 'y', s.frame, live.y);
            ed.patchLighting(n, 'Key light');
          } else ed.patchLighting({ ...l, lights: l.lights.map((x) => (x.id === id ? { ...x, x: live.x, y: live.y } : x)) }, 'Move light');
        }}>
        <div className="rig-stack">
          <canvas ref={canvasRef} className="pixelated" aria-label="Lighting preview" />
          <canvas ref={overlayRef} className="rig-overlay" aria-hidden />
        </div>
      </div>
      <div className="row">
        <button className="btn" aria-label="Previous frame" onClick={() => ed.setFrame(s.frame - 1)}>◀</button>
        <button className={'btn' + (ed.playing ? ' on' : '')} onClick={() => ed.togglePlay()}>{ed.playing ? '■' : '▶'}</button>
        <button className="btn" aria-label="Next frame" onClick={() => ed.setFrame(s.frame + 1)}>▶|</button>
        <span className="dim grow">Frame {s.frame + 1}/{d.frames.length}</span>
        <label className="check" title="Dragging a light keys its position on this frame, so lights can move over the animation"><input type="checkbox" checked={keyMode} onChange={(e) => setKeyMode(e.target.checked)} /> Key on this frame</label>
      </div>

      <h4>Normal map</h4>
      <p className="dim">Made from your art: each visible layer is its own shape, rounded at its edges, with detail from brightness. No grey painting needed.</p>
      <Slider label="Edge rounding" value={l.normals.bevel} min={0.5} max={16} step={0.5} unit="px" title="How far in from the edge a shape rounds off" onChange={(n) => setL({ normals: { ...l.normals, bevel: n } }, 'Normal settings')} />
      <Slider label="Strength" value={l.normals.strength} min={0.5} max={8} step={0.5} title="How strong the relief is" onChange={(n) => setL({ normals: { ...l.normals, strength: n } }, 'Normal settings')} />
      <Slider label="Detail from brightness" value={l.normals.detail} min={0} max={100} unit="%" onChange={(n) => setL({ normals: { ...l.normals, detail: n } }, 'Normal settings')} />
      <label className="check"><input type="checkbox" checked={l.normals.invertDetail} onChange={(e) => setL({ normals: { ...l.normals, invertDetail: e.target.checked } }, 'Normal settings')} /> Dark lines are ridges</label>
      <div className="row wrap">
        <button className="btn primary" onClick={() => ed.generateNormals()}>{normalsMade ? 'Remake normals' : 'Make normals'}</button>
        {normalLayer && <button className="btn" onClick={() => ed.patchLayer(normalLayer.id, { visible: !normalLayer.visible }, normalLayer.visible ? 'Hide normals' : 'Show normals')}>{normalLayer.visible ? 'Hide normal layer' : 'Show normal layer to paint'}</button>}
      </div>
      <div className="row">
        <NormalPicker />
        <p className="dim grow">Pick a direction, then paint it on the normal layer with any tool. Saving that layer as a PNG exports the normal map; an imported normal map works too if you choose it below.</p>
      </div>
      <label className="field">Normal layer<select value={l.normalLayer ?? ''} onChange={(e) => setL({ normalLayer: e.target.value || null }, 'Normal layer')}>
        <option value="">None (flat)</option>
        {d.layers.filter((x) => x.kind === 'image').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select></label>

      <h4>Lights</h4>
      <div className="rig-bones" role="listbox" aria-label="Lights">
        {l.lights.map((li) => (
          <button key={li.id} role="option" aria-selected={li.id === light?.id} className={'rig-bone' + (li.id === light?.id ? ' on' : '')} onClick={() => setSel(li.id)}>
            <i className="swatchdot" style={{ background: li.colour }} /> {li.name} <span className="dim">({li.kind}{li.on ? '' : ', off'})</span>{keyedHere(li.id) && <b className="keymark">◆</b>}
          </button>
        ))}
      </div>
      <div className="row wrap">
        {(['point', 'spot', 'directional'] as const).map((k) => (
          <button key={k} className="btn" onClick={() => {
            const li = Lt.newLight(newId('lt'), `${k[0].toUpperCase() + k.slice(1)} ${l.lights.length + 1}`, d.width, d.height, k);
            ed.patchLighting({ ...l, lights: [...l.lights, li] }, 'Add light'); setSel(li.id);
          }}>+ {k === 'directional' ? 'Sun' : k === 'spot' ? 'Spot' : 'Point'}</button>
        ))}
      </div>
      {light && (
        <>
          <div className="row">
            <label className="check"><input type="checkbox" checked={light.on} onChange={(e) => setLight({ on: e.target.checked }, 'Light on/off')} /> On</label>
            <input className="colorin" type="color" aria-label="Light colour" value={light.colour} onChange={(e) => setLight({ colour: e.target.value }, 'Light colour')} />
            <input className="grow" aria-label="Light name" value={light.name} onChange={(e) => setLight({ name: e.target.value }, 'Rename light')} onKeyDown={(e) => e.stopPropagation()} />
            <button className="mini" title="Delete light" aria-label="Delete light" onClick={() => { const t = { ...l.tracks }; delete t[light.id]; ed.patchLighting({ ...l, lights: l.lights.filter((x) => x.id !== light.id), tracks: t }, 'Delete light'); }}>×</button>
          </div>
          <Slider label="Intensity" value={lights.find((x) => x.id === light.id)?.intensity ?? light.intensity} min={0} max={4} step={0.05} onChange={(n) => keyMode ? ed.patchLighting(Lt.setLightKey(d, l, light.id, 'intensity', s.frame, n), 'Key light') : setLight({ intensity: n })} />
          {light.kind !== 'directional' && <>
            <Slider label="Height" value={light.z} min={1} max={256} unit="px" title="How far above the picture: low lights rake across it" onChange={(n) => keyMode ? ed.patchLighting(Lt.setLightKey(d, l, light.id, 'z', s.frame, n), 'Key light') : setLight({ z: n })} />
            <Slider label="Reach" value={light.radius} min={4} max={512} unit="px" title="The light fades to nothing at this distance" onChange={(n) => setLight({ radius: n })} />
          </>}
          {light.kind !== 'point' && <Slider label="Direction" value={light.angle} min={-180} max={180} unit="°" title="Where it shines across the picture (0 = right, 90 = down)" onChange={(n) => setLight({ angle: n })} />}
          {light.kind === 'directional' && <Slider label="Elevation" value={light.elevation} min={1} max={90} unit="°" onChange={(n) => setLight({ elevation: n })} />}
          {light.kind === 'spot' && <>
            <Slider label="Cone" value={light.cone} min={5} max={170} unit="°" onChange={(n) => setLight({ cone: n })} />
            <Slider label="Soft edge" value={light.softness} min={0} max={1} step={0.05} onChange={(n) => setLight({ softness: n })} />
          </>}
          <Slider label="Shine" value={light.specular} min={0} max={1} step={0.05} title="Highlights on surfaces facing between the light and you" onChange={(n) => setLight({ specular: n })} />
          <Slider label="Flicker" value={light.flicker} min={0} max={1} step={0.05} title="Random dimming per frame, like a flame" onChange={(n) => setLight({ flicker: n })} />
        </>
      )}

      <h4>Look</h4>
      <div className="row"><span className="grow">Ambient</span><input className="colorin" type="color" aria-label="Ambient colour" value={l.ambient} onChange={(e) => setL({ ambient: e.target.value }, 'Ambient colour')} /></div>
      <Slider label="Ambient strength" value={l.ambientIntensity} min={0} max={1} step={0.05} onChange={(n) => setL({ ambientIntensity: n })} />
      <Slider label="Shading steps" value={l.bands} min={0} max={12} title="Light snaps to this many steps, like a shading ramp. 0 is smooth." onChange={(n) => setL({ bands: n })} />
      <label className="check"><input type="checkbox" checked={l.dither} onChange={(e) => setL({ dither: e.target.checked })} /> Dither between steps</label>
      <label className="check"><input type="checkbox" checked={l.shadows} onChange={(e) => setL({ shadows: e.target.checked })} /> Shadows from the surface</label>
      <label className="check"><input type="checkbox" checked={l.usePalette} onChange={(e) => setL({ usePalette: e.target.checked })} /> Only palette colours</label>

      <h4>Render</h4>
      <div className="row wrap">
        <button className="btn primary" onClick={() => ed.renderLit(s.frame, s.frame)}>This frame</button>
        <button className="btn" onClick={() => ed.renderLit(0, d.frames.length - 1)}>All {d.frames.length} frames</button>
      </div>
      <p className="dim">Lit frames go on a new layer as ordinary pixels; the layers they came from are hidden.</p>
    </div>
  );
}
