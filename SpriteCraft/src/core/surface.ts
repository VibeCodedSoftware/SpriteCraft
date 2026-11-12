// An editing surface: the working copy of one cel while a tool is using it. Every tool writes through here, so masks,
// selections, alpha lock and canvas bounds are enforced in one place. Writes always start from the untouched `base`, so
// painting back and forth within one stroke does not build up semi-transparent colour.
import { blendPixel } from './compose';
import { celToBuffer, trimToCel } from './doc';
import { isSelected } from './selection';
import { rectUnion, type Cel, type Rect, type Selection } from './types';

export interface SurfaceOptions {
  canvasW: number; canvasH: number;
  selection?: Selection | null;
  alphaLock?: boolean;
}

export class Surface {
  /** Covers the canvas and any part of the cel outside it, so off-canvas pixels are never lost. */
  rect: Rect;
  base: Uint32Array;
  buf: Uint32Array;
  /** The working image as a cel, for the compositor to draw in place of the stored one. */
  cel: Cel;
  /** Canvas area changed since it was last redrawn. */
  dirty: Rect | null = null;
  /** Everything touched since the surface was made. */
  touched: Rect | null = null;

  constructor(source: Cel | null | undefined, public o: SurfaceOptions) {
    const canvas = { x: 0, y: 0, w: o.canvasW, h: o.canvasH };
    this.rect = source ? rectUnion(canvas, source)! : canvas;
    this.base = celToBuffer(source, this.rect);
    this.buf = this.base.slice();
    this.cel = { id: source?.id ?? 'working', x: this.rect.x, y: this.rect.y, w: this.rect.w, h: this.rect.h, data: this.buf, opacity: source?.opacity ?? 255 };
  }

  private mark(x: number, y: number) {
    const d = this.dirty;
    if (!d) this.dirty = { x, y, w: 1, h: 1 };
    else {
      if (x < d.x) { d.w += d.x - x; d.x = x; } else if (x >= d.x + d.w) d.w = x - d.x + 1;
      if (y < d.y) { d.h += d.y - y; d.y = y; } else if (y >= d.y + d.h) d.h = y - d.y + 1;
    }
  }

  /** Index into the buffers, or -1 where tools may not write. */
  private index(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.o.canvasW || y >= this.o.canvasH) return -1;
    if (this.o.selection && !isSelected(this.o.selection, x, y)) return -1;
    return (y - this.rect.y) * this.rect.w + (x - this.rect.x);
  }

  /** Paints a colour over what was here before the stroke. */
  paint(x: number, y: number, color: number) {
    const i = this.index(x, y);
    if (i < 0) return;
    const b = this.base[i];
    let out: number;
    if (this.o.alphaLock) {
      const ba = b >>> 24;
      if (ba === 0) return;
      const mixed = blendPixel('normal', (b | 0xff000000) >>> 0, color & 255, (color >>> 8) & 255, (color >>> 16) & 255, color >>> 24);
      out = ((mixed & 0xffffff) | (ba << 24)) >>> 0;
    } else {
      const a = color >>> 24;
      out = a === 255 || (b >>> 24) === 0 ? (a ? color : b) : blendPixel('normal', b, color & 255, (color >>> 8) & 255, (color >>> 16) & 255, a);
    }
    this.buf[i] = out;
    this.mark(x, y);
  }

  /** Writes a pixel exactly as given, alpha included. */
  set(x: number, y: number, color: number) {
    const i = this.index(x, y);
    if (i < 0) return;
    if (this.o.alphaLock && (this.base[i] >>> 24) === 0) return;
    this.buf[i] = this.o.alphaLock ? ((color & 0xffffff) | (this.base[i] & 0xff000000)) >>> 0 : color;
    this.mark(x, y);
  }

  /** Removes up to `amount` (0..255) of opacity. On an alpha-locked layer erasing does nothing, as locking promises. */
  erase(x: number, y: number, amount = 255) {
    const i = this.index(x, y);
    if (i < 0 || this.o.alphaLock) return;
    const b = this.base[i], a = b >>> 24;
    if (!a) return;
    const na = amount >= 255 ? 0 : Math.round((a * (255 - amount)) / 255);
    this.buf[i] = na ? ((b & 0xffffff) | (na << 24)) >>> 0 : 0;
    this.mark(x, y);
  }

  restore(x: number, y: number) {
    const i = this.index(x, y);
    if (i < 0) return;
    this.buf[i] = this.base[i];
    this.mark(x, y);
  }

  get(x: number, y: number): number {
    if (x < this.rect.x || y < this.rect.y || x >= this.rect.x + this.rect.w || y >= this.rect.y + this.rect.h) return 0;
    return this.buf[(y - this.rect.y) * this.rect.w + (x - this.rect.x)];
  }

  /** Base pixel, ignoring what the stroke has done so far. */
  getBase(x: number, y: number): number {
    if (x < this.rect.x || y < this.rect.y || x >= this.rect.x + this.rect.w || y >= this.rect.y + this.rect.h) return 0;
    return this.base[(y - this.rect.y) * this.rect.w + (x - this.rect.x)];
  }

  /** Puts everything back as it was, keeping the old area marked so the view gets redrawn. Used by live shape previews. */
  reset() {
    const t = rectUnion(this.touched, this.dirty);
    if (t) {
      for (let y = t.y; y < t.y + t.h; y++) {
        const s = (y - this.rect.y) * this.rect.w + (t.x - this.rect.x);
        this.buf.set(this.base.subarray(s, s + t.w), s);
      }
      this.touched = t;
      this.dirty = { ...t };
    }
  }

  /** Hands over the area to redraw. */
  takeDirty(): Rect | null {
    const d = this.dirty;
    if (d) { this.touched = rectUnion(this.touched, d); this.dirty = null; }
    return d;
  }

  /** Accepts the current pixels as the new starting point (for tools that work in separate steps). */
  rebase() { this.base.set(this.buf); this.touched = null; }

  changed(): boolean {
    for (let i = 0; i < this.buf.length; i++) if (this.buf[i] !== this.base[i]) return true;
    return false;
  }

  /** The finished image, trimmed. Null when it ended up empty. */
  finish(): Cel | null {
    return trimToCel(this.buf, this.rect.w, this.rect.h, this.rect.x, this.rect.y, this.cel.opacity);
  }

  /** A copy of the canvas area of the working image. */
  canvasCopy(): Uint32Array {
    return celToBuffer(this.cel, { x: 0, y: 0, w: this.o.canvasW, h: this.o.canvasH });
  }
}
