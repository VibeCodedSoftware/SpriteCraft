// The Node editor (Phase 8): a graph of nodes on the current layer. Drag from an output dot to an input dot to wire
// images; feed numbers (Time, Maths) into any number setting from the inspector. Every node shows a small preview of
// its result on this frame. The graph is a live shader on the layer, so it plays and exports like everything else.
import { useEffect, useMemo, useRef, useState } from 'react';
import { composeFrame, layerPixels, layersBelow } from '../core/compose';
import type { EffectParam } from '../core/effects';
import { NODE_PRESETS, connect, evaluate, identityGraph, newNode, nodeType, nodeTypes, type GNode, type NodeCtx, type NodeDef, type NodeGraph } from '../core/nodes';
import { newId, type LayerFx } from '../core/types';
import { ed, loadPref, savePref, useEd } from '../editor/editor';
import { pickFiles, saveBytes } from '../editor/files';

const FORMAT = 'spritecraft.nodes';
const NW = 158, HEAD = 22, ROW = 18, THUMB = 44;
const findFx = (fx: LayerFx[] | undefined) => fx?.find((f) => f.effect === 'nodes');

const rowsOf = (def: NodeDef | undefined) => (def ? def.outputs.length + def.inputs.length : 0);
const heightOf = (def: NodeDef | undefined) => HEAD + rowsOf(def) * ROW + (def?.outputs.some((o) => o.type === 'image') || def?.type === 'output' ? THUMB + 8 : 4);
const outPos = (n: GNode, i: number) => ({ x: n.x + NW, y: n.y + HEAD + i * ROW + ROW / 2 });
const inPos = (n: GNode, def: NodeDef, j: number) => ({ x: n.x, y: n.y + HEAD + (def.outputs.length + j) * ROW + ROW / 2 });
const wire = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(30, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
};

/** Checks a graph from a file: known node types only, sensible values, links between nodes that exist. */
export function sanitizeGraph(raw: any): { graph: NodeGraph; dropped: number } {
  const nodes: GNode[] = [];
  let dropped = 0;
  for (const n of Array.isArray(raw?.nodes) ? raw.nodes : []) {
    const def = typeof n?.type === 'string' ? nodeType(n.type) : undefined;
    if (!def || typeof n.id !== 'string') { dropped++; continue; }
    const base = newNode(n.type, n.id, Number(n.x) || 0, Number(n.y) || 0);
    const params: Record<string, any> = { ...base.params };
    for (const p of def.params) {
      const v = n.params?.[p.key];
      if (p.type === 'number' && typeof v === 'number' && Number.isFinite(v)) params[p.key] = v;
      else if (p.type === 'bool' && typeof v === 'boolean') params[p.key] = v;
      else if ((p.type === 'color' || p.type === 'text') && typeof v === 'string' && v.length < 4000) params[p.key] = v;
      else if (p.type === 'choice' && p.options.includes(v)) params[p.key] = v;
    }
    nodes.push({ ...base, params });
  }
  let graph: NodeGraph = { nodes, links: [] };
  for (const l of Array.isArray(raw?.links) ? raw.links : []) {
    if (typeof l?.from !== 'string' || typeof l?.to !== 'string' || typeof l?.out !== 'string' || typeof l?.in !== 'string') continue;
    graph = connect(graph, { from: l.from, out: l.out, to: l.to, in: l.in }) ?? graph;
  }
  if (!graph.nodes.some((n) => n.type === 'output')) graph = { ...graph, nodes: [...graph.nodes, newNode('output', newId('nd'), 400, 40)] };
  return { graph, dropped };
}

function Thumb({ data, w, h }: { data: Uint32Array | undefined; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    if (data) g.putImageData(new ImageData(new Uint8ClampedArray(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), w, h), 0, 0);
  });
  const k = THUMB / Math.max(w, h);
  return <canvas ref={ref} className="pixelated node-thumb" style={{ width: w * k, height: h * k }} />;
}

export function NodePanel() {
  useEd();
  const d = ed.doc, s = ed.s, layer = ed.layer;
  const fx = findFx(layer?.fx);
  const graph = fx?.params.graph as NodeGraph | undefined;
  const [sel, setSel] = useState('');
  const [moving, setMoving] = useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ from: string; out: string; x: number; y: number } | null>(null);
  const [userPresets, setUserPresets] = useState<Record<string, NodeGraph>>(() => loadPref('nodePresets', {}));
  const boxRef = useRef<HTMLDivElement>(null);
  const types = useMemo(() => nodeTypes(), []);
  const defOf = (n: GNode) => types.find((t) => t.type === n.type);

  // Every node's result on this frame, for the previews and the inspector.
  const frameId = d.frames[s.frame]?.id;
  const result = useMemo(() => {
    if (!layer || !graph) return null;
    const at = d.layers.findIndex((l) => l.id === layer.id);
    const under = { ...d, layers: d.layers.map((l, k) => (k >= at ? { ...l, visible: false } : l)) };
    let seconds = 0, loopSeconds = 0;
    d.frames.forEach((f, k) => { if (k < s.frame) seconds += f.duration / 1000; loopSeconds += f.duration / 1000; });
    const ctx: NodeCtx = { w: d.width, h: d.height, own: layerPixels(d, layer.id, frameId), palette: d.palette, t: s.frame / d.frames.length, frame: s.frame, frames: d.frames.length, seconds, loopSeconds,
      below: composeFrame(under, s.frame, { skipReference: true }), belowWhere: (keep) => layersBelow(d, layer.id, s.frame, keep), layerPixels: (id) => layerPixels(d, id, frameId) };
    return evaluate(graph, ctx);
  }, [d, layer, graph, s.frame, frameId]);

  if (!layer || layer.kind !== 'image') return <div className="nodepanel"><p className="dim">Choose an image layer: a node graph sits on a layer.</p></div>;

  const attach = (g: NodeGraph, label: string) => ed.patchLayer(layer.id, { fx: [...(layer.fx ?? []).filter((f) => f.effect !== 'nodes'), { id: newId('fx'), effect: 'nodes', on: true, params: { graph: g } }] }, label);

  if (!graph || !fx) {
    return (
      <div className="nodepanel">
        <p className="dim">Build effects by wiring nodes together: inputs (this layer, other layers, noise, gradients), shaders, colour, lighting, masks, blending, particles and weather, animated by Time. It's optional: every panel still works on its own.</p>
        <div className="row wrap">
          <button className="btn primary" onClick={() => attach(identityGraph(), 'Add node graph')}>Add a node graph to “{layer.name}”</button>
        </div>
        <h4>Or start from</h4>
        <div className="row wrap">
          {NODE_PRESETS.map((p) => <button key={p.name} className="btn" title={p.doc} onClick={() => attach(p.build(), `Nodes: ${p.name}`)}>{p.name}</button>)}
          {Object.entries(userPresets).map(([name, g]) => <button key={name} className="btn" onClick={() => attach(sanitizeGraph(g).graph, `Nodes: ${name}`)}>{name}</button>)}
        </div>
      </div>
    );
  }

  const setGraph = (g: NodeGraph, label = 'Change nodes') =>
    ed.patchLayer(layer.id, { fx: layer.fx!.map((f) => (f.id === fx.id ? { ...f, params: { ...f.params, graph: g } } : f)) }, label);
  const view = moving ? { ...graph, nodes: graph.nodes.map((n) => (n.id === moving.id ? { ...n, x: moving.x, y: moving.y } : n)) } : graph;
  const cur = view.nodes.find((n) => n.id === sel);
  const curDef = cur && defOf(cur);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + boxRef.current!.scrollLeft, y: e.clientY - r.top + boxRef.current!.scrollTop };
  };
  const width = Math.max(600, ...view.nodes.map((n) => n.x + NW + 200)), height = Math.max(260, ...view.nodes.map((n) => n.y + heightOf(defOf(n)) + 120));

  const addNode = (type: string) => {
    const box = boxRef.current;
    const x = Math.round((box?.scrollLeft ?? 0) + 40 + (graph.nodes.length % 5) * 24), y = Math.round((box?.scrollTop ?? 0) + 30 + (graph.nodes.length % 5) * 24);
    const n = newNode(type, newId('nd'), x, y);
    // Wire it after the selected node, before whatever that fed, when both pass images.
    let g: NodeGraph = { ...graph, nodes: [...graph.nodes, n] };
    const def = nodeType(type);
    if (cur && curDef?.outputs[0]?.type === 'image' && def?.inputs[0]?.type === 'image') {
      const next = graph.links.filter((l) => l.from === cur.id && l.out === curDef.outputs[0].key);
      g = connect(g, { from: cur.id, out: curDef.outputs[0].key, to: n.id, in: def.inputs[0].key }) ?? g;
      for (const l of next) if (def.outputs[0]?.type === 'image') g = connect({ ...g, links: g.links.filter((x) => x !== l) }, { ...l, from: n.id, out: def.outputs[0].key }) ?? g;
      n.x = cur.x + 30; n.y = cur.y + heightOf(curDef) + 20;
    }
    setGraph(g, `Add ${def?.name ?? type} node`);
    setSel(n.id);
  };
  const removeNode = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    if (!n || n.type === 'output') return;
    let g: NodeGraph = { nodes: graph.nodes.filter((x) => x.id !== id), links: graph.links.filter((l) => l.from !== id && l.to !== id) };
    // Taking a node out of a chain joins what fed its first image input to what its image output fed.
    const def = defOf(n), firstIn = def?.inputs[0], firstOut = def?.outputs[0];
    const src = firstIn?.type === 'image' ? graph.links.find((l) => l.to === id && l.in === firstIn.key) : undefined;
    if (src && firstOut?.type === 'image') for (const l of graph.links.filter((x) => x.from === id && x.out === firstOut.key)) g = connect(g, { from: src.from, out: src.out, to: l.to, in: l.in }) ?? g;
    setGraph(g, 'Remove node');
    setSel('');
  };
  const setParam = (p: EffectParam, v: any) => setGraph({ ...graph, nodes: graph.nodes.map((n) => (n.id === cur!.id ? { ...n, params: { ...n.params, [p.key]: v } } : n)) }, 'Node setting');
  const numberSources = graph.nodes.flatMap((n) => (n.id === cur?.id ? [] : (defOf(n)?.outputs ?? []).filter((o) => o.type === 'number').map((o) => ({ value: `${n.id}|${o.key}`, label: `${defOf(n)!.name} · ${o.label}`, n, o }))));

  const onPointerMove = (e: React.PointerEvent) => {
    if (moving) { const p = local(e); setMoving({ ...moving, x: Math.max(0, Math.round(p.x - moving.dx)), y: Math.max(0, Math.round(p.y - moving.dy)) }); }
    else if (drag) { const p = local(e); setDrag({ ...drag, x: p.x, y: p.y }); }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (moving) {
      const n = graph.nodes.find((x) => x.id === moving.id);
      if (n && (n.x !== moving.x || n.y !== moving.y)) setGraph({ ...graph, nodes: graph.nodes.map((x) => (x.id === moving.id ? { ...x, x: moving.x, y: moving.y } : x)) }, 'Move node');
      setMoving(null);
    }
    if (drag) {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-in]') as HTMLElement | null;
      if (el) {
        const g = connect(graph, { from: drag.from, out: drag.out, to: el.dataset.node!, in: el.dataset.in! });
        if (g) setGraph(g, 'Connect nodes'); else ed.toast("Those can't be connected (it would loop back, or the types differ).");
      }
      setDrag(null);
    }
  };

  const outImage = result?.image;
  const errorCount = result?.errors.size ?? 0;

  return (
    <div className="nodepanel" onKeyDown={(e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && sel && (e.target as HTMLElement).tagName !== 'INPUT') { e.stopPropagation(); removeNode(sel); } }} tabIndex={-1}>
      <div className="row wrap node-bar">
        <button className="btn" aria-label="Previous frame" onClick={() => ed.setFrame(s.frame - 1)}>◀</button>
        <button className={'btn' + (ed.playing ? ' on' : '')} onClick={() => ed.togglePlay()}>{ed.playing ? '■' : '▶'}</button>
        <button className="btn" aria-label="Next frame" onClick={() => ed.setFrame(s.frame + 1)}>▶|</button>
        <span className="dim">Frame {s.frame + 1}/{d.frames.length}</span>
        <select aria-label="Add node" value="" onChange={(e) => { if (e.target.value) addNode(e.target.value); }}>
          <option value="">+ Add node…</option>
          {[...new Set(types.map((t) => t.category))].filter((c) => c !== 'Output').map((c) => (
            <optgroup key={c} label={c}>{types.filter((t) => t.category === c).map((t) => <option key={t.type} value={t.type}>{t.name}</option>)}</optgroup>
          ))}
        </select>
        <select aria-label="Start from a preset" value="" onChange={(e) => {
          const p = NODE_PRESETS.find((x) => x.name === e.target.value), u = userPresets[e.target.value];
          if (p) setGraph(p.build(), `Nodes: ${p.name}`); else if (u) setGraph(sanitizeGraph(u).graph, `Nodes: ${e.target.value}`);
          setSel('');
        }}>
          <option value="">Replace with preset…</option>
          {NODE_PRESETS.map((p) => <option key={p.name}>{p.name}</option>)}
          {Object.keys(userPresets).map((n) => <option key={n}>{n}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={fx.on} onChange={(e) => ed.patchLayer(layer.id, { fx: layer.fx!.map((f) => (f.id === fx.id ? { ...f, on: e.target.checked } : f)) }, 'Toggle node graph')} /> On</label>
        <span className="grow" />
        <button className="btn" onClick={() => {
          const name = window.prompt('Name for this node preset:', layer.name + ' nodes');
          if (!name?.trim()) return;
          const n = { ...userPresets, [name.trim()]: graph };
          setUserPresets(n); savePref('nodePresets', n);
        }}>Save preset</button>
        <button className="btn" onClick={() => saveBytes(`${layer.name}.spritenodes.json`, JSON.stringify({ format: FORMAT, version: 1, graph }, null, 2), 'SpriteCraft node graph')}>Export…</button>
        <button className="btn" onClick={async () => {
          const [f] = await pickFiles('.json,.spritenodes.json');
          if (!f) return;
          try {
            const j = JSON.parse(await f.text());
            if (j?.format !== FORMAT || !j.graph) throw new Error('not a SpriteCraft node graph');
            const { graph: g, dropped } = sanitizeGraph(j.graph);
            setGraph(g, 'Import nodes');
            ed.toast(`Imported ${g.nodes.length} nodes${dropped ? `; ${dropped} of a kind not available here were left out` : ''}.`);
          } catch (err: any) { ed.toast(`Couldn't import: ${err.message ?? err}`); }
        }}>Import…</button>
        <button className="btn" title="Turn the graph's result into this layer's pixels on every frame" onClick={() => ed.bakeParticles(layer.id, 'nodes')}>Bake</button>
        <button className="btn" onClick={() => ed.patchLayer(layer.id, { fx: layer.fx!.filter((f) => f.id !== fx.id).length ? layer.fx!.filter((f) => f.id !== fx.id) : undefined }, 'Remove node graph')}>Remove graph</button>
      </div>
      {errorCount > 0 && <p className="warn">{errorCount} node{errorCount === 1 ? '' : 's'} failed on this frame and {errorCount === 1 ? 'is' : 'are'} passed over (marked red).</p>}

      <div className="node-split">
        <div className="node-graph" ref={boxRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
          onPointerDown={(e) => { if (e.target === boxRef.current || (e.target as HTMLElement).classList.contains('node-canvas')) setSel(''); }}>
          <div className="node-canvas" style={{ width, height }}>
            <svg className="node-wires" width={width} height={height}>
              {view.links.map((l, i) => {
                const a = view.nodes.find((n) => n.id === l.from), b = view.nodes.find((n) => n.id === l.to);
                const da = a && defOf(a), db = b && defOf(b);
                if (!a || !b || !da || !db) return null;
                const oi = da.outputs.findIndex((o) => o.key === l.out), ii = db.inputs.findIndex((x) => x.key === l.in);
                const num = ii < 0;
                const end = num ? { x: b.x, y: b.y + HEAD / 2 } : inPos(b, db, ii);
                return <path key={i} d={wire(outPos(a, Math.max(0, oi)), end)} className={'node-wire' + (num ? ' num' : '')} />;
              })}
              {drag && (() => { const a = view.nodes.find((n) => n.id === drag.from)!; const da = defOf(a)!; return <path d={wire(outPos(a, da.outputs.findIndex((o) => o.key === drag.out)), drag)} className="node-wire live" />; })()}
            </svg>
            {view.nodes.map((n) => {
              const def = defOf(n);
              const res = result?.outputs.get(n.id);
              const err = result?.errors.get(n.id);
              return (
                <div key={n.id} className={'node' + (n.id === sel ? ' on' : '') + (err ? ' bad' : '') + (!def ? ' missing' : '')} style={{ left: n.x, top: n.y, width: NW, height: heightOf(def) }} title={err ?? def?.doc}
                  onPointerDown={() => setSel(n.id)}>
                  <div className={'node-head cat-' + (def?.category ?? 'x').split(' ')[0].toLowerCase()}
                    onPointerDown={(e) => { const p = local(e); setSel(n.id); setMoving({ id: n.id, dx: p.x - n.x, dy: p.y - n.y, x: n.x, y: n.y }); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }}>
                    <span className="grow">{def?.name ?? `Missing: ${n.type}`}</span>
                    {n.type !== 'output' && <button className="mini" aria-label={`Remove ${def?.name ?? 'node'}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => removeNode(n.id)}>×</button>}
                  </div>
                  {def?.outputs.map((o) => (
                    <div key={'o' + o.key} className="node-row out">
                      <span className="grow">{o.label}{o.type === 'number' && typeof res?.[o.key] === 'number' ? ` = ${(+res[o.key]).toFixed(2)}` : ''}</span>
                      <span className={'port ' + o.type} title={o.type === 'number' ? 'A number: feed it into a setting from the inspector' : 'Drag to an image input'}
                        onPointerDown={(e) => { e.stopPropagation(); if (o.type !== 'image') { setSel(n.id); return; } const p = local(e); setDrag({ from: n.id, out: o.key, x: p.x, y: p.y }); }} />
                    </div>
                  ))}
                  {def?.inputs.map((inp) => {
                    const linked = graph.links.some((l) => l.to === n.id && l.in === inp.key);
                    return (
                      <div key={'i' + inp.key} className="node-row in">
                        <span className={'port ' + inp.type + (linked ? ' linked' : '')} data-node={n.id} data-in={inp.key} title={linked ? 'Click to disconnect' : 'Drop a wire here'}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => { if (linked) setGraph({ ...graph, links: graph.links.filter((l) => !(l.to === n.id && l.in === inp.key)) }, 'Disconnect'); }} />
                        <span className="grow">{inp.label}</span>
                      </div>
                    );
                  })}
                  {def && (def.outputs.some((o) => o.type === 'image') || def.type === 'output') && <Thumb data={def.type === 'output' ? outImage : res?.image} w={d.width} h={d.height} />}
                </div>
              );
            })}
          </div>
        </div>

        <div className="node-inspector">
          {!cur && <p className="dim">Click a node to change its settings. Drag from an output dot (right) to an input dot (left) to connect; click a connected input to disconnect. Delete removes the selected node.</p>}
          {cur && curDef && (
            <>
              <h4>{curDef.name}</h4>
              <p className="dim">{curDef.doc}</p>
              {curDef.params.map((p) => {
                const link = graph.links.find((l) => l.to === cur.id && l.in === p.key);
                if (p.key === 'layer' && cur.type === 'layer') {
                  return (
                    <label key={p.key} className="field">Layer<select value={cur.params.layer} onChange={(e) => setParam(p, e.target.value)}>
                      <option value="">Choose…</option>
                      {d.layers.filter((l) => l.kind === 'image' && l.id !== layer.id).map((l) => <option key={l.id} value={l.id}>{l.name}{l.visible ? '' : ' (hidden)'}</option>)}
                    </select></label>
                  );
                }
                return (
                  <div key={p.key} className="node-param">
                    <label className={p.type === 'bool' ? 'check' : 'field'}>
                      {p.type === 'bool' && <input type="checkbox" checked={!!cur.params[p.key]} onChange={(e) => setParam(p, e.target.checked)} />}
                      <span className="grow">{p.label}</span>
                      {p.type === 'number' && !link && <><input type="range" aria-label={p.label} min={p.min} max={p.max} step={p.step ?? 1} value={cur.params[p.key]} onChange={(e) => setParam(p, +e.target.value)} /><span className="val">{+(+cur.params[p.key]).toFixed(2)}</span></>}
                      {p.type === 'number' && link && <span className="val">linked</span>}
                      {p.type === 'color' && <input className="colorin" type="color" aria-label={p.label} value={cur.params[p.key]} onChange={(e) => setParam(p, e.target.value)} />}
                      {p.type === 'choice' && <select value={cur.params[p.key]} onChange={(e) => setParam(p, e.target.value)}>{p.options.map((o) => <option key={o}>{o}</option>)}</select>}
                      {p.type === 'text' && <input aria-label={p.label} value={cur.params[p.key]} onChange={(e) => setParam(p, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />}
                    </label>
                    {p.type === 'number' && numberSources.length > 0 && (
                      <select className="node-link" aria-label={`Feed ${p.label} from`} value={link ? `${link.from}|${link.out}` : ''} onChange={(e) => {
                        const rest = graph.links.filter((l) => !(l.to === cur.id && l.in === p.key));
                        if (!e.target.value) { setGraph({ ...graph, links: rest }, 'Unlink setting'); return; }
                        const [from, out] = e.target.value.split('|');
                        const g = connect(graph, { from, out, to: cur.id, in: p.key });
                        if (g) setGraph(g, 'Link setting'); else ed.toast("That would loop back on itself.");
                      }}>
                        <option value="">{link ? 'Unlink' : '← from…'}</option>
                        {numberSources.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    )}
                  </div>
                );
              })}
              {!curDef.params.length && <p className="dim">No settings.</p>}
              {cur.type !== 'output' && <button className="btn" onClick={() => removeNode(cur.id)}>Remove node</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
