// The tools. Each is an object of pointer handlers that write through the editor's Surface. A tool is registered in one
// line, and plugins will be able to add their own the same way.
import { A, B, G, R, nearestIndex, rgba } from '../core/color';
import { contentBounds } from '../core/doc';
import * as Ras from '../core/raster';
import * as Dyn from '../core/dynamics';
import { outlineSegments } from '../core/selection';
import type { Surface } from '../core/surface';
import { placedBounds } from '../core/transform';
import { celKey, rectUnion, type Pixel, type Rect } from '../core/types';
import { ed, emptyMask } from './editor';

export interface Pointer {
  x: number; y: number;
  /** Position in canvas pixels with fractions. */
  fx: number; fy: number;
  button: number;
  shift: boolean; ctrl: boolean; alt: boolean;
  pressure: number;
  /** A pen or stylus: only then is `pressure` meaningful (a mouse reports 0.5 while pressed). */
  pen?: boolean;
  /** Size of one canvas pixel on screen. */
  zoom: number;
}

export interface Overlay {
  /** Canvas to screen. */
  sx: (x: number) => number; sy: (y: number) => number; zoom: number;
  ctx: CanvasRenderingContext2D;
}

export interface Tool {
  id: string;
  label: string;
  key?: string;
  group: 'draw' | 'shape' | 'fill' | 'select' | 'view';
  /** Which settings to show in the options bar. */
  options: string[];
  cursor?: string;
  /** Show the brush footprint under the mouse. */
  showsBrush?: boolean;
  hint?: string;
  down?(p: Pointer): void;
  move?(p: Pointer): void;
  up?(p: Pointer): void;
  /** Mouse moving with no button held. */
  hover?(p: Pointer): void;
  /** Commits anything half-finished (the polygon's points). */
  finish?(): void;
  cancel?(): void;
  overlay?(o: Overlay): void;
}

export const tools: Tool[] = [];
const byId = new Map<string, Tool>();
export const registerTool = (t: Tool) => { tools.push(t); byId.set(t.id, t); };
export const toolById = (id: string) => byId.get(id);
export const activeTool = () => toolById(ed.tempTool ?? ed.toolId)!;

const colorFor = (p: Pointer): Pixel => (p.button === 2 ? ed.bg : ed.fg);

/** Runs a plot through the symmetry settings. Mirrored points use the axis between pixels. */
function symPlot(fn: Ras.Plot): Ras.Plot {
  const { x: sx, y: sy, cx, cy } = ed.sym;
  if (!sx && !sy) return fn;
  return (x, y) => {
    fn(x, y);
    const mx = 2 * cx - 1 - x, my = 2 * cy - 1 - y;
    if (sx) fn(mx, y);
    if (sy) fn(x, my);
    if (sx && sy) fn(mx, my);
  };
}

/** Snaps a position to the tile grid when snapping is on. */
function snapPoint(p: { x: number; y: number }): { x: number; y: number } {
  const g = ed.doc.grid;
  if (!g.snap || !g.showTile) return p;
  return {
    x: Math.round((p.x - g.offX) / g.tileW) * g.tileW + g.offX,
    y: Math.round((p.y - g.offY) / g.tileH) * g.tileH + g.offY,
  };
}

const applyColor = (c: Pixel) => {
  // The brush's opacity scales whatever colour is used, except in indexed mode where every pixel must be a palette colour.
  if (ed.doc.colorMode === 'indexed') return c;
  const a = Math.round((A(c) * ed.brush.opacity) / 255);
  return rgba(R(c), G(c), B(c), a);
};

// ---- Freehand drawing, shared by every brush-like tool

type Ink = (s: Surface, x: number, y: number, color: Pixel, p: Pointer) => void;

function bitmapOffsets(bmp: { w: number; h: number; data: Uint32Array }) {
  const out: { x: number; y: number; c: number }[] = [];
  const ox = Math.floor(bmp.w / 2), oy = Math.floor(bmp.h / 2);
  for (let y = 0; y < bmp.h; y++) for (let x = 0; x < bmp.w; x++) {
    const c = bmp.data[y * bmp.w + x];
    if (A(c)) out.push({ x: x - ox, y: y - oy, c });
  }
  return out;
}

function brushOffsets() {
  const b = ed.brush;
  if (b.custom) return bitmapOffsets(b.custom);
  return Ras.brushOffsets(b.size, b.shape).map((o) => ({ ...o, c: 0 }));
}

function makeFreehand(id: string, label: string, key: string | undefined, options: string[], ink: Ink, undoLabel: string, hint?: string): Tool {
  let surf: Surface | null = null;
  let last: { x: number; y: number } | null = null;
  let path: Ras.Pt[] = [];
  let counts = new Map<number, number>();
  let offsets: { x: number; y: number; c: number }[] = [];
  let color = 0;
  let pp = false;
  // Animated brush: one offset list per image, and a count of dabs laid so far in this stroke.
  let animSets: { x: number; y: number; c: number }[][] | null = null;
  let dabs = 0;
  // Live brush: decides where dabs fall and how each one varies. Null when dynamics are off.
  let planner: Dyn.DabPlanner | null = null;
  const sized = new Map<number, { x: number; y: number; c: number }[]>();
  const W = () => ed.doc.width;

  const stamp = (x: number, y: number, p: Pointer) => {
    let dab: Dyn.Dab | null = null;
    if (planner) {
      dab = planner.next(x, y, p.pressure, p.pen);
      if (!dab) return;
      x = dab.x; y = dab.y;
    }
    let use = offsets;
    if (animSets) {
      const n = animSets.length, b = ed.brush;
      const i = b.animMode === 'frame' ? ed.s.frame % n : Math.floor(dabs / Math.max(1, b.animEvery)) % n;
      use = animSets[i];
      dabs++;
    } else if (dab && !ed.brush.custom && dab.size !== ed.brush.size) {
      let s = sized.get(dab.size);
      if (!s) { s = Ras.brushOffsets(dab.size, ed.brush.shape).map((o) => ({ ...o, c: 0 })); sized.set(dab.size, s); }
      use = s;
    }
    if (dab) use = Dyn.turnOffsets(use, dab.quarter, dab.flip);
    const shift = !!dab && (dab.hue !== 0 || dab.value !== 0);
    const plot = symPlot((px, py) => {
      for (const o of use) {
        // A colour brush carries its own colours; everything else inks with the current colour.
        let c = o.c && ed.brush.customColors ? applyColor(o.c) : color;
        if (shift) c = ed.snap(Dyn.shiftColor(c, dab!.hue, dab!.value));
        ink(surf!, px + o.x, py + o.y, c, p);
      }
    });
    plot(x, y);
  };

  const pixelStep = (x: number, y: number, p: Pointer) => {
    path.push({ x, y });
    const k = y * W() + x;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    stamp(x, y, p);
    const corner = Ras.pixelPerfectCorner(path);
    if (corner >= 0) {
      const c = path[corner];
      path.splice(corner, 1);
      const ck = c.y * W() + c.x, n = (counts.get(ck) ?? 1) - 1;
      counts.set(ck, n);
      if (n <= 0) symPlot((px, py) => surf!.restore(px, py))(c.x, c.y);
    }
  };

  return {
    id, label, key, group: 'draw', options, showsBrush: true, hint, cursor: 'crosshair',
    down(p) {
      surf = ed.beginSurface();
      if (!surf) return;
      offsets = brushOffsets();
      animSets = ed.brush.anim && ed.brush.custom ? ed.brush.anim.map(bitmapOffsets) : null;
      dabs = 0;
      const dyn = ed.brush.dyn;
      planner = dyn.on ? new Dyn.DabPlanner(dyn, ed.brush.size, (Date.now() ^ (p.x * 73856093) ^ (p.y * 19349663)) >>> 0) : null;
      color = applyColor(colorFor(p));
      pp = ed.brush.pixelPerfect && ed.brush.size === 1 && !ed.brush.custom && !planner;
      path = []; counts = new Map();
      if (p.shift && lastStrokeEnd && !ed.s.editMask) {
        // Shift-click draws a straight line from where the last stroke ended.
        Ras.line(lastStrokeEnd.x, lastStrokeEnd.y, p.x, p.y, (x, y) => stamp(x, y, p));
      } else if (pp) pixelStep(p.x, p.y, p);
      else stamp(p.x, p.y, p);
      last = { x: p.x, y: p.y };
    },
    move(p) {
      if (!surf || !last) return;
      if (p.x === last.x && p.y === last.y) return;
      Ras.line(last.x, last.y, p.x, p.y, (x, y) => {
        if (x === last!.x && y === last!.y) return;
        if (pp) pixelStep(x, y, p); else stamp(x, y, p);
      });
      last = { x: p.x, y: p.y };
    },
    up() {
      if (!surf) return;
      lastStrokeEnd = last;
      ed.endSurface(undoLabel);
      surf = null; last = null;
    },
    cancel() { if (surf) { ed.cancelSurface(); surf = null; last = null; } },
  };
}

let lastStrokeEnd: { x: number; y: number } | null = null;

registerTool(makeFreehand('pencil', 'Pencil', 'b', ['brush', 'opacity', 'pixelPerfect'],
  (s, x, y, c) => s.paint(x, y, c), 'Draw', 'Right button draws in the background colour. Shift-click continues with a straight line.'));

registerTool(makeFreehand('eraser', 'Eraser', 'e', ['brush', 'opacity', 'pixelPerfect'],
  (s, x, y) => s.erase(x, y, ed.brush.opacity), 'Erase', 'On a layer mask this reveals the layer again.'));

registerTool(makeFreehand('dither', 'Dither brush', 'd', ['brush', 'dither', 'density'],
  (s, x, y, c) => {
    const b = ed.brush;
    if (Ras.ditherThreshold(b.ditherKind, x, y) < b.density) s.paint(x, y, c);
    else if (b.ditherBg) s.paint(x, y, ed.bg);
  }, 'Dither', 'Paints a pattern. Density sets how much is filled; turn on Fill gaps to use the background colour between dots.'));

registerTool(makeFreehand('pattern', 'Pattern brush', 'k', ['brush', 'patternPick'],
  (s, x, y, c) => {
    const pat = ed.brush.pattern;
    if (!pat) { s.paint(x, y, c); return; }
    const px = ((x % pat.w) + pat.w) % pat.w, py = ((y % pat.h) + pat.h) % pat.h;
    const col = pat.data[py * pat.w + px];
    if (A(col)) s.paint(x, y, col);
  }, 'Paint pattern', 'Select some pixels and use Set pattern from selection. Paints that image, repeating across the canvas.'));

registerTool(makeFreehand('shade', 'Shade brush', 'j', ['brush', 'shade'],
  (s, x, y, _c, p) => {
    // Steps a pixel along the palette, once per stroke: the classic way to shade inside a ramp.
    const base = s.getBase(x, y);
    if (!A(base) || !ed.doc.palette.length) return;
    const pal = ed.doc.palette;
    const step = p.button === 2 ? -ed.brush.shadeStep : ed.brush.shadeStep;
    const i = nearestIndex(base, pal);
    const n = Math.max(0, Math.min(pal.length - 1, i + step));
    s.set(x, y, ((pal[n] & 0xffffff) | (base & 0xff000000)) >>> 0);
  }, 'Shade', 'Moves pixels along the palette: left button forward, right button back. Order your palette as ramps.'));

// ---- Shapes with a live preview

interface ShapeOpts { id: string; label: string; key: string; draw(a: Ras.Pt, b: Ras.Pt, filled: boolean, plot: Ras.Plot, p: Pointer): void; constrain(a: Ras.Pt, b: Ras.Pt, p: Pointer): Ras.Pt; undo: string; canFill: boolean; hint: string }

function makeShape(o: ShapeOpts): Tool {
  let surf: Surface | null = null, a: Ras.Pt | null = null, color = 0;
  let offsets: { x: number; y: number; c: number }[] = [];
  const redraw = (p: Pointer) => {
    if (!surf || !a) return;
    let b = snapPoint({ x: p.x, y: p.y });
    b = o.constrain(a, b, p);
    surf.reset();
    let from = a;
    if (p.alt) {
      // Alt draws from the centre out.
      from = { x: a.x - (b.x - a.x), y: a.y - (b.y - a.y) };
    }
    const filled = o.canFill && ed.shape.filled;
    const plot = symPlot((x, y) => {
      if (filled) { surf!.paint(x, y, color); return; }
      for (const d of offsets) surf!.paint(x + d.x, y + d.y, color);
    });
    o.draw(from, b, filled, plot, p);
  };
  return {
    id: o.id, label: o.label, key: o.key, group: 'shape', cursor: 'crosshair', showsBrush: true, hint: o.hint,
    options: o.canFill ? ['brush', 'opacity', 'filled'] : ['brush', 'opacity'],
    down(p) {
      surf = ed.beginSurface();
      if (!surf) return;
      color = applyColor(colorFor(p));
      offsets = Ras.brushOffsets(ed.brush.size, ed.brush.shape).map((d) => ({ ...d, c: 0 }));
      a = snapPoint({ x: p.x, y: p.y });
      redraw(p);
    },
    move(p) { redraw(p); },
    up(p) { if (!surf) return; redraw(p); ed.endSurface(o.undo); surf = null; a = null; },
    cancel() { if (surf) { ed.cancelSurface(); surf = null; a = null; } },
  };
}

const square = (a: Ras.Pt, b: Ras.Pt, p: Pointer): Ras.Pt => {
  if (!p.shift) return b;
  const m = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return { x: a.x + Math.sign(b.x - a.x || 1) * m, y: a.y + Math.sign(b.y - a.y || 1) * m };
};

registerTool(makeShape({
  id: 'line', label: 'Line', key: 'l', undo: 'Draw line', canFill: false,
  hint: 'Shift locks to straight, 45° and 2:1 isometric angles. With an isometric grid and snapping on, every line follows them.',
  constrain: (a, b, p) => (p.shift || (ed.doc.grid.iso !== 'off' && ed.doc.grid.snap) ? Ras.constrainLine(a.x, a.y, b.x, b.y) : b),
  draw: (a, b, _f, plot) => Ras.line(a.x, a.y, b.x, b.y, plot),
}));
registerTool(makeShape({
  id: 'rect', label: 'Rectangle', key: 'u', undo: 'Draw rectangle', canFill: true, hint: 'Shift makes a square. Alt draws from the centre.', constrain: square,
  draw: (a, b, f, plot) => (f ? Ras.rectFill : Ras.rectOutline)(a.x, a.y, b.x, b.y, plot),
}));
registerTool(makeShape({
  id: 'ellipse', label: 'Ellipse', key: 'o', undo: 'Draw ellipse', canFill: true, hint: 'Shift makes a circle. Alt draws from the centre.', constrain: square,
  draw: (a, b, f, plot) => (f ? Ras.ellipseFill : Ras.ellipseOutline)(a.x, a.y, b.x, b.y, plot),
}));

// ---- Polygon: click to place points, double-click, click the first point, or Enter to finish

{
  let pts: Ras.Pt[] = [], cur: Ras.Pt | null = null, button = 0;
  const finish = () => {
    if (pts.length >= 2) {
      const surf = ed.beginSurface();
      if (surf) {
        const color = applyColor(button === 2 ? ed.bg : ed.fg);
        const offs = Ras.brushOffsets(ed.brush.size, ed.brush.shape);
        const filled = ed.shape.filled;
        const plot = symPlot((x, y) => { if (filled) surf.paint(x, y, color); else for (const d of offs) surf.paint(x + d.x, y + d.y, color); });
        if (filled) Ras.polygonFill(pts, plot); else Ras.polygonOutline(pts, plot, true);
        ed.endSurface('Draw polygon');
      }
    }
    pts = []; cur = null;
    ed.toolFinish = null;
    ed.notify();
  };
  registerTool({
    id: 'polygon', label: 'Polygon', key: 'y', group: 'shape', cursor: 'crosshair', options: ['brush', 'opacity', 'filled'], showsBrush: true,
    hint: 'Click to place points. Finish by clicking the first point or pressing Enter; Esc cancels.',
    down(p) {
      button = p.button;
      const q = snapPoint({ x: p.x, y: p.y });
      if (pts.length >= 2 && Math.abs(q.x - pts[0].x) <= 1 && Math.abs(q.y - pts[0].y) <= 1) { finish(); return; }
      pts.push(q); cur = q;
      ed.toolFinish = finish;
      ed.notify();
    },
    hover(p) { if (pts.length) { cur = { x: p.x, y: p.y }; ed.notify(); } },
    move(p) { if (pts.length) { cur = { x: p.x, y: p.y }; ed.notify(); } },
    finish,
    cancel() { pts = []; cur = null; ed.toolFinish = null; ed.notify(); },
    overlay({ ctx, sx, sy, zoom }) {
      if (!pts.length) return;
      ctx.save();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      pts.forEach((q, i) => { const X = sx(q.x + 0.5), Y = sy(q.y + 0.5); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
      if (cur) ctx.lineTo(sx(cur.x + 0.5), sy(cur.y + 0.5));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffcf4a';
      const r = Math.max(3, zoom * 0.3);
      for (const q of pts) ctx.fillRect(sx(q.x + 0.5) - r, sy(q.y + 0.5) - r, r * 2, r * 2);
      ctx.restore();
    },
  });
}

// ---- Fills

registerTool({
  id: 'bucket', label: 'Bucket fill', key: 'g', group: 'fill', cursor: 'crosshair', options: ['tolerance', 'contiguous', 'sampleAll', 'opacity'],
  hint: 'Contiguous fills the connected area; turn it off to replace that colour everywhere on the layer.',
  down(p) {
    if (p.x < 0 || p.y < 0 || p.x >= ed.doc.width || p.y >= ed.doc.height) return;
    const surf = ed.beginSurface();
    if (!surf) return;
    const d = ed.doc, f = ed.fill;
    const source = f.sampleAll ? ed.sampleBuffer(true) : surf.canvasCopy();
    const mask = Ras.floodMask(source, d.width, d.height, p.x, p.y, f.tolerance, f.contiguous);
    const color = applyColor(colorFor(p));
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
      if (mask[y * d.width + x]) { if (A(color)) surf.paint(x, y, color); else surf.erase(x, y); }
    }
    ed.endSurface('Fill');
  },
});

{
  let surf: Surface | null = null, a: Ras.Pt | null = null, b: Ras.Pt | null = null, button = 0;
  /** The colours a gradient runs through: two ends, or the palette entries between them. */
  const stops = (): Pixel[] => {
    const g = ed.gradient;
    const from = button === 2 ? ed.bg : ed.fg, to = button === 2 ? ed.fg : ed.bg;
    if (g.end === 'transparent') return [from, (from & 0xffffff) >>> 0];
    if (g.end === 'palette') {
      const pal = ed.doc.palette;
      const i = nearestIndex(from, pal), j = nearestIndex(to, pal);
      const list = i <= j ? pal.slice(i, j + 1) : pal.slice(j, i + 1).reverse();
      if (list.length >= 2) return list;
    }
    return [from, to];
  };
  const draw = () => {
    if (!surf || !a || !b) return;
    surf.reset();
    const d = ed.doc, g = ed.gradient, list = stops();
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1, len = Math.sqrt(len2);
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
      const t0 = g.kind === 'linear' ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : Math.hypot(x - a.x, y - a.y) / len;
      const t = Math.max(0, Math.min(1, t0)) * (list.length - 1);
      let i = Math.floor(t);
      const frac = t - i;
      if (frac > Ras.ditherThreshold(g.dither, x, y)) i++;
      const c = list[Math.min(i, list.length - 1)];
      if (A(c)) surf.paint(x, y, c);
    }
  };
  registerTool({
    id: 'gradient', label: 'Gradient', key: 'n', group: 'fill', cursor: 'crosshair', options: ['gradient'],
    hint: 'Drag from start to end. Stays within the selection. Palette mode steps through the palette entries between your two colours.',
    down(p) {
      surf = ed.beginSurface();
      if (!surf) return;
      button = p.button; a = { x: p.x, y: p.y }; b = { x: p.x, y: p.y };
      draw();
    },
    move(p) {
      if (!surf) return;
      b = p.shift ? Ras.constrainLine(a!.x, a!.y, p.x, p.y) : { x: p.x, y: p.y };
      draw();
    },
    up() { if (!surf) return; ed.endSurface('Gradient'); surf = null; a = b = null; ed.notify(); },
    cancel() { if (surf) { ed.cancelSurface(); surf = null; a = b = null; } },
    overlay({ ctx, sx, sy }) {
      if (!a || !b) return;
      ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(sx(a.x + 0.5), sy(a.y + 0.5)); ctx.lineTo(sx(b.x + 0.5), sy(b.y + 0.5)); ctx.stroke();
      ctx.restore();
    },
  });
}

registerTool({
  id: 'replace', label: 'Colour replace', key: 'r', group: 'fill', cursor: 'crosshair', options: ['tolerance'],
  hint: 'Click a colour to swap it for the foreground colour on this cel. Sprite › Replace colour can cover the whole sprite.',
  down(p) {
    const from = ed.sample(p.x, p.y, false);
    if (!A(from)) { ed.toast('Click on a pixel of the active layer.'); return; }
    ed.replaceColor(from, colorFor(p), ed.fill.tolerance, 'cel');
  },
});

registerTool({
  id: 'eyedropper', label: 'Eyedropper', key: 'i', group: 'fill', cursor: 'crosshair', options: ['sampleAll'],
  hint: 'Picks a colour. Hold Alt with any drawing tool to use it for a moment. Right button sets the background colour.',
  down(p) { pick(p); },
  move(p) { pick(p); },
});

function pick(p: Pointer) {
  const c = ed.sample(p.x, p.y, ed.fill.sampleAll);
  if (!A(c)) return;
  if (p.button === 2) ed.setBg(c); else ed.setFg(c);
}

// ---- Selection tools

/** Which way a new selection combines, from the option or the keys held. */
const selectMode = (p: Pointer) => {
  if (p.shift && p.alt) return 'intersect' as const;
  if (p.shift) return 'add' as const;
  if (p.alt) return 'subtract' as const;
  return ed.select.mode;
};

function makeDragSelect(id: string, label: string, key: string, fillMask: (a: Ras.Pt, b: Ras.Pt, plot: Ras.Plot) => void, pathOf: (a: Ras.Pt, b: Ras.Pt, ctx: CanvasRenderingContext2D, sx: (n: number) => number, sy: (n: number) => number) => void): Tool {
  let a: Ras.Pt | null = null, b: Ras.Pt | null = null;
  return {
    id, label, key, group: 'select', cursor: 'crosshair', options: ['selectMode'],
    hint: 'Shift adds, Alt subtracts, both intersect. A click with no drag deselects.',
    down(p) { ed.endActiveEdit(); a = { x: p.x, y: p.y }; b = a; },
    move(p) { if (a) { b = p.shift && !p.alt && !ed.doc.selection ? square(a, { x: p.x, y: p.y }, p) : { x: p.x, y: p.y }; ed.notify(); } },
    up(p) {
      if (!a || !b) return;
      const mode = selectMode(p);
      if (a.x === b.x && a.y === b.y && mode === 'replace') ed.deselect();
      else {
        const d = ed.doc, m = emptyMask(d);
        fillMask(a, b, (x, y) => { if (x >= 0 && y >= 0 && x < d.width && y < d.height) m[y * d.width + x] = 255; });
        ed.applySelectionMask(m, mode);
      }
      a = b = null;
    },
    cancel() { a = b = null; ed.notify(); },
    overlay({ ctx, sx, sy }) {
      if (!a || !b) return;
      ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); pathOf(a, b, ctx, sx, sy); ctx.stroke();
      ctx.strokeStyle = '#000'; ctx.lineDashOffset = 4; ctx.stroke();
      ctx.restore();
    },
  };
}

const boxOf = (a: Ras.Pt, b: Ras.Pt) => ({ l: Math.min(a.x, b.x), t: Math.min(a.y, b.y), r: Math.max(a.x, b.x) + 1, b: Math.max(a.y, b.y) + 1 });

registerTool(makeDragSelect('select-rect', 'Rectangle select', 'm', (a, b, plot) => Ras.rectFill(a.x, a.y, b.x, b.y, plot), (a, b, ctx, sx, sy) => {
  const q = boxOf(a, b);
  ctx.rect(sx(q.l), sy(q.t), sx(q.r) - sx(q.l), sy(q.b) - sy(q.t));
}));
registerTool(makeDragSelect('select-ellipse', 'Ellipse select', 'shift+m', (a, b, plot) => Ras.ellipseFill(a.x, a.y, b.x, b.y, plot), (a, b, ctx, sx, sy) => {
  const q = boxOf(a, b);
  ctx.ellipse((sx(q.l) + sx(q.r)) / 2, (sy(q.t) + sy(q.b)) / 2, (sx(q.r) - sx(q.l)) / 2, (sy(q.b) - sy(q.t)) / 2, 0, 0, Math.PI * 2);
}));

{
  let pts: Ras.Pt[] = [];
  registerTool({
    id: 'lasso', label: 'Lasso select', key: 'q', group: 'select', cursor: 'crosshair', options: ['selectMode'],
    hint: 'Draw around an area; it closes by itself. Shift adds, Alt subtracts.',
    down(p) { ed.endActiveEdit(); pts = [{ x: p.x, y: p.y }]; },
    move(p) { if (pts.length) { const l = pts[pts.length - 1]; if (l.x !== p.x || l.y !== p.y) { pts.push({ x: p.x, y: p.y }); ed.notify(); } } },
    up(p) {
      if (!pts.length) return;
      if (pts.length < 3) { if (selectMode(p) === 'replace') ed.deselect(); pts = []; return; }
      const d = ed.doc, m = emptyMask(d);
      Ras.polygonFill(pts, (x, y) => { if (x >= 0 && y >= 0 && x < d.width && y < d.height) m[y * d.width + x] = 255; });
      ed.applySelectionMask(m, selectMode(p));
      pts = [];
    },
    cancel() { pts = []; ed.notify(); },
    overlay({ ctx, sx, sy }) {
      if (pts.length < 2) return;
      ctx.save(); ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      pts.forEach((q, i) => { if (i) ctx.lineTo(sx(q.x + 0.5), sy(q.y + 0.5)); else ctx.moveTo(sx(q.x + 0.5), sy(q.y + 0.5)); });
      ctx.closePath(); ctx.stroke(); ctx.restore();
    },
  });
}

registerTool({
  id: 'wand', label: 'Magic wand', key: 'w', group: 'select', cursor: 'crosshair', options: ['selectMode', 'selectFlood'],
  hint: 'Selects by colour. Shift adds, Alt subtracts.',
  down(p) {
    ed.endActiveEdit();
    const d = ed.doc;
    if (p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) return;
    const src = ed.sampleBuffer(ed.select.sampleAll);
    ed.applySelectionMask(Ras.floodMask(src, d.width, d.height, p.x, p.y, ed.select.tolerance, ed.select.contiguous), selectMode(p));
  },
});

// ---- Move and transform

type HandleId = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot';

/** Handle positions on screen, turning with the image. */
function handles(o: { sx: (n: number) => number; sy: (n: number) => number }) {
  const f = ed.s.float!;
  const { cx, cy, sw, sh, angle } = f.place;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const at = (u: number, v: number) => {
    const dx = (u * sw) / 2, dy = (v * sh) / 2;
    return { x: o.sx(cx + dx * cos - dy * sin), y: o.sy(cy + dx * sin + dy * cos) };
  };
  const list: { id: HandleId; u: number; v: number; x: number; y: number }[] = ([
    ['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1], ['e', 1, 0], ['se', 1, 1], ['s', 0, 1], ['sw', -1, 1], ['w', -1, 0],
  ] as [HandleId, number, number][]).map(([id, u, v]) => ({ id, u, v, ...at(u, v) }));
  const top = at(0, sh >= 0 ? -1 : 1);
  const center = at(0, 0);
  const len = Math.hypot(top.x - center.x, top.y - center.y) || 1;
  const rot = { id: 'rot' as HandleId, u: 0, v: -1, x: top.x + ((top.x - center.x) / len) * 22, y: top.y + ((top.y - center.y) / len) * 22 };
  return { list, rot, corners: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], top };
}

function insideFloat(fx: number, fy: number) {
  const { cx, cy, sw, sh, angle } = ed.s.float!.place;
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const dx = fx - cx, dy = fy - cy;
  return Math.abs(dx * cos - dy * sin) <= Math.abs(sw) / 2 && Math.abs(dx * sin + dy * cos) <= Math.abs(sh) / 2;
}

/** What the mouse would grab, in screen space so handles stay easy to hit at any zoom. */
let viewMap: { sx: (n: number) => number; sy: (n: number) => number } | null = null;
export const setViewMap = (m: typeof viewMap) => { viewMap = m; };

function grabAt(p: Pointer): HandleId | null {
  if (!viewMap || !ed.s.float) return null;
  const X = viewMap.sx(p.fx), Y = viewMap.sy(p.fy);
  const h = handles(viewMap);
  if (Math.hypot(h.rot.x - X, h.rot.y - Y) <= 8) return 'rot';
  for (const q of h.list) if (Math.hypot(q.x - X, q.y - Y) <= 7) return q.id;
  return insideFloat(p.fx, p.fy) ? 'move' : null;
}

function drawFloatBox({ ctx, sx, sy }: Overlay) {
  if (!ed.s.float) return;
  const h = handles({ sx, sy });
  ctx.save();
  ctx.lineWidth = 1;
  const trace = () => { ctx.beginPath(); h.corners.forEach((c, i) => { if (i) ctx.lineTo(c.x, c.y); else ctx.moveTo(c.x, c.y); }); ctx.closePath(); };
  ctx.strokeStyle = '#000'; trace(); ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 4]); trace(); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(h.top.x, h.top.y); ctx.lineTo(h.rot.x, h.rot.y); ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111';
  for (const q of h.list) { ctx.fillRect(q.x - 4, q.y - 4, 8, 8); ctx.strokeRect(q.x - 4 + 0.5, q.y - 4 + 0.5, 7, 7); }
  ctx.beginPath(); ctx.arc(h.rot.x, h.rot.y, 5, 0, Math.PI * 2); ctx.fillStyle = '#ffcf4a'; ctx.fill(); ctx.stroke();
  ctx.restore();
}

/** Shared by Move and Transform: dragging handles of a floating image. */
function makeFloatDrag() {
  let grab: HandleId | null = null, start: { fx: number; fy: number } | null = null;
  let begin: { cx: number; cy: number; sw: number; sh: number; angle: number } | null = null;
  return {
    get active() { return grab !== null; },
    tryGrab(p: Pointer): boolean {
      grab = grabAt(p);
      if (!grab) return false;
      start = { fx: p.fx, fy: p.fy };
      begin = { ...ed.s.float!.place };
      return true;
    },
    drag(p: Pointer) {
      const f = ed.s.float;
      if (!grab || !f || !begin || !start) return;
      const pl = f.place;
      if (grab === 'move') {
        let dx = p.fx - start.fx, dy = p.fy - start.fy;
        if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        // Whole pixels: keeps the image on the grid, so it stays crisp when not rotated.
        pl.cx = begin.cx + Math.round(dx); pl.cy = begin.cy + Math.round(dy);
      } else if (grab === 'rot') {
        const a0 = Math.atan2(start.fy - begin.cy, start.fx - begin.cx), a1 = Math.atan2(p.fy - begin.cy, p.fx - begin.cx);
        let ang = begin.angle + (a1 - a0);
        if (p.shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
        pl.angle = ang;
      } else {
        const u = grab.includes('w') ? -1 : grab.includes('e') ? 1 : 0;
        const v = grab.includes('n') ? -1 : grab.includes('s') ? 1 : 0;
        const cos = Math.cos(-begin.angle), sin = Math.sin(-begin.angle);
        const ddx = p.fx - start.fx, ddy = p.fy - start.fy;
        const lx = ddx * cos - ddy * sin, ly = ddx * sin + ddy * cos;
        let nw = begin.sw + u * lx * Math.sign(begin.sw || 1), nh = begin.sh + v * ly * Math.sign(begin.sh || 1);
        nw = Math.round(nw); nh = Math.round(nh);
        if (p.shift && u && v) {
          const k = Math.max(Math.abs(nw / begin.sw), Math.abs(nh / begin.sh));
          nw = Math.round(begin.sw * k); nh = Math.round(begin.sh * k);
        }
        if (nw === 0) nw = 1;
        if (nh === 0) nh = 1;
        pl.sw = nw; pl.sh = nh;
        // The opposite side stays put.
        const shiftX = ((nw - begin.sw) * u * Math.sign(begin.sw || 1)) / 2, shiftY = ((nh - begin.sh) * v * Math.sign(begin.sh || 1)) / 2;
        const c = Math.cos(begin.angle), s = Math.sin(begin.angle);
        pl.cx = begin.cx + shiftX * c - shiftY * s; pl.cy = begin.cy + shiftX * s + shiftY * c;
      }
      ed.renderFloat();
    },
    release() { grab = null; start = null; begin = null; },
  };
}

{
  const floatDrag = makeFloatDrag();
  let start: { x: number; y: number } | null = null;
  let origin: { x: number; y: number; cel: any } | null = null;
  registerTool({
    id: 'move', label: 'Move', key: 'v', group: 'select', cursor: 'move', options: [],
    hint: 'Drags the selection, or the whole cel when nothing is selected. Moved cels keep pixels that go off the canvas. Shift locks the direction.',
    down(p) {
      const s = ed.s;
      if (s.float && floatDrag.tryGrab(p)) return;
      if (s.float) ed.commitFloat();
      const sel = ed.doc.selection;
      if (sel) {
        if (ed.liftFloat('Move selection') && floatDrag.tryGrab(p)) return;
        return;
      }
      const block = ed.editBlock();
      if (block) { ed.toast(block); return; }
      const cel = ed.doc.cels[celKey(s.layerId, ed.frameId)];
      if (!cel) { ed.toast('This cel is empty.'); return; }
      start = { x: p.x, y: p.y };
      origin = { x: cel.x, y: cel.y, cel };
    },
    move(p) {
      if (floatDrag.active) { floatDrag.drag(p); return; }
      if (!start || !origin) return;
      let dx = p.x - start.x, dy = p.y - start.y;
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      ed.s.preview = { layerId: ed.s.layerId, cel: { ...origin.cel, x: origin.x + dx, y: origin.y + dy } };
      ed.invalidate();
      ed.notify();
    },
    up() {
      if (floatDrag.active) { floatDrag.release(); return; }
      const pv = ed.s.preview;
      ed.s.preview = null;
      if (pv && origin && (pv.cel.x !== origin.x || pv.cel.y !== origin.y)) {
        const d = ed.doc, cels = { ...d.cels };
        // Linked cels move together.
        for (const k in cels) if (cels[k] === origin.cel) cels[k] = pv.cel;
        ed.commit('Move', { ...d, cels });
      } else ed.invalidate();
      start = origin = null;
    },
    cancel() {
      if (floatDrag.active) floatDrag.release();
      if (ed.s.preview) { ed.s.preview = null; ed.invalidate(); }
      start = origin = null;
      ed.cancelFloat();
    },
    overlay: drawFloatBox,
  });

  const tDrag = makeFloatDrag();
  registerTool({
    id: 'transform', label: 'Transform', key: 't', group: 'select', cursor: 'default', options: ['rotateQuality', 'transformActions'],
    hint: 'Drag corners to scale (Shift keeps proportions), the yellow dot to rotate (Shift for 15° steps), inside to move. Enter applies, Esc cancels. Dragging past an edge flips.',
    down(p) {
      if (!ed.s.float) { if (!ed.liftFloat()) return; }
      if (tDrag.tryGrab(p)) return;
      ed.commitFloat();
    },
    move(p) { tDrag.drag(p); },
    up() { tDrag.release(); },
    finish() { if (ed.s.float) ed.commitFloat(); },
    cancel() { tDrag.release(); ed.cancelFloat(); },
    overlay: drawFloatBox,
  });
}

// ---- Navigation. The viewport handles these itself; they exist so they appear in the toolbar with their shortcuts.

registerTool({ id: 'hand', label: 'Hand', key: 'h', group: 'view', cursor: 'grab', options: [], hint: 'Drags the view. Hold Space or the middle mouse button with any tool.' });
registerTool({ id: 'zoom', label: 'Zoom', key: 'z', group: 'view', cursor: 'zoom-in', options: [], hint: 'Click to zoom in, Alt-click to zoom out. The mouse wheel works with any tool.' });

// ---- Editor integration

ed.setTool = (id: string) => {
  if (id === ed.toolId) return;
  const prev = toolById(ed.toolId);
  // Finish what the previous tool was doing rather than losing it.
  ed.toolFinish?.();
  if (prev?.id === 'transform' || prev?.id === 'move') { if (ed.s.float && id !== 'transform' && id !== 'move') ed.commitFloat(); }
  ed.toolId = id;
  ed.notify();
};

/** Marching ants segments of the current selection, cached by object. */
let segCache: { sel: unknown; segs: number[] } = { sel: null, segs: [] };
export function selectionSegments(): number[] {
  const sel = ed.doc.selection;
  if (!sel) return [];
  if (segCache.sel !== sel) segCache = { sel, segs: outlineSegments(sel) };
  return segCache.segs;
}

/** Commands that act on the float, usable from menus and keys. */
export function flipFloat(axis: 'h' | 'v') {
  const f = ed.s.float;
  if (!f) { if (!ed.liftFloat('Flip')) return; }
  const pl = ed.s.float!.place;
  if (axis === 'h') pl.sw = -pl.sw; else pl.sh = -pl.sh;
  ed.renderFloat();
}

export function rotateFloat(rad: number) {
  if (!ed.s.float && !ed.liftFloat('Rotate')) return;
  ed.s.float!.place.angle += rad;
  ed.renderFloat();
}

/** Nudges the floating image, or lifts the selection first. */
export function nudge(dx: number, dy: number) {
  if (!ed.s.float) {
    if (!ed.doc.selection) {
      const c = ed.doc.cels[celKey(ed.s.layerId, ed.frameId)];
      const block = ed.editBlock();
      if (block || !c) return;
      const d = ed.doc, cels = { ...d.cels }, moved = { ...c, x: c.x + dx, y: c.y + dy };
      for (const k in cels) if (cels[k] === c) cels[k] = moved;
      ed.commit('Nudge', { ...d, cels });
      return;
    }
    if (!ed.liftFloat('Move selection')) return;
  }
  const pl = ed.s.float!.place;
  pl.cx += dx; pl.cy += dy;
  ed.renderFloat();
}

export const contentBox = (): Rect | null => contentBounds(ed.doc);
export { placedBounds, rectUnion };
