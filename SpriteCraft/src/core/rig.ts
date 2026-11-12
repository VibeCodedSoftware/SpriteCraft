// Phase 3: the paper rig. A character made of drawn parts (layers) hung on a 3D skeleton, posed and turned in real time.
//
// How it works, and what it deliberately does not do:
// - Each part is a flat card cut from its layer and hung on a bone. Bones form a hierarchy and turn about their joints
//   in 3D. This is cutout animation in 3D space, as flat "paper" characters have used in games since the 1990s.
// - Turning a card foreshortens the artist's own drawing, sampled pixel by pixel with no blending.
// - When a card turns far enough, it switches to a view the artist drew for that angle (three-quarter, side, back),
//   shown facing the camera at the bone's position, the way directional sprites have worked since the early 1990s.
// - Parts are drawn back to front by depth each frame, so an arm passes behind the body as the character turns.
// - SpriteCraft never generates or redraws new pixel art for an angle: every pixel shown is one the artist drew.
// No patent search found the claims behind the "patented" label of other tools, so this is a design choice to stay
// with long-documented techniques, not legal advice.
import { A, B, G, R, rgba } from './color';
import { easeFn, liveKeys, sampleKeys, type Key } from './anim';
import { renderPlaced, upscale8, type Bitmap } from './transform';
import { ditherThreshold } from './raster';
import type { Doc } from './types';

export type Axis = 'rx' | 'ry' | 'rz';
export type ViewName = 'front' | 'threeq' | 'side' | 'back';

export interface Bone {
  id: string;
  name: string;
  parent: string | null;
  /** The joint at rest, in canvas pixels; z is towards the viewer. */
  head: { x: number; y: number; z: number };
}

export interface Part {
  /** The layer drawn as the front of this part. */
  layerId: string;
  boneId: string;
  /** Depth of the card at rest (canvas pixels towards the viewer). Overlapping parts sort by this as they turn. */
  z: number;
  /** Layers drawn for other angles, all facing right where it matters. Missing views fall back to the front. */
  views: Partial<Record<Exclude<ViewName, 'front'>, string>>;
  /** Seen from behind with no back view drawn: show the front mirrored (true, like paper) or as drawn (false). */
  mirrorBack: boolean;
  /**
   * Thickness of the card in pixels, like cardboard. When the card turns, its edge shows as a strip coloured from the
   * outermost pixel of each row, so a part seen side-on stays visible instead of vanishing. 0 is paper-thin.
   */
  thickness?: number;
  /**
   * The solid the drawing is projected onto, like a label printed on an object: a flat card, a box (torsos), a tube
   * round the upright axis (arms, legs), or a ball (heads). Facing you at rest, every shape shows the drawing exactly.
   */
  shape?: PartShape;
  /** How far the shape bulges towards (and away from) the viewer, in pixels. Defaults from the part's size. */
  depth?: number;
  /**
   * What the back shows when no back view is drawn. Every option uses colours already in the drawing:
   * 'top' takes the topmost colour of each column (the hair on a head), 'edges' the outline colour of each row on that
   * side (sleeves, shirts), 'mirror' and 'asDrawn' the front drawing, 'colour' one chosen colour.
   * Unset: heads ('ball') use 'top', tubes and boxes 'edges', cards follow `mirrorBack`.
   */
  backMode?: BackMode;
  /** The colour for backMode 'colour', 0xAABBGGRR. */
  backColour?: number;
  /** Shape sliders for balls, tubes and boxes, each -100..100 (flatFront 0..95): see drawShaped. */
  fullness?: number;
  flatFront?: number;
  /** Carved parts: 0 keeps the hard corners where the front and side outlines meet, 100 rounds them fully. Default 70. */
  roundCorners?: number;
  /**
   * Bends inside the part, like an elbow or a knee: from canvas row `at` down, the part follows bone `boneId` (a child of
   * the bone above it). Each lower piece also carries a few rows above its bend, which fill the outside of the joint
   * when it bends.
   */
  bends?: { boneId: string; at: number }[];
  taper?: number;
  lean?: number;
}

export type BackMode = 'top' | 'edges' | 'mirror' | 'asDrawn' | 'colour';

export const backModeOf = (p: Part): BackMode =>
  p.backMode ?? (p.shape === 'ball' ? 'top' : p.shape === 'tube' || p.shape === 'box' ? 'edges' : p.mirrorBack ? 'mirror' : 'asDrawn');

/**
 * The colour on the back of a part at (u, v) of its drawing, when no back view is drawn. `u` is in the drawing's own
 * left-to-right, so 'mirror' shows the drawing as paper would from behind.
 */
function backSampler(b: Bitmap, mode: BackMode, colour: number): (ui: number, vi: number) => number {
  const { w, h, data } = b;
  if (mode === 'mirror') return (ui, vi) => data[vi * w + ui];
  if (mode === 'asDrawn') return (ui, vi) => data[vi * w + (w - 1 - ui)];
  if (mode === 'colour') return (ui, vi) => (A(data[vi * w + ui]) ? colour : 0);
  if (mode === 'top') {
    const top = new Uint32Array(w);
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) if (A(data[j * w + i])) { top[i] = data[j * w + i]; break; }
    return (ui, vi) => (A(data[vi * w + ui]) ? top[ui] : 0);
  }
  // 'edges': each row's outermost colour on the side of the drawing this point is on.
  const left = new Uint32Array(h), right = new Uint32Array(h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) if (A(data[j * w + i])) { left[j] = data[j * w + i]; break; }
    for (let i = w - 1; i >= 0; i--) if (A(data[j * w + i])) { right[j] = data[j * w + i]; break; }
  }
  return (ui, vi) => (A(data[vi * w + ui]) ? (ui < w / 2 ? left[vi] : right[vi]) : 0);
}

/** 'carved' is cut from the front and side drawings together (it needs a side view; without one it acts as a box). */
export type PartShape = 'card' | 'box' | 'tube' | 'ball' | 'carved';

/** The bulge a shape gets when none is set: round shapes as deep as they are wide. */
export const defaultDepth = (shape: PartShape, w: number, h: number) =>
  shape === 'ball' ? Math.min(w, h) / 2 : shape === 'tube' ? w / 2 : shape === 'box' ? Math.max(1, Math.round(w / 3)) : 1;

/** A first guess at a part's shape from its name, then its proportions. */
export function guessShape(name: string, w: number, h: number): PartShape {
  const n = name.toLowerCase();
  if (/head|face|skull|ball|eye/.test(n)) return 'ball';
  if (/arm|leg|tail|neck|finger|thigh|shin|limb|hand|foot|feet/.test(n)) return 'tube';
  if (/body|torso|chest|hip|pelvis|belly|trunk/.test(n)) return 'box';
  const r = h / Math.max(1, w);
  return r >= 1.8 ? 'tube' : r >= 0.7 && r <= 1.4 ? 'ball' : 'box';
}

export interface Rig {
  bones: Bone[];
  parts: Part[];
  /** Keyframes per bone and axis (degrees). The bone id "view" holds the camera's turn (ry) and tilt (rx). */
  tracks: Record<string, Partial<Record<Axis, Key[]>>>;
  /** The point the whole character turns around when the camera orbits. */
  centre: { x: number; y: number; z: number };
  /** Darkening of a card's back when no back view is drawn, 0..100. */
  backShade: number;
  /** Use the 8× pixel-art enlargement when sampling turned cards, for cleaner diagonals. */
  cleanEdges: boolean;
  /** 0..100: how much surfaces turned away from the viewer darken on balls, tubes and boxes. 0 adds no colours. */
  shading?: number;
}

export const VIEW_BONE = 'view';

export type Pose = Record<string, { rx: number; ry: number; rz: number }>;

// ---- 3×3 rotation maths (row-major), y pointing down the canvas and z towards the viewer.

type M3 = number[];
export function rot(rx: number, ry: number, rz: number): M3 {
  const d = Math.PI / 180;
  const [cx, sx] = [Math.cos(rx * d), Math.sin(rx * d)], [cy, sy] = [Math.cos(ry * d), Math.sin(ry * d)], [cz, sz] = [Math.cos(rz * d), Math.sin(rz * d)];
  // Rz · Ry · Rx: tilt first, then turn, then roll.
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}
const mul = (a: M3, b: M3): M3 => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
};
const apply = (m: M3, x: number, y: number, z: number): [number, number, number] =>
  [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];

export interface BoneWorld { m: M3; head: [number, number, number] }

/** Every bone's world rotation and joint position for a pose (camera turn not included). */
export function solve(rig: Rig, pose: Pose): Map<string, BoneWorld> {
  const out = new Map<string, BoneWorld>();
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const visit = (b: Bone, depth: number): BoneWorld => {
    const done = out.get(b.id);
    if (done) return done;
    const p = pose[b.id] ?? { rx: 0, ry: 0, rz: 0 };
    const local = rot(p.rx, p.ry, p.rz);
    const parent = b.parent ? byId.get(b.parent) : undefined;
    let w: BoneWorld;
    if (!parent || depth > 64) w = { m: local, head: [b.head.x, b.head.y, b.head.z] };
    else {
      const pw = visit(parent, depth + 1);
      // The joint rides on the parent: its offset from the parent's joint turns with the parent.
      const o = apply(pw.m, b.head.x - parent.head.x, b.head.y - parent.head.y, b.head.z - parent.head.z);
      w = { m: mul(pw.m, local), head: [pw.head[0] + o[0], pw.head[1] + o[1], pw.head[2] + o[2]] };
    }
    out.set(b.id, w);
    return w;
  };
  for (const b of rig.bones) visit(b, 0);
  return out;
}

/**
 * Where each bone is on screen in a pose: its joint and its tip, both as canvas pixels (x, y, and depth). The tip is the
 * joint of its first child bone when it has one; otherwise it reaches to the end of the part it carries (or 6 pixels).
 * Used to draw the bones over the preview and to grab them.
 */
export function boneScreens(rig: Rig, pose: Pose, images: Map<string, PartImage>): Map<string, { head: [number, number, number]; tip: [number, number, number] }> {
  const world = solve(rig, pose);
  const v = pose[VIEW_BONE] ?? { rx: 0, ry: 0, rz: 0 };
  const view = rot(v.rx, v.ry, 0);
  const C = rig.centre;
  const toScreen = (p: [number, number, number]): [number, number, number] => {
    const q = apply(view, p[0] - C.x, p[1] - C.y, p[2] - C.z);
    return [q[0] + C.x, q[1] + C.y, q[2] + C.z];
  };
  // How far each bone reaches at rest, down its part (to the next bend, or the part's bottom).
  const reach = new Map<string, number>();
  for (const p of rig.parts) {
    const img = images.get(p.layerId);
    if (!img) continue;
    const bottom = img.box.y + img.box.h;
    const stops = [...(p.bends ?? [])].sort((a, b) => a.at - b.at);
    const chain = [{ boneId: p.boneId, at: rig.bones.find((b) => b.id === p.boneId)?.head.y ?? img.box.y }, ...stops];
    chain.forEach((c, i) => reach.set(c.boneId, Math.max(2, (i + 1 < chain.length ? chain[i + 1].at : bottom) - c.at)));
  }
  const out = new Map<string, { head: [number, number, number]; tip: [number, number, number] }>();
  for (const b of rig.bones) {
    const w = world.get(b.id);
    if (!w) continue;
    const child = rig.bones.find((c) => c.parent === b.id);
    const len = reach.get(b.id);
    let tip: [number, number, number];
    if (len !== undefined) {
      const d = apply(w.m, 0, len, 0);
      tip = toScreen([w.head[0] + d[0], w.head[1] + d[1], w.head[2] + d[2]]);
    } else if (child && world.get(child.id)) tip = toScreen(world.get(child.id)!.head);
    else { const d = apply(w.m, 0, 6, 0); tip = toScreen([w.head[0] + d[0], w.head[1] + d[1], w.head[2] + d[2]]); }
    out.set(b.id, { head: toScreen(w.head), tip });
  }
  return out;
}

/** Which drawn view suits a card, from where its face points after turning. Angles are degrees from facing front. */
export function pickView(nx: number, nz: number): { view: ViewName; flip: boolean; angle: number } {
  const a = (Math.atan2(nx, nz) * 180) / Math.PI;
  const m = Math.abs(a);
  // Turning right (positive) shows the right-facing views as drawn; turning left mirrors them.
  const flip = a < 0;
  if (m <= 22.5) return { view: 'front', flip: false, angle: a };
  if (m <= 67.5) return { view: 'threeq', flip, angle: a };
  if (m <= 112.5) return { view: 'side', flip, angle: a };
  // A back view is drawn once, as seen from behind; it isn't mirrored by the direction of the turn.
  return { view: 'back', flip: false, angle: a };
}

export interface PartImage {
  /** Canvas-sized pixels of a layer at the frame being drawn. */
  data: Uint32Array;
  /** The box holding its pixels. */
  box: { x: number; y: number; w: number; h: number };
}

const shade = (c: number, k: number) => (k >= 1 ? c : rgba(Math.round(R(c) * k), Math.round(G(c) * k), Math.round(B(c) * k), A(c)));

const cropBmp = (img: PartImage, W: number): Bitmap => {
  const { x, y, w, h } = img.box, data = new Uint32Array(w * h);
  for (let r = 0; r < h; r++) data.set(img.data.subarray((y + r) * W + x, (y + r) * W + x + w), r * w);
  return { w, h, data };
};

export interface DrawnPart { layerId: string; view: ViewName; depth: number }

/** The rows [y0, y1) of a layer image (canvas rows), or null when nothing is drawn there. */
function sliceRows(img: PartImage, y0: number, y1: number, W: number): PartImage | null {
  const top = Math.max(img.box.y, Math.ceil(y0)), bot = Math.min(img.box.y + img.box.h, Math.ceil(y1));
  if (bot <= top) return null;
  const data = new Uint32Array(img.data.length);
  data.set(img.data.subarray(top * W, bot * W), top * W);
  return { data, box: { x: img.box.x, y: top, w: img.box.w, h: bot - top } };
}

/** Rows the piece below a bend reaches back above it: half the limb's width there, so the joint's outside stays filled. */
export function jointOverlap(img: PartImage, at: number, W: number): number {
  const y = Math.min(img.box.y + img.box.h - 1, Math.max(img.box.y, Math.floor(at)));
  let l = -1, r = -1;
  for (let x = img.box.x; x < img.box.x + img.box.w; x++) if (A(img.data[y * W + x])) { if (l < 0) l = x; r = x; }
  return l < 0 ? 1 : Math.max(1, Math.ceil((r - l + 1) / 2));
}

/**
 * Splits parts with bends into one piece per bone, each with its own slice of the drawings (front and views). Pieces of
 * one part report the part's layer id. Unbent parts pass through unchanged.
 */
function bendPieces(rig: Rig, images: Map<string, PartImage>, W: number) {
  const imgs = new Map(images);
  const pieces: { part: Part; srcLayer: string; bias: number }[] = [];
  for (const part of rig.parts) {
    const front = images.get(part.layerId);
    if (!part.bends?.length || !front) { pieces.push({ part, srcLayer: part.layerId, bias: 0 }); continue; }
    const bends = [...part.bends].sort((a, b) => a.at - b.at);
    const cuts = [-Infinity, ...bends.map((b) => b.at), Infinity];
    for (let s = 0; s < cuts.length - 1; s++) {
      const from = cuts[s] - (s === 0 ? 0 : jointOverlap(front, cuts[s], W)), to = cuts[s + 1];
      const key = (id: string) => `${id}#${s}`;
      const piece = sliceRows(front, from, to, W);
      if (!piece) continue;
      imgs.set(key(part.layerId), piece);
      const views: Part['views'] = {};
      for (const [k, id] of Object.entries(part.views) as [keyof Part['views'], string | undefined][]) {
        const src = id ? images.get(id) : undefined;
        const sl = src ? sliceRows(src, from, to, W) : null;
        if (sl) { imgs.set(key(id!), sl); views[k] = key(id!); }
      }
      pieces.push({
        part: { ...part, layerId: key(part.layerId), boneId: s === 0 ? part.boneId : bends[s - 1].boneId, views, bends: undefined },
        srcLayer: part.layerId, bias: -0.02 * s,
      });
    }
  }
  return { pieces, imgs };
}

/** Adds a bend to a part at canvas row `at`, with a new bone jointed there (child of the bone above that row). */
export function addBend(rig: Rig, layerId: string, at: number, img: PartImage, W: number, newId: (p: string) => string, name?: string): Rig {
  const part = rig.parts.find((p) => p.layerId === layerId);
  if (!part) return rig;
  const y = Math.round(at);
  if (y <= img.box.y || y >= img.box.y + img.box.h) return rig;
  if (part.bends?.some((b) => b.at === y)) return rig;
  const bends = [...(part.bends ?? [])].sort((a, b) => a.at - b.at);
  const above = [...bends].reverse().find((b) => b.at < y);
  const below = bends.find((b) => b.at > y);
  const parentId = above ? above.boneId : part.boneId;
  const parent = rig.bones.find((b) => b.id === parentId)!;
  // The joint sits in the middle of the drawing on that row.
  let l = -1, r = -1;
  for (let x = img.box.x; x < img.box.x + img.box.w; x++) if (A(img.data[y * W + x])) { if (l < 0) l = x; r = x; }
  const id = newId('b');
  const base = rig.bones.find((b) => b.id === part.boneId)!;
  const bone: Bone = { id, name: name ?? `${base.name} bend ${bends.length + 1}`, parent: parentId, head: { x: l < 0 ? parent.head.x : (l + r + 1) / 2, y, z: parent.head.z } };
  // A bend added between two others takes over as the parent of the one below it.
  const bones = rig.bones.map((b) => (below && b.id === below.boneId ? { ...b, parent: id } : b));
  return {
    ...rig, bones: [...bones, bone],
    parts: rig.parts.map((p) => (p === part ? { ...p, bends: [...bends, { boneId: id, at: y }].sort((a, b) => a.at - b.at) } : p)),
  };
}

/** Removes a bend and its bone; the bone below it (if any) hangs from the bone above instead. */
export function removeBend(rig: Rig, layerId: string, boneId: string): Rig {
  const part = rig.parts.find((p) => p.layerId === layerId);
  const gone = rig.bones.find((b) => b.id === boneId);
  if (!part || !gone) return rig;
  const tracks = { ...rig.tracks };
  delete tracks[boneId];
  return {
    ...rig, tracks,
    bones: rig.bones.filter((b) => b.id !== boneId).map((b) => (b.parent === boneId ? { ...b, parent: gone.parent } : b)),
    parts: rig.parts.map((p) => (p === part ? { ...p, bends: (p.bends ?? []).filter((b) => b.boneId !== boneId) } : p)),
  };
}

/**
 * Draws the rig in a pose into a canvas-sized image. `images` gives each layer's pixels for the frame. Returns the
 * image and, for the editor, which view each part showed and its depth.
 */
export function renderRig(rig: Rig, pose: Pose, images: Map<string, PartImage>, W: number, H: number, cache = new Map<string, Bitmap>()): { image: Uint32Array; parts: DrawnPart[] } {
  const out = new Uint32Array(W * H);
  const world = solve(rig, pose);
  const v = pose[VIEW_BONE] ?? { rx: 0, ry: 0, rz: 0 };
  const view = rot(v.rx, v.ry, 0);
  const C = rig.centre;
  const toScreen = (p: [number, number, number]): [number, number, number] => {
    const q = apply(view, p[0] - C.x, p[1] - C.y, p[2] - C.z);
    return [q[0] + C.x, q[1] + C.y, q[2] + C.z];
  };
  const big = (key: string, b: Bitmap) => { let x = cache.get(key); if (!x) { x = upscale8(b); cache.set(key, x); } return x; };

  type Job = { depth: number; order: number; draw: () => void; layerId: string; view: ViewName };
  const jobs: Job[] = [];
  const { pieces, imgs } = bendPieces(rig, images, W);
  pieces.forEach(({ part, srcLayer, bias }, order) => {
    const bw = world.get(part.boneId);
    const front = imgs.get(part.layerId);
    const bone = rig.bones.find((b) => b.id === part.boneId);
    if (!bw || !front || !bone) return;
    const M = mul(view, bw.m);
    // Where the card's corner and axes land on screen.
    const corner = (x: number, y: number) => toScreen(((p) => [bw.head[0] + p[0], bw.head[1] + p[1], bw.head[2] + p[2]] as [number, number, number])(apply(bw.m, x - bone.head.x, y - bone.head.y, part.z - bone.head.z)));
    const U = apply(M, 1, 0, 0), V = apply(M, 0, 1, 0), N = apply(M, 0, 0, 1);
    const pick = pickView(N[0], N[2]);
    const drawn = pick.view !== 'front' ? part.views[pick.view] : undefined;
    const viewImg = drawn ? imgs.get(drawn) : undefined;
    const anchor = toScreen([bw.head[0], bw.head[1], bw.head[2] + (part.z - bone.head.z)]);
    const mid = corner(front.box.x + front.box.w / 2, front.box.y + front.box.h / 2);
    // Pieces of one bent part sort by their own depth, nudged so the upper piece covers the joint rows of the next.
    mid[2] += bias;

    if (viewImg && (part.shape ?? 'card') === 'card') {
      // A flat card swaps to a drawn view, facing the camera at the joint, keeping only the bone's roll on screen.
      // Solid shapes use drawn views in 3D instead (a side view carves the shape and colours its sides).
      const angle = Math.atan2(-V[0], V[1]);
      const b = cropBmp(viewImg, W);
      const ox = viewImg.box.x + viewImg.box.w / 2 - bone.head.x, oy = viewImg.box.y + viewImg.box.h / 2 - bone.head.y;
      const cs = Math.cos(angle), sn = Math.sin(angle);
      const fx = pick.flip ? -ox : ox;
      const cx = anchor[0] + fx * cs - oy * sn, cy = anchor[1] + fx * sn + oy * cs;
      const turned = Math.abs(Math.sin(angle * 2)) > 1e-6;
      const key = 'v:' + drawn;
      jobs.push({ depth: mid[2], order, layerId: srcLayer, view: pick.view, draw: () =>
        renderPlaced(b, { cx, cy, sw: pick.flip ? -b.w : b.w, sh: b.h, angle }, (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) out[y * W + x] = c; },
          rig.cleanEdges && turned ? big(key, b) : b, rig.cleanEdges && turned ? 8 : 1) });
      return;
    }

    const b = cropBmp(front, W);
    const o = corner(front.box.x, front.box.y);

    const shape = part.shape ?? 'card';
    if (shape !== 'card') {
      jobs.push({ depth: mid[2], order, layerId: srcLayer, view: N[2] < 0 ? 'back' : 'front', draw: () => drawShaped(out, W, H, b, front, o, U, V, N, shape, part, rig, imgs) });
      return;
    }

    // The front drawing as a card: inverse-map each screen pixel onto the card plane and take the nearest pixel.
    const det = U[0] * V[1] - U[1] * V[0];
    const backSide = N[2] < 0;
    const k = backSide ? 1 - rig.backShade / 100 : 1;
    const T = part.thickness ?? 2;
    // The card's edge: the side whose outward direction points at the viewer. One strip per row of the drawing,
    // T pixels deep along the card's normal, coloured from the outermost pixel of that row.
    const edge = () => {
      if (T <= 0 || Math.abs(U[2]) < 0.05) return;
      const right = U[2] > 0, sk = 1 - Math.max(rig.backShade, 30) / 100;
      for (let j = 0; j < b.h; j++) {
        let xe = -1;
        if (right) { for (let x = b.w - 1; x >= 0; x--) if (A(b.data[j * b.w + x])) { xe = x + 1; break; } }
        else { for (let x = 0; x < b.w; x++) if (A(b.data[j * b.w + x])) { xe = x; break; } }
        if (xe < 0) continue;
        const c = shade(b.data[j * b.w + (right ? xe - 1 : xe)], sk);
        const e = [o[0] + U[0] * xe + V[0] * j - N[0] * T / 2, o[1] + U[1] * xe + V[1] * j - N[1] * T / 2];
        const ed2 = N[0] * V[1] - N[1] * V[0];
        if (Math.abs(ed2) < 1e-6) continue;
        const px = [e[0], e[0] + N[0] * T, e[0] + V[0], e[0] + N[0] * T + V[0]], py = [e[1], e[1] + N[1] * T, e[1] + V[1], e[1] + N[1] * T + V[1]];
        const ax = Math.max(0, Math.floor(Math.min(...px))), bx = Math.min(W - 1, Math.ceil(Math.max(...px)));
        const ay = Math.max(0, Math.floor(Math.min(...py))), by = Math.min(H - 1, Math.ceil(Math.max(...py)));
        for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
          const dx = x + 0.5 - e[0], dy = y + 0.5 - e[1];
          const s = (dx * V[1] - dy * V[0]) / ed2, t = (N[0] * dy - N[1] * dx) / ed2;
          if (s >= 0 && s < T && t >= 0 && t < 1) out[y * W + x] = c;
        }
      }
    };
    if (Math.abs(det) < 1e-3) {
      // Exactly edge-on: only the edge shows.
      jobs.push({ depth: mid[2], order, layerId: srcLayer, view: 'side', draw: edge });
      return;
    }
    const xs = [0, b.w].flatMap((u) => [0, b.h].map((vv) => o[0] + U[0] * u + V[0] * vv));
    const ys = [0, b.w].flatMap((u) => [0, b.h].map((vv) => o[1] + U[1] * u + V[1] * vv));
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    const plain = Math.abs(U[1]) < 1e-9 && Math.abs(V[0]) < 1e-9 && Math.abs(Math.abs(U[0]) - 1) < 1e-9 && Math.abs(Math.abs(V[1]) - 1) < 1e-9;
    const smp = rig.cleanEdges && !plain ? big('f:' + part.layerId, b) : b, f = smp === b ? 1 : 8;
    const backOf = backSampler(b, backModeOf(part), part.backColour ?? 0xff808080);
    jobs.push({ depth: mid[2], order, layerId: srcLayer, view: backSide ? 'back' : 'front', draw: () => {
      edge();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - o[0], dy = y + 0.5 - o[1];
        const u = (dx * V[1] - dy * V[0]) / det, vv = (U[0] * dy - U[1] * dx) / det;
        if (u < 0 || vv < 0 || u >= b.w || vv >= b.h) continue;
        // From behind, the back setting decides: paper shows the drawing mirrored, the others take colours from it.
        const c = backSide ? backOf(Math.floor(u), Math.floor(vv)) : smp.data[Math.floor(vv * f) * smp.w + Math.floor(u * f)];
        if (A(c)) out[y * W + x] = shade(c, k);
      }
    } });
  });
  // Back to front; parts at the same depth keep their layer order.
  jobs.sort((a, b) => a.depth - b.depth || a.order - b.order);
  for (const j of jobs) j.draw();
  return { image: out, parts: jobs.map((j) => ({ layerId: j.layerId, view: j.view, depth: j.depth })) };
}

/**
 * Draws a solid part. Each screen pixel casts a ray into the part's own space (u along the drawing's width, v down it,
 * z out of it towards the viewer at rest) and stops where the ray first meets the solid. The solid is either:
 * - carved: inside both the front drawing's outline and the side drawing's outline (row by row; the side view's
 *   columns run from back to front), with each row's cross-section rounded to fit both, so a nose drawn in the side
 *   view sticks out and corners aren't boxy; or
 * - a ball, tube or box, reshaped by the part's sliders (fullness, flat front, taper, lean).
 *
 * Colour: every drawing of the part (front, side, back, three-quarter) is a view from one direction. A surface point
 * takes its colour from the drawing made closest to the current camera angle, among the drawings that face that point.
 * So the camera never sees one drawing smeared across a surface turned away from it: sides wear the side drawing (or
 * the row's outline colour when there is none), corners wear the three-quarter drawing when there is one. At rest,
 * facing front, the front drawing is chosen everywhere and the part is its drawing pixel for pixel.
 */
function drawShaped(out: Uint32Array, W: number, H: number, b: Bitmap, front: PartImage, o: number[], U: number[], V: number[], N: number[], shape: PartShape, part: Part, rig: Rig, images: Map<string, PartImage>) {
  const w = b.w, h = b.h;
  const amount = (rig.shading ?? 40) / 100, backK = 1 - rig.backShade / 100;
  const backImg = part.views.back ? images.get(part.views.back) : undefined;
  const back = backImg ? cropBmp(backImg, W) : null;
  const backOf = backSampler(b, backModeOf(part), part.backColour ?? 0xff808080);

  // A drawn side view (facing right: its left is the back, its right the front) carves the part.
  const sideImg = part.views.side ? images.get(part.views.side) : undefined;
  const sideBmp = sideImg ? cropBmp(sideImg, W) : null;
  const side = shape === 'carved' ? sideBmp : null;
  // Side rows line up with front rows by their place on the canvas; z = 0 is the middle of the side drawing.
  const sideRow0 = sideImg ? front.box.y - sideImg.box.y : 0, sideZ0 = sideBmp ? sideBmp.w / 2 : 0;
  const sideAt = (v: number, z: number) => {
    if (!sideBmp) return 0;
    const r = Math.floor(v) + sideRow0, c = Math.floor(z + sideZ0);
    return r < 0 || c < 0 || r >= sideBmp.h || c >= sideBmp.w ? 0 : sideBmp.data[r * sideBmp.w + c];
  };
  const tqImg = part.views.threeq ? images.get(part.views.threeq) : undefined;
  const tq = tqImg ? cropBmp(tqImg, W) : null;
  const tqRow0 = tqImg ? front.box.y - tqImg.box.y : 0;

  // Each row's outline colours, left and right: what a side looks like when no side view is drawn.
  const rowL = new Uint32Array(h), rowR = new Uint32Array(h), rowSpan: [number, number][] = [];
  for (let j = 0; j < h; j++) {
    let l = -1, r = -1;
    for (let i = 0; i < w; i++) if (A(b.data[j * w + i])) { if (l < 0) l = i; r = i; }
    rowSpan.push([l, r]);
    if (l >= 0) { rowL[j] = b.data[j * w + l]; rowR[j] = b.data[j * w + r]; }
  }
  // Each row's most common colour: skin on a face, hair above it. Surfaces the part's chosen drawing sees too steeply
  // are filled with these plain colours rather than another drawing, which would bring a second set of eyes and mouth.
  const rowMode = new Uint32Array(h);
  for (let j = 0; j < h; j++) {
    const tally = new Map<number, number>();
    for (let i = 0; i < w; i++) { const p = b.data[j * w + i]; if (A(p)) tally.set(p, (tally.get(p) ?? 0) + 1); }
    let bn = 0;
    for (const [p, n] of tally) if (n > bn) { bn = n; rowMode[j] = p; }
  }
  // The back of a carved part with no back view drawn: each row's back-most colour in the side drawing (the hair).
  const sideBack = new Uint32Array(h);
  if (sideBmp) for (let j = 0; j < h; j++) {
    const r = j + sideRow0;
    if (r < 0 || r >= sideBmp.h) continue;
    for (let c = 0; c < sideBmp.w; c++) if (A(sideBmp.data[r * sideBmp.w + c])) { sideBack[j] = sideBmp.data[r * sideBmp.w + c]; break; }
  }

  // Carved: each row's cross-section is a rounded rectangle fitted to the front's width and the side's depth there.
  // The exponent runs from 2 (an ellipse) to 20 (nearly square corners).
  const roundness = Math.max(0, Math.min(100, part.roundCorners ?? 70)) / 100;
  const sx = 2 + (1 - roundness) * 18;
  const rowDepth: [number, number][] = [];
  if (side) for (let j = 0; j < h; j++) {
    const r = j + sideRow0;
    let zb = Infinity, zf = -Infinity;
    if (r >= 0 && r < side.h) for (let c = 0; c < side.w; c++) if (A(side.data[r * side.w + c])) { zb = Math.min(zb, c - sideZ0); zf = Math.max(zf, c + 1 - sideZ0); }
    rowDepth.push([zb, zf]);
  }

  // Analytic solids: front and back surface depth per pixel, after the sliders.
  const zF = new Float32Array(w * h), zB = new Float32Array(w * h);
  const base = shape === 'carved' ? 'box' : shape;
  const D0 = Math.max(0.5, part.depth ?? defaultDepth(base, w, h));
  const cx = w / 2, cy = h / 2, rx = Math.max(0.5, w / 2), ry = Math.max(0.5, h / 2);
  let zmin = side ? -sideZ0 : Infinity, zmax = side ? sideZ0 : -Infinity;
  if (!side) {
    const full = Math.max(-1, Math.min(1, (part.fullness ?? 0) / 100)), flat = Math.max(0, Math.min(0.95, (part.flatFront ?? 0) / 100));
    const taper = Math.max(-1, Math.min(1, (part.taper ?? 0) / 100)), lean = Math.max(-1, Math.min(1, (part.lean ?? 0) / 100));
    // Fullness bends the round profile: towards a box above 0, towards a point below 0.
    const p = 0.5 * (full >= 0 ? 1 - 0.9 * full : 1 - 2 * full);
    for (let j = 0; j < h; j++) {
      const vs = (j + 0.5) / h;
      // Taper: deeper at the top and thinner at the bottom above 0, the other way below. Lean: the top moves forward.
      const tap = Math.max(0.05, 1 + taper * (1 - 2 * vs)), off = lean * D0 * (1 - 2 * vs);
      for (let i = 0; i < w; i++) {
        const tx = (i + 0.5 - cx) / rx, ty = (j + 0.5 - cy) / ry;
        const r2 = base === 'tube' ? tx * tx : base === 'ball' ? tx * tx + ty * ty : 0;
        const prof = base === 'box' ? 1 : Math.pow(Math.max(0, 1 - r2), p);
        const d = Math.max(0.5, D0 * tap * prof);
        const f = Math.max(0.5, Math.min(d, D0 * tap * (1 - flat)));
        const k = j * w + i;
        zF[k] = off + f; zB[k] = off - d;
        if (zF[k] > zmax) zmax = zF[k];
        if (zB[k] < zmin) zmin = zB[k];
      }
    }
  }

  /** Inside a carved row's rounded cross-section (also its normal there, when asked). */
  const carvedRound = (u: number, vi: number, z: number) => {
    const [l, r] = rowSpan[vi], [zb, zf] = rowDepth[vi];
    if (l < 0 || !(zf > zb)) return -1;
    const a = (r - l + 1) / 2, uc = l + a, bb = (zf - zb) / 2, zc = zb + bb;
    return Math.pow(Math.abs((u - uc) / a), sx) + Math.pow(Math.abs((z - zc) / bb), sx);
  };

  /** 0 inside the solid; 1 outside the front outline (the ray is at a side wall); 2 outside the depth (a front or back face). */
  const test = (u: number, v: number, z: number) => {
    if (u < 0 || v < 0 || u >= w || v >= h) return 1;
    const vi = Math.floor(v), i = vi * w + Math.floor(u);
    if (!A(b.data[i])) return 1;
    if (side) {
      if (!A(sideAt(v, z))) return 2;
      const q = carvedRound(u, vi, z);
      return q >= 0 && q <= 1 ? 0 : 2;
    }
    return z <= zF[i] && z >= zB[i] ? 0 : 2;
  };

  // Screen bounds of the part's local box.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const u of [0, w]) for (const v of [0, h]) for (const z of [zmin, zmax]) {
    const qx = o[0] + U[0] * u + V[0] * v + N[0] * z, qy = o[1] + U[1] * u + V[1] * v + N[1] * z;
    x0 = Math.min(x0, qx); x1 = Math.max(x1, qx); y0 = Math.min(y0, qy); y1 = Math.max(y1, qy);
  }
  const ax = Math.max(0, Math.floor(x0)), bx = Math.min(W - 1, Math.ceil(x1)), ay = Math.max(0, Math.floor(y0)), by = Math.min(H - 1, Math.ceil(y1));
  // Moving one unit towards the viewer moves (U.z, V.z, N.z) in the part's space (the rotation is orthonormal). That is
  // also the direction to the camera, which decides which drawing is closest to this view.
  const du = U[2], dv = V[2], dz = N[2];
  const vl = Math.hypot(du, dz) || 1, viewU = du / vl, viewZ = dz / vl;
  const S2 = Math.SQRT1_2;
  // Directions the drawings were made from (in the part's space): front, back, the two sides, and the two corners.
  // The side drawing faces right, so it was seen from -u; seen from +u it is the same drawing mirrored.
  const views: { u: number; z: number; ok: boolean; key: 'front' | 'back' | 'sideL' | 'sideR' | 'tqL' | 'tqR' }[] = [
    { u: 0, z: 1, ok: true, key: 'front' }, { u: 0, z: -1, ok: true, key: 'back' },
    { u: -1, z: 0, ok: true, key: 'sideL' }, { u: 1, z: 0, ok: true, key: 'sideR' },
    { u: -S2, z: S2, ok: !!tq, key: 'tqL' }, { u: S2, z: S2, ok: !!tq, key: 'tqR' },
  ];
  const weight = views.map((d) => Math.max(0.05, d.u * viewU + d.z * viewZ));
  // The part commits to the one drawing nearest the camera, so a face shows one set of features rather than an eye
  // from one drawing and an eye from another. Other drawings only cover surfaces it sees too steeply to look right.
  let primary = 0;
  for (let k = 1; k < views.length; k++) if (views[k].ok && weight[k] > weight[primary]) primary = k;
  const STEEP = 0.35; // below this (about 70° off its own direction) a drawing would be visibly smeared

  // When the front is squeezed (turned away), one screen pixel covers several of its columns. Picking just one would
  // drop small features at random, so a feature among the covered columns wins over the row's plain colours.
  const squeeze = 1 / Math.max(0.15, Math.hypot(U[0], U[1]));
  const reach = squeeze > 1.3 ? Math.ceil((squeeze - 1) / 2) : 0;
  const plain = (c: number, j: number) => c === rowMode[j] || c === rowL[j] || c === rowR[j];
  const colourFrom = (key: string, u: number, v: number, z: number, ui: number, vi: number): number => {
    switch (key) {
      case 'front': {
        const c0 = b.data[vi * w + ui];
        if (!reach || !plain(c0, vi)) return c0;
        // Only the screen pixel whose centre falls nearest a feature column takes it, so features keep their size.
        for (let k = 1; k <= reach; k++) for (const i of [ui - k, ui + k]) {
          if (i < 0 || i >= w || Math.abs(i + 0.5 - u) > squeeze / 2) continue;
          const c = b.data[vi * w + i];
          if (A(c) && !plain(c, vi)) return c;
        }
        return c0;
      }
      case 'sideL': case 'sideR': {
        if (sideBmp) return sideAt(v, z);
        return key === 'sideL' ? rowL[vi] : rowR[vi];
      }
      case 'tqL': case 'tqR': {
        // The three-quarter drawing as seen from 45° to the front right (mirrored for the left): its columns run along
        // the line that view looks across.
        const t = tq!, r = vi + tqRow0;
        if (r < 0 || r >= t.h) return 0;
        const across = key === 'tqL' ? (u - cx) * S2 + z * S2 : (u - cx) * S2 - z * S2;
        let c = Math.floor(across + t.w / 2);
        if (key === 'tqR') c = t.w - 1 - c;
        return c < 0 || c >= t.w ? 0 : t.data[r * t.w + c];
      }
      default: {
        if (back) {
          // A back view is drawn as seen from behind: its left is the drawing's right.
          const bu = Math.min(back.w - 1, Math.max(0, Math.floor(((w - u) / w) * back.w))), bv = Math.min(back.h - 1, Math.max(0, Math.floor((v / h) * back.h)));
          return back.data[bv * back.w + bu];
        }
        if (sideBmp && !part.backMode && A(sideBack[vi])) return shade(sideBack[vi], backK);
        return shade(backOf(ui, vi), backK);
      }
    }
  };

  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    const px = x + 0.5 - o[0], py = y + 0.5 - o[1], pz = -o[2];
    const qu = U[0] * px + U[1] * py + U[2] * pz, qv = V[0] * px + V[1] * py + V[2] * pz, qz = N[0] * px + N[1] * py + N[2] * pz;
    // The stretch of the ray inside the part's box, as a range of s (distance towards the viewer).
    let lo = -Infinity, hi = Infinity;
    const slab = (q: number, d: number, a: number, c: number) => {
      if (Math.abs(d) < 1e-9) { if (q < a || q > c) { lo = Infinity; } return; }
      let s0 = (a - q) / d, s1 = (c - q) / d;
      if (s0 > s1) [s0, s1] = [s1, s0];
      lo = Math.max(lo, s0); hi = Math.min(hi, s1);
    };
    slab(qu, du, 0, w); slab(qv, dv, 0, h); slab(qz, dz, zmin, zmax);
    if (lo > hi) continue;
    // March from the viewer's side, then narrow down onto the surface.
    let prev = hi + 0.5, hit = NaN;
    for (let s = hi; s >= lo - 1e-6; s -= 0.5) {
      if (test(qu + du * s, qv + dv * s, qz + dz * s) === 0) { hit = s; break; }
      prev = s;
    }
    if (Number.isNaN(hit)) continue;
    let a2 = hit, b2 = prev;
    for (let k = 0; k < 6; k++) { const m = (a2 + b2) / 2; if (test(qu + du * m, qv + dv * m, qz + dz * m) === 0) a2 = m; else b2 = m; }
    const u = qu + du * a2, v = qv + dv * a2, z = qz + dz * a2;
    const uo = qu + du * b2, vo = qv + dv * b2, zo = qz + dz * b2;
    const why = test(uo, vo, zo);
    const ui = Math.min(w - 1, Math.max(0, Math.floor(u))), vi = Math.min(h - 1, Math.max(0, Math.floor(v)));

    // The surface's outward direction here.
    let nu = 0, nv = 0, nz = 0;
    if (side && why === 2) {
      const [l, r] = rowSpan[vi], [zb, zf] = rowDepth[vi];
      const a = (r - l + 1) / 2, bb = Math.max(0.5, (zf - zb) / 2);
      const tu = (u - (l + a)) / a, tz = (z - (zb + bb)) / bb;
      nu = Math.sign(tu) * Math.pow(Math.abs(tu), sx - 1) / a; nz = Math.sign(tz) * Math.pow(Math.abs(tz), sx - 1) / bb;
      if (!nu && !nz) nz = Math.sign(zo - z) || 1;
    } else if (why === 1) {
      if (Math.floor(uo) !== Math.floor(u) || Math.abs(du) >= Math.abs(dv)) nu = Math.sign(uo - u) || 1; else nv = Math.sign(vo - v) || 1;
    } else if (!side && base !== 'box') {
      nu = (u - cx) / (rx * rx); nv = base === 'ball' ? (v - cy) / (ry * ry) : 0;
      nz = (Math.sign(zo - z) || 1) * Math.max(Math.abs(z), 0.25) / (D0 * D0);
    } else nz = Math.sign(zo - z) || 1;
    const nl = Math.hypot(nu, nz) || 1, hu = nu / nl, hz = nz / nl;

    // The part's chosen drawing where it sees this point well; otherwise the best drawing that faces this point.
    let best = -1, bestScore = -Infinity, c = 0;
    const pd = views[primary], pf = hu * pd.u + hz * pd.z;
    if (pf >= STEEP || (primary === 0 && hz >= 0 && why !== 1 && pf > 0)) {
      const cc = colourFrom(pd.key, u, v, z, ui, vi);
      if (A(cc)) { best = primary; c = cc; }
    }
    if (best < 0) for (let k = 0; k < views.length; k++) {
      const d = views[k];
      if (!d.ok) continue;
      const facing = hu * d.u + hz * d.z;
      if (facing <= 1e-6 && !(k === 0 && hz >= 0 && why !== 1)) continue;
      const score = Math.max(facing, 0.01) * weight[k];
      if (score > bestScore) {
        // Filling in: the chosen drawing itself, the back, or plain row colours. Never a second detailed drawing.
        let cc = k === primary || d.key === 'back' ? colourFrom(d.key, u, v, z, ui, vi)
          : d.key === 'sideL' ? rowL[vi] : d.key === 'sideR' ? rowR[vi] : rowMode[vi];
        // A feature of the chosen drawing (an eye, a mouth: anything not its row's usual colour) stays wherever that
        // drawing can still see the point, even steeply, so faces don't lose their eyes half-way round.
        if (k !== primary && pf > 0.02) {
          const fp = colourFrom(pd.key, u, v, z, ui, vi);
          if (A(fp) && fp !== rowMode[vi] && fp !== rowL[vi] && fp !== rowR[vi]) cc = fp;
        }
        if (A(cc)) { best = k; bestScore = score; c = cc; }
      }
    }
    if (best < 0) c = b.data[vi * w + ui];

    if (amount > 0) {
      const l = Math.hypot(nu, nv, nz) || 1;
      // The normal's component towards the viewer: the screen z of M·n.
      const toward = Math.max(0, (U[2] * nu + V[2] * nv + N[2] * nz) / l);
      // Three bands, as pixel artists shade: each colour gains at most two darker steps, never a smear of near-copies.
      // A surface turned up to about 50° from you stays fully lit. Each band is flat colour; only a narrow strip at a
      // band's edge is mixed with an ordered dither (fixed to the screen), so the edge fades instead of splitting.
      const edgeBand = (t: number, at: number) => {
        const f = (at + 0.06 - t) / 0.12; // 0 just above the edge, 1 just below
        return f <= 0 ? 0 : f >= 1 ? 1 : f > ditherThreshold('bayer4', x, y) ? 1 : 0;
      };
      const band = edgeBand(toward, 0.6) + edgeBand(toward, 0.3);
      c = shade(c, band === 0 ? 1 : band === 1 ? 1 - amount * 0.5 : 1 - amount);
    }
    if (A(c)) out[y * W + x] = c;
  }
}

// ---- Building and animating

/** A first rig: every visible image layer becomes a part on its own bone, jointed at the middle of its art. */
export function rigFromLayers(layers: { id: string; name: string }[], boxes: Map<string, { x: number; y: number; w: number; h: number }>, newId: (p: string) => string): Rig {
  const bones: Bone[] = [], parts: Part[] = [];
  let cx = 0, cy = 0, n = 0;
  layers.forEach((l, i) => {
    const b = boxes.get(l.id);
    if (!b) return;
    const id = newId('b');
    const shape = guessShape(l.name, b.w, b.h);
    // Limbs swing from their top (shoulder, hip); everything else turns about its middle.
    const top = shape === 'tube' ? b.y + Math.min(b.w / 2, b.h / 4) : b.y + b.h / 2;
    bones.push({ id, name: l.name, parent: null, head: { x: b.x + b.w / 2, y: top, z: i } });
    parts.push({ layerId: l.id, boneId: id, z: i, views: {}, mirrorBack: true, shape });
    cx += b.x + b.w / 2; cy += b.y + b.h / 2; n++;
  });
  return { bones, parts, tracks: {}, centre: { x: n ? cx / n : 0, y: n ? cy / n : 0, z: 0 }, backShade: 25, cleanEdges: true, shading: 40 };
}

/** The pose at a frame from the keyframes. Bones without keys rest at 0. */
export function poseAt(doc: Doc, rig: Rig, frame: number, extraView?: { rx?: number; ry?: number }): Pose {
  const pose: Pose = {};
  for (const id of [...rig.bones.map((b) => b.id), VIEW_BONE]) {
    const t = rig.tracks[id] ?? {};
    pose[id] = {
      rx: sampleKeys(liveKeys(doc, t.rx), frame, 0), ry: sampleKeys(liveKeys(doc, t.ry), frame, 0), rz: sampleKeys(liveKeys(doc, t.rz), frame, 0),
    };
  }
  if (extraView) pose[VIEW_BONE] = { ...pose[VIEW_BONE], rx: pose[VIEW_BONE].rx + (extraView.rx ?? 0), ry: pose[VIEW_BONE].ry + (extraView.ry ?? 0) };
  return pose;
}

/** Sets a bone's angle at a frame, adding the key there (and a resting key at frame 0 for a track's first key). */
export function setRigKey(doc: Doc, rig: Rig, boneId: string, axis: Axis, frame: number, v: number): Rig {
  const f = doc.frames[frame].id;
  const keys = [...(rig.tracks[boneId]?.[axis] ?? [])];
  if (!liveKeys(doc, keys).length && frame !== 0) keys.push({ f: doc.frames[0].id, v: 0, ease: 'in-out-sine' });
  const at = keys.findIndex((k) => k.f === f);
  if (at >= 0) keys[at] = { ...keys[at], v }; else keys.push({ f, v, ease: 'in-out-sine' });
  return { ...rig, tracks: { ...rig.tracks, [boneId]: { ...(rig.tracks[boneId] ?? {}), [axis]: keys } } };
}

export function clearRigKeys(doc: Doc, rig: Rig, boneId: string, frame: number): Rig {
  const f = doc.frames[frame].id, t = rig.tracks[boneId];
  if (!t) return rig;
  const n: Partial<Record<Axis, Key[]>> = {};
  for (const a of ['rx', 'ry', 'rz'] as Axis[]) { const k = (t[a] ?? []).filter((x) => x.f !== f); if (k.length) n[a] = k; }
  return { ...rig, tracks: { ...rig.tracks, [boneId]: n } };
}

/** Frames holding any rig key. */
export function rigKeyFrames(doc: Doc, rig: Rig): Set<number> {
  const s = new Set<number>();
  for (const t of Object.values(rig.tracks)) for (const keys of Object.values(t)) for (const k of liveKeys(doc, keys)) s.add(k.i);
  return s;
}

/** Camera turns for a turnaround: `frames` angles over a full circle, without repeating the first. */
export const turnaround = (frames: number, ease = easeFn('linear')) => Array.from({ length: Math.max(1, frames) }, (_, i) => 360 * ease(i / Math.max(1, frames)));

/** Whether a bone may take a parent without making a loop. */
export function canParent(rig: Rig, boneId: string, parent: string | null): boolean {
  let p = parent;
  for (let guard = 0; p && guard < 256; guard++) { if (p === boneId) return false; p = rig.bones.find((b) => b.id === p)?.parent ?? null; }
  return true;
}
