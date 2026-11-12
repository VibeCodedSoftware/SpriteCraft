// The Performance panel (Phase 9): what the live effects cost on this frame, how well the cache is doing, any shader
// that failed, and settings for slower machines.
import { useState } from 'react';
import { clearFxCache, composeFrame, fxErrors, fxSettings, fxStats, type FxSettings } from '../core/compose';
import { effectById } from '../core/effects';
import { ed, savePref, useEd } from '../editor/editor';

/** Applies and remembers performance settings, then redraws. */
export function setFxSettings(patch: Partial<FxSettings>) {
  Object.assign(fxSettings, patch);
  savePref('performance', { ...fxSettings });
  clearFxCache();
  ed.invalidate('full');
  ed.notify();
}

export function PerfPanel() {
  useEd();
  const d = ed.doc, s = ed.s;
  const [timing, setTiming] = useState<{ frame: number; total: number; layers: { name: string; fx: string; ms: number }[] } | null>(null);
  const [loop, setLoop] = useState<{ cold: number; warm: number; max: number; budget: number } | null>(null);
  const fxLayers = d.layers.filter((l) => l.fx?.some((f) => f.on));

  /** Draws this frame with nothing kept, and reports each shaded layer's time. */
  const timeFrame = () => {
    clearFxCache();
    fxStats.ms.clear();
    const t0 = performance.now();
    composeFrame(d, s.frame, { skipReference: true });
    const total = performance.now() - t0;
    setTiming({
      frame: s.frame, total,
      layers: fxLayers.map((l) => ({ name: l.name, fx: l.fx!.filter((f) => f.on).map((f) => effectById(f.effect)?.name ?? f.effect).join(', '), ms: fxStats.ms.get(l.id) ?? 0 }))
        .sort((a, b) => b.ms - a.ms),
    });
  };
  /** Draws every frame twice: first from scratch, then as playback does with results kept. */
  const timeLoop = () => {
    clearFxCache();
    let cold = 0, max = 0;
    for (let i = 0; i < d.frames.length; i++) { const t0 = performance.now(); composeFrame(d, i, { skipReference: true }); const dt = performance.now() - t0; cold += dt; max = Math.max(max, dt); }
    const t1 = performance.now();
    for (let i = 0; i < d.frames.length; i++) composeFrame(d, i, { skipReference: true });
    const warm = performance.now() - t1;
    const budget = Math.min(...d.frames.map((f) => f.duration));
    setLoop({ cold: cold / d.frames.length, warm: warm / d.frames.length, max, budget });
  };
  const errors = [...fxErrors.entries()].map(([k, msg]) => {
    const [lid, fid] = k.split('|');
    const l = d.layers.find((x) => x.id === lid), f = l?.fx?.find((x) => x.id === fid);
    return l && f ? { layer: l.name, fx: effectById(f.effect)?.name ?? f.effect, msg } : null;
  }).filter(Boolean) as { layer: string; fx: string; msg: string }[];
  const mb = (n: number) => (n / 1048576).toFixed(1);

  return (
    <div className="shaderpanel perfpanel">
      <h4>This sprite</h4>
      <p className="dim">{d.width}×{d.height}, {d.layers.length} layer{d.layers.length === 1 ? '' : 's'}, {d.frames.length} frame{d.frames.length === 1 ? '' : 's'}; {fxLayers.length} layer{fxLayers.length === 1 ? '' : 's'} with live effects.</p>
      <div className="row wrap">
        <button className="btn" onClick={timeFrame} disabled={!fxLayers.length}>Time this frame</button>
        <button className="btn" onClick={timeLoop}>Time the whole loop</button>
      </div>
      {timing && (
        <>
          <p>Frame {timing.frame + 1} from scratch: <b>{timing.total.toFixed(1)} ms</b></p>
          <table className="perf-table"><tbody>
            {timing.layers.map((l) => <tr key={l.name + l.fx}><td>{l.name}</td><td className="dim">{l.fx}</td><td className="num">{l.ms.toFixed(1)} ms</td></tr>)}
          </tbody></table>
        </>
      )}
      {loop && (
        <p>
          Per frame: <b>{loop.cold.toFixed(1)} ms</b> the first time (slowest {loop.max.toFixed(1)} ms), <b>{loop.warm.toFixed(1)} ms</b> once kept.
          {loop.max > loop.budget
            ? <span className="warn"> The first play-through can't keep up with {loop.budget} ms frames; it's smooth from the second loop. Bake heavy layers, or turn off live effects on the canvas while drawing.</span>
            : <span className="dim"> Fast enough for {loop.budget} ms frames.</span>}
        </p>
      )}

      <h4>Kept results</h4>
      <p className="dim">Shaded layers are kept per frame, so playback and redraws skip the work. {fxStats.hits} reused, {fxStats.misses} drawn, {fxStats.deferred} shown from before a stroke; {mb(fxStats.bytes)} of {fxSettings.budgetMB} MB.</p>
      <label className="check"><input type="checkbox" checked={fxSettings.cache} onChange={(e) => setFxSettings({ cache: e.target.checked })} /> Keep shaded layers</label>
      <label className="check" title="Faster drawing on big sprites; the effects catch up when you let go"><input type="checkbox" checked={fxSettings.deferWhileDrawing} onChange={(e) => setFxSettings({ deferWhileDrawing: e.target.checked })} /> While drawing, show effects on other layers as before the stroke</label>
      <label className="field"><span className="grow">Memory for kept results (MB)</span>
        <input type="range" aria-label="Memory for kept results" min={32} max={1024} step={32} value={fxSettings.budgetMB} onChange={(e) => setFxSettings({ budgetMB: +e.target.value })} />
        <span className="val">{fxSettings.budgetMB}</span></label>
      <button className="btn" onClick={() => setFxSettings({})}>Free kept results</button>

      <h4>Quality</h4>
      <label className="check" title="Off: the canvas (and the Preview panel, which copies it) shows only your art, which is fastest. The effect panels' own previews and every export still include the effects."><input type="checkbox" checked={fxSettings.showOnCanvas} onChange={(e) => setFxSettings({ showOnCanvas: e.target.checked })} /> Show live effects on the canvas</label>

      <h4>Problems</h4>
      {errors.length ? errors.map((e, i) => <p key={i} className="warn">{e.layer} · {e.fx}: {e.msg}. It's being passed over.</p>) : <p className="dim">No live effect has failed.</p>}
      {errors.length > 0 && <button className="btn" onClick={() => { fxErrors.clear(); setFxSettings({}); }}>Try them again</button>}
    </div>
  );
}
