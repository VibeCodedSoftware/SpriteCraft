// The Rig panel (Phase 3): hang drawn parts on a 3D skeleton, pose and turn it in real time, then render frames.
// Dragging a slider poses live; letting go sets a key on the current frame (one undo step per change).
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Rg from '../core/rig';
import { fromHex, toHex } from '../core/color';
import { ed, useEd } from '../editor/editor';
import { newId } from '../core/types';
import { Num } from './Panels';

type Live = { bone: string; axis: Rg.Axis; v: number } | null;

export function RigPanel() {
  useEd();
  const d = ed.doc, rig = d.rig, s = ed.s;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState<string>('');
  const [live, setLive] = useState<Live>(null);
  // Orbiting the preview only looks around; "Key the camera" makes it part of the animation.
  const [orbit, setOrbit] = useState({ rx: 0, ry: 0 });
  const drag = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null);
  const [spin, setSpin] = useState(12);
  const [bendAt, setBendAt] = useState<number | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [showBones, setShowBones] = useState(true);
  // Grabbing a bone: it swings round its joint as the pointer moves, and letting go keys it on this frame.
  // The axis is the bone's own axis that faces the camera most: Bend (Z) seen from the front, Tilt (X) seen from the
  // side, so the bone always swings the way the pointer moves.
  const boneDrag = useRef<{ id: string; cx: number; cy: number; a0: number; v0: number; axis: Rg.Axis; sign: number } | null>(null);
  const cache = useMemo(() => new Map(), [d]);
  const images = useMemo(() => ed.rigImages(), [d, s.frame]);

  const bone = rig?.bones.find((b) => b.id === sel) ?? rig?.bones[0];
  const part = rig && bone ? rig.parts.find((p) => p.boneId === bone.id) : undefined;
  const pose = rig ? Rg.poseAt(d, rig, s.frame, orbit) : null;
  if (pose && live) pose[live.bone] = { ...pose[live.bone], [live.axis]: live.v };

  // Preview scale: whole screen pixels per sprite pixel.
  const zoom = Math.max(1, Math.floor(240 / Math.max(d.width, d.height)));
  const bones = rig && pose ? Rg.boneScreens(rig, pose, images) : null;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !rig || !pose) return;
    c.width = d.width; c.height = d.height;
    const out = Rg.renderRig(rig, pose, images, d.width, d.height, cache).image;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), d.width, d.height), 0, 0);
    c.style.width = d.width * zoom + 'px'; c.style.height = d.height * zoom + 'px';
    // The bones, drawn at screen resolution over the pixel art: a line from joint to tip, a dot on the joint.
    const o = overlayRef.current;
    if (!o) return;
    o.width = d.width * zoom; o.height = d.height * zoom;
    o.style.width = o.width + 'px'; o.style.height = o.height + 'px';
    const g = o.getContext('2d')!;
    g.clearRect(0, 0, o.width, o.height);
    if (!showBones || !bones) return;
    const fr = d.frames[s.frame].id;
    // Far bones first, so nearer ones are drawn on top.
    const list = [...bones.entries()].sort((a, b) => a[1].head[2] - b[1].head[2]);
    for (const [id, bs] of list) {
      const on = id === (sel || rig.bones[0]?.id);
      const isKeyed = Object.values(rig.tracks[id] ?? {}).some((ks) => ks?.some((k) => k.f === fr));
      const [hx, hy] = [bs.head[0] * zoom, bs.head[1] * zoom], [tx, ty] = [bs.tip[0] * zoom, bs.tip[1] * zoom];
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineWidth = on ? 6 : 5;
      g.beginPath(); g.moveTo(hx, hy); g.lineTo(tx, ty); g.stroke();
      g.strokeStyle = on ? '#ffb547' : 'rgba(255,255,255,0.85)'; g.lineWidth = on ? 3 : 2;
      g.beginPath(); g.moveTo(hx, hy); g.lineTo(tx, ty); g.stroke();
      g.fillStyle = on ? '#ffb547' : '#ffffff'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(hx, hy, on ? 5 : 4, 0, Math.PI * 2); g.fill(); g.stroke();
      if (isKeyed) { g.fillStyle = '#ffb547'; g.font = 'bold 10px sans-serif'; g.fillText('◆', hx + 6, hy - 4); }
    }
  });

  /** The bone under a point of the preview (display pixels), or null. Joints win over the lines between them. */
  const boneAt = (px: number, py: number): string | null => {
    if (!bones || !showBones) return null;
    let best: string | null = null, bestD = 8;
    for (const [id, bs] of bones) {
      const ax = bs.head[0] * zoom, ay = bs.head[1] * zoom, bx = bs.tip[0] * zoom, by = bs.tip[1] * zoom;
      const dj = Math.hypot(px - ax, py - ay) - 3;
      const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2)) : 0;
      const ds = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
      const dd = Math.min(dj, ds);
      if (dd < bestD) { bestD = dd; best = id; }
    }
    return best;
  };

  if (!rig) {
    return (
      <div className="rigpanel">
        <p>Turn a character drawn in parts, in 3D, in real time.</p>
        <p className="dim">Draw each part (head, body, each arm and leg) on its own layer. Each becomes a flat card on its own bone. Then give the bones parents, so an arm moves with the body, and turn them.</p>
        <p className="dim">For better turns, draw extra views of a part (three-quarter, side, back) on other layers and assign them; SpriteCraft switches to them by angle. It never invents pixels: every pixel shown is one you drew.</p>
        <button className="btn primary" onClick={() => ed.makeRig()}>Make a rig from the visible layers</button>
      </div>
    );
  }

  const layerName = (id: string) => d.layers.find((l) => l.id === id)?.name ?? '(deleted layer)';
  const otherLayers = d.layers.filter((l) => l.kind === 'image' && !rig.parts.some((p) => p.layerId === l.id));
  const setBone = (patch: Partial<Rg.Bone>, label = 'Change bone') => ed.patchRig({ ...rig, bones: rig.bones.map((b) => (b.id === bone!.id ? { ...b, ...patch } : b)) }, label);
  const setPart = (patch: Partial<Rg.Part>, label = 'Change part') => ed.patchRig({ ...rig, parts: rig.parts.map((p) => (p.boneId === bone!.id ? { ...p, ...patch } : p)) }, label);
  const f = d.frames[s.frame].id;
  const keyed = (id: string) => Object.values(rig.tracks[id] ?? {}).some((ks) => ks?.some((k) => k.f === f));

  const slider = (axis: Rg.Axis, label: string, target = bone!.id) => {
    const v = live && live.bone === target && live.axis === axis ? live.v : Math.round((pose![target]?.[axis] ?? 0) - (target === Rg.VIEW_BONE ? (axis === 'rx' ? orbit.rx : axis === 'ry' ? orbit.ry : 0) : 0));
    const commit = (n: number) => { setLive(null); ed.patchRig(Rg.setRigKey(d, rig, target, axis, s.frame, n), 'Pose'); };
    return (
      <label className="field"><span className="grow">{label}</span>
        <input type="range" aria-label={label} min={-180} max={180} value={v}
          onChange={(e) => setLive({ bone: target, axis, v: +e.target.value })}
          onPointerUp={(e) => commit(+(e.target as HTMLInputElement).value)}
          onKeyUp={(e) => commit(+(e.target as HTMLInputElement).value)} />
        <Num value={v} min={-720} max={720} width={46} onChange={commit} /><span className="dim">°</span>
      </label>
    );
  };

  const keyFrames = [...Rg.rigKeyFrames(d, rig)].sort((a, b) => a - b);
  const range: [number, number] = keyFrames.length > 1 ? [keyFrames[0], keyFrames[keyFrames.length - 1]] : [0, d.frames.length - 1];

  return (
    <div className="rigpanel">
      <div className="rig-view" title="Drag a bone to bend it (a key is set on this frame). Drag anywhere else to look around."
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          const r = canvasRef.current!.getBoundingClientRect();
          const px = e.clientX - r.left, py = e.clientY - r.top;
          const hit = boneAt(px, py);
          if (hit && bones) {
            const bs = bones.get(hit)!, cx = bs.head[0] * zoom, cy = bs.head[1] * zoom;
            setSel(hit);
            // The camera's turn (keyed plus orbit) decides which axis faces it: the screen's normal in the character's
            // space is (-sin turn, 0, cos turn).
            const turn = ((pose?.[Rg.VIEW_BONE]?.ry ?? 0) * Math.PI) / 180;
            const front = Math.abs(Math.cos(turn)) >= Math.abs(Math.sin(turn));
            const axis: Rg.Axis = front ? 'rz' : 'rx', sign = front ? Math.sign(Math.cos(turn)) || 1 : -(Math.sign(Math.sin(turn)) || 1);
            boneDrag.current = { id: hit, cx, cy, a0: Math.atan2(py - cy, px - cx), v0: Rg.poseAt(d, rig, s.frame)[hit]?.[axis] ?? 0, axis, sign };
            return;
          }
          drag.current = { x: e.clientX, y: e.clientY, ...orbit };
        }}
        onPointerMove={(e) => {
          const bd = boneDrag.current;
          if (bd) {
            const r = canvasRef.current!.getBoundingClientRect();
            const a = Math.atan2(e.clientY - r.top - bd.cy, e.clientX - r.left - bd.cx);
            // Screen angles grow clockwise (y points down), the same way Bend (Z) does facing front.
            let deg = bd.v0 + (bd.sign * (a - bd.a0) * 180) / Math.PI;
            deg = ((deg + 540) % 360) - 180;
            setLive({ bone: bd.id, axis: bd.axis, v: Math.round(deg) });
            return;
          }
          const g = drag.current;
          if (g) setOrbit({ ry: Math.round(g.ry + (e.clientX - g.x)), rx: Math.max(-89, Math.min(89, Math.round(g.rx - (e.clientY - g.y) / 2))) });
        }}
        onPointerUp={() => {
          const bd = boneDrag.current;
          boneDrag.current = null; drag.current = null;
          if (bd && live && live.bone === bd.id) {
            setLive(null);
            ed.patchRig(Rg.setRigKey(d, rig, bd.id, bd.axis, s.frame, live.v), 'Bend bone');
          }
        }}>
        <div className="rig-stack">
          <canvas ref={canvasRef} className="pixelated" aria-label="Rig preview" />
          <canvas ref={overlayRef} className="rig-overlay" aria-hidden />
        </div>
      </div>
      <div className="row">
        <button className="btn" title="Previous frame" aria-label="Previous frame" onClick={() => ed.setFrame(s.frame - 1)}>◀</button>
        <button className={'btn' + (ed.playing ? ' on' : '')} title="Play / stop" onClick={() => ed.togglePlay()}>{ed.playing ? '■' : '▶'}</button>
        <button className="btn" title="Next frame" aria-label="Next frame" onClick={() => ed.setFrame(s.frame + 1)}>▶|</button>
        <span className="dim grow">Frame {s.frame + 1}/{d.frames.length}{orbit.ry || orbit.rx ? ` · looking ${orbit.ry}° round` : ''}</span>
        <button className="btn" title="Add a frame after this one" onClick={() => ed.addFrame()}>+ Frame</button>
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={showBones} onChange={(e) => setShowBones(e.target.checked)} /> Show bones</label>
        <span className="grow" />
        <button className="btn" onClick={() => setOrbit({ rx: 0, ry: 0 })}>Front view</button>
      </div>

      <h4>Bones</h4>
      <div className="rig-bones" role="listbox" aria-label="Bones">
        {rig.bones.map((b) => {
          const depth = (() => { let n = 0, p = b.parent; while (p && n < 32) { n++; p = rig.bones.find((x) => x.id === p)?.parent ?? null; } return n; })();
          return (
            <button key={b.id} role="option" aria-selected={b.id === bone?.id} className={'rig-bone' + (b.id === bone?.id ? ' on' : '')} style={{ paddingLeft: 4 + depth * 12 }} onClick={() => setSel(b.id)}>
              {b.name}{keyed(b.id) && <b className="keymark" title="Has a key on this frame">◆</b>}
            </button>
          );
        })}
      </div>

      {bone && (
        <>
          <h4>Pose of “{bone.name}”</h4>
          {slider('rx', 'Tilt (X)')}
          {slider('ry', 'Turn (Y)')}
          {slider('rz', 'Bend (Z)')}
          <div className="row">
            <button className="btn" disabled={!keyed(bone.id)} onClick={() => ed.patchRig(Rg.clearRigKeys(d, rig, bone.id, s.frame), 'Delete key')}>Remove key here</button>
          </div>

          <h4>Setup</h4>
          <label className="field">Name<input value={bone.name} onChange={(e) => setBone({ name: e.target.value }, 'Rename bone')} onKeyDown={(e) => e.stopPropagation()} /></label>
          <label className="field">Hangs from<select value={bone.parent ?? ''} onChange={(e) => {
            const p = e.target.value || null;
            if (!Rg.canParent(rig, bone.id, p)) { ed.toast('That would make a loop of bones.'); return; }
            setBone({ parent: p }, 'Set parent');
          }}>
            <option value="">Nothing (a root)</option>
            {rig.bones.filter((b) => b.id !== bone.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></label>
          <div className="row wrap" title="The joint the bone turns around, in canvas pixels. Put it at the shoulder for an arm, the neck for a head.">
            <span className="dim">Joint</span>
            <label>X<Num value={+bone.head.x.toFixed(1)} step={0.5} width={50} onChange={(n) => setBone({ head: { ...bone.head, x: n } }, 'Move joint')} /></label>
            <label>Y<Num value={+bone.head.y.toFixed(1)} step={0.5} width={50} onChange={(n) => {
              // A bend's joint and the row where its part is cut move together.
              const host = rig.parts.find((p) => p.bends?.some((b) => b.boneId === bone.id));
              if (!host) { setBone({ head: { ...bone.head, y: n } }, 'Move joint'); return; }
              ed.patchRig({
                ...rig,
                bones: rig.bones.map((b) => (b.id === bone.id ? { ...b, head: { ...b.head, y: n } } : b)),
                parts: rig.parts.map((p) => (p === host ? { ...p, bends: p.bends!.map((b) => (b.boneId === bone.id ? { ...b, at: Math.round(n) } : b)).sort((a, c) => a.at - c.at) } : p)),
              }, 'Move bend');
            }} /></label>
            <label title="Depth: larger is nearer the viewer">Z<Num value={+bone.head.z.toFixed(1)} step={0.5} width={46} onChange={(n) => setBone({ head: { ...bone.head, z: n } }, 'Move joint')} /></label>
          </div>
          {(() => {
            const host = rig.parts.find((p) => p.bends?.some((b) => b.boneId === bone.id));
            return host && (
              <div className="notice">
                <p>A bend in “{layerName(host.layerId)}”: everything below its joint follows this bone. Use Bend (Z) above to bend it like an elbow or knee.</p>
                <button className="btn danger" onClick={() => { setSel(''); ed.patchRig(Rg.removeBend(rig, host.layerId, bone.id), 'Remove bend'); }}>Remove this bend</button>
              </div>
            );
          })()}
          {part && (
            <>
              <h4>Bends</h4>
              {(part.bends ?? []).map((bd) => {
                const bb = rig.bones.find((b) => b.id === bd.boneId);
                return (
                  <div className="row" key={bd.boneId}>
                    <button className="link grow" onClick={() => setSel(bd.boneId)}>{bb?.name ?? 'Bend'} at row {bd.at}</button>
                    <button className="mini" aria-label={`Remove ${bb?.name ?? 'bend'}`} title="Remove this bend" onClick={() => ed.patchRig(Rg.removeBend(rig, part.layerId, bd.boneId), 'Remove bend')}>×</button>
                  </div>
                );
              })}
              {(() => {
                const img = images.get(part.layerId);
                if (!img) return null;
                const at = bendAt ?? Math.round(img.box.y + img.box.h / 2);
                return (
                  <div className="row wrap" title="Bends the part at this canvas row, like an elbow or knee. The part below follows a new bone you can bend and animate.">
                    <label>Row<Num value={at} min={img.box.y + 1} max={img.box.y + img.box.h - 1} width={50} onChange={(n) => setBendAt(n)} /></label>
                    <button className="btn" onClick={() => {
                      const next = Rg.addBend(rig, part.layerId, at, img, d.width, newId, `${bone.name} bend ${(part.bends?.length ?? 0) + 1}`);
                      if (next === rig) { ed.toast('Choose a row inside the part, not already bent.'); return; }
                      ed.patchRig(next, 'Add bend');
                      setSel(next.bones[next.bones.length - 1].id);
                      setBendAt(null);
                    }}>Add a bend here</button>
                  </div>
                );
              })()}
              <label className="field" title="How far in front the card sits. Parts at different depths swap order as the character turns.">Card depth<Num value={part.z} step={0.5} width={50} onChange={(n) => setPart({ z: n }, 'Card depth')} /></label>
              <label className="field" title="The solid your drawing is printed on. Facing you at rest, every shape shows the drawing exactly.">Shape<select value={part.shape ?? 'card'} onChange={(e) => setPart({ shape: e.target.value as Rg.PartShape, depth: undefined }, 'Part shape')}>
                <option value="carved" disabled={!part.views.side}>From side drawing{part.views.side ? '' : ' (assign a side view first)'}</option>
                <option value="ball">Ball (heads)</option>
                <option value="tube">Tube (arms, legs)</option>
                <option value="box">Box (bodies)</option>
                <option value="card">Flat card</option>
              </select></label>
              {part.shape === 'carved' && (
                <>
                  <p className="dim">Shaped by your front and side drawings together: where both outlines cover a point, it's solid. Turned, each spot shows the drawing made closest to that angle; a ¾ view makes the corners your own art.</p>
                  <label className="field" title="0 keeps hard corners where the front and side outlines meet; 100 rounds them fully"><span className="grow">Round corners</span>
                    <input type="range" aria-label="Round corners" min={0} max={100} value={part.roundCorners ?? 70} onChange={(e) => setPart({ roundCorners: +e.target.value }, 'Round corners')} /><span className="val">{part.roundCorners ?? 70}</span></label>
                </>
              )}
              {(part.shape === 'ball' || part.shape === 'tube' || part.shape === 'box') && (
                <>
                  {([['fullness', 'Fullness', -100, 100, 'Above 0 swells towards a box, below 0 pinches to a point'], ['flatFront', 'Flat front', 0, 95, 'Flattens the face that points at you, like a face or a chest'], ['taper', 'Taper', -100, 100, 'Above 0: deeper at the top, thinner at the bottom'], ['lean', 'Lean', -100, 100, 'Above 0: the top leans towards you']] as const).map(([k, label, min, max, tip]) => (
                    <label key={k} className="field" title={tip}><span className="grow">{label}</span>
                      <input type="range" aria-label={label} min={min} max={max} value={part[k] ?? 0} onChange={(e) => setPart({ [k]: +e.target.value } as Partial<Rg.Part>, label)} />
                      <span className="val">{part[k] ?? 0}</span>
                    </label>
                  ))}
                </>
              )}
              {(part.shape ?? 'card') !== 'card' && part.shape !== 'carved'
                ? <label className="field" title="How far it bulges towards you and away from you">Depth<Num value={+(part.depth ?? Rg.defaultDepth(part.shape!, images.get(part.layerId)?.box.w ?? 8, images.get(part.layerId)?.box.h ?? 8)).toFixed(1)} min={0.5} max={256} step={0.5} width={50} onChange={(n) => setPart({ depth: n }, 'Part depth')} /><span className="dim">px</span></label>
                : part.shape === 'carved' ? null : <label className="field" title="Like cardboard: when the part turns, its edge shows this many pixels deep, coloured from your drawing's outline. 0 is paper-thin and vanishes side-on.">Thickness<Num value={part.thickness ?? 2} min={0} max={64} width={50} onChange={(n) => setPart({ thickness: n }, 'Thickness')} /><span className="dim">px</span></label>}
              <p className="dim">Front: {layerName(part.layerId)}</p>
              {(['threeq', 'side', 'back'] as const).map((v) => (
                <label key={v} className="field">{v === 'threeq' ? '¾ view' : v === 'side' ? 'Side view' : 'Back view'}
                  <select value={part.views[v] ?? ''} onChange={(e) => {
                    const id = e.target.value || undefined, views = { ...part.views, [v]: id };
                    // A side view on a solid part shapes it: switch to carving (and back to a box if the view is removed).
                    const solid = (part.shape ?? 'card') !== 'card';
                    const shape = v !== 'side' || !solid ? part.shape : id ? 'carved' : part.shape === 'carved' ? 'box' : part.shape;
                    setPart({ views, shape }, 'Set view');
                  }}>
                    <option value="">{v === 'back' ? 'None: show the front card' : 'None: foreshorten the front'}</option>
                    {otherLayers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              ))}
              {!part.views.back && (
                <label className="field" title="Used when no back view is drawn. Every choice uses colours from your drawing.">Back
                  <select value={Rg.backModeOf(part)} onChange={(e) => setPart({ backMode: e.target.value as Rg.BackMode }, 'Back side')}>
                    <option value="top">Top colour of each column (hair)</option>
                    <option value="edges">Outline colour of each row (clothes)</option>
                    <option value="mirror">Front, mirrored (like paper)</option>
                    <option value="asDrawn">Front, as drawn</option>
                    <option value="colour">One colour</option>
                  </select>
                  {Rg.backModeOf(part) === 'colour' && <input className="colorin" type="color" aria-label="Back colour" value={toHex(part.backColour ?? 0xff808080).slice(0, 7)} onChange={(e) => setPart({ backColour: fromHex(e.target.value) ?? 0xff808080 }, 'Back colour')} />}
                </label>
              )}
            </>
          )}
        </>
      )}

      <h4>Camera</h4>
      {slider('ry', 'Camera turn', Rg.VIEW_BONE)}
      {slider('rx', 'Camera tilt', Rg.VIEW_BONE)}
      <p className="dim">Camera keys animate the view. Dragging the preview only looks around.</p>
      <label className="field" title="Balls, tubes and boxes darken where they turn away from you. 0 adds no new colours."><span className="grow">Roundness shading</span>
        <input type="range" aria-label="Roundness shading" min={0} max={90} value={rig.shading ?? 40} onChange={(e) => ed.patchRig({ ...rig, shading: +e.target.value }, 'Shading')} /><span className="val">{rig.shading ?? 40}%</span></label>
      <label className="field" title="Backs of cards with no back view drawn are darkened this much"><span className="grow">Back shading</span>
        <input type="range" aria-label="Back shading" min={0} max={90} value={rig.backShade} onChange={(e) => ed.patchRig({ ...rig, backShade: +e.target.value }, 'Back shading')} /><span className="val">{rig.backShade}%</span></label>
      <label className="check" title="Turned cards are sampled from an 8× pixel-art enlargement, which keeps diagonals cleaner. Still only your colours."><input type="checkbox" checked={rig.cleanEdges} onChange={(e) => ed.patchRig({ ...rig, cleanEdges: e.target.checked }, 'Clean edges')} /> Clean edges when turned</label>

      <h4>Render</h4>
      <button className="btn primary" onClick={() => ed.renderRigFrames(s.frame, s.frame)}>This frame</button>
      <button className="btn" onClick={() => ed.renderRigFrames(range[0], range[1])}>Frames {range[0] + 1}–{range[1] + 1}{keyFrames.length > 1 ? ' (the keyed animation)' : ''}</button>
      <div className="row">
        <button className="btn" onClick={() => ed.renderTurnaround(spin, orbit.rx)}>Turnaround</button>
        <label><Num value={spin} min={2} max={64} width={44} onChange={setSpin} /> frames</label>
      </div>
      <p className="dim">Renders go on a new layer as ordinary pixels to touch up; the part layers are hidden so nothing shows twice.</p>
      <button className="btn danger" onClick={() => ed.removeRig()}>Delete rig</button>
    </div>
  );
}
