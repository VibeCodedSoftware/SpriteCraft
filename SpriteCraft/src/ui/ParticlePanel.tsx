// The Particles panel (Phase 6, the ParticleCraft module): pixel particle systems that live on a layer. They draw in whole
// pixels with stepped colours, loop perfectly over the animation, show in playback and every export, can be baked into
// frames to retouch, and travel to and from ParticleCraft as real-time craft.vfx effects.
import { useEffect, useRef, useState } from 'react';
import { composeFrame } from '../core/compose';
import { PARTICLE_PRESETS, newEmitter, newSystem, spriteFromLayer, type Emitter, type ParticleSystem } from '../core/particles';
import { newId, type LayerFx } from '../core/types';
import { ed, useEd } from '../editor/editor';
import { pickFiles, saveBytes } from '../editor/files';
import { api } from '../editor/store';
import { exchangeFileName } from '../io/craft';
import { readParticleVfx, writeParticleVfx } from '../io/particlecraft';

type NumKey = { [K in keyof Emitter]-?: Emitter[K] extends number ? K : never }[keyof Emitter];
interface Field { k: NumKey; label: string; min: number; max: number; step?: number; title?: string }
const F = (k: NumKey, label: string, min: number, max: number, step = 1, title?: string): Field => ({ k, label, min, max, step, title });

const SECTIONS: { name: string; fields: Field[] }[] = [
  { name: 'Emission', fields: [F('rate', 'Rate (per second)', 0, 300), F('burst', 'Burst each loop', 0, 200), F('lifetime', 'Lifetime (s)', 0.05, 5, 0.05), F('lifetimeVar', 'Lifetime random', 0, 1, 0.05)] },
  { name: 'Motion', fields: [F('speed', 'Speed (px/s)', 0, 200), F('speedVar', 'Speed random', 0, 1, 0.05), F('angle', 'Direction (°, -90 = up)', -180, 180), F('spread', 'Spread (°)', 0, 180), F('radial', 'Outward speed', -100, 100, 1, 'Speed straight out from the shape centre: explosions')] },
  { name: 'Forces', fields: [F('gravity', 'Gravity (down)', -300, 300), F('wind', 'Wind (right)', -200, 200), F('drag', 'Drag', 0, 10, 0.1), F('turbulence', 'Turbulence', 0, 200), F('turbulenceScale', 'Turbulence size (px)', 2, 64), F('swirl', 'Swirl (°/s)', -720, 720, 5), F('attract', 'Pull to point (− pushes)', -300, 300), F('attractX', 'Point X', -64, 64), F('attractY', 'Point Y', -64, 64)] },
  { name: 'Look', fields: [F('sizeStart', 'Size at birth', 0, 16, 0.5), F('sizeEnd', 'Size at death', 0, 16, 0.5), F('sizeVar', 'Size random', 0, 8, 0.5), F('alphaStart', 'Opacity at birth', 0, 1, 0.05), F('alphaEnd', 'Opacity at death', 0, 1, 0.05), F('trail', 'Trail (s)', 0, 0.5, 0.01), F('spin', 'Sprite spin (¼ turns/s)', -8, 8, 0.5), F('seed', 'Random seed', 1, 999)] },
];

/** The layer's live particle system, if it has one. */
const findFx = (fx: LayerFx[] | undefined) => fx?.find((f) => f.effect === 'particles' && f.params.system);

export function ParticlePanel() {
  useEd();
  const d = ed.doc, s = ed.s, layer = ed.layer;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ Emission: true, Motion: true });
  const fx = findFx(layer?.fx);
  const sys = fx?.params.system as ParticleSystem | undefined;
  const cur = sys?.emitters.find((e) => e.id === sel) ?? sys?.emitters[0];
  const zoom = Math.max(1, Math.floor(260 / Math.max(d.width, d.height)));
  const loopSeconds = d.frames.reduce((a, f) => a + f.duration / 1000, 0);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = d.width; c.height = d.height;
    const out = composeFrame(d, s.frame, { skipReference: true });
    const g = c.getContext('2d')!;
    g.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), d.width, d.height), 0, 0);
    if (sys) {
      // Where the system sits (and the selected emitter's pull point), as small marks.
      g.fillStyle = 'rgba(255,80,200,0.9)';
      g.fillRect(sys.x - 2, sys.y, 5, 1); g.fillRect(sys.x, sys.y - 2, 1, 5);
      if (cur?.attract) { g.fillStyle = 'rgba(80,220,255,0.9)'; g.fillRect(sys.x + cur.attractX - 1, sys.y + cur.attractY - 1, 3, 3); }
    }
    c.style.width = d.width * zoom + 'px'; c.style.height = d.height * zoom + 'px';
  });

  const presetEmitters = (name: string) => (PARTICLE_PRESETS.find((p) => p.name === name)?.emitters ?? []).map((e) => ({ ...newEmitter(newId('pe')), ...e }));
  const newLayer = (preset: string) => {
    const system = { ...newSystem(d.width, d.height), name: preset, emitters: presetEmitters(preset) };
    ed.addParticleLayer(system, preset);
    setSel('');
  };

  if (!layer || layer.kind !== 'image' || !sys || !fx) {
    return (
      <div className="shaderpanel">
        <p className="dim">Particles live on their own layer, drawn in whole pixels and looping over the animation. Pick a starting point:</p>
        <div className="row wrap">{PARTICLE_PRESETS.map((p) => <button key={p.name} className="btn" onClick={() => newLayer(p.name)}>{p.name}</button>)}</div>
        <div className="row wrap">
          <button className="btn" onClick={() => ed.addParticleLayer({ ...newSystem(d.width, d.height), emitters: [newEmitter(newId('pe'))] })}>Empty particle layer</button>
          <button className="btn" title="A real-time effect (.vfx.json) made in ParticleCraft" onClick={() => void importAsLayer()}>Import from ParticleCraft…</button>
        </div>
        {d.frames.length < 2 && <p className="dim">Particles move over the frames: add some (Alt+N), around 8–16 at 100 ms, to see them play.</p>}
      </div>
    );
  }

  const setSys = (patch: Partial<ParticleSystem>, label = 'Change particles') =>
    ed.patchLayer(layer.id, { fx: layer.fx!.map((f) => (f.id === fx.id ? { ...f, params: { ...f.params, system: { ...sys, ...patch } } } : f)) }, label);
  const setEm = (patch: Partial<Emitter>, label = 'Change emitter') => setSys({ emitters: sys.emitters.map((e) => (e.id === cur!.id ? { ...e, ...patch } : e)) }, label);
  const addEmitters = (list: Emitter[], label: string) => { setSys({ emitters: [...sys.emitters, ...list] }, label); if (list.length) setSel(list[list.length - 1].id); };

  async function importVfxHere() {
    const [f] = await pickFiles('.json,.vfx.json');
    if (!f) return;
    try {
      const { system, notes } = readParticleVfx(await f.text(), d.width, d.height);
      addEmitters(system.emitters.map((e) => ({ ...e, x: e.x, y: e.y })), `Import ${system.name}`);
      ed.toast(`Added ${system.emitters.length} emitter${system.emitters.length === 1 ? '' : 's'} from "${system.name}".${notes.length ? ' ' + notes.join('; ') + '.' : ''}`);
    } catch (err: any) { ed.toast(`Couldn't import: ${err.message ?? err}`); }
  }
  const asset = () => writeParticleVfx(sys, loopSeconds);

  /** Uses another layer's pixels (every frame it has, in order) as the particle's picture. */
  const spriteFrom = (id: string) => {
    if (!id) { setEm({ look: 'pixel', sprite: undefined }, 'Particle look'); return; }
    const sp = spriteFromLayer(d, id);
    if (!sp) { ed.toast('That layer is empty.'); return; }
    setEm({ look: 'sprite', sprite: sp }, 'Particle sprite');
    ed.toast(`Particles now use a ${sp.w}×${sp.h} picture${sp.frames.length > 1 ? ` with ${sp.frames.length} frames over their life` : ''}. Hide that layer if it shouldn't show itself.`);
  };

  return (
    <div className="shaderpanel">
      <div className="rig-view" title="Click to move the particles here; Shift+click sets the selected emitter's pull point"
        onClick={(e) => {
          const r = canvasRef.current!.getBoundingClientRect();
          const x = Math.floor((e.clientX - r.left) / zoom), y = Math.floor((e.clientY - r.top) / zoom);
          if (e.shiftKey && cur) setEm({ attractX: x - sys.x, attractY: y - sys.y }, 'Move pull point');
          else setSys({ x, y }, 'Move particles');
        }}>
        <canvas ref={canvasRef} className="pixelated" aria-label="Particle preview" />
      </div>
      <div className="row">
        <button className="btn" aria-label="Previous frame" onClick={() => ed.setFrame(s.frame - 1)}>◀</button>
        <button className={'btn' + (ed.playing ? ' on' : '')} onClick={() => ed.togglePlay()}>{ed.playing ? '■' : '▶'}</button>
        <button className="btn" aria-label="Next frame" onClick={() => ed.setFrame(s.frame + 1)}>▶|</button>
        <span className="dim grow">Frame {s.frame + 1}/{d.frames.length} · {loopSeconds.toFixed(2)} s</span>
        <button className="btn" title="Add a frame so particles have time to move" onClick={() => ed.addFrame()}>+ Frame</button>
      </div>
      {d.frames.length < 2 && <p className="dim">Add frames (Alt+N) to see particles move; the loop is the whole animation.</p>}

      <h4>System “{layer.name}”</h4>
      <label className="check" title="Emission repeats every loop so the last frame runs into the first"><input type="checkbox" checked={sys.looping} onChange={(e) => setSys({ looping: e.target.checked }, 'Particle loop')} /> Loop seamlessly</label>
      <label className="check"><input type="checkbox" checked={sys.palette} onChange={(e) => setSys({ palette: e.target.checked }, 'Particle palette')} /> Snap colours to the palette</label>
      <label className="field" title="Paint on this layer, then keep particles inside or outside what you painted">Mask<select value={sys.mask} onChange={(e) => setSys({ mask: e.target.value as ParticleSystem['mask'] }, 'Particle mask')}>
        <option value="none">None</option><option value="inside">Only inside this layer's pixels</option><option value="outside">Only outside this layer's pixels</option>
      </select></label>
      {sys.mask !== 'none' && <label className="check"><input type="checkbox" checked={sys.keepArt} onChange={(e) => setSys({ keepArt: e.target.checked }, 'Particle mask')} /> Show the mask pixels too</label>}

      <h4>Emitters</h4>
      <div className="rig-bones" role="listbox" aria-label="Emitters">
        {sys.emitters.map((e) => (
          <div key={e.id} className={'rig-bone fxrow' + (e.id === cur?.id ? ' on' : '')}>
            <input type="checkbox" checked={e.on} aria-label={`${e.name} on`} onChange={(ev) => setSys({ emitters: sys.emitters.map((x) => (x.id === e.id ? { ...x, on: ev.target.checked } : x)) }, 'Toggle emitter')} />
            <span className="swatchdot" style={{ background: e.colours[0] }} />
            <button className="link grow" onClick={() => setSel(e.id)}>{e.name}</button>
            <button className="mini" aria-label="Duplicate emitter" title="Duplicate" onClick={() => addEmitters([{ ...e, id: newId('pe'), name: e.name + ' copy', seed: e.seed + 1 }], 'Duplicate emitter')}>⧉</button>
            <button className="mini" aria-label="Remove emitter" onClick={() => setSys({ emitters: sys.emitters.filter((x) => x.id !== e.id) }, 'Remove emitter')}>×</button>
          </div>
        ))}
      </div>
      <label className="field">Add<select value="" onChange={(e) => {
        if (e.target.value === '_empty') addEmitters([newEmitter(newId('pe'), `Emitter ${sys.emitters.length + 1}`)], 'Add emitter');
        else if (e.target.value) addEmitters(presetEmitters(e.target.value), `Add ${e.target.value}`);
      }}>
        <option value="">Choose an emitter…</option>
        <option value="_empty">Empty emitter</option>
        {PARTICLE_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select></label>

      {cur && (
        <>
          <h4><input className="namein" aria-label="Emitter name" value={cur.name} onChange={(e) => setEm({ name: e.target.value }, 'Rename emitter')} onKeyDown={(e) => e.stopPropagation()} /></h4>
          <label className="field">Shape<select value={cur.shape} onChange={(e) => setEm({ shape: e.target.value as Emitter['shape'] }, 'Emitter shape')}>
            <option value="point">Point</option><option value="line">Line</option><option value="box">Box</option><option value="circle">Circle (filled)</option><option value="ring">Ring</option>
          </select></label>
          {cur.shape !== 'point' && <>
            <Slider f={F('shapeW', cur.shape === 'circle' || cur.shape === 'ring' ? 'Width (diameter)' : 'Width', 1, 128)} v={cur.shapeW} set={(v) => setEm({ shapeW: v })} />
            {cur.shape !== 'line' && <Slider f={F('shapeH', 'Height', 1, 128)} v={cur.shapeH} set={(v) => setEm({ shapeH: v })} />}
          </>}
          <Slider f={F('x', 'Offset X', -64, 64)} v={cur.x} set={(v) => setEm({ x: v })} />
          <Slider f={F('y', 'Offset Y', -64, 64)} v={cur.y} set={(v) => setEm({ y: v })} />
          {SECTIONS.map((sec) => (
            <div key={sec.name}>
              <button className="link sect" aria-expanded={!!open[sec.name]} onClick={() => setOpen({ ...open, [sec.name]: !open[sec.name] })}>{open[sec.name] ? '▾' : '▸'} {sec.name}</button>
              {open[sec.name] && sec.fields.map((f) => <Slider key={f.k} f={f} v={cur[f.k]} set={(v) => setEm({ [f.k]: v } as Partial<Emitter>)} />)}
              {open[sec.name] && sec.name === 'Look' && (
                <>
                  <label className="field">Particle<select value={cur.look} onChange={(e) => setEm({ look: e.target.value as Emitter['look'] }, 'Particle look')}>
                    <option value="pixel">Square pixels</option><option value="disc">Round</option><option value="spark">Spark (streak)</option><option value="star">Star / cross</option>
                    {cur.sprite && <option value="sprite">Picture</option>}
                  </select></label>
                  <label className="field" title="Use another layer's art as the particle (frames play over its life)">Picture from layer<select value="" onChange={(e) => spriteFrom(e.target.value)}>
                    <option value="">{cur.sprite ? `Current ${cur.sprite.w}×${cur.sprite.h}…` : 'Choose a layer…'}</option>
                    {d.layers.filter((l) => l.kind === 'image' && l.id !== layer.id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select></label>
                  <label className="field">Fade<select value={cur.fade} onChange={(e) => setEm({ fade: e.target.value as Emitter['fade'] }, 'Particle fade')}>
                    <option value="dither">Dither (solid pixels)</option><option value="alpha">See-through</option>
                  </select></label>
                  <label className="field">Blend<select value={cur.blend} onChange={(e) => setEm({ blend: e.target.value as Emitter['blend'] }, 'Particle blend')}>
                    <option value="normal">Normal</option><option value="additive">Add (glow)</option>
                  </select></label>
                </>
              )}
              {open[sec.name] && sec.name === 'Forces' && (
                <>
                  <label className="check"><input type="checkbox" checked={cur.floor !== null} onChange={(e) => setEm({ floor: e.target.checked ? Math.min(d.height - 1, sys.y + 8) : null }, 'Particle floor')} /> Bounce on a floor</label>
                  {cur.floor !== null && <Slider f={F('bounce', 'Floor row', 0, d.height - 1)} v={cur.floor} set={(v) => setEm({ floor: v })} />}
                  <label className="check" title="Particles bounce off solid pixels in the layers under this one"><input type="checkbox" checked={cur.collideArt} onChange={(e) => setEm({ collideArt: e.target.checked }, 'Particle collisions')} /> Bounce off the art below</label>
                  {(cur.floor !== null || cur.collideArt) && <Slider f={F('bounce', 'Bounciness', 0, 1, 0.05)} v={cur.bounce} set={(v) => setEm({ bounce: v })} />}
                </>
              )}
            </div>
          ))}
          <h4>Colours over life</h4>
          <div className="row wrap">
            {cur.colours.map((c, i) => (
              <span key={i} className="rampcol">
                <input className="colorin" type="color" aria-label={`Colour ${i + 1}`} value={c} onChange={(e) => setEm({ colours: cur.colours.map((x, k) => (k === i ? e.target.value : x)) }, 'Particle colour')} />
                {cur.colours.length > 1 && <button className="mini" aria-label={`Remove colour ${i + 1}`} onClick={() => setEm({ colours: cur.colours.filter((_, k) => k !== i) }, 'Particle colour')}>×</button>}
              </span>
            ))}
            <button className="btn" onClick={() => setEm({ colours: [...cur.colours, cur.colours[cur.colours.length - 1] ?? '#ffffff'] }, 'Particle colour')}>+</button>
            <button className="btn" title="Use the palette's selected colour" onClick={() => {
              const c = ed.fg; const hex = '#' + [c & 255, (c >>> 8) & 255, (c >>> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('');
              setEm({ colours: [...cur.colours, hex] }, 'Particle colour');
            }}>+ Current colour</button>
          </div>
          <p className="dim">Colours step from first to last over each particle's life, with no blended in-between shades.</p>
        </>
      )}

      <h4>ParticleCraft</h4>
      <div className="row wrap">
        <button className="btn" onClick={() => importVfxHere()}>Import emitters…</button>
        <button className="btn" disabled={!sys.emitters.length} onClick={() => saveBytes(exchangeFileName(sys.name), JSON.stringify(asset(), null, 2), 'ParticleCraft effect')}>Export .vfx.json…</button>
        <button className="btn" disabled={!sys.emitters.length} title="Put it in the shared folder ParticleCraft, GameCraft and LogicCraft read" onClick={async () => {
          try { const name = exchangeFileName(sys.name); await api.exchangePut(name, JSON.stringify(asset())); ed.toast(`Sent ${name} to the Craft exchange folder.`); }
          catch (err: any) { ed.toast(`Couldn't send: ${err.message ?? err}`); }
        }}>Send to the Craft apps</button>
      </div>
      <p className="dim">Sizes and speeds convert at 16 pixels a metre. In the other apps the particles play as ordinary real-time particles; for exact pixels, bake and send the frames as a flipbook (File menu).</p>

      <h4>Bake</h4>
      <p className="dim">Particles already show in playback and every export. Baking turns them into pixels on each frame of this layer, so you can retouch them.</p>
      <button className="btn" onClick={() => ed.bakeParticles(layer.id)}>Bake to frames</button>
    </div>
  );
}

function Slider({ f, v, set }: { f: Field; v: number; set: (v: number) => void }) {
  return (
    <label className="field" title={f.title}>
      <span className="grow">{f.label}</span>
      <input type="range" aria-label={f.label} min={f.min} max={f.max} step={f.step ?? 1} value={v} onChange={(e) => set(+e.target.value)} />
      <span className="val">{+(+v).toFixed(2)}</span>
    </label>
  );
}

/** Opens a real-time ParticleCraft effect as a new particle layer (used from the empty panel). */
async function importAsLayer() {
  const [f] = await pickFiles('.json,.vfx.json');
  if (!f) return;
  try {
    const { system, notes } = readParticleVfx(await f.text(), ed.doc.width, ed.doc.height);
    ed.addParticleLayer(system, system.name);
    ed.toast(`Added "${system.name}" as particles.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`);
  } catch (err: any) { ed.toast(`Couldn't import: ${err.message ?? err}`); }
}
