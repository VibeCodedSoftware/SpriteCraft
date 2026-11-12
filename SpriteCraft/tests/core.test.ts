import { describe, expect, it } from 'vitest';
import { blendPixel, composeFrame } from '../src/core/compose';
import { A, B, G, R, fromHex, nearestIndex, rgba, toHex } from '../src/core/color';
import { addLayer, cropTo, duplicateFrame, duplicateLayer, flipSprite, insertFrame, isLinkedCel, layerRows, moveFrame, moveLayer, newDoc, newLayer, removeFrame, removeLayer, resizeCanvas, rotateSprite, scaleSprite, setCel, toIndexed, trimToCel, updateLayer } from '../src/core/doc';
import { brushOffsets, constrainLine, ditherThreshold, ellipseFill, ellipseOutline, floodMask, line, pixelPerfectCorner, polygonFill, rectOutline } from '../src/core/raster';
import { combine, fromMask, growSelection, invertSelection, isSelected, outlineSegments, selectAll, toFullMask } from '../src/core/selection';
import { placedBounds, renderPlaced, scale2x, upscale8 } from '../src/core/transform';
import { extractPalette, makeRamp, paletteToGpl, paletteToHex, parsePaletteFile } from '../src/core/palette';
import { defaultParams, effectById } from '../src/core/effects';
import { celKey, maskKey, type Doc } from '../src/core/types';

const RED = rgba(255, 0, 0), GREEN = rgba(0, 255, 0), BLUE = rgba(0, 0, 255), WHITE = rgba(255, 255, 255);

/** A doc with solid-colour fills, one per layer given. */
function solid(colors: number[], w = 2, h = 2): Doc {
  let d = newDoc(w, h);
  d = { ...d, layers: [] };
  for (const c of colors) {
    const l = newLayer('L');
    d = addLayer(d, l);
    d = setCel(d, celKey(l.id, d.frames[0].id), { id: 'c' + l.id, x: 0, y: 0, w, h, opacity: 255, data: new Uint32Array(w * h).fill(c) });
  }
  return d;
}

describe('compositor', () => {
  it('draws layers bottom to top', () => {
    expect(composeFrame(solid([RED, BLUE]), 0)[0]).toBe(BLUE);
  });
  it('blends half-transparent normal exactly', () => {
    const p = blendPixel('normal', RED, 0, 0, 255, 128);
    expect(A(p)).toBe(255); expect(B(p)).toBe(128); expect(R(p)).toBe(127);
  });
  it('does not change a colour on transparent backdrops, whatever the mode', () => {
    for (const m of ['multiply', 'screen', 'hue', 'divide'] as const) expect(blendPixel(m, 0, 10, 20, 30, 77)).toBe(rgba(10, 20, 30, 77));
  });
  it('implements the common modes', () => {
    expect(blendPixel('multiply', WHITE, 10, 20, 30, 255)).toBe(rgba(10, 20, 30));
    expect(blendPixel('screen', rgba(0, 0, 0), 10, 20, 30, 255)).toBe(rgba(10, 20, 30));
    expect(blendPixel('difference', RED, 255, 0, 0, 255)).toBe(rgba(0, 0, 0));
    expect(blendPixel('addition', rgba(200, 0, 0), 100, 0, 0, 255)).toBe(rgba(255, 0, 0));
    expect(blendPixel('subtract', rgba(200, 50, 0), 100, 100, 0, 255)).toBe(rgba(100, 0, 0));
  });
  it('luminosity keeps hue, takes brightness', () => {
    const p = blendPixel('luminosity', RED, 255, 255, 255, 255);
    expect(p).toBe(WHITE);
  });
  it('respects hidden layers, opacity and groups', () => {
    let d = solid([RED, BLUE]);
    d = updateLayer(d, d.layers[1].id, { visible: false });
    expect(composeFrame(d, 0)[0]).toBe(RED);
    d = updateLayer(d, d.layers[1].id, { visible: true, opacity: 0 });
    expect(composeFrame(d, 0)[0]).toBe(RED);
    const g = newLayer('G', 'group');
    let d2 = solid([RED, BLUE]);
    d2 = addLayer(d2, g);
    d2 = updateLayer(d2, d2.layers[1].id, { parentId: g.id });
    d2 = updateLayer(d2, g.id, { visible: false });
    expect(composeFrame(d2, 0)[0]).toBe(RED);
  });
  it('clipping masks follow the layer below', () => {
    let d = newDoc(2, 1);
    const base = d.layers[0], top = newLayer('top');
    d = addLayer(d, top);
    const fid = d.frames[0].id;
    d = setCel(d, celKey(base.id, fid), { id: 'b', x: 0, y: 0, w: 1, h: 1, opacity: 255, data: Uint32Array.of(RED) });
    d = setCel(d, celKey(top.id, fid), { id: 't', x: 0, y: 0, w: 2, h: 1, opacity: 255, data: Uint32Array.of(BLUE, BLUE) });
    expect([...composeFrame(d, 0)]).toEqual([BLUE, BLUE]);
    d = updateLayer(d, top.id, { clip: true });
    expect([...composeFrame(d, 0)]).toEqual([BLUE, 0]);
  });
  it('layer masks hide by alpha and can be turned off', () => {
    let d = solid([RED]);
    const l = d.layers[0];
    d = updateLayer(d, l.id, { mask: true });
    d = setCel(d, maskKey(l.id, d.frames[0].id), { id: 'm', x: 0, y: 0, w: 1, h: 1, opacity: 255, data: Uint32Array.of(rgba(0, 0, 0, 255)) });
    expect(composeFrame(d, 0)[0]).toBe(0);
    expect(composeFrame(d, 0)[1]).toBe(RED);
    d = updateLayer(d, l.id, { maskEnabled: false });
    expect(composeFrame(d, 0)[0]).toBe(RED);
  });
  it('skips reference layers on request', () => {
    let d = solid([RED]);
    d = updateLayer(d, d.layers[0].id, { kind: 'reference' });
    expect(composeFrame(d, 0)[0]).toBe(RED);
    expect(composeFrame(d, 0, { skipReference: true })[0]).toBe(0);
  });
});

describe('document operations share what they do not change', () => {
  it('trims a cel to its pixels', () => {
    const data = new Uint32Array(16);
    data[5] = RED; data[10] = BLUE;
    const c = trimToCel(data, 4, 4, 100, 200)!;
    expect([c.x, c.y, c.w, c.h]).toEqual([101, 201, 2, 2]);
    expect(trimToCel(new Uint32Array(4), 2, 2, 0, 0)).toBeNull();
  });
  it('linked frames edit together; a plain duplicate does not', () => {
    let d = solid([RED]);
    const l = d.layers[0];
    const linked = duplicateFrame(d, 0, true);
    const key = (doc: Doc, f: number) => celKey(l.id, doc.frames[f].id);
    expect(isLinkedCel(linked, key(linked, 1))).toBe(true);
    const edited = setCel(linked, key(linked, 1), { id: 'n', x: 0, y: 0, w: 1, h: 1, opacity: 255, data: Uint32Array.of(BLUE) });
    expect(edited.cels[key(edited, 0)].data[0]).toBe(BLUE);
    const copy = duplicateFrame(d, 0, false);
    const e2 = setCel(copy, key(copy, 1), { id: 'n', x: 0, y: 0, w: 1, h: 1, opacity: 255, data: Uint32Array.of(BLUE) });
    expect(e2.cels[key(e2, 0)].data[0]).toBe(RED);
    expect(d.cels[key(d, 0)].data[0]).toBe(RED); // The original document is untouched.
  });
  it('a duplicated layer is independent of the original', () => {
    const d = solid([RED]);
    const { doc, id } = duplicateLayer(d, d.layers[0].id);
    const fid = doc.frames[0].id;
    const edited = setCel(doc, celKey(id, fid), { id: 'n', x: 0, y: 0, w: 1, h: 1, opacity: 255, data: Uint32Array.of(BLUE) });
    expect(edited.cels[celKey(d.layers[0].id, fid)].data[0]).toBe(RED);
  });
  it('frames keep tags in step', () => {
    let d = newDoc(1, 1, 'x', 4);
    d = { ...d, tags: [{ id: 't', name: 'run', from: 1, to: 2, dir: 'forward', repeat: 0, color: '#fff' }] };
    expect(insertFrame(d, 0).tags[0]).toMatchObject({ from: 2, to: 3 });
    expect(removeFrame(d, 0).tags[0]).toMatchObject({ from: 0, to: 1 });
    expect(removeFrame(removeFrame(d, 1), 1).tags).toEqual([]);
    expect(moveFrame(d, 0, 3).frames[3].id).toBe(d.frames[0].id);
  });
  it('removes a group with its contents and lists rows top first', () => {
    let d = newDoc(1, 1);
    const g = newLayer('G', 'group'), kid = newLayer('K');
    d = addLayer(d, g);
    d = addLayer(d, { ...kid });
    d = updateLayer(d, kid.id, { parentId: g.id });
    expect(layerRows(d).map((r) => [r.layer.name, r.depth])).toEqual([['G', 0], ['K', 1], ['Layer 1', 0]]);
    expect(removeLayer(d, g.id).layers.map((l) => l.name)).toEqual(['Layer 1']);
    expect(moveLayer(d, g.id, -1).layers.filter((l) => !l.parentId)[0].name).toBe('G');
  });
  it('resizes, crops, scales, flips and rotates', () => {
    const d = setCel(newDoc(4, 2), celKey('x', 'y'), null);
    const l = d.layers[0], fid = d.frames[0].id;
    const one = setCel(d, celKey(l.id, fid), { id: 'c', x: 0, y: 0, w: 1, h: 1, opacity: 255, data: Uint32Array.of(RED) });
    const at = (doc: Doc, x: number, y: number) => composeFrame(doc, 0)[y * doc.width + x];
    expect(at(resizeCanvas(one, 6, 4, 0.5, 0.5), 1, 1)).toBe(RED);
    expect(at(flipSprite(one, 'h'), 3, 0)).toBe(RED);
    expect(at(flipSprite(one, 'v'), 0, 1)).toBe(RED);
    const r = rotateSprite(one, 1);
    expect([r.width, r.height]).toEqual([2, 4]);
    expect(at(r, 1, 0)).toBe(RED);
    expect(at(rotateSprite(one, 2), 3, 1)).toBe(RED);
    expect(at(rotateSprite(one, 3), 0, 3)).toBe(RED);
    const s = scaleSprite(one, 8, 4);
    expect(at(s, 1, 1)).toBe(RED); expect(at(s, 2, 2)).toBe(0);
    expect(cropTo(one, { x: 0, y: 0, w: 1, h: 1 }).width).toBe(1);
  });
  it('indexed mode snaps every pixel to the palette', () => {
    let d = solid([rgba(250, 10, 10)]);
    d = { ...d, palette: [RED, BLUE] };
    expect(composeFrame(toIndexed(d), 0)[0]).toBe(RED);
  });
});

describe('raster', () => {
  const pts = (f: (plot: (x: number, y: number) => void) => void) => { const s = new Set<string>(); f((x, y) => s.add(`${x},${y}`)); return s; };
  it('lines reach both ends and stay connected', () => {
    const s = pts((p) => line(0, 0, 7, 3, p));
    expect(s.has('0,0') && s.has('7,3')).toBe(true);
    expect(s.size).toBe(8);
  });
  it('rect outline has no doubled corners', () => {
    expect(pts((p) => rectOutline(0, 0, 3, 2, p)).size).toBe(10);
    expect(pts((p) => rectOutline(0, 0, 0, 0, p)).size).toBe(1);
  });
  it('ellipses are symmetric on both axes, and an outline is a subset of the fill', () => {
    for (const [w, h] of [[6, 6], [7, 7], [8, 5], [1, 1], [2, 2], [3, 9]]) {
      const s = pts((p) => ellipseFill(0, 0, w - 1, h - 1, p));
      for (const c of s) {
        const [x, y] = c.split(',').map(Number);
        expect(s.has(`${w - 1 - x},${y}`)).toBe(true);
        expect(s.has(`${x},${h - 1 - y}`)).toBe(true);
      }
      for (const c of pts((p) => ellipseOutline(0, 0, w - 1, h - 1, p))) expect(s.has(c)).toBe(true);
    }
  });
  it('fills a polygon by its inside', () => {
    const s = pts((p) => polygonFill([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], p));
    expect(s.size).toBe(25);
  });
  it('pixel perfect removes L corners only', () => {
    expect(pixelPerfectCorner([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toBe(1);
    expect(pixelPerfectCorner([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }])).toBe(-1);
    expect(pixelPerfectCorner([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBe(-1);
  });
  it('flood fill stops at other colours, or takes all matches when not contiguous', () => {
    const a = RED, b = BLUE;
    const data = Uint32Array.of(a, b, a, a, b, a, a, b, a);
    const count = (m: Uint8Array) => m.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(count(floodMask(data, 3, 3, 0, 0, 0, true))).toBe(3);
    expect(count(floodMask(data, 3, 3, 0, 0, 0, false))).toBe(6);
    expect(count(floodMask(Uint32Array.of(rgba(100, 0, 0), rgba(105, 0, 0)), 2, 1, 0, 0, 10, true))).toBe(2);
    expect(count(floodMask(Uint32Array.of(rgba(100, 0, 0), rgba(105, 0, 0)), 2, 1, 0, 0, 0, true))).toBe(1);
  });
  it('flood fill handles a large open area', () => {
    const data = new Uint32Array(1000 * 1000);
    const m = floodMask(data, 1000, 1000, 500, 500, 0, true);
    expect(m[0]).toBe(255); expect(m[999999]).toBe(255);
  });
  it('brushes stay centred', () => {
    expect(brushOffsets(1, 'square')).toEqual([{ x: 0, y: 0 }]);
    expect(brushOffsets(3, 'square').length).toBe(9);
    const c = brushOffsets(5, 'circle');
    expect(c.length).toBeLessThan(25);
    expect(c.some((o) => o.x === -2 && o.y === 0) && c.some((o) => o.x === 2 && o.y === 0)).toBe(true);
  });
  it('dither thresholds are evenly spread', () => {
    const v: number[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) v.push(ditherThreshold('bayer4', x, y));
    expect(new Set(v).size).toBe(16);
    expect(v.reduce((a, b) => a + b) / 16).toBeCloseTo(0.5);
    expect(ditherThreshold('bayer4', -1, -1)).toBe(ditherThreshold('bayer4', 3, 3));
  });
  it('constrained lines hit straight, diagonal and 2:1 iso angles', () => {
    expect(constrainLine(0, 0, 10, 1)).toEqual({ x: 10, y: 0 });
    expect(constrainLine(0, 0, 1, 10)).toEqual({ x: 0, y: 10 });
    expect(constrainLine(0, 0, 10, 9)).toEqual({ x: 10, y: 10 });
    expect(constrainLine(0, 0, 20, 10)).toEqual({ x: 20, y: 10 });
    expect(constrainLine(0, 0, -20, 10)).toEqual({ x: -20, y: 10 });
  });
});

describe('selection', () => {
  const mask = (w: number, h: number, on: [number, number][]) => { const m = new Uint8Array(w * h); on.forEach(([x, y]) => { m[y * w + x] = 255; }); return m; };
  it('tightens to a bounding box', () => {
    const s = fromMask(mask(4, 4, [[1, 1], [2, 2]]), { x: 0, y: 0, w: 4, h: 4 })!;
    expect([s.x, s.y, s.w, s.h]).toEqual([1, 1, 2, 2]);
    expect(isSelected(s, 2, 2)).toBe(true);
    expect(isSelected(s, 2, 1)).toBe(false);
  });
  it('adds, subtracts and intersects', () => {
    const a = fromMask(mask(4, 1, [[0, 0], [1, 0]]), { x: 0, y: 0, w: 4, h: 1 });
    const b = mask(4, 1, [[1, 0], [2, 0]]);
    const on = (s: any) => [...toFullMask(s, 4, 1)].map((v) => (v ? 1 : 0)).join('');
    expect(on(combine(a, b, 4, 1, 'replace'))).toBe('0110');
    expect(on(combine(a, b, 4, 1, 'add'))).toBe('1110');
    expect(on(combine(a, b, 4, 1, 'subtract'))).toBe('1000');
    expect(on(combine(a, b, 4, 1, 'intersect'))).toBe('0100');
    expect(on(invertSelection(a, 4, 1))).toBe('0011');
  });
  it('grows and shrinks', () => {
    const s = selectAll(5, 5);
    expect(growSelection(s, -1, 5, 5)).toMatchObject({ x: 1, y: 1, w: 3, h: 3 });
    const dot = fromMask(mask(5, 5, [[2, 2]]), { x: 0, y: 0, w: 5, h: 5 })!;
    expect(growSelection(dot, 1, 5, 5)!.mask.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(5);
  });
  it('traces a box as four merged edges', () => {
    expect(outlineSegments(selectAll(9, 3)).length).toBe(16);
  });
});

describe('transforms keep the pixel art palette', () => {
  const src = { w: 2, h: 2, data: Uint32Array.of(RED, GREEN, BLUE, WHITE) };
  it('scale2x introduces no new colours', () => {
    const big = upscale8(src);
    expect(big.w).toBe(16);
    expect(new Set(big.data).size).toBe(4);
    const cross = scale2x({ w: 3, h: 3, data: Uint32Array.of(0, RED, 0, RED, 0, RED, 0, RED, 0) });
    expect(cross.w).toBe(6);
  });
  it('an identity placement returns the image', () => {
    const out = new Map<string, number>();
    renderPlaced(src, { cx: 1, cy: 1, sw: 2, sh: 2, angle: 0 }, (x, y, c) => out.set(`${x},${y}`, c));
    expect(out.get('0,0')).toBe(RED);
    expect(out.get('1,1')).toBe(WHITE);
  });
  it('negative sizes flip and 90 degrees turns', () => {
    const out = new Map<string, number>();
    renderPlaced(src, { cx: 1, cy: 1, sw: -2, sh: 2, angle: 0 }, (x, y, c) => out.set(`${x},${y}`, c));
    expect(out.get('0,0')).toBe(GREEN);
    out.clear();
    renderPlaced(src, { cx: 1, cy: 1, sw: 2, sh: 2, angle: Math.PI / 2 }, (x, y, c) => out.set(`${x},${y}`, c));
    expect(out.get('1,0')).toBe(RED); // The top-left corner moves to the top right when turned clockwise.
    expect(placedBounds({ cx: 0, cy: 0, sw: 4, sh: 2, angle: Math.PI / 2 }).w).toBeLessThanOrEqual(3);
  });
  it('scaling doubles with no blur', () => {
    const out = new Map<string, number>();
    renderPlaced(src, { cx: 2, cy: 2, sw: 4, sh: 4, angle: 0 }, (x, y, c) => out.set(`${x},${y}`, c));
    expect(out.size).toBe(16);
    expect(new Set(out.values()).size).toBe(4);
    expect(out.get('1,1')).toBe(RED);
    expect(out.get('2,1')).toBe(GREEN);
  });
});

describe('palette', () => {
  it('keeps an image that fits, and reduces one that does not', () => {
    const img = Uint32Array.of(RED, RED, GREEN, 0);
    expect(extractPalette([img], 8).sort()).toEqual([RED, GREEN].sort());
    const many = new Uint32Array(4096);
    for (let i = 0; i < 4096; i++) many[i] = rgba(i & 15, (i >> 4) & 15, (i >> 8) & 15);
    expect(extractPalette([many], 16).length).toBe(16);
  });
  it('ramps start and end on the chosen colours', () => {
    const r = makeRamp(RED, BLUE, 5, 15);
    expect(r.length).toBe(5); expect(r[0]).toBe(RED); expect(r[4]).toBe(BLUE);
    expect(makeRamp(rgba(0, 0, 0), WHITE, 3)[1]).toBe(rgba(128, 128, 128));
  });
  it('reads and writes palette files', () => {
    expect(parsePaletteFile(paletteToGpl([RED, BLUE], 'x'))).toEqual([RED, BLUE]);
    expect(parsePaletteFile(paletteToHex([RED, BLUE]))).toEqual([RED, BLUE]);
    expect(parsePaletteFile('JASC-PAL\n0100\n2\n255 0 0\n0 0 255\n')).toEqual([RED, BLUE]);
    expect(() => parsePaletteFile('nonsense!')).toThrow();
  });
  it('colour helpers', () => {
    expect(toHex(fromHex('#123456')!)).toBe('#123456');
    expect(fromHex('f0a')).toBe(rgba(255, 0, 170));
    expect(fromHex('zzz')).toBeNull();
    expect(G(rgba(1, 2, 3))).toBe(2);
    expect(nearestIndex(rgba(250, 0, 0), [BLUE, RED])).toBe(1);
  });
});

describe('effects', () => {
  it('outline adds only around the shape', () => {
    const e = effectById('outline')!;
    const src = new Uint32Array(9); src[4] = RED;
    const out = e.apply(src, 3, 3, defaultParams(e), { palette: [] });
    expect(out[4]).toBe(RED);
    expect([out[1], out[3], out[5], out[7]]).toEqual(Array(4).fill(rgba(0, 0, 0)));
    expect(out[0]).toBe(0);
  });
  it('does not change its input', () => {
    const e = effectById('invert')!;
    const src = Uint32Array.of(RED);
    expect(e.apply(src, 1, 1, {}, { palette: [] })[0]).toBe(rgba(0, 255, 255));
    expect(src[0]).toBe(RED);
  });
  it('map to palette keeps alpha and uses only palette colours', () => {
    const e = effectById('palette-map')!;
    const out = e.apply(Uint32Array.of(rgba(250, 5, 5, 200)), 1, 1, defaultParams(e), { palette: [RED, BLUE] });
    expect(out[0]).toBe(rgba(255, 0, 0, 200));
  });
});
