// The Brush panel: live brush dynamics for every freehand tool (pencil, eraser, dither, shade and the rest).
import { type Dynamics } from '../core/dynamics';
import { ed, savePref, useEd } from '../editor/editor';
import { Num } from './Panels';

export function setDynamics(patch: Partial<Dynamics>) {
  ed.brush = { ...ed.brush, dyn: { ...ed.brush.dyn, ...patch } };
  savePref('brush', { ...ed.brush, custom: null, pattern: null, anim: null });
  ed.notify();
}

function Slider({ label, value, min, max, unit, title, onChange }: { label: string; value: number; min: number; max: number; unit?: string; title?: string; onChange: (n: number) => void }) {
  return (
    <label className="field" title={title}>
      <span className="grow">{label}</span>
      <input type="range" aria-label={label} min={min} max={max} value={value} onChange={(e) => onChange(+e.target.value)} />
      <Num value={value} min={min} max={max} width={46} onChange={onChange} />{unit && <span className="dim">{unit}</span>}
    </label>
  );
}

export function BrushPanel() {
  useEd();
  const d = ed.brush.dyn;
  const custom = !!ed.brush.custom;
  return (
    <div className="brushpanel">
      <label className="check"><input type="checkbox" checked={d.on} onChange={(e) => setDynamics({ on: e.target.checked })} /> <b>Live brush</b></label>
      <p className="dim">Varies every dab of the pencil, eraser and other freehand tools. Pixel-perfect lines are off while it is on.</p>
      <fieldset disabled={!d.on}>
        <Slider label="Spacing" value={d.spacing} min={1} max={64} unit="px" title="Pixels of stroke between dabs" onChange={(n) => setDynamics({ spacing: n })} />
        <Slider label="Scatter" value={d.scatter} min={0} max={64} unit="px" title="How far a dab may land from the stroke" onChange={(n) => setDynamics({ scatter: n })} />
        <Slider label="Density" value={d.density} min={1} max={100} unit="%" title="Chance that each dab is placed" onChange={(n) => setDynamics({ density: n })} />
        <Slider label="Size variation" value={d.sizeJitter} min={0} max={100} unit="%" title={custom ? 'Round and square brushes only' : 'How much smaller a dab may be'} onChange={(n) => setDynamics({ sizeJitter: n })} />
        <label className="check" title="With a pen or tablet, pressing lighter paints smaller"><input type="checkbox" checked={d.pressureSize} onChange={(e) => setDynamics({ pressureSize: e.target.checked })} /> Pen pressure sets size</label>
        <h4>Colour</h4>
        <Slider label="Hue variation" value={d.hueJitter} min={0} max={180} unit="°" onChange={(n) => setDynamics({ hueJitter: n })} />
        <Slider label="Brightness variation" value={d.valueJitter} min={0} max={100} unit="%" onChange={(n) => setDynamics({ valueJitter: n })} />
        {ed.doc.colorMode === 'indexed' && <p className="dim">Indexed sprite: varied colours snap to the nearest palette colour.</p>}
        <h4>Turning</h4>
        <label className="field">Turn the brush<select value={d.rotate} onChange={(e) => setDynamics({ rotate: e.target.value as Dynamics['rotate'] })}>
          <option value="none">No</option>
          <option value="random">Randomly, in quarter turns</option>
          <option value="direction">With the stroke, in quarter turns</option>
        </select></label>
        <label className="check"><input type="checkbox" checked={d.flip} onChange={(e) => setDynamics({ flip: e.target.checked })} /> Randomly mirror</label>
        <p className="dim">Quarter turns and mirrors move pixels without resampling, so the brush keeps its exact pixels{custom ? '' : '. They show with a custom brush (Ctrl+B)'}.</p>
      </fieldset>
      <button className="btn" onClick={() => setDynamics({ ...{ spacing: 1, scatter: 0, sizeJitter: 0, hueJitter: 0, valueJitter: 0, density: 100, rotate: 'none', flip: false } })}>Reset</button>
    </div>
  );
}
