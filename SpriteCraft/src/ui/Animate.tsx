// The Animate panel (Phase 2): motion tweens on the current layer. Values shown are the ones at the current frame; changing
// one sets a key there. The curve editor times the segment that leaves the key on this frame.
import { useRef, useState } from 'react';
import * as M from '../core/anim';
import { celKey } from '../core/types';
import { ed, useEd } from '../editor/editor';
import { Num } from './Panels';

const isCustom = (e: M.Ease): e is { bezier: [number, number, number, number] } => typeof e === 'object' && 'bezier' in e;

/** A draggable timing curve. Presets are drawn too, read-only, so the shape of any easing is visible. */
export function CurveEditor({ ease, onChange }: { ease: M.Ease; onChange: (e: M.Ease) => void }) {
  const S = 132, P = 14;
  const svg = useRef<SVGSVGElement>(null);
  const fn = M.easeFn(ease);
  // Overshooting curves (back, elastic) go outside 0..1, so the box leaves room above and below.
  const toX = (x: number) => P + x * (S - 2 * P), toY = (y: number) => S - P - y * (S - 2 * P) * 0.72 - (S - 2 * P) * 0.14;
  const pts: string[] = [];
  for (let i = 0; i <= 64; i++) { const x = i / 64; pts.push(`${toX(x).toFixed(1)},${toY(fn(x)).toFixed(1)}`); }
  const b = isCustom(ease) ? ease.bezier : null;
  const drag = (which: 0 | 1) => (e: React.PointerEvent) => {
    if (!b) return;
    const el = svg.current!;
    (e.target as Element).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const sx = ((ev.clientX - r.left) / r.width) * S, sy = ((ev.clientY - r.top) / r.height) * S;
      const x = Math.max(0, Math.min(1, (sx - P) / (S - 2 * P)));
      const y = Math.max(-0.5, Math.min(1.5, (S - P - (S - 2 * P) * 0.14 - sy) / ((S - 2 * P) * 0.72)));
      const nb: [number, number, number, number] = [...b];
      nb[which * 2] = +x.toFixed(3); nb[which * 2 + 1] = +y.toFixed(3);
      cur = nb;
      setLive(nb);
    };
    let cur: [number, number, number, number] = [...b];
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setLive(null); onChange({ bezier: cur }); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [live, setLive] = useState<[number, number, number, number] | null>(null);
  const shown = live ?? b;
  const liveFn = live ? M.cubicBezier(...live) : null;
  const livePts: string[] = [];
  if (liveFn) for (let i = 0; i <= 64; i++) { const x = i / 64; livePts.push(`${toX(x).toFixed(1)},${toY(liveFn(x)).toFixed(1)}`); }
  return (
    <svg ref={svg} className="curve" viewBox={`0 0 ${S} ${S}`} width={S} height={S} role="img" aria-label={`Timing curve: ${M.easeLabel(ease)}`}>
      <rect x={toX(0)} y={toY(1)} width={toX(1) - toX(0)} height={toY(0) - toY(1)} className="curve-box" />
      <polyline points={(liveFn ? livePts : pts).join(' ')} className="curve-line" />
      {shown && <>
        <line x1={toX(0)} y1={toY(0)} x2={toX(shown[0])} y2={toY(shown[1])} className="curve-arm" />
        <line x1={toX(1)} y1={toY(1)} x2={toX(shown[2])} y2={toY(shown[3])} className="curve-arm" />
        <circle cx={toX(shown[0])} cy={toY(shown[1])} r={5} className="curve-handle" onPointerDown={drag(0)} aria-label="First handle" />
        <circle cx={toX(shown[2])} cy={toY(shown[3])} r={5} className="curve-handle" onPointerDown={drag(1)} aria-label="Second handle" />
      </>}
    </svg>
  );
}

function EaseChooser({ ease, onChange }: { ease: M.Ease; onChange: (e: M.Ease) => void }) {
  const value = typeof ease === 'string' ? ease : 'steps' in ease ? 'steps' : 'custom';
  return (
    <>
      <label className="field">Easing
        <select aria-label="Easing" value={value} onChange={(e) => {
          const v = e.target.value;
          if (v === 'custom') onChange({ bezier: [0.4, 0, 0.6, 1] });
          else if (v === 'steps') onChange({ steps: 4 });
          else onChange(v as M.EasePreset);
        }}>
          {M.EASE_PRESETS.map((p) => <option key={p} value={p}>{M.easeLabel(p)}</option>)}
          <option value="steps">Steps</option>
          <option value="custom">Custom curve (drag the handles)</option>
        </select>
      </label>
      {typeof ease === 'object' && 'steps' in ease && <label className="field">Steps<Num value={ease.steps} min={1} max={64} onChange={(n) => onChange({ steps: n })} /></label>}
      <CurveEditor ease={ease} onChange={onChange} />
    </>
  );
}

export function AnimatePanel() {
  useEd();
  const d = ed.doc, s = ed.s, layer = ed.layer;
  const list = M.motionsOnLayer(d, s.layerId);
  const m = ed.motion;
  const last = d.frames.length - 1;
  const [from, to] = s.range ?? [s.frame, last];

  if (!layer || layer.kind !== 'image') return <p className="dim">Choose an image layer to animate it.</p>;

  if (!m) {
    return (
      <div className="animate">
        <p className="dim">A tween moves, turns, scales, fades or recolours the art on the current frame across a run of frames. The frames in between are made for you and stay editable.</p>
        <p className="dim">Frames {from + 1} to {to + 1}{s.range ? ' (selected in the timeline)' : ' (shift-click frames in the timeline to choose others)'}.</p>
        <button className="btn primary" disabled={d.frames.length < 2 || from === to} onClick={() => ed.newMotion(from, to)}>New tween from frame {s.frame + 1}</button>
        {d.frames.length < 2 && <p className="warn">Add frames first (Alt+N).</p>}
        {list.length > 0 && (
          <>
            <h4>Tweens on this layer</h4>
            {list.map((x) => { const r = M.motionRange(d, x); return (
              <button key={x.id} className="btn" onClick={() => { if (r) ed.setFrame(r[0]); }}>{x.name}{r ? `: frames ${r[0] + 1}–${r[1] + 1}` : ''}</button>
            ); })}
          </>
        )}
      </div>
    );
  }

  const range = M.motionRange(d, m);
  const sample = M.sampleMotion(d, m, s.frame);
  const f = d.frames[s.frame].id;
  const keysHere = M.PROPS.filter((p) => (m.tracks[p.key] ?? []).some((k) => k.f === f));
  const ease = keysHere.length ? (m.tracks[keysHere[0].key]!.find((k) => k.f === f)!.ease) : null;
  const keyIdx = [...M.keyFrames(d, m)].sort((a, b) => a - b);
  const prevKey = [...keyIdx].reverse().find((i) => i < s.frame), nextKey = keyIdx.find((i) => i > s.frame);
  const drawn = range ? d.frames.slice(range[0], range[1] + 1).filter((fr) => { const c = d.cels[celKey(m.layerId, fr.id)]; return c && c.gen !== m.id; }).length : 0;
  const here = d.cels[celKey(m.layerId, f)];
  const inRange = !!range && s.frame >= range[0] && s.frame <= range[1];

  return (
    <div className="animate">
      {list.length > 1 && (
        <label className="field">Tween<select value={m.id} onChange={(e) => { ed.motionPick = e.target.value; ed.notify(); }}>
          {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select></label>
      )}
      <div className="row">
        <b className="grow">{m.name}</b>
        <span className="dim">{range ? `frames ${range[0] + 1}–${range[1] + 1}` : 'no keys'}</span>
      </div>

      {m.editing ? (
        <div className="notice">
          <p>Editing the original art on frame {d.frames.findIndex((x) => x.id === m.editing) + 1}. Other frames update when you finish.</p>
          <button className="btn primary" onClick={() => ed.endSourceEdit()}>Done editing art</button>
        </div>
      ) : (
        <>
          <div className="row">
            <button className="btn" title="Previous key" disabled={prevKey === undefined} onClick={() => ed.setFrame(prevKey!)}>◂ Key</button>
            <span className="grow dim mid">Frame {s.frame + 1}{keysHere.length ? ' · key' : inRange ? ' · in between' : ' · outside'}</span>
            <button className="btn" title="Next key" disabled={nextKey === undefined} onClick={() => ed.setFrame(nextKey!)}>Key ▸</button>
          </div>
          {!inRange && (
            <p className="dim">This frame is outside the tween. A value set here adds a key and extends the tween to it.{' '}
              <button className="link" onClick={() => { ed.motionPick = null; ed.notify(); }}>Close this tween</button></p>
          )}
          <table className="props">
            <tbody>
              {M.PROPS.map((p) => {
                const has = keysHere.includes(p);
                const animated = (m.tracks[p.key]?.length ?? 0) > 0;
                return (
                  <tr key={p.key} className={animated ? 'animated' : ''}>
                    <td><button className={'keybtn' + (has ? ' on' : '')} aria-pressed={has} title={has ? `Remove the ${p.label} key on this frame` : `Add a ${p.label} key on this frame`} aria-label={`${p.label} key`} onClick={() => ed.toggleMotionKey(p.key)}>◆</button></td>
                    <td>{p.label}</td>
                    <td><Num value={+sample[p.key].toFixed(2)} min={p.min} max={p.max} step={p.key === 'x' || p.key === 'y' ? 1 : p.key === 'rotation' || p.key === 'hue' ? 5 : 1} width={62} title={`${p.label} at this frame. Changing it sets a key here.`} onChange={(n) => ed.setMotionValue(p.key, n)} /></td>
                    <td className="dim">{p.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {ease ? (
            <>
              <h4>Timing to the next key</h4>
              <EaseChooser ease={ease} onChange={(e) => ed.setMotionEase(e)} />
            </>
          ) : <p className="dim">Go to a key (◆) to change the timing that leaves it.</p>}

          <h4>Options</h4>
          <label className="check"><input type="checkbox" checked={m.curvedPath} onChange={(e) => ed.patchMotion({ curvedPath: e.target.checked }, 'Curved path')} /> Curved path through the position keys</label>
          <label className="field" title="Stretches the art along its direction of travel by speed, keeping its area">Squash &amp; stretch
            <input type="range" min={0} max={100} value={m.squash} onChange={(e) => ed.patchMotion({ squash: +e.target.value }, 'Squash and stretch')} /><span className="val">{m.squash}</span>
          </label>
          <label className="check"><input type="checkbox" checked={m.snap} onChange={(e) => ed.patchMotion({ snap: e.target.checked }, 'Whole-pixel moves')} /> Move in whole pixels</label>
          <label className="check" title="Turning uses an 8× pixel-art enlargement for cleaner edges. Off samples the art directly."><input type="checkbox" checked={m.quality === 'smooth-edges'} onChange={(e) => ed.patchMotion({ quality: e.target.checked ? 'smooth-edges' : 'nearest' }, 'Rotation quality')} /> Clean edges when turning</label>
          <div className="row">
            <label>Pivot X<Num value={+m.pivot.x.toFixed(1)} step={0.5} onChange={(n) => ed.patchMotion({ pivot: { ...m.pivot, x: n } }, 'Move pivot')} /></label>
            <label>Y<Num value={+m.pivot.y.toFixed(1)} step={0.5} onChange={(n) => ed.patchMotion({ pivot: { ...m.pivot, y: n } }, 'Move pivot')} /></label>
          </div>

          <h4>Frames</h4>
          {drawn > 0 && <p className="dim">{drawn} frame{drawn === 1 ? ' was' : 's were'} painted by hand and {drawn === 1 ? 'is' : 'are'} kept as drawn. Right-click a cel in the timeline to put the tween back on it.</p>}
          {inRange && here && here.gen !== m.id && <button className="btn" onClick={() => ed.resetCelToTween()}>Reset this frame to the tween</button>}
          <div className="row wrap">
            <button className="btn" title="Shows the original art on this frame to paint on" onClick={() => ed.beginSourceEdit()}>Edit art</button>
            <button className="btn" title="Keeps every frame as ordinary pixels and removes the tween" onClick={() => ed.removeMotion(true)}>Convert to frames</button>
            <button className="btn danger" title="Removes the tween and its frames, and puts the original art back on the first frame" onClick={() => ed.removeMotion(false)}>Delete</button>
          </div>
        </>
      )}
    </div>
  );
}
