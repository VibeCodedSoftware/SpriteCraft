// The Shaders panel (Phase 5): a live stack of shaders on the current layer. Shaders run whenever the frame is drawn, so
// the canvas, playback and every export show them. Number settings can be keyed per frame. Stacks can be saved as
// presets or shared as .spritefx.json files.
import { useEffect, useRef, useState } from 'react';
import { liveKeys, sampleKeys } from '../core/anim';
import { composeFrame } from '../core/compose';
import { defaultParams, effectById, effects, type EffectParam } from '../core/effects';
import { SHADER_PRESETS } from '../core/shaders';
import { newId, type LayerFx } from '../core/types';
import { ed, loadPref, savePref, useEd } from '../editor/editor';
import { pickFiles, saveBytes } from '../editor/files';

const FX_FORMAT = 'spritecraft.shaders';

export function ShaderPanel() {
  useEd();
  const d = ed.doc, s = ed.s, layer = ed.layer;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState<string>('');
  const [keyMode, setKeyMode] = useState(false);
  const [userPresets, setUserPresets] = useState<Record<string, { effect: string; params: Record<string, any> }[]>>(() => loadPref('fxPresets', {}));
  const stack = layer?.fx ?? [];
  const cur = stack.find((f) => f.id === sel) ?? stack[0];
  const zoom = Math.max(1, Math.floor(240 / Math.max(d.width, d.height)));

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = d.width; c.height = d.height;
    const out = composeFrame(d, s.frame, { skipReference: true });
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), d.width, d.height), 0, 0);
    c.style.width = d.width * zoom + 'px'; c.style.height = d.height * zoom + 'px';
  });

  if (!layer || layer.kind !== 'image') return <div className="shaderpanel"><p className="dim">Choose an image layer: shaders sit on a layer.</p></div>;

  const setStack = (fx: LayerFx[], label = 'Change shaders') => ed.patchLayer(layer.id, { fx: fx.length ? fx : undefined }, label);
  const setFx = (patch: Partial<LayerFx>, label = 'Change shader') => setStack(stack.map((f) => (f.id === cur!.id ? { ...f, ...patch } : f)), label);
  /** Adds shaders in one step (a preset's whole stack is one undo step and none overwrite each other). */
  const addAll = (list: { effect: string; params?: Record<string, any> }[], label?: string) => {
    const made: LayerFx[] = [];
    for (const { effect, params } of list) {
      const e = effectById(effect);
      if (e) made.push({ id: newId('fx'), effect, on: true, params: { ...defaultParams(e), ...(params ?? {}) } });
    }
    if (!made.length) return 0;
    setStack([...stack, ...made], label ?? `Add ${effectById(made[0].effect)!.name}`);
    setSel(made[made.length - 1].id);
    return made.length;
  };
  const add = (effect: string, params: Record<string, any> = {}) => addAll([{ effect, params }]);
  const frameId = d.frames[s.frame].id;
  const valueOf = (f: LayerFx, p: EffectParam) => (p.type === 'number' && f.keys?.[p.key] ? sampleKeys(liveKeys(d, f.keys[p.key]), s.frame, f.params[p.key]) : f.params[p.key]);
  const setParam = (p: EffectParam, v: any) => {
    if (keyMode && p.type === 'number') {
      const keys = [...(cur!.keys?.[p.key] ?? [])];
      if (!liveKeys(d, keys).length && s.frame !== 0) keys.push({ f: d.frames[0].id, v: cur!.params[p.key], ease: 'in-out-sine' });
      const at = keys.findIndex((k) => k.f === frameId);
      if (at >= 0) keys[at] = { ...keys[at], v }; else keys.push({ f: frameId, v, ease: 'in-out-sine' });
      setFx({ keys: { ...(cur!.keys ?? {}), [p.key]: keys } }, 'Key shader setting');
    } else setFx({ params: { ...cur!.params, [p.key]: v } }, 'Shader setting');
  };
  const keyedHere = (p: EffectParam) => !!cur?.keys?.[p.key]?.some((k) => k.f === frameId);
  const asPreset = () => stack.map((f) => ({ effect: f.effect, params: f.params }));

  return (
    <div className="shaderpanel">
      <div className="rig-view" title={cur?.effect === 'water' ? 'Click to add a ripple point to the water' : 'Live preview with shaders'}
        onClick={(e) => {
          if (cur?.effect !== 'water') return;
          const r = canvasRef.current!.getBoundingClientRect();
          const x = Math.floor((e.clientX - r.left) / zoom), y = Math.floor((e.clientY - r.top) / zoom);
          const pts = String(cur.params.points ?? '').trim();
          setFx({ params: { ...cur.params, points: (pts ? pts + '; ' : '') + `${x},${y}` } }, 'Add ripple point');
        }}>
        <canvas ref={canvasRef} className="pixelated" aria-label="Shader preview" />
      </div>
      <div className="row">
        <button className="btn" aria-label="Previous frame" onClick={() => ed.setFrame(s.frame - 1)}>◀</button>
        <button className={'btn' + (ed.playing ? ' on' : '')} onClick={() => ed.togglePlay()}>{ed.playing ? '■' : '▶'}</button>
        <button className="btn" aria-label="Next frame" onClick={() => ed.setFrame(s.frame + 1)}>▶|</button>
        <span className="dim grow">Frame {s.frame + 1}/{d.frames.length}</span>
        <button className="btn" title="Add a frame so shaders have time to move" onClick={() => ed.addFrame()}>+ Frame</button>
      </div>
      {d.frames.length < 2 && <p className="dim">Shaders animate over the frames: add a few (Alt+N) to see waves move.</p>}

      <h4>Stack on “{layer.name}”</h4>
      {stack.length === 0 && <p className="dim">No shaders yet. Add one below. For water, paint the water's shape on its own layer, put things that stand in it on layers above, and add Water.</p>}
      <div className="rig-bones" role="listbox" aria-label="Shader stack">
        {stack.map((f, i) => (
          <div key={f.id} className={'rig-bone fxrow' + (f.id === cur?.id ? ' on' : '')}>
            <input type="checkbox" checked={f.on} aria-label={`${effectById(f.effect)?.name ?? f.effect} on`} onChange={(e) => setStack(stack.map((x) => (x.id === f.id ? { ...x, on: e.target.checked } : x)), 'Toggle shader')} />
            <button className="link grow" onClick={() => setSel(f.id)}>{effectById(f.effect)?.name ?? f.effect}{f.keys && Object.keys(f.keys).length ? ' ◆' : ''}</button>
            <button className="mini" aria-label="Move up" title="Run earlier" disabled={i === 0} onClick={() => { const n = [...stack]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setStack(n, 'Reorder shaders'); }}>▲</button>
            <button className="mini" aria-label="Move down" title="Run later" disabled={i === stack.length - 1} onClick={() => { const n = [...stack]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setStack(n, 'Reorder shaders'); }}>▼</button>
            <button className="mini" aria-label="Remove shader" onClick={() => setStack(stack.filter((x) => x.id !== f.id), 'Remove shader')}>×</button>
          </div>
        ))}
      </div>
      <label className="field">Add<select value="" onChange={(e) => { if (e.target.value) add(e.target.value); }}>
        <option value="">Choose a shader…</option>
        {effects().filter((e) => e.id !== 'particles' && e.id !== 'weather' && e.id !== 'nodes').map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select></label>

      {cur && (() => {
        const e = effectById(cur.effect);
        if (!e) return <p className="warn">This shader isn't available in this version.</p>;
        return (
          <>
            <h4>{e.name}</h4>
            <label className="check" title="Changing a number setting keys it on this frame, so it can change over the animation"><input type="checkbox" checked={keyMode} onChange={(ev) => setKeyMode(ev.target.checked)} /> Key settings on this frame</label>
            {e.params.map((p) => {
              const v = valueOf(cur, p);
              return (
                <label key={p.key} className={p.type === 'bool' ? 'check' : 'field'}>
                  {p.type === 'bool' && <input type="checkbox" checked={!!v} onChange={(ev) => setParam(p, ev.target.checked)} />}
                  <span className="grow">{p.label}{keyedHere(p) && <b className="keymark"> ◆</b>}</span>
                  {p.type === 'number' && <><input type="range" aria-label={p.label} min={p.min} max={p.max} step={p.step ?? 1} value={v} onChange={(ev) => setParam(p, +ev.target.value)} /><span className="val">{+(+v).toFixed(2)}</span></>}
                  {p.type === 'color' && <input className="colorin" type="color" aria-label={p.label} value={v} onChange={(ev) => setParam(p, ev.target.value)} />}
                  {p.type === 'choice' && <select value={v} onChange={(ev) => setParam(p, ev.target.value)}>{p.options.map((o) => <option key={o}>{o}</option>)}</select>}
                  {p.type === 'text' && <input aria-label={p.label} value={v} onChange={(ev) => setParam(p, ev.target.value)} onKeyDown={(ev) => ev.stopPropagation()} />}
                </label>
              );
            })}
            {cur.effect === 'formula' && <p className="dim">Formulas use x, y, u, v, t (0–1 over the loop), frame, w, h and the pixel's r, g, b, a, with + − × ÷ % ^, comparisons, a ? b : c, and sin cos abs floor round sqrt min max clamp mix step fract noise.</p>}
            {cur.effect === 'water' && <p className="dim">Click the preview to add a ripple point. Things on layers above the water make ripples and trails where they touch it, and are reflected.</p>}
            {cur.keys && Object.keys(cur.keys).length > 0 && <button className="btn" onClick={() => setFx({ keys: undefined }, 'Clear shader keys')}>Clear this shader's keys</button>}
          </>
        );
      })()}

      <h4>Presets</h4>
      <div className="row wrap">
        {SHADER_PRESETS.map((p) => <button key={p.name} className="btn" title="Adds this stack to the layer" onClick={() => addAll(p.fx, `Preset: ${p.name}`)}>{p.name}</button>)}
        {Object.entries(userPresets).map(([name, fx]) => <button key={name} className="btn" onClick={() => addAll(fx, `Preset: ${name}`)}>{name}</button>)}
      </div>
      <div className="row wrap">
        <button className="btn" disabled={!stack.length} onClick={() => {
          const name = window.prompt('Name for this shader preset:', layer.name + ' shaders');
          if (!name?.trim()) return;
          const n = { ...userPresets, [name.trim()]: asPreset() };
          setUserPresets(n); savePref('fxPresets', n);
        }}>Save as preset</button>
        <button className="btn" disabled={!stack.length} onClick={() => saveBytes(`${layer.name}.spritefx.json`, JSON.stringify({ format: FX_FORMAT, version: 1, fx: asPreset() }, null, 2), 'SpriteCraft shaders')}>Export…</button>
        <button className="btn" onClick={async () => {
          const [f] = await pickFiles('.json,.spritefx.json');
          if (!f) return;
          try {
            const j = JSON.parse(await f.text());
            if (j?.format !== FX_FORMAT || !Array.isArray(j.fx)) throw new Error('not a SpriteCraft shader file');
            const known = j.fx.filter((x: any) => typeof x?.effect === 'string' && effectById(x.effect));
            addAll(known.map((x: any) => ({ effect: x.effect, params: typeof x.params === 'object' && x.params ? x.params : {} })), 'Import shaders');
            ed.toast(`Added ${known.length} shader${known.length === 1 ? '' : 's'}${known.length < j.fx.length ? `; ${j.fx.length - known.length} not available here were skipped` : ''}.`);
          } catch (err: any) { ed.toast(`Couldn't import: ${err.message ?? err}`); }
        }}>Import…</button>
      </div>

      <h4>Render</h4>
      <p className="dim">Shaders already show in playback and every export. To keep the result as pixels you can retouch, render it to a new layer.</p>
      <button className="btn" onClick={() => {
        const imgs = d.frames.map((_, i) => composeFrame(d, i, { skipReference: true }));
        const hide = d.layers.filter((l) => l.kind === 'image' && l.visible).map((l) => l.id);
        ed.placeRendered(imgs, `Shaded ${d.frames.length > 1 ? `1–${d.frames.length}` : ''}`.trim(), 0, hide);
      }}>Render all frames to a new layer</button>
    </div>
  );
}
