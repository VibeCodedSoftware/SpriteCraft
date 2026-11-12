import { describe, expect, it } from 'vitest';
import { A, rgba } from '../src/core/color';
import { composeFrame } from '../src/core/compose';
import { addLayer, newDoc, newLayer, setCel, trimToCel } from '../src/core/doc';
import '../src/core/effects';
import { NODE_PRESETS, connect, evaluate, identityGraph, makesCycle, newNode, nodeTypes, type NodeCtx, type NodeGraph } from '../src/core/nodes';
import { celKey } from '../src/core/types';
import { sanitizeGraph } from '../src/ui/NodePanel';

const W = 16, H = 16;
const RED = rgba(220, 40, 40);
const square = () => { const a = new Uint32Array(W * H); for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) a[y * W + x] = RED; return a; };
const ctx = (own = square(), t = 0): NodeCtx => ({ w: W, h: H, own, palette: [], t, frame: Math.round(t * 8), frames: 8, seconds: t, loopSeconds: 1 });
const g = (types: string[], links: [number, string, number, string][]): NodeGraph => {
  const nodes = types.map((t, i) => newNode(t, 'n' + i, i * 200, 0));
  return { nodes, links: links.map(([a, out, b, inn]) => ({ from: nodes[a].id, out, to: nodes[b].id, in: inn })) };
};
const count = (img: Uint32Array) => img.reduce((n, c) => n + (A(c) ? 1 : 0), 0);

describe('graph evaluation', () => {
  it('This layer → Output gives the layer unchanged', () => {
    const own = square();
    expect(evaluate(identityGraph(), ctx(own)).image).toEqual(own);
  });
  it('an Output with nothing linked shows the layer', () => {
    expect(evaluate(g(['output'], []), ctx()).image).toEqual(square());
  });
  it('runs effects as nodes, in order', () => {
    const r = evaluate(g(['this', 'fx:outline', 'output'], [[0, 'image', 1, 'image'], [1, 'image', 2, 'image']]), ctx());
    expect(count(r.image)).toBeGreaterThan(count(square()));
  });
  it('a number from Time drives a setting, so the graph animates', () => {
    // Move by (progress × 8) pixels.
    const graph = g(['this', 'time', 'math', 'offset', 'output'], [[0, 'image', 3, 'image'], [1, 't', 2, 'a'], [2, 'value', 3, 'dx'], [3, 'image', 4, 'image']]);
    graph.nodes[2].params = { ...graph.nodes[2].params, op: 'A × B', b: 8 };
    const a = evaluate(graph, ctx(square(), 0)).image, b = evaluate(graph, ctx(square(), 0.5)).image;
    expect(b[4 * W + 8]).toBe(RED); // the square's left edge moved 4 pixels right
    expect(A(b[4 * W + 4])).toBe(0);
    expect(a).toEqual(square());
  });
  it('masks keep only inside or outside', () => {
    const graph = g(['this', 'color', 'mask', 'output'], [[1, 'image', 2, 'image'], [0, 'image', 2, 'mask'], [2, 'image', 3, 'image']]);
    const inside = evaluate(graph, ctx()).image;
    expect(count(inside)).toBe(64);
    graph.nodes[2].params.keep = 'Outside the mask';
    expect(count(evaluate(graph, ctx()).image)).toBe(W * H - 64);
  });
  it('blends one image over another', () => {
    const graph = g(['color', 'this', 'blend', 'output'], [[0, 'image', 2, 'base'], [1, 'image', 2, 'top'], [2, 'image', 3, 'image']]);
    const out = evaluate(graph, ctx()).image;
    expect(out[5 * W + 5]).toBe(RED);
    expect(out[0]).not.toBe(RED);
    expect(count(out)).toBe(W * H);
  });
  it('lights an image with banded steps and keeps empty pixels empty', () => {
    const out = evaluate(g(['this', 'light', 'output'], [[0, 'image', 1, 'image'], [1, 'image', 2, 'image']]), ctx()).image;
    expect(count(out)).toBe(64);
    expect(new Set([...out].filter((c) => A(c))).size).toBeGreaterThan(1);
  });
  it('noise loops exactly over the animation', () => {
    const graph = g(['noise', 'output'], [[0, 'image', 1, 'image']]);
    // Progress 1 is the frame after the last, which must be the first frame again.
    expect(evaluate(graph, ctx(square(), 1)).image).toEqual(evaluate(graph, ctx(square(), 0)).image);
    expect(evaluate(graph, ctx(square(), 0)).image).not.toEqual(evaluate(graph, ctx(square(), 0.5)).image);
  });
  it('a node that fails is passed over, and the rest still runs', () => {
    const graph = g(['this', 'fx:outline', 'output'], [[0, 'image', 1, 'image'], [1, 'image', 2, 'image']]);
    graph.nodes[1].type = 'fx:outline';
    graph.nodes[1].params = { color: 'not a colour', where: 'Outside', corners: false };
    const r = evaluate(graph, ctx());
    expect(r.image.length).toBe(W * H);
  });
});

describe('wiring', () => {
  it('refuses loops and mismatched types', () => {
    const graph = g(['fx:outline', 'fx:invert', 'output'], [[0, 'image', 1, 'image']]);
    expect(makesCycle(graph, 'n1', 'n0')).toBe(true);
    expect(connect(graph, { from: 'n1', out: 'image', to: 'n0', in: 'image' })).toBeNull();
    const t = { ...graph, nodes: [...graph.nodes, newNode('time', 'tm')] };
    expect(connect(t, { from: 'tm', out: 't', to: 'n1', in: 'image' })).toBeNull(); // number into an image input
    expect(connect(t, { from: 'n0', out: 'image', to: 'n1', in: 'nope' })).toBeNull();
  });
  it('a new link replaces the old one into the same input', () => {
    const graph = g(['this', 'color', 'output'], [[0, 'image', 2, 'image']]);
    const next = connect(graph, { from: 'n1', out: 'image', to: 'n2', in: 'image' })!;
    expect(next.links).toEqual([{ from: 'n1', out: 'image', to: 'n2', in: 'image' }]);
  });
  it('every node type runs on its own without failing', () => {
    for (const def of nodeTypes()) {
      const graph: NodeGraph = { nodes: [newNode(def.type, 'x')], links: [] };
      const r = evaluate(graph, ctx());
      expect(r.errors.size, def.type).toBe(0);
    }
  });
  it('every preset evaluates without errors and gives an image', () => {
    for (const p of NODE_PRESETS) {
      const r = evaluate(p.build(), ctx(square(), 0.25));
      expect(r.errors.size, p.name).toBe(0);
      expect(r.image.length, p.name).toBe(W * H);
    }
  });
});

describe('files and layers', () => {
  it('cleans graphs from files: unknown nodes, bad values and broken links are left out', () => {
    const raw = {
      nodes: [{ id: 'a', type: 'this', x: 0, y: 0, params: {} }, { id: 'b', type: 'fx:evil', x: 0, y: 0, params: {} },
        { id: 'c', type: 'offset', x: 'x', y: 0, params: { dx: 'constructor', dy: 3, wrap: 'yes' } }],
      links: [{ from: 'a', out: 'image', to: 'c', in: 'image' }, { from: 'b', out: 'image', to: 'c', in: 'image' }, { from: 'c', out: 'image', to: 'c', in: 'image' }],
    };
    const { graph, dropped } = sanitizeGraph(raw);
    expect(dropped).toBe(1);
    const c = graph.nodes.find((n) => n.id === 'c')!;
    expect(c.params).toEqual({ dx: 0, dy: 3, wrap: false });
    expect(c.x).toBe(0);
    expect(graph.links).toEqual([{ from: 'a', out: 'image', to: 'c', in: 'image' }]);
    expect(graph.nodes.some((n) => n.type === 'output')).toBe(true);
  });
  it('runs live on a layer and reads other layers, hidden ones too', () => {
    let d = newDoc(W, H, 'n', 2);
    const maskL = { ...newLayer('Mask'), visible: false };
    d = addLayer(d, maskL, null);
    const half = new Uint32Array(W * H); for (let i = 0; i < W * H / 2; i++) half[i] = rgba(255, 255, 255);
    for (const fr of d.frames) d = setCel(d, celKey(maskL.id, fr.id), trimToCel(half, W, H, 0, 0), false);
    const graph = g(['color', 'layer', 'mask', 'output'], [[0, 'image', 2, 'image'], [1, 'image', 2, 'mask'], [2, 'image', 3, 'image']]);
    graph.nodes[1].params.layer = maskL.id;
    d = addLayer(d, { ...newLayer('Nodes'), fx: [{ id: 'f', effect: 'nodes', on: true, params: { graph } }] }, null);
    const out = composeFrame(d, 0);
    expect(A(out[0])).toBe(255);
    expect(A(out[W * H - 1])).toBe(0);
  });
});
