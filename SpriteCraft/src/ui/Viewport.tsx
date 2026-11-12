// The canvas view. Pixels come from the compositor into an offscreen canvas one dirty rectangle at a time, then the GPU
// scales that with nearest-neighbour sampling, so a brush stroke does not recomposite the whole image.
import { useEffect, useRef } from 'react';
import { composeFrame, composeRegion, fxSettings } from '../core/compose';
import { A, B, G, R, toCss } from '../core/color';
import { brushOffsets } from '../core/raster';
import { rectIntersect, type Doc } from '../core/types';
import { ed } from '../editor/editor';
import { activeTool, selectionSegments, setViewMap, type Overlay, type Pointer } from '../editor/tools';
import { area, fitView, nextZoom, zoomAt } from './viewMath';

/** The composed current frame, for the Preview panel to draw from. */
export const display = { canvas: null as HTMLCanvasElement | null };

function makeImage(data: Uint32Array, w: number, h: number) {
  return new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), w, h);
}

/** An onion-skin frame, optionally tinted so it reads as "before" or "after". */
function onionCanvas(doc: Doc, frame: number, tint: [number, number, number] | null) {
  const data = composeFrame(doc, frame, { skipReference: true });
  if (tint) {
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      if (!A(p)) continue;
      const l = (R(p) * 0.3 + G(p) * 0.59 + B(p) * 0.11) / 255;
      data[i] = ((A(p) << 24) | (Math.round(tint[2] * l) << 16) | (Math.round(tint[1] * l) << 8) | Math.round(tint[0] * l)) >>> 0;
    }
  }
  const c = document.createElement('canvas');
  c.width = doc.width; c.height = doc.height;
  c.getContext('2d')!.putImageData(makeImage(data, doc.width, doc.height), 0, 0);
  return c;
}

export function Viewport() {
  const ref = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = ref.current!, box = boxRef.current!;
    const g = canvas.getContext('2d', { alpha: false })!;
    const off = document.createElement('canvas');
    const og = off.getContext('2d')!;
    display.canvas = off;

    let raf = 0, lastVersion = -1, antsPhase = 0, lastAnts = 0, needs = true;
    let offDoc: Doc | null = null, offFrame = -1;
    let onions: { doc: Doc; key: string; list: { canvas: HTMLCanvasElement; alpha: number }[] } | null = null;
    let cursor: { x: number; y: number } | null = null;
    let panning: { x: number; y: number; vx: number; vy: number; id: number } | null = null;
    let dragging = false, pointerId = -1, spaceDown = false, usingTemp = false, autoFit = true;
    let checker: CanvasPattern | null = null;
    const statusEl = () => document.getElementById('status-pos');

    const dpr = () => window.devicePixelRatio || 1;
    const resize = () => {
      const r = box.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr())), h = Math.max(1, Math.round(r.height * dpr()));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
        area.w = w; area.h = h;
        // Until the user has touched the view, keep the sprite fitted while the layout settles.
        if (autoFit) fitView();
        needs = true;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();

    const makeChecker = () => {
      const size = Math.round(8 * dpr());
      const c = document.createElement('canvas');
      c.width = c.height = size * 2;
      const q = c.getContext('2d')!;
      q.fillStyle = '#34363f'; q.fillRect(0, 0, size * 2, size * 2);
      q.fillStyle = '#292b33'; q.fillRect(0, 0, size, size); q.fillRect(size, size, size, size);
      checker = g.createPattern(c, 'repeat');
    };
    makeChecker();

    /** Pushes changed pixels into the offscreen image. */
    const syncImage = () => {
      const s = ed.s, d = s.doc;
      if (off.width !== d.width || off.height !== d.height) { off.width = d.width; off.height = d.height; ed.pendingDirty = 'full'; }
      if (offFrame !== s.frame) { offFrame = s.frame; ed.pendingDirty = 'full'; }
      if (offDoc !== d) {
        // A commit names the area it changed; any other change to the document asks for a full redraw itself.
        offDoc = d;
      }
      const dirty = ed.takeDirty();
      if (!dirty) return false;
      const canvasRect = { x: 0, y: 0, w: d.width, h: d.height };
      const r = dirty === 'full' ? canvasRect : rectIntersect(dirty, canvasRect);
      if (!r) return false;
      const data = composeRegion(d, s.frame, r, { override: ed.override(), noFx: !fxSettings.showOnCanvas });
      og.putImageData(makeImage(data, r.w, r.h), r.x, r.y);
      return true;
    };

    const onionFor = (d: Doc, frame: number) => {
      const o = ed.onion;
      if (!o.on || ed.playing) return null;
      const key = `${frame}:${o.before}:${o.after}:${o.opacity}:${o.tint}`;
      if (onions && onions.doc === d && onions.key === key) return onions.list;
      const list: { canvas: HTMLCanvasElement; alpha: number }[] = [];
      const base = o.opacity / 255;
      for (let i = o.before; i >= 1; i--) {
        const f = frame - i;
        if (f >= 0) list.push({ canvas: onionCanvas(d, f, o.tint ? [255, 90, 80] : null), alpha: base * (1 - (i - 1) / (o.before + 1)) });
      }
      for (let i = o.after; i >= 1; i--) {
        const f = frame + i;
        if (f < d.frames.length) list.push({ canvas: onionCanvas(d, f, o.tint ? [80, 170, 255] : null), alpha: base * (1 - (i - 1) / (o.after + 1)) });
      }
      onions = { doc: d, key, list };
      return list;
    };

    const paint = (now: number) => {
      const s = ed.s, d = s.doc;
      if (!s.view) fitView(s);
      const v = s.view!, z = v.zoom;
      const W = d.width * z, H = d.height * z;
      const sx = (n: number) => v.x + n * z, sy = (n: number) => v.y + n * z;
      setViewMap({ sx, sy });
      g.imageSmoothingEnabled = false;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#1b1c22';
      g.fillRect(0, 0, canvas.width, canvas.height);
      // Backdrop of the canvas area.
      g.save();
      g.translate(v.x, v.y);
      g.fillStyle = checker!;
      g.fillRect(0, 0, W, H);
      g.restore();
      const onion = onionFor(d, s.frame);
      if (onion) for (const o of onion) { g.globalAlpha = o.alpha; g.drawImage(o.canvas, v.x, v.y, W, H); }
      g.globalAlpha = 1;
      g.drawImage(off, v.x, v.y, W, H);
      g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1;
      g.strokeRect(v.x - 0.5, v.y - 0.5, W + 1, H + 1);

      // Visible part of the canvas, in canvas pixels, so grids only draw what can be seen.
      const x0 = Math.max(0, Math.floor(-v.x / z)), y0 = Math.max(0, Math.floor(-v.y / z));
      const x1 = Math.min(d.width, Math.ceil((canvas.width - v.x) / z)), y1 = Math.min(d.height, Math.ceil((canvas.height - v.y) / z));
      const grid = d.grid;
      if (grid.pixelGrid && z >= 8) {
        g.strokeStyle = 'rgba(255,255,255,.10)';
        g.beginPath();
        for (let x = x0; x <= x1; x++) { const X = sx(x) + 0.5; g.moveTo(X, sy(y0)); g.lineTo(X, sy(y1)); }
        for (let y = y0; y <= y1; y++) { const Y = sy(y) + 0.5; g.moveTo(sx(x0), Y); g.lineTo(sx(x1), Y); }
        g.stroke();
      }
      if (grid.showTile && grid.tileW > 0 && grid.tileH > 0) {
        g.strokeStyle = 'rgba(120,200,255,.55)';
        g.beginPath();
        const fx = ((grid.offX % grid.tileW) + grid.tileW) % grid.tileW, fy = ((grid.offY % grid.tileH) + grid.tileH) % grid.tileH;
        for (let x = fx; x <= d.width; x += grid.tileW) { const X = sx(x) + 0.5; g.moveTo(X, sy(0)); g.lineTo(X, sy(d.height)); }
        for (let y = fy; y <= d.height; y += grid.tileH) { const Y = sy(y) + 0.5; g.moveTo(sx(0), Y); g.lineTo(sx(d.width), Y); }
        g.stroke();
      }
      if (grid.iso !== 'off' && grid.isoW > 1) {
        // Diagonals of an isometric cell: 2:1 for the iso grid, 1:1 for the diamond grid.
        const cellW = grid.isoW, cellH = grid.iso === 'iso' ? grid.isoW / 2 : grid.isoW;
        const slope = cellH / cellW;
        g.save();
        g.beginPath(); g.rect(sx(0), sy(0), W, H); g.clip();
        g.strokeStyle = 'rgba(255,190,90,.55)';
        g.beginPath();
        const span = d.height / slope + d.width;
        for (let c = -Math.ceil(span / cellW) * cellW; c <= span; c += cellW) {
          g.moveTo(sx(c), sy(0)); g.lineTo(sx(c + d.height / slope), sy(d.height));
          g.moveTo(sx(c), sy(0)); g.lineTo(sx(c - d.height / slope), sy(d.height));
        }
        g.stroke();
        g.restore();
      }
      g.lineWidth = 1;
      for (const gd of d.guides) {
        g.strokeStyle = 'rgba(80,230,255,.85)';
        g.beginPath();
        if (gd.axis === 'x') { g.moveTo(sx(gd.pos) + 0.5, 0); g.lineTo(sx(gd.pos) + 0.5, canvas.height); }
        else { g.moveTo(0, sy(gd.pos) + 0.5); g.lineTo(canvas.width, sy(gd.pos) + 0.5); }
        g.stroke();
      }
      if (ed.sym.x || ed.sym.y) {
        g.strokeStyle = 'rgba(255,100,200,.8)';
        g.setLineDash([6, 4]);
        g.beginPath();
        if (ed.sym.x) { g.moveTo(sx(ed.sym.cx) + 0.5, sy(0)); g.lineTo(sx(ed.sym.cx) + 0.5, sy(d.height)); }
        if (ed.sym.y) { g.moveTo(sx(0), sy(ed.sym.cy) + 0.5); g.lineTo(sx(d.width), sy(ed.sym.cy) + 0.5); }
        g.stroke();
        g.setLineDash([]);
      }

      const tool = activeTool();
      // Brush footprint, with symmetry, so the user sees what a click will touch.
      if (cursor && tool.showsBrush && !dragging && !ed.playing) {
        const b = ed.brush;
        const list = b.custom
          ? (() => {
            const out: { x: number; y: number; c: number }[] = [];
            const ox = Math.floor(b.custom.w / 2), oy = Math.floor(b.custom.h / 2);
            for (let y = 0; y < b.custom.h; y++) for (let x = 0; x < b.custom.w; x++) { const c = b.custom.data[y * b.custom.w + x]; if (A(c)) out.push({ x: x - ox, y: y - oy, c }); }
            return out;
          })()
          : brushOffsets(b.size, b.shape).map((o) => ({ ...o, c: 0 }));
        const eraser = tool.id === 'eraser';
        const place = (px: number, py: number) => {
          for (const o of list) {
            const c = o.c && b.customColors ? o.c : ed.fg;
            g.fillStyle = eraser ? 'rgba(255,255,255,.45)' : toCss(c);
            g.fillRect(sx(px + o.x), sy(py + o.y), Math.ceil(z), Math.ceil(z));
          }
        };
        g.globalAlpha = 0.75;
        place(cursor.x, cursor.y);
        if (ed.sym.x) place(2 * ed.sym.cx - 1 - cursor.x, cursor.y);
        if (ed.sym.y) place(cursor.x, 2 * ed.sym.cy - 1 - cursor.y);
        if (ed.sym.x && ed.sym.y) place(2 * ed.sym.cx - 1 - cursor.x, 2 * ed.sym.cy - 1 - cursor.y);
        g.globalAlpha = 1;
      }

      // Marching ants. Not drawn over floating pixels, which show their own box.
      if (d.selection && !s.float) {
        const segs = selectionSegments();
        g.lineWidth = 1;
        const trace = () => { g.beginPath(); for (let i = 0; i < segs.length; i += 4) { g.moveTo(sx(segs[i]) + 0.5, sy(segs[i + 1]) + 0.5); g.lineTo(sx(segs[i + 2]) + 0.5, sy(segs[i + 3]) + 0.5); } };
        g.strokeStyle = '#000'; g.setLineDash([]); trace(); g.stroke();
        g.strokeStyle = '#fff'; g.setLineDash([4, 4]); g.lineDashOffset = -antsPhase; trace(); g.stroke();
        g.setLineDash([]); g.lineDashOffset = 0;
      }
      const o: Overlay = { sx, sy, zoom: z, ctx: g };
      tool.overlay?.(o);
      void now;
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const changed = syncImage();
      if (ed.version !== lastVersion) { lastVersion = ed.version; needs = true; }
      if (changed) needs = true;
      if (ed.doc.selection && now - lastAnts > 130) { antsPhase = (antsPhase + 1) % 8; lastAnts = now; needs = true; }
      if (needs) { needs = false; paint(now); }
    };
    raf = requestAnimationFrame(frame);

    const toPointer = (e: PointerEvent): Pointer => {
      const r = canvas.getBoundingClientRect();
      const v = ed.s.view!;
      const px = (e.clientX - r.left) * dpr(), py = (e.clientY - r.top) * dpr();
      const fx = (px - v.x) / v.zoom, fy = (py - v.y) / v.zoom;
      return { x: Math.floor(fx), y: Math.floor(fy), fx, fy, button: e.button === 2 || (e.buttons & 2) !== 0 ? 2 : 0, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, pressure: e.pressure || 1, pen: (e as PointerEvent).pointerType === 'pen', zoom: v.zoom };
    };

    const screenPos = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * dpr(), y: (e.clientY - r.top) * dpr() };
    };

    const onDown = (e: PointerEvent) => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      autoFit = false;
      const s = ed.s;
      if (!s.view) return;
      const toolId = ed.toolId;
      if (e.button === 1 || spaceDown || toolId === 'hand') {
        panning = { x: e.clientX, y: e.clientY, vx: s.view.x, vy: s.view.y, id: e.pointerId };
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }
      if (toolId === 'zoom') {
        const q = screenPos(e);
        s.view = zoomAt(s.view, nextZoom(s.view.zoom, e.altKey || e.button === 2 ? -1 : 1), q.x, q.y);
        ed.notify();
        return;
      }
      ed.stop();
      // Holding Alt with a brush picks colour for a moment.
      if (e.altKey && ['draw', 'fill'].includes(activeTool().group) && activeTool().id !== 'eyedropper') { ed.tempTool = 'eyedropper'; usingTemp = true; }
      const tool = activeTool();
      if (!tool.down) return;
      dragging = true; pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      try { tool.down(toPointer(e)); }
      catch (err: any) { ed.toast(`Tool error: ${err.message ?? err}`); console.error(err); }
      needs = true;
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (!ed.s.view) return;
      if (panning) {
        ed.s.view = { ...ed.s.view, x: panning.vx + Math.round((e.clientX - panning.x) * dpr()), y: panning.vy + Math.round((e.clientY - panning.y) * dpr()) };
        needs = true;
        return;
      }
      const p = toPointer(e);
      const nc = { x: p.x, y: p.y };
      if (!cursor || cursor.x !== nc.x || cursor.y !== nc.y) {
        cursor = nc; needs = true;
        const el = statusEl();
        if (el) el.textContent = p.x >= 0 && p.y >= 0 && p.x < ed.doc.width && p.y < ed.doc.height ? `${p.x}, ${p.y}` : '';
      }
      const tool = activeTool();
      if (dragging && e.pointerId === pointerId) {
        // Coalesced events keep fast strokes smooth: each is a real position the pen passed through.
        const events = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
        for (const ev of events?.length ? events : [e]) {
          try { tool.move?.(toPointerKeep(ev, e)); }
          catch (err: any) { ed.toast(`Tool error: ${err.message ?? err}`); console.error(err); }
        }
        needs = true;
      } else if (!dragging) tool.hover?.(p);
    };
    /** Coalesced events carry position but sometimes not the buttons, so those come from the real event. */
    const toPointerKeep = (ev: PointerEvent, real: PointerEvent): Pointer => ({ ...toPointer(ev), button: toPointer(real).button, shift: real.shiftKey, alt: real.altKey, ctrl: real.ctrlKey });

    const onUp = (e: PointerEvent) => {
      if (panning) { panning = null; canvas.style.cursor = ''; return; }
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      const tool = activeTool();
      const p = toPointer(e);
      if (e.button === 2) p.button = 2;
      try { tool.up?.(p); }
      catch (err: any) { ed.toast(`Tool error: ${err.message ?? err}`); console.error(err); }
      if (usingTemp) { ed.tempTool = null; usingTemp = false; }
      needs = true;
      ed.notify();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      autoFit = false;
      const s = ed.s;
      if (!s.view) return;
      if (e.ctrlKey || !e.shiftKey) {
        const q = screenPos(e);
        const nz = nextZoom(s.view.zoom, e.deltaY < 0 ? 1 : -1);
        if (nz !== s.view.zoom) s.view = zoomAt(s.view, nz, q.x, q.y);
      } else {
        s.view = { ...s.view, x: s.view.x - Math.round(e.deltaY) };
      }
      needs = true;
    };

    const onLeave = () => { cursor = null; needs = true; const el = statusEl(); if (el) el.textContent = ''; };
    const noMenu = (e: Event) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      spaceDown = e.type === 'keydown';
      canvas.style.cursor = spaceDown ? 'grab' : '';
      if (spaceDown) e.preventDefault();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  return (
    <div className="viewport" ref={boxRef}>
      <canvas ref={ref} data-testid="canvas" style={{ cursor: activeTool().cursor ?? 'crosshair' }} />
    </div>
  );
}
