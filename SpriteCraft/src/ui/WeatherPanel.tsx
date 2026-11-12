// The Weather panel (Phase 7): procedural pixel rain and snow on a layer. Like particles they are live (canvas, playback,
// exports), loop exactly over the animation, and can be baked into frames or saved alone as transparent PNG frames.
import { useEffect, useRef } from 'react';
import { zipSync } from 'fflate';
import { composeFrame, isBackdrop } from '../core/compose';
import * as D from '../core/doc';
import { spriteFromLayer } from '../core/particles';
import { newId, type LayerFx } from '../core/types';
import { WEATHER_PRESETS, newWeather, type Depth, type Weather } from '../core/weather';
import { ed, useEd } from '../editor/editor';
import { saveBytes } from '../editor/files';
import { encodePng } from '../io/png';

type NumKey = { [K in keyof Weather]-?: Weather[K] extends number ? K : never }[keyof Weather];
const findFx = (fx: LayerFx[] | undefined) => fx?.find((f) => f.effect === 'weather' && f.params.weather);

export function WeatherPanel() {
  useEd();
  const d = ed.doc, s = ed.s, layer = ed.layer;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fx = findFx(layer?.fx);
  const wt = fx?.params.weather as Weather | undefined;
  const zoom = Math.max(1, Math.floor(260 / Math.max(d.width, d.height)));
  const loopSeconds = d.frames.reduce((a, f) => a + f.duration / 1000, 0);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = d.width; c.height = d.height;
    const out = composeFrame(d, s.frame, { skipReference: true });
    const g = c.getContext('2d')!;
    g.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), d.width, d.height), 0, 0);
    if (wt && wt.ground !== null) { g.fillStyle = 'rgba(255,80,200,0.5)'; g.fillRect(0, wt.ground, d.width, 1); }
    c.style.width = d.width * zoom + 'px'; c.style.height = d.height * zoom + 'px';
  });

  const make = (name: string, w: Partial<Weather> & { kind: Weather['kind'] }, where: 'front' | 'behind') => {
    const weather = { ...newWeather(w.kind), ...w, seed: 1 + Math.floor(Math.random() * 999) };
    ed.addLiveLayer('weather', { weather }, name, null, where === 'behind' ? 'bottom' : 'above');
  };

  if (!layer || layer.kind !== 'image' || !wt || !fx) {
    return (
      <div className="shaderpanel">
        <p className="dim">Rain and snow go on their own layer, looping over the animation. Pick a mood; it goes in front of everything (put it lower in the layers to fall behind a character).</p>
        <div className="row wrap">{WEATHER_PRESETS.map((p) => <button key={p.name} className="btn" onClick={() => make(p.name, p.w, 'front')}>{p.name}</button>)}</div>
        {d.frames.length < 2 && <p className="dim">Weather moves over the frames: add some (Alt+N), around 8–16 at 100 ms, to see it fall.</p>}
      </div>
    );
  }

  const set = (patch: Partial<Weather>, label = 'Change weather') =>
    ed.patchLayer(layer.id, { fx: layer.fx!.map((f) => (f.id === fx.id ? { ...f, params: { ...f.params, weather: { ...wt, ...patch } } } : f)) }, label);
  const N = (k: NumKey, label: string, min: number, max: number, step = 1, title?: string) => (
    <label className="field" title={title}>
      <span className="grow">{label}</span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={wt[k]} onChange={(e) => set({ [k]: +e.target.value } as Partial<Weather>)} />
      <span className="val">{+(+wt[k]).toFixed(2)}</span>
    </label>
  );
  const C = (k: 'near' | 'far' | 'splash' | 'settle' | 'shade', label: string) => (
    <label className="field"><span className="grow">{label}</span><input className="colorin" type="color" aria-label={label} value={wt[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<Weather>, 'Weather colour')} /></label>
  );
  const rain = wt.kind === 'rain';
  /** Changes the weather, renaming the layer too while it still has a mood's name. */
  const setMood = (patch: Partial<Weather>, name: string) => {
    const named = WEATHER_PRESETS.some((p) => p.name === layer.name) || layer.name === 'Rain' || layer.name === 'Snow';
    ed.patchLayer(layer.id, { ...(named ? { name } : {}), fx: layer.fx!.map((f) => (f.id === fx.id ? { ...f, params: { ...f.params, weather: { ...wt, ...patch } } } : f)) }, `Weather: ${name}`);
  };

  /** Keeps the far layers here and puts the nearest drops on a copy at the top, in front of everything. */
  const split = () => {
    const front = { ...D.newLayer(layer.name + ' (front)'), fx: [{ id: newId('fx'), effect: 'weather', on: true, params: { weather: { ...wt, depths: { far: false, mid: false, near: true }, settleDepth: 0, seed: wt.seed + 1 } } }] };
    let nd = D.updateLayer(d, layer.id, { fx: layer.fx!.map((f) => (f.id === fx.id ? { ...f, params: { ...f.params, weather: { ...wt, depths: { ...wt.depths, near: false } } } } : f)) });
    nd = D.addLayer(nd, front, null);
    ed.commit('Split weather front and back', nd);
    ed.toast(`The nearest ${rain ? 'drops' : 'flakes'} are now on "${front.name}" at the top. Move "${layer.name}" below your character so the rest falls behind.`);
  };

  const saveFrames = async () => {
    const res = ed.liveLayerFrames(layer.id, 'weather');
    if (!res) return;
    const files: Record<string, Uint8Array> = {};
    const pad = (n: number) => String(n).padStart(3, '0');
    res.images.forEach((data, i) => { files[`${layer.name}_${pad(i + 1)}.png`] = encodePng({ w: d.width, h: d.height, data }); });
    if (await saveBytes(`${layer.name}_frames.zip`, zipSync(files, { level: 0 }), 'Zip of PNG images')) ed.toast(`Saved ${res.images.length} transparent frames of "${layer.name}".`);
  };

  return (
    <div className="shaderpanel">
      <div className="rig-view" title="Shift+click to set the ground row where drops stop"
        onClick={(e) => {
          if (!e.shiftKey) return;
          const r = canvasRef.current!.getBoundingClientRect();
          set({ ground: Math.floor((e.clientY - r.top) / zoom) }, 'Weather ground');
        }}>
        <canvas ref={canvasRef} className="pixelated" aria-label="Weather preview" />
      </div>
      <div className="row">
        <button className="btn" aria-label="Previous frame" onClick={() => ed.setFrame(s.frame - 1)}>◀</button>
        <button className={'btn' + (ed.playing ? ' on' : '')} onClick={() => ed.togglePlay()}>{ed.playing ? '■' : '▶'}</button>
        <button className="btn" aria-label="Next frame" onClick={() => ed.setFrame(s.frame + 1)}>▶|</button>
        <span className="dim grow">Frame {s.frame + 1}/{d.frames.length} · {loopSeconds.toFixed(2)} s</span>
        <button className="btn" onClick={() => ed.addFrame()}>+ Frame</button>
      </div>

      <h4>“{layer.name}”</h4>
      <div className="row wrap">
        <button className={'btn' + (rain ? ' on' : '')} onClick={() => !rain && setMood({ ...newWeather('rain'), seed: wt.seed, depths: wt.depths, ground: wt.ground, hitArt: wt.hitArt, surfaces: wt.surfaces }, 'Rain')}>Rain</button>
        <button className={'btn' + (!rain ? ' on' : '')} onClick={() => rain && setMood({ ...newWeather('snow'), seed: wt.seed, depths: wt.depths, ground: wt.ground, hitArt: wt.hitArt, surfaces: wt.surfaces }, 'Snow')}>Snow</button>
        <select aria-label="Mood" value="" onChange={(e) => { const p = WEATHER_PRESETS.find((x) => x.name === e.target.value); if (p) setMood({ ...newWeather(p.w.kind), ...p.w, seed: wt.seed, depths: wt.depths.far && wt.depths.mid && wt.depths.near ? { ...wt.depths, ...(p.w.depths ?? {}) } : wt.depths, ground: wt.ground, hitArt: wt.hitArt, surfaces: wt.surfaces }, p.name); }}>
          <option value="">Mood…</option>
          {WEATHER_PRESETS.map((p) => <option key={p.name}>{p.name}</option>)}
        </select>
      </div>
      {N('amount', rain ? 'Density' : 'Amount', 0.2, 20, 0.2)}
      {N('speed', 'Falling speed (px/s)', rain ? 40 : 4, rain ? 500 : 120)}
      {N('speedVar', 'Speed variety', 0, 1, 0.05)}
      {N('wind', 'Wind (°)', -70, 70)}
      {N('sway', rain ? 'Flutter (px)' : 'Drift (px)', 0, 10, 0.5)}
      {rain ? N('length', 'Streak length', 1, 24) : N('size', 'Flake size', 1, 4)}
      {rain && N('perspective', 'Perspective', 0, 1, 0.05, 'Drops fan out from above the middle, as if looking up')}
      <div className="row wrap" role="group" aria-label="Depth layers">
        <span className="dim">Layers:</span>
        {(['far', 'mid', 'near'] as Depth[]).map((k) => (
          <label key={k} className="check"><input type="checkbox" checked={wt.depths[k]} onChange={(e) => set({ depths: { ...wt.depths, [k]: e.target.checked } }, 'Weather layers')} /> {k === 'far' ? 'Far' : k === 'mid' ? 'Middle' : 'Near'}</label>
        ))}
      </div>
      <button className="btn" title="Near drops in front of everything, the rest behind" disabled={!wt.depths.near || (!wt.depths.far && !wt.depths.mid)} onClick={split}>Split into front and back layers</button>

      <h4>Surfaces</h4>
      <label className="check" title="Drops and flakes land on solid art in the layers under this one"><input type="checkbox" checked={wt.hitArt} onChange={(e) => set({ hitArt: e.target.checked }, 'Weather surfaces')} /> Land on the art below</label>
      {wt.hitArt && (() => {
        const at = d.layers.findIndex((l) => l.id === layer.id);
        const under = d.layers.slice(0, at).filter((l) => l.kind === 'image').reverse();
        const fid = d.frames[s.frame].id;
        const auto = (id: string) => { const l = d.layers.find((x) => x.id === id)!; return !isBackdrop(d, l, fid) && !l.bakedFrom && !l.fx?.some((f) => f.on && (f.effect === 'weather' || f.effect === 'particles')); };
        const on = (id: string) => (wt.surfaces ? wt.surfaces.includes(id) : auto(id));
        if (!under.length) return <p className="dim">No layers under this one yet.</p>;
        return (
          <div className="row wrap" role="group" aria-label="Lands on">
            <span className="dim" title="Layers that fill the whole canvas (a sky) are left out unless you tick them">Lands on:</span>
            {under.map((l) => (
              <label key={l.id} className="check"><input type="checkbox" checked={on(l.id)} onChange={(e) => {
                const now = under.filter((x) => (x.id === l.id ? e.target.checked : on(x.id))).map((x) => x.id);
                set({ surfaces: now }, 'Weather surfaces');
              }} /> {l.name}</label>
            ))}
            {wt.surfaces && <button className="link" onClick={() => set({ surfaces: undefined }, 'Weather surfaces')}>auto</button>}
          </div>
        );
      })()}
      <label className="check"><input type="checkbox" checked={wt.ground !== null} onChange={(e) => set({ ground: e.target.checked ? Math.max(0, d.height - 4) : null }, 'Weather ground')} /> Ground row (Shift+click the preview)</label>
      {wt.ground !== null && (
        <label className="field"><span className="grow">Ground row</span>
          <input type="range" aria-label="Ground row" min={0} max={d.height - 1} value={wt.ground} onChange={(e) => set({ ground: +e.target.value }, 'Weather ground')} />
          <span className="val">{wt.ground}</span></label>
      )}
      {rain ? <>
        <label className="check"><input type="checkbox" checked={wt.splashes} onChange={(e) => set({ splashes: e.target.checked }, 'Weather splashes')} /> Splashes</label>
        <p className="dim">Paint puddles on this layer: drops landing on them make ripples. Over a Water shader, drops touching the water make its ripples too.</p>
      </> : <>
        {N('settleDepth', 'Settled snow (px)', 0, 8)}
        {wt.settleDepth > 0 && (
          <label className="field">Settling<select value={wt.settleMode} onChange={(e) => set({ settleMode: e.target.value as Weather['settleMode'] }, 'Snow settling')}>
            <option value="steady">Steady (loops)</option><option value="build">Builds up over the animation</option>
          </select></label>
        )}
        {N('linger', 'Flakes stay after landing (s)', 0, 3, 0.1)}
        <label className="field" title="Draw a flake on its own layer and use it">Flake picture<select value="" onChange={(e) => {
          if (e.target.value === '_none') { set({ sprite: undefined }, 'Flake picture'); return; }
          const sp = e.target.value ? spriteFromLayer(d, e.target.value) : null;
          if (e.target.value && !sp) { ed.toast('That layer is empty.'); return; }
          if (sp) { set({ sprite: sp }, 'Flake picture'); ed.toast(`Flakes now use a ${sp.w}×${sp.h} picture. Hide that layer if it shouldn't show itself.`); }
        }}>
          <option value="">{wt.sprite ? `Current ${wt.sprite.w}×${wt.sprite.h}…` : 'Built-in shapes'}</option>
          {wt.sprite && <option value="_none">Back to built-in shapes</option>}
          {d.layers.filter((l) => l.kind === 'image' && l.id !== layer.id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select></label>
      </>}

      <h4>Colours</h4>
      {C('near', rain ? 'Near drops' : 'Near flakes')}
      {C('far', rain ? 'Far drops' : 'Far flakes')}
      {rain ? C('splash', 'Splashes and ripples') : <>{C('settle', 'Settled snow')}{C('shade', 'Snow shadow')}</>}
      <label className="check"><input type="checkbox" checked={wt.palette} onChange={(e) => set({ palette: e.target.checked }, 'Weather palette')} /> Snap colours to the palette</label>
      {N('seed', 'Random seed', 1, 999)}

      <h4>Output</h4>
      <p className="dim">Weather already shows in playback and every export. Bake it to retouch the pixels, or save it alone as transparent frames.</p>
      <div className="row wrap">
        <button className="btn" onClick={() => ed.bakeParticles(layer.id, 'weather')}>Bake to frames</button>
        <button className="btn" onClick={() => void saveFrames()}>Save transparent PNG frames…</button>
      </div>
    </div>
  );
}
