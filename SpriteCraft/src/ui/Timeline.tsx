// The timeline: layers down the side, frames across the top. Only the frames in view are in the DOM, so long animations
// stay fast.
import { useEffect, useRef, useState } from 'react';
import { isLinkedCel, layerRows, totalDuration } from '../core/doc';
import { keyFrames, motionRange, motionsOnLayer } from '../core/anim';
import { celKey } from '../core/types';
import { ed, useEd } from '../editor/editor';
import { Icon } from './icons';
import { Btn, Num } from './Panels';
import { showContextMenu } from './ContextMenu';

const CELL = 22;

export function Timeline() {
  useEd();
  const d = ed.doc, s = ed.s;
  const rows = layerRows(d);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollX, setScrollX] = useState(0);
  const [viewW, setViewW] = useState(800);
  const drag = useRef<{ kind: 'cel' | 'frame'; layer?: string; frame: number } | null>(null);

  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The current frame stays in view, including during playback.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const x = s.frame * CELL;
    if (x < el.scrollLeft) el.scrollLeft = x;
    else if (x + CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = x + CELL - el.clientWidth;
  }, [s.frame]);

  const first = Math.max(0, Math.floor(scrollX / CELL) - 2);
  const last = Math.min(d.frames.length - 1, Math.ceil((scrollX + viewW) / CELL) + 2);
  const visible: number[] = [];
  for (let i = first; i <= last; i++) visible.push(i);

  const range = s.range;
  const inRange = (f: number) => !!range && f >= range[0] && f <= range[1];
  const clickFrame = (f: number, shift: boolean) => {
    if (shift) { const a = range ? range[0] : s.frame; s.range = [Math.min(a, f), Math.max(a, f)]; }
    else s.range = null;
    ed.setFrame(f);
    ed.notify();
  };
  const target = (e: PointerEvent | React.PointerEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const c = el?.closest?.('[data-frame]') as HTMLElement | null;
    return c ? { frame: +c.dataset.frame!, layer: c.dataset.layer } : null;
  };
  const dur = d.frames[s.frame]?.duration ?? 100;
  const seconds = totalDuration(d) / 1000;

  return (
    <div className="timeline" data-testid="timeline">
      <div className="tl-bar">
        <Btn icon="prev" title="First frame (Home)" onClick={() => ed.setFrame(0)} />
        <Btn icon={ed.playing ? 'stop' : 'play'} title="Play / stop (Enter)" on={ed.playing} onClick={() => ed.togglePlay()} />
        <Btn icon="next" title="Last frame (End)" onClick={() => ed.setFrame(d.frames.length - 1)} />
        <span className="tl-sep" />
        <Btn icon="plus" title="New frame (Alt+N)" onClick={() => ed.addFrame()} />
        <Btn icon="copy" title="Duplicate frame (Alt+D)" onClick={() => ed.duplicateFrame()} />
        <Btn icon="link" title="Duplicate with linked cels: editing one edits both (Alt+Shift+D)" onClick={() => ed.duplicateFrame(true)} />
        <Btn icon="trash" title="Delete frame (Alt+Delete)" onClick={() => ed.removeFrames()} disabled={d.frames.length <= 1} />
        <span className="tl-sep" />
        <Btn icon="onion" title="Onion skin (Ctrl+Shift+K). Settings are in the Canvas panel." on={ed.onion.on} onClick={() => { ed.onion = { ...ed.onion, on: !ed.onion.on }; ed.notify(); }} />
        <Btn icon="tag" title="New tag from the selected frames. Shift-click frames to choose several." onClick={() => {
          const [a, b] = s.range ?? [s.frame, s.frame];
          const t = ed.addTag(a, b, `Tag ${d.tags.length + 1}`);
          ed.openDialog('tag', { id: t.id });
        }} />
        <button className="btn" title="Tween the art on this frame across the selected frames (or to the last frame). Opens in the Animate panel." onClick={() => {
          const [a, b] = s.range ?? [s.frame, d.frames.length - 1];
          ed.newMotion(a, b);
        }}>Tween</button>
        <label className="check" title="Loop inside the tag under the current frame"><input type="checkbox" checked={ed.loopRange === 'tag'} onChange={(e) => { ed.loopRange = e.target.checked ? 'tag' : 'all'; ed.notify(); }} /> Loop tag</label>
        <span className="tl-sep" />
        <label title="How long this frame shows. With frames selected, applies to all of them.">Frame <b>{s.frame + 1}</b>/{d.frames.length}
          <Num value={dur} min={1} max={65535} width={58} onChange={(n) => ed.setDuration(n)} /> ms
        </label>
        <label title="Sets every frame to the same speed">Speed
          <select value="" onChange={(e) => { const fps = +e.target.value; if (fps) ed.setDuration(1000 / fps, [0, d.frames.length - 1]); }}>
            <option value="">fps…</option>
            {[4, 6, 8, 10, 12, 15, 20, 24, 30, 60].map((n) => <option key={n} value={n}>{n} fps</option>)}
          </select>
        </label>
        <span className="dim">{seconds.toFixed(2)} s</span>
      </div>
      <div className="tl-body">
        <div className="tl-layers">
          <div className="tl-corner" style={{ height: d.tags.length ? 38 : 20 }} />
          {rows.map(({ layer, depth }) => (
            <div key={layer.id} className={'tl-layer' + (s.layerId === layer.id ? ' active' : '')} style={{ paddingLeft: 2 + depth * 10 }} onClick={() => ed.selectLayer(layer.id)}>
              <button className="mini" title={layer.visible ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); ed.patchLayer(layer.id, { visible: !layer.visible }, layer.visible ? 'Hide layer' : 'Show layer'); }}><Icon name={layer.visible ? 'eye' : 'eyeoff'} size={13} /></button>
              <button className="mini" title={layer.locked ? 'Unlock' : 'Lock'} onClick={(e) => { e.stopPropagation(); ed.patchLayer(layer.id, { locked: !layer.locked }, layer.locked ? 'Unlock layer' : 'Lock layer'); }}><Icon name={layer.locked ? 'lock' : 'unlock'} size={13} /></button>
              <span className="name">{layer.name}</span>
            </div>
          ))}
        </div>
        <div className="tl-scroll" ref={scroller} onScroll={(e) => setScrollX((e.target as HTMLElement).scrollLeft)}>
          <div className="tl-track" style={{ width: d.frames.length * CELL }}>
            {d.tags.length > 0 && (
              <div className="tl-tags">
                {d.tags.map((t) => (
                  <button key={t.id} className="tl-tag" style={{ left: t.from * CELL, width: (t.to - t.from + 1) * CELL - 2, background: t.color }} title={`${t.name}: frames ${t.from + 1} to ${t.to + 1}. Click to edit.`} onClick={() => ed.openDialog('tag', { id: t.id })}>{t.name}</button>
                ))}
              </div>
            )}
            <div className="tl-frames">
              {visible.map((f) => (
                <div key={d.frames[f].id} data-frame={f} style={{ left: f * CELL }}
                  className={'tl-frame' + (f === s.frame ? ' cur' : '') + (inRange(f) ? ' sel' : '')}
                  title={`Frame ${f + 1}, ${d.frames[f].duration} ms. Shift-click selects several, drag to move.`}
                  onPointerDown={(e) => { if (e.button) return; drag.current = { kind: 'frame', frame: f }; clickFrame(f, e.shiftKey); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
                  onPointerUp={(e) => {
                    const dr = drag.current; drag.current = null;
                    const t = target(e);
                    if (dr?.kind === 'frame' && t && t.frame !== dr.frame && !e.shiftKey) ed.moveFrame(dr.frame, t.frame);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    ed.setFrame(f);
                    showContextMenu(e.clientX, e.clientY, [
                      { label: 'New frame', run: () => ed.addFrame() },
                      { label: 'Duplicate', run: () => ed.duplicateFrame() },
                      { label: 'Duplicate linked', run: () => ed.duplicateFrame(true) },
                      { label: 'Delete', run: () => ed.removeFrames(), disabled: d.frames.length <= 1 },
                      { label: 'Move left', run: () => ed.moveFrame(f, f - 1), disabled: f === 0 },
                      { label: 'Move right', run: () => ed.moveFrame(f, f + 1), disabled: f === d.frames.length - 1 },
                    ]);
                  }}>{f + 1}</div>
              ))}
            </div>
            {rows.map(({ layer }) => {
              // Tweens on this layer: which frames they span and where their keys are.
              const tw = motionsOnLayer(d, layer.id).map((m) => ({ m, r: motionRange(d, m), keys: keyFrames(d, m) }));
              const tweenAt = (f: number) => tw.find((t) => t.r && f >= t.r[0] && f <= t.r[1]);
              return (
              <div key={layer.id} className={'tl-row' + (s.layerId === layer.id ? ' active' : '')}>
                {layer.kind === 'group' ? null : visible.map((f) => {
                  const key = celKey(layer.id, d.frames[f].id);
                  const cel = d.cels[key];
                  const has = !!cel;
                  const linked = has && isLinkedCel(d, key);
                  const t = tweenAt(f);
                  const isKey = !!t && t.keys.has(f);
                  const gen = !!cel?.gen;
                  const what = gen ? ' (made by the tween)' : t && has ? ' (painted over the tween)' : linked ? ' (linked)' : '';
                  return (
                    <div key={d.frames[f].id} data-frame={f} data-layer={layer.id} style={{ left: f * CELL }}
                      className={'tl-cel' + (f === s.frame ? ' cur' : '') + (inRange(f) ? ' sel' : '') + (s.layerId === layer.id && f === s.frame ? ' here' : '') + (t ? ' tween' : '') + (t && f === t.r![0] ? ' tween-start' : '') + (t && f === t.r![1] ? ' tween-end' : '')}
                      title={has ? `${layer.name}, frame ${f + 1}${what}${isKey ? ', key' : ''}. Drag to move; Ctrl copies, Alt links.` : `${layer.name}, frame ${f + 1}: empty${isKey ? ', key' : ''}`}
                      onPointerDown={(e) => {
                        if (e.button) return;
                        ed.selectLayer(layer.id);
                        clickFrame(f, e.shiftKey);
                        drag.current = { kind: 'cel', layer: layer.id, frame: f };
                      }}
                      onPointerUp={(e) => {
                        const dr = drag.current; drag.current = null;
                        const t = target(e);
                        if (dr?.kind === 'cel' && t?.layer && (t.frame !== dr.frame || t.layer !== dr.layer)) {
                          ed.placeCel(dr.layer!, dr.frame, t.layer, t.frame, e.ctrlKey ? 'copy' : e.altKey ? 'link' : 'move');
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        ed.selectLayer(layer.id);
                        ed.setFrame(f);
                        showContextMenu(e.clientX, e.clientY, [
                          { label: 'Clear cel', run: () => ed.clearCel(layer.id, f), disabled: !has },
                          { label: 'Unlink', run: () => ed.unlinkCel(layer.id, f), disabled: !linked },
                          { label: 'Link to previous frame', run: () => ed.placeCel(layer.id, f - 1, layer.id, f, 'link'), disabled: f === 0 || !d.cels[celKey(layer.id, d.frames[f - 1].id)] },
                          { label: 'Copy to next frame', run: () => ed.placeCel(layer.id, f, layer.id, f + 1, 'copy'), disabled: !has || f === d.frames.length - 1 },
                          ...(t ? [
                            { label: 'Reset to the tween', run: () => ed.resetCelToTween(layer.id, f), disabled: !has || gen },
                            { label: `Open "${t.m.name}" in Animate`, run: () => { ed.motionPick = t.m.id; ed.notify(); } },
                          ] : []),
                        ]);
                      }}>
                      {isKey && <b className="tl-key" aria-hidden>◆</b>}
                      {has && <i className={gen ? 'dot gen' : linked ? 'dot linked' : 'dot'} />}
                    </div>
                  );
                })}
              </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
