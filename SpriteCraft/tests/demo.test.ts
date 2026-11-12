// The demo shipped in the zip must keep opening and rendering as the app changes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composeFrame } from '../src/core/compose';
import { celToBuffer } from '../src/core/doc';
import { poseAt, renderRig, type PartImage } from '../src/core/rig';
import { celKey } from '../src/core/types';
import { readProject } from '../src/io/project';

describe('Rig demo', () => {
  const { doc } = readProject(new Uint8Array(readFileSync(new URL('../packaging/demos/Rig demo.spritecraft', import.meta.url))));

  it('opens with its rig, bends and a rendered wave', () => {
    expect(doc.frames.length).toBe(8);
    expect(doc.rig?.parts.length).toBe(6);
    expect(doc.rig?.parts.filter((p) => p.bends?.length).length).toBe(4);
    for (let i = 0; i < 8; i++) expect(composeFrame(doc, i).some((p) => p !== 0)).toBe(true);
  });

  it('re-renders from its rig, and the arm really moves between frames', () => {
    const f0 = doc.frames[0].id, imgs = new Map<string, PartImage>();
    for (const l of doc.layers) {
      const c = doc.cels[celKey(l.id, f0)];
      if (c) imgs.set(l.id, { data: celToBuffer(c, { x: 0, y: 0, w: doc.width, h: doc.height }), box: { x: c.x, y: c.y, w: c.w, h: c.h } });
    }
    const a = renderRig(doc.rig!, poseAt(doc, doc.rig!, 0), imgs, doc.width, doc.height).image;
    const b = renderRig(doc.rig!, poseAt(doc, doc.rig!, 3), imgs, doc.width, doc.height).image;
    expect(a.some((p) => p !== 0)).toBe(true);
    expect(a).not.toEqual(b);
  });
});
