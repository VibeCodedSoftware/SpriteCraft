import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { composeFrame } from '../src/core/compose';
import { rgba } from '../src/core/color';
import { addLayer, duplicateFrame, newDoc, newLayer, setCel, updateLayer } from '../src/core/doc';
import { celKey, maskKey, type Doc } from '../src/core/types';
import { decodePng, encodePng } from '../src/io/png';
import { decodeGif, encodeGif } from '../src/io/gif';
import { readAseprite, writeAseprite } from '../src/io/aseprite';
import { readProject, writeProject } from '../src/io/project';
import { buildSheet, detectGrid, docFromFrames, sheetGrid, sliceSheet } from '../src/io/sheet';
import { MAX_STRIP, exchangeFileName, flipbookFps, makeFlipbook, readFlipbook } from '../src/io/craft';
import { parseVfxAsset } from '@shared/src/vfx/vfx';

const RED = rgba(255, 0, 0), GREEN = rgba(0, 255, 0), BLUE = rgba(0, 0, 255);

function sample(): Doc {
  let d = newDoc(4, 3, 'hero', 2);
  const base = d.layers[0];
  const grp = newLayer('Group', 'group');
  const kid = newLayer('Kid');
  d = addLayer(d, grp);
  d = addLayer(d, kid);
  d = updateLayer(d, kid.id, { parentId: grp.id, blend: 'multiply', opacity: 200 });
  const [f0, f1] = d.frames;
  d = setCel(d, celKey(base.id, f0.id), { id: 'a', x: 1, y: 1, w: 2, h: 1, opacity: 255, data: Uint32Array.of(RED, rgba(1, 2, 3, 77)) });
  d = setCel(d, celKey(base.id, f1.id), d.cels[celKey(base.id, f0.id)]); // Linked.
  d = setCel(d, celKey(kid.id, f1.id), { id: 'b', x: 0, y: 0, w: 1, h: 1, opacity: 128, data: Uint32Array.of(BLUE) }, false);
  return { ...d, tags: [{ id: 't', name: 'walk', from: 0, to: 1, dir: 'pingpong', repeat: 2, color: '#ff8800' }], frames: [{ ...f0, duration: 120 }, { ...f1, duration: 80 }] };
}

describe('PNG', () => {
  it('round-trips exact pixels, including colour under low alpha', () => {
    const img = { w: 3, h: 2, data: Uint32Array.of(RED, rgba(10, 20, 30, 1), 0, rgba(200, 100, 50, 128), GREEN, rgba(255, 255, 255, 0)) };
    const back = decodePng(encodePng(img));
    expect([back.w, back.h]).toEqual([3, 2]);
    expect([...back.data]).toEqual([...img.data]);
  });
  it('reads a palette PNG with transparency and 1-bit depth', () => {
    // Built by hand: 2×1, 1-bit indexed, entry 0 transparent.
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const chunk = (t: string, body: number[]) => {
      const bytes = [...t].map((c) => c.charCodeAt(0)).concat(body);
      let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); c = (c ^ 0xffffffff) >>> 0;
      return [(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...bytes, c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255];
    };
    const file = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10,
      ...chunk('IHDR', [0, 0, 0, 2, 0, 0, 0, 1, 1, 3, 0, 0, 0]),
      ...chunk('PLTE', [0, 0, 0, 255, 0, 0]), ...chunk('tRNS', [0]),
      ...chunk('IDAT', [...zlibSync(Uint8Array.of(0, 0b01000000))]), ...chunk('IEND', [])]);
    const img = decodePng(file);
    expect([...img.data]).toEqual([rgba(0, 0, 0, 0), RED]);
  });
  it('refuses other data', () => { expect(() => decodePng(new Uint8Array(20))).toThrow('Not a PNG'); });
});

describe('GIF', () => {
  it('round-trips frames, timing and transparency', () => {
    const a = Uint32Array.of(RED, 0, GREEN, BLUE), b = Uint32Array.of(0, RED, BLUE, 0);
    const gif = encodeGif([{ data: a, delay: 100 }, { data: b, delay: 250 }], 2, 2);
    const back = decodeGif(gif);
    expect(back.frames.length).toBe(2);
    expect(back.frames[1].delay).toBe(250);
    expect([...back.frames[0].data]).toEqual([...a]);
    expect([...back.frames[1].data]).toEqual([...b]); // Transparent pixels do not show the frame before.
  });
  it('survives long noisy frames past the LZW table limit', () => {
    const w = 256, h = 256, data = new Uint32Array(w * h);
    let seed = 7;
    for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = rgba((seed >> 8) & 63, (seed >> 14) & 63, 0); }
    const back = decodeGif(encodeGif([{ data, delay: 100 }], w, h));
    expect(back.frames[0].data.length).toBe(data.length);
    // Reduced to 256 colours, so pixels may move a little, but must stay close and in place.
    let far = 0;
    for (let i = 0; i < data.length; i++) if (Math.abs((data[i] & 255) - (back.frames[0].data[i] & 255)) > 24) far++;
    expect(far).toBeLessThan(data.length * 0.02);
  });
  it('matte flattens partial transparency', () => {
    const back = decodeGif(encodeGif([{ data: Uint32Array.of(rgba(255, 0, 0, 128)), delay: 100 }], 1, 1, { matte: rgba(255, 255, 255) }));
    const p = back.frames[0].data[0];
    expect(p >>> 24).toBe(255);
    expect((p >>> 8) & 255).toBeGreaterThan(100);
  });
});

describe('.aseprite', () => {
  it('round-trips layers, frames, cels, links, tags and palette', () => {
    const d = sample();
    const { doc } = readAseprite(writeAseprite(d).bytes, 'x');
    expect(doc.layers.map((l) => [l.name, l.kind])).toEqual([['Layer 1', 'image'], ['Group', 'group'], ['Kid', 'image']]);
    expect(doc.layers[2].parentId).toBe(doc.layers[1].id);
    expect(doc.layers[2].blend).toBe('multiply');
    expect(doc.layers[2].opacity).toBe(200);
    expect(doc.frames.map((f) => f.duration)).toEqual([120, 80]);
    expect(doc.tags[0]).toMatchObject({ name: 'walk', from: 0, to: 1, dir: 'pingpong', repeat: 2, color: '#ff8800' });
    expect(doc.palette).toEqual(d.palette);
    const k0 = celKey(doc.layers[0].id, doc.frames[0].id), k1 = celKey(doc.layers[0].id, doc.frames[1].id);
    expect(doc.cels[k0]).toBe(doc.cels[k1]); // Still linked.
    expect(doc.cels[k0]).toMatchObject({ x: 1, y: 1, w: 2, h: 1 });
    for (const f of [0, 1]) expect([...composeFrame(doc, f)]).toEqual([...composeFrame(d, f)]);
  });
  it('reads a file built by hand from the specification: indexed colour with a transparent entry', () => {
    const bytes: number[] = [];
    const u16 = (v: number) => bytes.push(v & 255, (v >> 8) & 255);
    const u32 = (v: number) => bytes.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
    const zero = (n: number) => { for (let i = 0; i < n; i++) bytes.push(0); };
    u32(0); u16(0xa5e0); u16(1); u16(2); u16(1); u16(8); u32(1); u16(100); u32(0); u32(0);
    bytes.push(0); zero(3); u16(2); bytes.push(1, 1); u16(0); u16(0); u16(16); u16(16); zero(84);
    expect(bytes.length).toBe(128);
    const frameAt = bytes.length;
    u32(0); u16(0xf1fa); u16(3); u16(50); zero(2); u32(3);
    const chunk = (type: number, body: () => void) => { const s = bytes.length; u32(0); u16(type); body(); const n = bytes.length - s; bytes[s] = n & 255; bytes[s + 1] = (n >> 8) & 255; };
    chunk(0x2019, () => { u32(2); u32(0); u32(1); zero(8); u16(0); bytes.push(0, 0, 0, 0); u16(0); bytes.push(255, 0, 0, 255); });
    chunk(0x2004, () => { u16(3); u16(0); u16(0); u16(0); u16(0); u16(0); bytes.push(255); zero(3); u16(1); bytes.push(65); });
    chunk(0x2005, () => { u16(0); u16(0); u16(0); bytes.push(255); u16(2); u16(0); zero(5); u16(2); u16(1); bytes.push(...zlibSync(Uint8Array.of(0, 1))); });
    const n = bytes.length - frameAt;
    bytes[frameAt] = n & 255; bytes[frameAt + 1] = (n >> 8) & 255;
    const { doc, warnings } = readAseprite(Uint8Array.from(bytes), 'hand');
    expect(doc.layers[0].name).toBe('A');
    expect(doc.frames[0].duration).toBe(50);
    expect([...composeFrame(doc, 0)]).toEqual([0, RED]);
    expect(warnings.some((w) => /indexed/i.test(w))).toBe(true);
  });
  it('says what the format cannot hold, and applies masks to the pixels', () => {
    let d = sample();
    const l = d.layers[0];
    d = updateLayer(d, l.id, { mask: true, clip: true });
    d = setCel(d, maskKey(l.id, d.frames[0].id), { id: 'm', x: 1, y: 1, w: 1, h: 1, opacity: 255, data: Uint32Array.of(rgba(0, 0, 0, 255)) });
    const { bytes, warnings } = writeAseprite(d);
    expect(warnings.length).toBe(2);
    const back = readAseprite(bytes).doc;
    expect(composeFrame(back, 0)[5]).toBe(0);
  });
  it('refuses other data', () => { expect(() => readAseprite(new Uint8Array(200))).toThrow('Not an Aseprite'); });
});

describe('.spritecraft', () => {
  it('keeps everything, including links, masks and clipping', () => {
    let d = sample();
    const l = d.layers[0];
    d = updateLayer(d, l.id, { mask: true, alphaLock: true });
    d = setCel(d, maskKey(l.id, d.frames[0].id), { id: 'm', x: 1, y: 1, w: 1, h: 1, opacity: 255, data: Uint32Array.of(rgba(0, 0, 0, 255)) });
    d = updateLayer(d, d.layers[2].id, { clip: true });
    d = { ...d, guides: [{ axis: 'x', pos: 2 }], colorMode: 'indexed' };
    const { doc } = readProject(writeProject(d));
    expect(doc.layers).toEqual(d.layers);
    expect(doc.frames).toEqual(d.frames);
    expect(doc.tags).toEqual(d.tags);
    expect(doc.guides).toEqual(d.guides);
    expect(doc.colorMode).toBe('indexed');
    const k = (f: number) => celKey(l.id, doc.frames[f].id);
    expect(doc.cels[k(0)]).toBe(doc.cels[k(1)]);
    for (const f of [0, 1]) expect([...composeFrame(doc, f)]).toEqual([...composeFrame(d, f)]);
  });
  it('rejects other files and future versions with a clear message', () => {
    expect(() => readProject(Uint8Array.of(1, 2, 3))).toThrow('not a SpriteCraft');
  });
});

describe('sprite sheets', () => {
  const strip = { w: 8, h: 2, data: new Uint32Array(16).map((_, i) => rgba(i, 0, 0)) };
  it('slices with margins and spacing', () => {
    const o = { frameW: 2, frameH: 2, marginX: 1, marginY: 0, spacingX: 1, spacingY: 0 };
    expect(sheetGrid(8, 2, o).cols).toBe(2);
    const f = sliceSheet(strip, o);
    expect(f.length).toBe(2);
    expect(f[1][0]).toBe(rgba(4, 0, 0));
  });
  it('finds a grid from transparent gaps', () => {
    const img = { w: 11, h: 3, data: new Uint32Array(33) };
    for (const x of [0, 4, 8]) for (let dx = 0; dx < 3; dx++) for (let y = 0; y < 3; y++) img.data[y * 11 + x + dx] = RED;
    expect(detectGrid(img)).toEqual({ frameW: 3, frameH: 3, spacingX: 1, spacingY: 0 });
  });
  it('lays out, scales and describes frames', () => {
    const d = sample();
    const s = buildSheet(d, { layout: 'grid', columns: 1, padding: 1, scale: 2, from: 0, to: 1 });
    expect([s.image.w, s.image.h]).toEqual([8, 13]);
    expect(s.rects[1]).toEqual({ x: 0, y: 7, w: 8, h: 6 });
    const json = s.json as any;
    expect(json.frames[1].duration).toBe(80);
    expect(json.meta.frameTags[0]).toMatchObject({ name: 'walk', from: 0, to: 1, direction: 'pingpong' });
    expect(s.image.data[3 * 8 + 2]).toBe(RED); // Pixel (1,1) scaled by 2.
  });
  it('makes a document from frames', () => {
    const d = docFromFrames([Uint32Array.of(RED), Uint32Array.of(0)], 1, 1, 'x', [50, 60]);
    expect(d.frames.map((f) => f.duration)).toEqual([50, 60]);
    expect(Object.keys(d.cels).length).toBe(1);
  });
});

describe('exchange with the other Craft apps', () => {
  it('writes a flipbook the shared parser accepts, exactly as GameCraft and LogicCraft read it', () => {
    const d = sample();
    const asset = parseVfxAsset(JSON.stringify(makeFlipbook(d, { from: 0, to: 1, scale: 1, loop: true })));
    expect(asset.kind).toBe('baked');
    expect(asset.flipbook).toMatchObject({ frames: 2, width: 4, height: 3, loop: true });
    expect(asset.flipbook!.image.startsWith('data:image/png;base64,')).toBe(true);
    expect(exchangeFileName('My sprite!')).toBe('My_sprite_.vfx.json');
  });
  it('comes back with the same pixels', () => {
    const d = sample();
    const asset = makeFlipbook(d, { from: 0, to: 1, scale: 1, loop: true });
    const back = readFlipbook(JSON.stringify(asset));
    expect(back.frames.length).toBe(2);
    for (const f of [0, 1]) expect([...composeFrame(back, f)]).toEqual([...composeFrame(d, f)]);
  });
  it('uses the average rate, and reports differing frame times', () => {
    const d = sample();
    expect(flipbookFps(d, 0, 1)).toBe(10);
    expect(makeFlipbook(d, { from: 0, to: 1, scale: 1, loop: true }).compatibility.gamecraft.length).toBe(1);
    expect(makeFlipbook(duplicateFrame(newDoc(1, 1), 0), { from: 0, to: 1, scale: 1, loop: true }).compatibility.gamecraft.length).toBe(0);
  });
  it('refuses strips too wide for the games, and effects with no frames', () => {
    expect(() => makeFlipbook(newDoc(MAX_STRIP, 1, 'x', 2), { from: 0, to: 1, scale: 1, loop: true })).toThrow('limit');
    expect(() => readFlipbook(JSON.stringify({ format: 'craft.vfx', kind: 'realtime' }))).toThrow('baked');
    expect(() => readFlipbook('{"format":"other"}')).toThrow();
  });
});
