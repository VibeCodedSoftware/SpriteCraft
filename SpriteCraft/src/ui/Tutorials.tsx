// In-app tutorials (Phase 9). Each one opens a practice sprite and walks through real steps; a step is ticked when the
// editor sees it done (a tool picked, pixels drawn, a light added…), never by just pressing Next. Steps that are only
// advice say so and have a Next button.
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { rgba } from '../core/color';
import { composeFrame, layerPixels } from '../core/compose';
import * as D from '../core/doc';
import { celKey, type Doc } from '../core/types';
import { ed, loadPref, savePref, useEd } from '../editor/editor';

interface Step {
  text: string;
  /** What to show when "Show me" is pressed. */
  show?: () => void;
  /** Taken when the step starts, passed to `done`. */
  begin?: () => unknown;
  /** True once the step is done. Steps without it are advice with a Next button. */
  done?: (base: any) => boolean;
}
export interface Tutorial { id: string; name: string; blurb: string; setup: () => void; steps: Step[] }

const pixelsOnLayer = () => {
  const l = ed.layer;
  if (!l) return 0;
  return layerPixels(ed.doc, l.id, ed.frameId).reduce((n, c) => n + (c >>> 24 ? 1 : 0), 0);
};
const practice = (name: string, w: number, h: number, frames: number, paint?: (x: number, y: number) => number): Doc => {
  let d = D.newDoc(w, h, name, frames);
  if (paint) {
    const img = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = paint(x, y);
    for (const fr of d.frames) d = D.setCel(d, celKey(d.layers[0].id, fr.id), D.trimToCel(img, w, h, 0, 0), false);
  }
  return d;
};
const ball = (cx: number, cy: number, r: number) => (x: number, y: number) => {
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d2 = dx * dx + dy * dy;
  return d2 > r * r ? 0 : d2 > (r - 1.2) ** 2 ? rgba(60, 30, 40) : dx + dy < -r * 0.6 ? rgba(255, 200, 150) : rgba(220, 100, 70);
};
const hasFx = (effect: string) => ed.doc.layers.some((l) => l.fx?.some((f) => f.on && f.effect === effect));

export const TUTORIALS: Tutorial[] = [
  {
    id: 'first', name: 'Your first sprite', blurb: 'Pencil, colours, eraser, undo and layers.',
    setup: () => ed.openDoc(practice('Tutorial: first sprite', 32, 32, 1)),
    steps: [
      { text: 'Pick the Pencil: the first tool on the left, or press B.', show: () => ed.setTool('pencil'), done: () => ed.toolId === 'pencil' },
      { text: 'Choose a colour: click any swatch in the Palette panel.', show: () => ed.showPanel?.('palette'), begin: () => ed.fg, done: (fg) => ed.fg !== fg },
      { text: 'Draw on the canvas. Put down at least 20 pixels: a smiley, a tree, anything.', done: () => pixelsOnLayer() >= 20 },
      { text: 'Pick the Eraser (E) and rub out a few pixels.', show: () => ed.setTool('eraser'), begin: () => pixelsOnLayer(), done: (n) => ed.toolId === 'eraser' && pixelsOnLayer() < n },
      { text: 'Changed your mind? Undo with Ctrl+Z to bring them back.', begin: () => pixelsOnLayer(), done: (n) => pixelsOnLayer() > n },
      { text: 'Add a layer with the + under the Layers panel. Layers keep parts separate, like an outline over colours.', show: () => ed.showPanel?.('layers'), begin: () => ed.doc.layers.length, done: (n) => ed.doc.layers.length > n },
      { text: 'That\'s the core. Save with Ctrl+S, and export a PNG or GIF from the File menu whenever you like.' },
    ],
  },
  {
    id: 'animate', name: 'Animate a bounce', blurb: 'Frames, moving art, onion skin, playback and tweens.',
    setup: () => ed.openDoc(practice('Tutorial: bounce', 32, 32, 1, ball(16, 8, 5))),
    steps: [
      { text: 'Copy the frame three times: press Alt+D three times (Frame › Duplicate frame), so every frame has the ball.', show: () => ed.showPanel?.('timeline'), done: () => ed.doc.frames.length >= 4 },
      { text: 'Go to frame 3 (press . to step) and drag the ball down with the Move tool (V), so it hits the ground.', show: () => { ed.setFrame(2); ed.setTool('move'); },
        done: () => { const t0 = topOf(composeFrame(ed.doc, 0)); return ed.doc.frames.some((_, i) => { const t = topOf(composeFrame(ed.doc, i)); return i > 0 && t >= 0 && t0 >= 0 && t !== t0; }); } },
      { text: 'Turn on onion skin (Ctrl+Shift+K, or the ghost button in the Timeline) to see the frames before and after.', done: () => ed.onion.on },
      { text: 'Press play (Enter) to watch it. Press Enter again to stop.', done: () => ed.playing },
      { text: 'Tweens draw the in-betweens for you: go to frame 1 (Home) and press Ctrl+Alt+T (Frame › New tween from this frame). The Animate panel then keys move, squash and easing.', show: () => { ed.setFrame(0); ed.showPanel?.('animate'); }, done: () => (ed.doc.motions?.length ?? 0) > 0 },
      { text: 'Done. Tags in the Timeline name loops like "walk" or "jump" for export.' },
    ],
  },
  {
    id: 'light', name: 'Light a sprite', blurb: 'Normal maps and moving lights in banded pixel shading.',
    setup: () => ed.openDoc(practice('Tutorial: lighting', 32, 32, 1, ball(16, 16, 11))),
    steps: [
      { text: 'Open Sprite › Lighting and press Make normals. It works out which way each pixel faces.', show: () => ed.showPanel?.('light'), done: () => !!ed.lighting.normalLayer },
      { text: 'Drag the light dot on the Lighting preview, or add a Point light, and watch the shading follow.', show: () => ed.showPanel?.('light'),
        begin: () => JSON.stringify(ed.lighting.lights), done: (j) => JSON.stringify(ed.lighting.lights) !== j },
      { text: 'Press Render this frame to turn the lit result into pixels on a new layer.', show: () => ed.showPanel?.('light'), done: () => ed.doc.layers.some((l) => l.name.startsWith('Lit')) },
      { text: 'Done. Tick "Key on this frame" in the Lighting panel to animate lights over frames.' },
    ],
  },
  {
    id: 'fx', name: 'Effects that move', blurb: 'Particles, weather and node graphs that loop, then baking them.',
    setup: () => ed.openDoc(practice('Tutorial: effects', 48, 48, 8, (x, y) => (y >= 40 ? rgba(90, 70, 50) : y === 39 ? rgba(70, 120, 60) : 0))),
    steps: [
      { text: 'Open Sprite › Particles and pick Fire. It goes on its own layer.', show: () => ed.showPanel?.('particles'), done: () => hasFx('particles') },
      { text: 'Press play (Enter). Particles loop exactly over the 8 frames.', done: () => ed.playing },
      { text: 'Open Sprite › Weather and pick Light snow. It settles on the ground.', show: () => ed.showPanel?.('weather'), done: () => hasFx('weather') },
      { text: 'Select the ground layer, open the Node editor and press "Add a node graph", then choose Moving light under "Replace with preset".', show: () => ed.showPanel?.('nodes'),
        done: () => ed.doc.layers.some((l) => l.fx?.some((f) => f.effect === 'nodes' && (f.params.graph?.nodes ?? []).some((n: { type: string }) => n.type === 'light'))) },
      { text: 'Bake one of them (the Bake button in its panel) to turn it into pixels you can retouch.', done: () => ed.doc.layers.some((l) => !!l.bakedFrom) },
      { text: 'Done. Everything live also shows in exports, and View › Performance shows what each effect costs.' },
    ],
  },
  {
    id: 'rig', name: 'Turn a character in 3D', blurb: 'The rig: parts on bones, posed and turned.',
    setup: () => ed.openDoc(practice('Tutorial: rig', 32, 32, 1, ball(16, 16, 9))),
    steps: [
      { text: 'Draw each body part on its own layer (head, body, arms, legs). Here one part is ready: open Sprite › Rig and press Make a rig.', show: () => ed.showPanel?.('rig'), done: () => !!ed.doc.rig },
      { text: 'Drag on the Rig preview to turn it, and try the shapes (ball, tube, box) for the part.', show: () => ed.showPanel?.('rig'), begin: () => JSON.stringify(ed.doc.rig), done: (j) => JSON.stringify(ed.doc.rig) !== j },
      { text: 'Open File › Open and look in the Demos folder next to SpriteCraft for "Rig demo": a whole character with elbows and knees, waving.' },
    ],
  },
];

/** Keeps one panel's failure inside that panel: it shows what went wrong and the rest of SpriteCraft keeps working. */
export class PanelBoundary extends Component<{ name: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) }; }
  componentDidCatch(e: unknown) { console.error(`Panel "${this.props.name}" failed:`, e); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="shaderpanel">
        <p className="warn">The {this.props.name} panel hit a problem: {this.state.error}</p>
        <p className="dim">Your sprite is fine. Try again, or close and reopen the panel from the View menu.</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

/** The first row with any pixels in a frame image (-1 when empty). */
function topOf(img: Uint32Array) { const w = ed.doc.width; for (let i = 0; i < img.length; i++) if (img[i] >>> 24) return Math.floor(i / w); return -1; }

export function TutorialPanel() {
  useEd();
  const [active, setActive] = useState<{ id: string; step: number } | null>(null);
  const [doneIds, setDoneIds] = useState<string[]>(() => { const v = loadPref<unknown>('tutorialsDone', []); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; });
  const base = useRef<{ key: string; value: unknown }>({ key: '', value: undefined });
  const tut = TUTORIALS.find((t) => t.id === active?.id);
  const step = tut && active ? tut.steps[active.step] : undefined;
  // Each step starts from where things are when it first shows (taken right away, before it is checked).
  const key = active ? `${active.id}:${active.step}` : '';
  if (base.current.key !== key) base.current = { key, value: step?.begin?.() };
  const ok = !!step?.done && step.done(base.current.value);
  // Move on shortly after a step is done, so the tick is seen.
  useEffect(() => {
    if (!ok || !tut || !active) return;
    const t = setTimeout(() => setActive((a) => (a && a.step < tut.steps.length - 1 ? { ...a, step: a.step + 1 } : a)), 700);
    return () => clearTimeout(t);
  }, [ok, tut, active]);

  const finish = () => {
    if (tut && !doneIds.includes(tut.id)) { const n = [...doneIds, tut.id]; setDoneIds(n); savePref('tutorialsDone', n); }
    setActive(null);
  };

  if (!tut || !active || !step) {
    return (
      <div className="shaderpanel tutorials">
        <p className="dim">Short hands-on lessons. Each opens a practice sprite in a new tab, so your work is safe, and ticks a step off when you've done it.</p>
        {TUTORIALS.map((t) => (
          <button key={t.id} className="tut-card" onClick={() => { t.setup(); setActive({ id: t.id, step: 0 }); }}>
            <b>{doneIds.includes(t.id) ? '✓ ' : ''}{t.name}</b><span className="dim">{t.blurb} · {t.steps.length} steps</span>
          </button>
        ))}
      </div>
    );
  }
  const last = active.step === tut.steps.length - 1;
  return (
    <div className="shaderpanel tutorials">
      <h4>{tut.name}</h4>
      <div className="tut-progress" aria-label={`Step ${active.step + 1} of ${tut.steps.length}`}>
        {tut.steps.map((_, i) => <span key={i} className={i < active.step ? 'done' : i === active.step ? 'now' : ''} />)}
      </div>
      <p className="tut-text">{step.text}</p>
      {step.done && <p className={ok ? 'tut-ok' : 'dim'}>{ok ? '✓ Done!' : 'Waiting for you to do this…'}</p>}
      <div className="row wrap">
        {active.step > 0 && <button className="btn" onClick={() => setActive({ ...active, step: active.step - 1 })}>Back</button>}
        {step.show && <button className="btn" onClick={() => step.show!()}>Show me</button>}
        {!last && <button className={'btn' + (!step.done || ok ? ' primary' : '')} onClick={() => setActive({ ...active, step: active.step + 1 })}>{step.done && !ok ? 'Skip' : 'Next'}</button>}
        {last && <button className="btn primary" onClick={finish}>Finish</button>}
        <span className="grow" />
        <button className="btn" onClick={() => setActive(null)}>All tutorials</button>
      </div>
    </div>
  );
}
