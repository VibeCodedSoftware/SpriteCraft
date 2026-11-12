# SpriteCraft 1.0

A pixel art and sprite animation editor. This version is the core editor, the Animation Studio (tweens, easing curves,
wave warp, animated and live brushes), the Rig, which turns characters drawn in parts in 3D, Lighting, with normal maps
and moving lights, Shaders, including water, pixel Particles, Weather (rain and snow), and a Node editor that wires them
together.

## Start

Two ways to get it:

- **Installer** (`SpriteCraft-1.0.0-setup.exe`): installs for you only, with no administrator rights, into
  `%LOCALAPPDATA%\Programs\SpriteCraft`, with Start menu and desktop shortcuts. Run a newer one to update. Remove it from
  Settings › Apps. It isn't signed, so Windows may say it doesn't recognise it: choose More info › Run anyway.
- **Zip**: unzip anywhere and run `SpriteCraft.exe`. Nothing is installed.

It needs the WebView2 runtime, which comes with Windows 10 and 11. Sprites are saved in
`%LOCALAPPDATA%\CraftApps\SpriteCraft` (uninstalling keeps them). Unsaved work is autosaved every 30 seconds and offered
back the next time you start.

New to it? **View › Tutorials** has five short hands-on lessons, from your first pixels to effects that move.

## If it feels slow

**View › Performance** times each layer's live effects and the whole loop. Live effects are kept once drawn, so the
second play-through is smooth. On a slow machine, untick "Show live effects on the canvas" while you draw (exports
still include them), or bake heavy layers into frames.

## What it does

- **Draw:** pencil with pixel-perfect lines, eraser, dither brush, pattern brush, shade brush, custom brushes, symmetry.
- **Shapes and fills:** line, rectangle, ellipse, polygon, bucket, dithered gradient, colour replace, eyedropper.
- **Select and transform:** rectangle, ellipse, lasso, magic wand; move, scale, flip and rotate with no new colours.
- **Layers:** groups, 19 blend modes, opacity, alpha lock, clipping masks, layer masks, reference images.
- **Colour:** palettes, ramps, palette from image, indexed mode, .gpl and .hex palette files.
- **Animation:** frames, tags, linked cels, onion skin, per-frame timing, ping-pong playback.
- **Guides:** pixel grid, tile grid, 2:1 isometric and diamond grids, angle-locked lines.
- **Effects:** outline, drop shadow, hue/saturation/value, brightness/contrast, invert, map to palette, wave warp. Any
  effect can be animated across frames, blending its settings from a start to an end value.
- **Tweens (new in 0.2):** select frames and press **Tween** in the timeline. In the Animate panel, set move, rotation,
  scale, opacity, hue or brightness on any frame to add a key. Choose easing presets, steps or a custom curve, a curved
  path, and squash and stretch. Frames the tween makes show as dashed dots; paint on one and it stays as you drew it.
- **Animated brushes (new in 0.2):** Edit › Set animated brush from selection turns several frames into one brush that
  changes image as you paint.
- **Live brush (new in 0.2):** the **Live** button beside the brush size opens the Brush panel: spacing, scatter, density,
  size and colour variation, pen pressure, and turning or mirroring the brush in quarter turns (which keeps its exact
  pixels).
- **Rig: turn characters in 3D (new in 0.3):** draw each body part on its own layer, then Sprite › Rig › Make a rig.
  Give the bones parents (an arm hangs from the body) and joints, and pose them with sliders or orbit by dragging the
  preview. Each part is a ball, tube, box or card, or carved from your front and side drawings so a nose sticks out
  side-on. Draw ¾ and back views for the best turns. Render the frame, the keyed animation or a full turnaround onto a
  new layer as ordinary pixels you can touch up. Facing front, every part looks exactly as you drew it.
  Arms and legs drawn on one layer can bend: pick the part, choose a row and press **Add a bend here** for an elbow or
  knee, then use **Bend (Z)** on the new bone and key it over frames.
  The bones are drawn over the Rig preview: drag one to bend it, and a key is set on the current frame. Step frames with
  the buttons under the preview, pose each one, then **Render frames** to turn it into pixel art, like a walk cycle.

- **Lighting (new in 0.4):** Sprite › Lighting. **Make normals** builds a normal map from your art, each layer its own
  rounded shape, on a hidden "Normals" layer you can show and paint (pick a surface direction on the sphere first). Add
  point, spot and sun lights, drag them on the preview, set colour, height, reach, shine and flicker, and tick "Key on
  this frame" to animate them. Light snaps to a few steps like a shading ramp, optionally only in palette colours.
  Render this frame or all frames to a new layer.

- **Shaders (new in 0.5):** Sprite › Shaders. Choose a layer and add live shaders to it: they run every time the frame is
  drawn, so playback and exports show them. For water, paint the water's shape on its own layer, put anything standing
  in it on layers above, and add **Water**: waves, reflections, foam, sparkles, and ripples where things touch it (click
  the preview to add your own). Also heat haze, wobble, pixel scatter, hue and palette cycling, gradient maps, dissolve,
  glitch, colour split, glow, halftone and **Custom formula**. Tick "Key settings on this frame" to animate a setting.
  Save stacks as presets or export them as `.spritefx.json` files to share.

- **Particles (new in 0.6):** Sprite › Particles (Ctrl+Shift+6), or the ParticleCraft workspace. Pick a preset (fire,
  smoke, sparks, magic sparkle, explosion, coin pickup, dust, hit flash, bubbles, heal, poison, portal) and it goes on a
  new layer. Click the preview to move it. Particles are drawn in whole pixels with stepped colours and dithered fades,
  and loop seamlessly over the animation (add frames to see them move). Add emitters and set their shape, rate, bursts,
  speed, gravity, wind, drag, turbulence and swirl, a floor or bouncing off your art, and a mask. **Picture from
  layer** uses your own art as the particle. **Bake to frames** turns them into pixels you can retouch. Import and
  export ParticleCraft real-time effects (`.vfx.json`), or send them straight to the Craft apps.

- **Weather (new in 0.7):** Sprite › Weather (Ctrl+Shift+7), or the Water & Weather Studio workspace. Pick a mood
  (drizzle, light or heavy rain, storm, looking up into rain, light snow, snowfall, blizzard, big flakes); it goes on a
  new layer at the top and loops over the animation. Set density, speed, wind, streak length or flake size, and which
  depth layers fall. **Split into front and back layers** puts the nearest drops in front of everything; move the other
  layer under your character. Rain and snow land on the layers below (a sky that fills the canvas is left out; tick the
  layers you want), splash, and ripple on puddles you paint on the weather layer. Snow settles on top of things, steady
  or building up. Use your own flake from a layer. **Bake to frames**, or **Save transparent PNG frames** of the weather
  alone.

- **Node editor (new in 0.8):** Sprite › Node editor (Ctrl+Shift+8), or the Node Editor workspace. Add a graph to a
  layer, or start from a preset (moving light, noise dissolve, hologram, shadow and outline, rainy night, scrolling
  sky). Pick **+ Add node** (it's wired in after the selected node), drag from an output dot to an input dot to
  connect, click a connected input to disconnect, and press Delete to remove a node. Click a node for its settings;
  any number setting can be fed from **Time** or **Maths** to animate it. Every node shows a small preview. Save
  presets, export and import `.spritenodes.json`, or **Bake** the result into frames. You never have to use it: every
  other panel works on its own.

## Demo

`Demos\Rig demo.spritecraft` (File › Open) is a character drawn in parts, rigged with elbows and knees, waving over 8
frames. The rendered wave is on its own layer; the parts are hidden underneath. Open Sprite › Rig to pose him, turn him
round or re-render the animation.

## Make isometric tiles

**File › New isometric tileset** opens a base set of isometric tiles on a locked layer, with an empty layer above it to
draw on and a 32×32 grid.

## Files

Opens and saves `.spritecraft` projects, PNG, GIF, sprite sheets (with JSON), image sequences, and `.aseprite` files.

## With the other Craft apps

**File › Send to GameCraft / LogicCraft** writes your animation to the shared exchange folder. In GameCraft use
Particles › Import from ParticleCraft; in LogicCraft use Objects › + ParticleCraft…. It arrives as an animated sprite.
WorldCraft lists it under Place effect, but doesn't draw it in its view yet. **File › Open from the Craft exchange folder**
brings baked ParticleCraft flipbooks in as frames you can edit, and real-time effects in as pixel particles on a new
layer. Particle systems made here can go the other way from the Particles panel (16 pixels a metre).

## Handy keys

B pencil · E eraser · G fill · M select · V move · Ctrl+T transform · Alt+N new frame · Enter play · X swap colours ·
[ and ] brush size · Space or middle mouse pans · wheel zooms. All can be changed in Edit › Keyboard shortcuts.
