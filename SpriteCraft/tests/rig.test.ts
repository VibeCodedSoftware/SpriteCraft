import { describe, expect, it } from 'vitest';
import { rgba } from '../src/core/color';
import { newDoc } from '../src/core/doc';
import { addBend, removeBend, boneScreens, canParent, pickView, poseAt, renderRig, rigFromLayers, setRigKey, solve, turnaround, VIEW_BONE, type PartImage, type Pose, type Rig } from '../src/core/rig';

const RED = rgba(220, 40, 40), BLUE = rgba(40, 60, 220), GREEN = rgba(40, 200, 60), YELLOW = rgba(240, 220, 40);
const W = 32, H = 32;

/** A canvas-sized layer image with a filled box, one corner marked green. */
function box(x: number, y: number, w: number, h: number, c: number): PartImage {
  const data = new Uint32Array(W * H);
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) data[j * W + i] = c;
  data[y * W + x] = GREEN;
  return { data, box: { x, y, w, h } };
}
let n = 0;
const id = (p: string) => `${p}${n++}`;

/** Body (red, 8×12 at 12,10) and arm (blue, 3×8 at 20,12), the arm in front. */
function character(): { rig: Rig; images: Map<string, PartImage> } {
  const images = new Map([['body', box(12, 10, 8, 12, RED)], ['arm', box(20, 12, 3, 8, BLUE)]]);
  const r = rigFromLayers([{ id: 'body', name: 'Body' }, { id: 'arm', name: 'Arm' }], new Map([...images].map(([k, v]) => [k, v.box])), id);
  // These tests are about flat cards; shapes have their own tests below.
  const rig = { ...r, parts: r.parts.map((p) => ({ ...p, shape: 'card' as const })) };
  return { rig, images };
}
const rest = (rig: Rig): Pose => Object.fromEntries([...rig.bones.map((b) => [b.id, { rx: 0, ry: 0, rz: 0 }]), [VIEW_BONE, { rx: 0, ry: 0, rz: 0 }]]);

describe('paper rig', () => {
  it('at rest draws every part exactly where it was drawn', () => {
    const { rig, images } = character();
    const out = renderRig(rig, rest(rig), images, W, H).image;
    expect(out[10 * W + 12]).toBe(GREEN);
    expect(out[15 * W + 15]).toBe(RED);
    expect(out[15 * W + 21]).toBe(BLUE);
    expect(out.filter((c) => c).length).toBe(8 * 12 + 3 * 8);
  });

  it('turning shows only colours the artist drew (no blending)', () => {
    const { rig, images } = character();
    const p = rest(rig);
    p[VIEW_BONE] = { rx: 15, ry: 50, rz: 0 };
    p[rig.bones[1].id] = { rx: 0, ry: 0, rz: 35 };
    const thin = { ...rig, cleanEdges: false, parts: rig.parts.map((q) => ({ ...q, thickness: 0 })) };
    for (const c of renderRig(thin, p, images, W, H).image) expect([0, RED, BLUE, GREEN]).toContain(c);
  });

  it('a card with thickness stays visible side-on, as an edge strip of its own shaded colours', () => {
    const { rig, images } = character();
    const p = rest(rig);
    p[VIEW_BONE] = { rx: 0, ry: 90, rz: 0 };
    const paper = renderRig({ ...rig, parts: [{ ...rig.parts[0], thickness: 0 }] }, p, images, W, H).image;
    expect(paper.some((c) => c)).toBe(false);
    const card = renderRig({ ...rig, parts: [{ ...rig.parts[0], thickness: 3 }] }, p, images, W, H).image;
    const cols = new Set<number>(), rows = new Set<number>();
    for (let i = 0; i < card.length; i++) if (card[i]) { cols.add(i % W); rows.add(Math.floor(i / W)); }
    expect(cols.size).toBe(3);
    expect(rows.size).toBe(12);
  });

  it('a card turned 60° about Y is foreshortened to about half its width', () => {
    const { rig, images } = character();
    const p = rest(rig);
    p[rig.bones[0].id] = { rx: 0, ry: 60, rz: 0 };
    const out = renderRig({ ...rig, parts: [{ ...rig.parts[0], thickness: 0 }] }, p, images, W, H).image;
    const cols = new Set<number>();
    for (let i = 0; i < out.length; i++) if (out[i]) cols.add(i % W);
    expect(cols.size).toBe(4);
  });

  it('a child bone follows its parent', () => {
    const { rig } = character();
    rig.bones[1] = { ...rig.bones[1], parent: rig.bones[0].id };
    const p = rest(rig);
    p[rig.bones[0].id] = { rx: 0, ry: 0, rz: 90 };
    const w = solve(rig, p).get(rig.bones[1].id)!;
    // The arm is a limb, so it's jointed at its shoulder (21.5, 13.5). Around the body's joint (16, 16) a quarter turn
    // clockwise takes it to (18.5, 21.5).
    expect(w.head[0]).toBeCloseTo(18.5); expect(w.head[1]).toBeCloseTo(21.5);
  });

  it('turning the camera half way round puts the arm behind the body', () => {
    const { rig, images } = character();
    // Arm overlapping the body, in front at rest.
    images.set('arm', box(14, 12, 3, 8, BLUE));
    const r1 = rigFromLayers([{ id: 'body', name: 'Body' }, { id: 'arm', name: 'Arm' }], new Map([...images].map(([k, v]) => [k, v.box])), id);
    const r2 = { ...r1, parts: r1.parts.map((p) => ({ ...p, shape: 'card' as const })) };
    const front = renderRig(r2, rest(r2), images, W, H);
    expect(front.parts.map((x) => x.layerId)).toEqual(['body', 'arm']);
    const p = rest(r2);
    p[VIEW_BONE] = { rx: 0, ry: 180, rz: 0 };
    const back = renderRig(r2, p, images, W, H);
    expect(back.parts.map((x) => x.layerId)).toEqual(['arm', 'body']);
  });

  it('chooses drawn views by angle, mirrored when turning the other way, and uses them', () => {
    expect(pickView(0, 1).view).toBe('front');
    expect(pickView(Math.sin(0.8), Math.cos(0.8)).view).toBe('threeq');
    expect(pickView(1, 0)).toMatchObject({ view: 'side', flip: false });
    expect(pickView(-1, 0)).toMatchObject({ view: 'side', flip: true });
    expect(pickView(0, -1)).toMatchObject({ view: 'back', flip: false });
    const { rig, images } = character();
    images.set('bodySide', box(14, 10, 4, 12, YELLOW));
    rig.parts[0] = { ...rig.parts[0], views: { side: 'bodySide' } };
    const p = rest(rig);
    p[rig.bones[0].id] = { rx: 0, ry: 90, rz: 0 };
    const out = renderRig({ ...rig, parts: [rig.parts[0]] }, p, images, W, H);
    expect(out.parts[0].view).toBe('side');
    expect(out.image.filter((c) => c === YELLOW).length).toBe(4 * 12 - 1);
  });

  it('from behind with no back view, mirrorBack chooses mirrored or as drawn', () => {
    const { rig, images } = character();
    const one = { ...rig, parts: [rig.parts[0]], backShade: 0 };
    const p = rest(rig);
    p[rig.bones[0].id] = { rx: 0, ry: 180, rz: 0 };
    // The green mark is top-left as drawn; paper seen from behind shows it top-right.
    expect(renderRig(one, p, images, W, H).image[10 * W + 19]).toBe(GREEN);
    const asDrawn = { ...one, parts: [{ ...one.parts[0], mirrorBack: false }] };
    expect(renderRig(asDrawn, p, images, W, H).image[10 * W + 12]).toBe(GREEN);
  });

  it('keys animate a bone with easing, and a first key rests at frame 0', () => {
    const doc = newDoc(W, H, 'T', 5);
    let { rig } = character();
    rig = setRigKey(doc, rig, rig.bones[1].id, 'rz', 4, 90);
    expect(poseAt(doc, rig, 0)[rig.bones[1].id].rz).toBe(0);
    expect(poseAt(doc, rig, 2)[rig.bones[1].id].rz).toBeCloseTo(45);
    expect(poseAt(doc, rig, 4)[rig.bones[1].id].rz).toBe(90);
  });

  describe('shaped parts', () => {
    /** A 12×12 head: left half yellow, right half red, so turning shows which side faces us. */
    const head = () => {
      const data = new Uint32Array(W * H);
      for (let y = 10; y < 22; y++) for (let x = 10; x < 22; x++) data[y * W + x] = x < 16 ? YELLOW : RED;
      return { data, box: { x: 10, y: 10, w: 12, h: 12 } };
    };
    const headRig = (shape: 'ball' | 'tube' | 'box', shading = 0): { rig: Rig; images: Map<string, PartImage> } => {
      const images = new Map([['head', head()]]);
      const r = rigFromLayers([{ id: 'head', name: 'Head' }], new Map([['head', images.get('head')!.box]]), id);
      return { rig: { ...r, shading, parts: [{ ...r.parts[0], shape }] }, images };
    };
    const turned = (rig: Rig, ry: number) => { const p = rest(rig); p[rig.bones[0].id] = { rx: 0, ry, rz: 0 }; return p; };
    const colsOf = (img: Uint32Array, c?: number) => { const s = new Set<number>(); for (let i = 0; i < img.length; i++) if (c === undefined ? img[i] : img[i] === c) s.add(i % W); return s.size; };

    it('guesses shapes from names and proportions', () => {
      const { rig } = headRig('ball');
      expect(rigFromLayers([{ id: 'head', name: 'Head' }], new Map([['head', { x: 0, y: 0, w: 8, h: 8 }]]), id).parts[0].shape).toBe('ball');
      expect(rigFromLayers([{ id: 'a', name: 'Left arm' }], new Map([['a', { x: 0, y: 0, w: 3, h: 12 }]]), id).parts[0].shape).toBe('tube');
      expect(rigFromLayers([{ id: 'b', name: 'Torso' }], new Map([['b', { x: 0, y: 0, w: 10, h: 12 }]]), id).parts[0].shape).toBe('box');
      expect(rig.parts[0].shape).toBe('ball');
    });

    it('at rest with no shading, every shape shows the drawing exactly', () => {
      for (const s of ['ball', 'tube', 'box'] as const) {
        const { rig, images } = headRig(s);
        expect(renderRig(rig, rest(rig), images, W, H).image).toEqual(images.get('head')!.data);
      }
    });

    it('a ball turned 90° stays as wide as it is deep, unlike a card that vanishes', () => {
      const { rig, images } = headRig('ball');
      expect(colsOf(renderRig(rig, turned(rig, 90), images, W, H).image)).toBeGreaterThanOrEqual(10);
    });

    it('turning a ball rolls the drawing round it: the side turning away narrows, the other side grows', () => {
      const { rig, images } = headRig('ball');
      const a = renderRig(rig, turned(rig, 40), images, W, H).image;
      const red = colsOf(a, RED), yellow = colsOf(a, YELLOW);
      expect(red).not.toBe(yellow);
      expect(red + yellow).toBeGreaterThan(6);
    });

    it('shading darkens only surfaces turned away; the middle facing you keeps its colour', () => {
      const { rig, images } = headRig('ball', 60);
      const out = renderRig(rig, rest(rig), images, W, H).image;
      expect(out[15 * W + 15]).toBe(YELLOW);
      expect(out[16 * W + 10]).not.toBe(YELLOW);
      // Banded: each drawn colour has at most three tones.
      expect(new Set(out.filter((c) => c)).size).toBeLessThanOrEqual(6);
    });

    it('with no back view, the back of a head takes the top colour of each column: hair, not the face', () => {
      const HAIR = rgba(90, 50, 30);
      const images = new Map([['head', head()]]);
      const d = images.get('head')!.data;
      for (let y = 10; y < 13; y++) for (let x = 10; x < 22; x++) d[y * W + x] = HAIR;
      const r = rigFromLayers([{ id: 'head', name: 'Head' }], new Map([['head', images.get('head')!.box]]), id);
      const rig = { ...r, shading: 0, backShade: 0 };
      expect(rig.parts[0].shape).toBe('ball');
      const out = renderRig(rig, turned(rig, 180), images, W, H).image;
      const seen = new Set(out.filter((c) => c));
      expect([...seen]).toEqual([HAIR]);
    });

    it('the back of an arm carries its outline colours round; other back settings still work', () => {
      const images = new Map([['arm', box(14, 8, 4, 14, BLUE)]]);
      const r = rigFromLayers([{ id: 'arm', name: 'Arm' }], new Map([['arm', images.get('arm')!.box]]), id);
      const rig = { ...r, shading: 0, backShade: 0 };
      expect(rig.parts[0].shape).toBe('tube');
      const p = turned(rig, 180);
      // Only the top-left pixel is green, so the edges of every row but the first are blue.
      const edges = renderRig(rig, p, images, W, H).image.filter((c) => c);
      expect(edges.filter((c) => c === BLUE).length).toBeGreaterThan(edges.length - 3);
      const one = { ...rig, parts: [{ ...rig.parts[0], backMode: 'colour' as const, backColour: YELLOW }] };
      expect(new Set(renderRig(one, p, images, W, H).image.filter((c) => c))).toEqual(new Set([YELLOW]));
    });

    describe('carved from front and side drawings', () => {
      /** Front: 12×12 yellow head. Side (facing right): a 10-wide green profile with a 2-pixel nose on row 6. */
      const carved = () => {
        const images = new Map([['head', head()]]);
        const sd = new Uint32Array(W * H);
        for (let y = 10; y < 22; y++) for (let x = 0; x < 10; x++) sd[y * W + x] = GREEN;
        sd[16 * W + 10] = RED; sd[16 * W + 11] = RED;
        images.set('side', { data: sd, box: { x: 0, y: 10, w: 12, h: 12 } });
        const r = rigFromLayers([{ id: 'head', name: 'Head' }], new Map([['head', images.get('head')!.box]]), id);
        return { rig: { ...r, shading: 0, parts: [{ ...r.parts[0], shape: 'carved' as const, views: { side: 'side' } }] }, images };
      };
      const rowWidth = (img: Uint32Array, y: number) => { let n = 0; for (let x = 0; x < W; x++) if (img[y * W + x]) n++; return n; };

      it('at rest is the front drawing exactly', () => {
        const { rig, images } = carved();
        expect(renderRig(rig, rest(rig), images, W, H).image).toEqual(images.get('head')!.data);
      });

      it('side-on, it has the side drawing\'s outline and colours, nose and all', () => {
        const { rig, images } = carved();
        const out = renderRig(rig, turned(rig, 90), images, W, H).image;
        expect(rowWidth(out, 16)).toBe(rowWidth(out, 12) + 2);
        expect(out.filter((c) => c === RED).length).toBe(2);
        expect(out.filter((c) => c === GREEN).length).toBeGreaterThan(80);
      });

      it('from behind with no back view, the back takes the back of the side drawing, not the face', () => {
        const { rig, images } = carved();
        const sd = images.get('side')!.data;
        for (let y = 10; y < 22; y++) sd[y * W] = BLUE; // the back-most column of the profile: "hair"
        const out = renderRig({ ...rig, backShade: 0 }, turned(rig, 180), images, W, H).image;
        expect(new Set(out.filter((c) => c))).toEqual(new Set([BLUE]));
      });

      it('rounded corners trim the boxy corner seen at 45°', () => {
        const { rig, images } = carved();
        const count = (rc: number) => renderRig({ ...rig, parts: [{ ...rig.parts[0], roundCorners: rc }] }, turned(rig, 45), images, W, H).image.filter((c) => c).length;
        expect(count(100)).toBeLessThan(count(0));
        // Rest is still exact with rounding on.
        expect(renderRig({ ...rig, parts: [{ ...rig.parts[0], roundCorners: 100 }] }, rest(rig), images, W, H).image).toEqual(images.get('head')!.data);
      });

      it('at 45° with no ¾ view, the face keeps both eyes, and dithered shading adds at most two tones per colour', () => {
        const { rig, images } = carved();
        const fd = images.get('head')!.data;
        fd[15 * W + 13] = BLUE; fd[15 * W + 18] = BLUE; // two eyes
        expect(renderRig(rig, turned(rig, 45), images, W, H).image.filter((c) => c === BLUE).length).toBeGreaterThanOrEqual(2);
        const shaded = renderRig({ ...rig, shading: 60 }, turned(rig, 45), images, W, H).image.filter((c) => c);
        // Drawn colours here: yellow, red, blue, green. Each may appear plain or in two darker steps.
        expect(new Set(shaded).size).toBeLessThanOrEqual(12);
      });

      it('turned part way, it keeps to the one drawing nearest the camera: no features from a second drawing', () => {
        const { rig, images } = carved();
        // Nearer the front, the side drawing's colours (green, and its red nose) don't appear.
        const near = renderRig(rig, turned(rig, 30), images, W, H).image;
        expect(near.some((c) => c === GREEN)).toBe(false);
        // Nearer the side, the side drawing takes over.
        const far = renderRig(rig, turned(rig, 60), images, W, H).image;
        expect(far.some((c) => c === GREEN)).toBe(true);
      });
    });

    it('side-on, a ball wears the outline colours of that side, not the front drawing smeared round it', () => {
      const { rig, images } = headRig('ball');
      // The left half of the drawing is yellow, the right red. Turned 90°, the camera faces the drawing's left edge.
      const out = renderRig(rig, turned(rig, 90), images, W, H).image;
      expect(new Set(out.filter((c) => c))).toEqual(new Set([YELLOW]));
    });

    it('at 45°, a drawn three-quarter view supplies the corner', () => {
      const { rig, images } = headRig('ball');
      images.set('tq', box(10, 10, 12, 12, BLUE));
      const r = { ...rig, parts: [{ ...rig.parts[0], views: { threeq: 'tq' } }] };
      const out = renderRig(r, turned(r, 45), images, W, H).image.filter((c) => c);
      expect(out.filter((c) => c === BLUE).length).toBeGreaterThan(out.length / 2);
      // Without it, the same angle shows only the drawing's own colours.
      for (const c of renderRig(rig, turned(rig, 45), images, W, H).image) expect([0, YELLOW, RED]).toContain(c);
    });

    it('shape sliders change the shape seen side-on', () => {
      const { rig, images } = headRig('ball');
      const side = (patch: object) => renderRig({ ...rig, parts: [{ ...rig.parts[0], ...patch }] }, turned(rig, 90), images, W, H).image;
      const width = (img: Uint32Array, y: number) => { let n = 0; for (let x = 0; x < W; x++) if (img[y * W + x]) n++; return n; };
      const plain = side({});
      // Flat front shaves off the face side; fullness swells it; taper makes the top deeper than the bottom.
      expect(width(side({ flatFront: 80 }), 16)).toBeLessThan(width(plain, 16));
      expect(width(side({ fullness: 100 }), 12)).toBeGreaterThan(width(plain, 12));
      const tapered = side({ taper: 80 });
      expect(width(tapered, 13)).toBeGreaterThan(width(tapered, 20));
      // Lean moves the top towards the viewer's side of the profile without changing the rest pose.
      expect(renderRig({ ...rig, parts: [{ ...rig.parts[0], lean: 60, taper: 40, fullness: 50 }] }, rest(rig), images, W, H).image).toEqual(images.get('head')!.data);
    });

    it('from behind, a ball shows the back view when one is drawn', () => {
      const { rig, images } = headRig('ball');
      images.set('headBack', box(10, 10, 12, 12, BLUE));
      const r = { ...rig, parts: [{ ...rig.parts[0], views: { back: 'headBack' } }] };
      const out = renderRig(r, turned(r, 180), images, W, H);
      // From straight behind, the back view is shown as a drawn view facing the camera.
      expect(out.image.filter((c) => c === BLUE).length).toBeGreaterThan(100);
    });
  });

  describe('bending inside a part', () => {
    /** One layer: a 4×14 leg (blue, a red foot on its last 3 rows) at x 14, y 8. */
    const leg = () => {
      const data = new Uint32Array(W * H);
      for (let y = 8; y < 22; y++) for (let x = 14; x < 18; x++) data[y * W + x] = y >= 19 ? RED : BLUE;
      const images = new Map<string, PartImage>([['leg', { data, box: { x: 14, y: 8, w: 4, h: 14 } }]]);
      const r = rigFromLayers([{ id: 'leg', name: 'Leg' }], new Map([['leg', images.get('leg')!.box]]), id);
      // Cards, so pixel positions are easy to check; bending works the same for every shape.
      return { rig: { ...r, shading: 0, parts: r.parts.map((p) => ({ ...p, shape: 'card' as const, thickness: 0 })) }, images };
    };

    it('a limb is jointed at its top by default', () => {
      const { rig } = leg();
      expect(rig.bones[0].head.y).toBeCloseTo(10);
    });

    it('adding a bend makes a child bone at that row and changes nothing at rest', () => {
      const { rig, images } = leg();
      const bent = addBend(rig, 'leg', 15, images.get('leg')!, W, id, 'Knee');
      const knee = bent.bones.find((b) => b.name === 'Knee')!;
      expect(knee.parent).toBe(rig.bones[0].id);
      expect(knee.head).toEqual({ x: 16, y: 15, z: rig.bones[0].head.z });
      expect(renderRig(bent, rest(bent), images, W, H).image).toEqual(images.get('leg')!.data);
    });

    it('bending the knee swings the lower leg and foot, and the upper leg stays put', () => {
      const { rig, images } = leg();
      const bent = addBend(rig, 'leg', 15, images.get('leg')!, W, id, 'Knee');
      const knee = bent.bones.find((b) => b.name === 'Knee')!;
      const p = rest(bent);
      p[knee.id] = { rx: 0, ry: 0, rz: 90 };
      const out = renderRig(bent, p, images, W, H).image;
      // Upper leg rows unchanged.
      for (let y = 8; y < 15; y++) for (let x = 14; x < 18; x++) expect(out[y * W + x]).toBe(BLUE);
      // The foot (red) now lies to the left of the knee at about knee height, not below it.
      const reds: [number, number][] = [];
      for (let i = 0; i < out.length; i++) if (out[i] === RED) reds.push([i % W, Math.floor(i / W)]);
      expect(reds.length).toBe(12);
      expect(reds.every(([x, y]) => x < 14 && y >= 13 && y <= 18)).toBe(true);
      // Nothing is left hanging below the knee.
      for (let y = 19; y < 22; y++) for (let x = 14; x < 18; x++) expect(out[y * W + x]).toBe(0);
    });

    it('the joint stays filled when bent: no gap between the pieces', () => {
      const { rig, images } = leg();
      const bent = addBend(rig, 'leg', 15, images.get('leg')!, W, id, 'Knee');
      const knee = bent.bones.find((b) => b.name === 'Knee')!;
      const p = rest(bent);
      p[knee.id] = { rx: 0, ry: 0, rz: 60 };
      const out = renderRig(bent, p, images, W, H).image;
      // Flood from the hip: every drawn pixel is reachable, so the leg is one connected shape.
      const seen = new Set<number>(), stack = [8 * W + 15];
      while (stack.length) { const i = stack.pop()!; if (seen.has(i) || !out[i]) continue; seen.add(i); stack.push(i - 1, i + 1, i - W, i + W); }
      expect(seen.size).toBe(out.filter((c) => c).length);
    });

    it('bones on screen: a leg reaches from its hip to its knee, the lower leg from the knee to the foot, and follows a bend', () => {
      const { rig, images } = leg();
      const bent = addBend(rig, 'leg', 15, images.get('leg')!, W, id, 'Knee');
      const knee = bent.bones.find((b) => b.name === 'Knee')!;
      const at = boneScreens(bent, rest(bent), images);
      expect(at.get(bent.bones[0].id)!.head.slice(0, 2)).toEqual([16, 10]);
      expect(at.get(bent.bones[0].id)!.tip[1]).toBeCloseTo(15);
      expect(at.get(knee.id)!.tip[1]).toBeCloseTo(22);
      const p = rest(bent);
      p[knee.id] = { rx: 0, ry: 0, rz: 90 };
      // Bent a quarter turn clockwise, the lower leg points left from the knee.
      const lower = boneScreens(bent, p, images).get(knee.id)!;
      expect(lower.tip[0]).toBeCloseTo(9); expect(lower.tip[1]).toBeCloseTo(15);
    });

    it('bends chain and can be removed; the bend below re-attaches to the bone above', () => {
      const { rig, images } = leg();
      let r = addBend(rig, 'leg', 18, images.get('leg')!, W, id, 'Ankle');
      r = addBend(r, 'leg', 14, images.get('leg')!, W, id, 'Knee');
      const knee = r.bones.find((b) => b.name === 'Knee')!, ankle = r.bones.find((b) => b.name === 'Ankle')!;
      expect(ankle.parent).toBe(knee.id);
      r = removeBend(r, 'leg', knee.id);
      expect(r.bones.find((b) => b.name === 'Ankle')!.parent).toBe(rig.bones[0].id);
      expect(r.parts[0].bends!.map((b) => b.at)).toEqual([18]);
    });
  });

  it('parenting refuses loops; a turnaround has no repeated frame', () => {
    const { rig } = character();
    const r = { ...rig, bones: [rig.bones[0], { ...rig.bones[1], parent: rig.bones[0].id }] };
    expect(canParent(r, r.bones[0].id, r.bones[1].id)).toBe(false);
    expect(canParent(r, r.bones[1].id, null)).toBe(true);
    expect(turnaround(4)).toEqual([0, 90, 180, 270]);
  });
});
