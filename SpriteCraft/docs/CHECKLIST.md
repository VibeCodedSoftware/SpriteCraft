# Feature checklist

## Phase 1, the editor: version 0.1

**Clicked** = done with real mouse or keyboard input in the dev app, result checked. **Tests** = covered by automated tests.
**Built** = written, and the code runs, but the control itself wasn't operated. The packaged exe has only been started.

| Feature | State | Evidence or limit |
|---|---|---|
| Pencil, pixel-perfect, eraser | Clicked, tests | |
| Line, rectangle, ellipse, polygon | Clicked, tests | Exact 2:1 lines step in clean pairs |
| Bucket, contiguous or global, tolerance | Clicked, tests | |
| Gradient with dither | Clicked | Radial and palette modes not operated |
| Colour replace, eyedropper | Clicked | |
| Dither brush | Clicked | |
| Pattern brush, shade brush, custom brush | Built | |
| Symmetry | Built | |
| Selection: rectangle, wand, lasso | Clicked, tests | Ellipse select shares the rectangle's code, not operated |
| Move and transform | Clicked, tests | Rotation kept the colour count. Pixels rotated or moved past the canvas edge as a selection are lost; a whole-cel move keeps them. Handle scaling is covered by tests of the sampler only |
| Cut, copy, paste, paste from system | Built | |
| Layers, groups, duplicate, delete | Clicked, tests | Drag-and-drop reordering not operated; the up and down buttons are the same operation |
| Locked layers refuse edits | Clicked | |
| 19 blend modes, opacity, clipping, groups | Tests | Blend menu not operated |
| Layer masks | Clicked, tests | |
| Alpha lock, reference layers | Tests | Via the surface and compositor |
| Palettes, presets, ramps, extraction, files | Tests | Dialogs not operated |
| Indexed mode | Tests | Stored as RGB locked to the palette. Two identical palette entries can't be told apart |
| Frames, duplicate, linked cels, tags | Clicked, tests | |
| Playback | Clicked | Ping-pong via code path, not watched |
| Onion skin | Built | |
| Tile, iso and diamond grids, guides | Tile grid seen; rest built | Guides are placed by number, not dragged |
| Isometric tileset template | Clicked | Art supplied by the project owner |
| Autosave and recovery | Clicked | Real recovery after a server restart: all 142 pixels returned |
| Save and open in the app | Built | Same reader and writer as tested files |
| PNG, GIF, sheet, sequence, .aseprite export | Clicked through the real dialog | Output decoded and compared, except zip contents. The native save dialog was bypassed in the test |
| .aseprite read | Tests | Includes a file built by hand from the spec. **No file from real Aseprite tried**, as Aseprite isn't installed here |
| Sprite sheet import, image sequences | Tests | Dialogs not operated |
| Effects | Tests | Dialog not operated |
| Custom shortcuts, workspaces, floating panels | Built | |
| Send to LogicCraft | Clicked | Imported, appears crisp, animates in Run |
| Send to GameCraft | Clicked | Imported with its own dialog, plays, `pixelArt: true` saved. **The small test sprite looked slightly rounded in play; not resolved** |
| WorldCraft | Not run | Reads `.vfx.json` names by existing code; draws nothing in its view |
| Licence guard | Tests | |

## Phase 2, Animation Studio: version 0.2

Tested on 2026-11-07. 98 automated tests pass, 26 of them in `tests/anim.test.ts` and 8 in `tests/dynamics.test.ts`.

| Feature | State | Evidence or limit |
|---|---|---|
| Tween from the current frame (timeline Tween button, Frame menu, Animate panel) | Clicked, tests | Opens the Animate panel by itself. Refuses to overlap another tween on the same layer |
| Keys for move X/Y, rotation, scale X/Y, opacity, hue, brightness | Clicked, tests | Typing a value sets a key on the current frame. A property's first key also anchors the resting value at the tween's start |
| Frames in between are generated and marked | Clicked, tests | Dashed dots in the timeline. Painting on one makes it a normal frame, which re-baking keeps |
| Reset a painted frame to the tween | Clicked, tests | Right-click the cel |
| Edit the original art | Clicked | Lays it out on the current frame; Done re-bakes every frame |
| Convert to frames, Delete tween | Tests | Buttons not clicked |
| Easing presets, steps, custom bezier curve editor | Clicked, tests | Handle dragged: frame 3 of 8 reached 88.6% of the move. One easing per key, shared by every property on that key |
| Curved motion path | Tests | Checkbox not clicked |
| Squash and stretch | Tests | Slider not moved |
| Whole-pixel moves, clean edges when turning, pivot | Clicked (rotation) | Rotation uses the 8× pixel-art enlargement, no new colours |
| Tweens in saves and autosave recovery | Clicked, tests | Recovered twice after page reloads, tween intact |
| Re-bake after frame, palette and size changes | Tests | Flipping or scaling the sprite doesn't move the pivot or mirror the keys yet |
| Wave warp: horizontal, vertical, both, ripple, local radius, edges | Clicked, tests | No new colours. Whole cycles loop exactly |
| Animate any effect across frames (start → end settings, easing, range) | Clicked (wave warp) | Preview plays in the dialog. On/off and choice settings can't blend, so they keep the start value |
| Animated brush from several frames | Clicked | Cycles along the stroke or follows the frame. "Follow the frame" mode not clicked. Use Live brush spacing to stop fast cycling smearing |
| Live brush: spacing, scatter, density, size and colour variation, pen pressure, quarter-turn and mirror | Clicked (spacing, scatter, hue), tests | A real stroke made about 11 dabs 6 px apart over 8 rows in 10 colours. Pressure only counts for a pen; no pen was available to try it. Turning and mirroring are covered by tests only |
| Onion skin | Built | Unchanged from 0.1 |

### Fixes in the other Craft apps (2026-11-07)

| Fix | Evidence |
|---|---|
| GameCraft blurred small pixel-art sprites in play: a scene pass reset every texture's magnification filter to linear | 8×8 checkerboard sent the SpriteCraft way, scaled 8×, played: hard edges. Pixel textures are recognised by their nearest-neighbour minification filter, the rule GameCraft already uses elsewhere |
| The import dialog in GameCraft and LogicCraft showed pixel-art flipbooks blurred | Thumbnail and preview now crisp in GameCraft. LogicCraft shares the dialog but wasn't opened |

## Phase 3, SpriteCraft 3D (the rig): version 0.3

Tested on 2026-11-07. 133 automated tests pass, 33 of them in `tests/rig.test.ts` and 2 in `tests/demo.test.ts` (the demo in the zip opens and re-renders). In the app, the Rig panel was driven
with real DOM events (buttons, selects, sliders, dragging the preview); the test character was set up in code.

| Feature | State | Evidence or limit |
|---|---|---|
| Make a rig from the visible layers, one part and bone per layer | Clicked, tests | Shapes guessed from layer names, then proportions: head ball, arms tubes, body box |
| Bone parents, joints (X, Y, Z), card depth | Clicked, tests | Loops between bones are refused |
| Pose bones in real time (tilt, turn, bend); a key on release | Clicked, tests | One undo step per change |
| Orbit the preview by dragging; camera turn and tilt keys | Clicked, tests | |
| Part shapes: ball, tube, box, flat card | Seen, tests | At rest every shape shows the drawing pixel for pixel |
| Carve a part from front and side drawings | Seen, tests | Profile with nose at 90°; assigning a side view switches the part to carved |
| Round corners (carved), fullness, flat front, taper, lean (other shapes) | Tests | Sliders seen in the panel, effect checked by tests only |
| Each part keeps to the drawing nearest the camera; plain row colours fill steep surfaces | Seen, tests | No doubled eyes or mouths between drawings |
| Three-quarter view projected at 45° | Seen, tests | Without one, 45° is clean but can't show true corner detail |
| Small features (eyes) kept when a face is squeezed | Seen, tests | Both eyes at 35° and 45° on the test head, one pixel each |
| Shading in three bands with a dithered edge | Seen, tests | At most two darker tones per colour; 0% adds none |
| Back without a back view: hair (top colour), outline colours, mirrored, as drawn, one colour | Seen, tests | Carved parts use the back of the side drawing |
| Depth sorting as the character turns | Tests | The arm passes behind the body from behind |
| Parts hold their latest drawing on frames without one | Seen | Keyed camera turn rendered over 5 frames |
| Render this frame, the keyed frames, or a turnaround to a new layer | Clicked | Part layers are hidden so nothing shows twice |
| Rig saved with the sprite | Built | Stored in the document like tweens; save and reload not tried |
| Bends inside a part (elbows, knees), several per part, removable | Clicked, tests | Added through the panel on a one-layer arm and leg, then bent with the sliders. Lower pieces carry rows above the joint, so it stays filled (tested: the leg stays one connected shape) |
| Limbs jointed at the shoulder or hip by default | Tests | Tube-shaped parts get their joint near the top |
| Bones drawn over the Rig preview; drag a bone to bend it and key the frame | Clicked, tests | A 4-frame side-on walk cycle was keyed only by dragging bones and rendered. Facing front a drag keys Bend (Z); side-on it keys Tilt (X), so the bone follows the pointer |
| Previous / play / next / + Frame in the Rig panel | Built | Play and step were used while keying the walk through the editor; the buttons themselves weren't clicked |

## Phase 4, Lighting Studio: version 0.4

Tested on 2026-11-08. 145 automated tests pass, 12 of them in `tests/light.test.ts`. In the app the Lighting panel was
driven with DOM events on the demo character (8 frames).

| Feature | State | Evidence or limit |
|---|---|---|
| Make normal maps from the art: each visible layer its own rounded shape, detail from brightness | Clicked, tests | 8 frames of normals made onto a hidden "Normals" layer. Slopes checked at each edge |
| Normal picker: set the paint colour to a surface direction, paint normals with any tool | Tests | Picker maths tested; painting with it not tried |
| Use any layer as the normal map (import, or paint your own) | Built | Selector in the panel; an imported PNG normal map not tried |
| Point, spot and directional lights; colour, intensity, height, reach, direction, cone, soft edge, shine, flicker | Clicked, tests | A warm point light and a blue spot lit the demo's wave |
| Drag lights on the preview; key position on a frame; keyed intensity and height | Clicked (drag), tests | Keyed movement tested, not watched in the app |
| Banded shading (steps), optional dither, palette-only, ambient | Seen, tests | Bands step brightness, not each channel, so coloured light keeps one ramp |
| Shadows from the surface | Tests | Height rebuilt from the normal map; a ridge shadows the ground behind it. Not tried on art in the app |
| Render this frame or all frames, lit, to a new layer | Clicked | 8 lit frames rendered |

## Phase 5, Shader Studio: version 0.5

Tested on 2026-11-08. 161 automated tests pass, 16 of them in `tests/shaders.test.ts`. The shader reference link in the
brief is wrong, so this phase follows the brief's effect list, the water reference's title, and common pixel-art
techniques.

| Feature | State | Evidence or limit |
|---|---|---|
| Live shader stacks on layers, run whenever a frame is drawn (canvas, playback, exports) | Clicked (water added), tests | A region drawn alone matches the same part of the full frame |
| Turn shaders on and off, reorder, remove; key number settings per frame | Tests | Keyed dissolve tested; the panel's buttons not clicked |
| Presets (built-in and saved), import and export as `.spritefx.json` | Built | Not clicked. Multi-shader presets add as one step |
| Water: waves, reflection of the scene above the waterline, see-through, depth colour, foam, sparkles | Seen, tests | Hill and legs reflected; about 2 ms per 64×64 frame |
| Water: ripple rings where things touch it, trails, typed or clicked ripple points | Seen, tests | Rings around a wading character's legs. Parts of a character under the waterline are not hidden by the water, since the water layer is drawn underneath it |
| Heat haze, wobble, pixel scatter | Tests | Only move pixels: no new colours |
| Hue cycle, palette cycle, gradient map, moving gradient tint | Tests (palette cycle) | |
| Dissolve, glitch, colour split, glow, halftone | Tests (dissolve, glow) | |
| Custom formula shader | Tests | Own small maths language; names like `constructor` are refused (a test caught that) |
| Render all frames with shaders to a new layer | Built | Not clicked |

## Phase 6, ParticleCraft module: version 0.6

Tested on 2026-11-08. 178 automated tests pass, 17 of them in `tests/particles.test.ts`. A one-off check (not kept in
the suite, since it reaches into the Shared folder) loaded every one of ParticleCraft's 26 presets and drew them, and
ran SpriteCraft's exported graphs through ParticleCraft's own compiler, which gave back the same values.

| Feature | State | Evidence or limit |
|---|---|---|
| Particle systems live on a layer, drawn whenever a frame is drawn (canvas, playback, exports) | Clicked (Fire preset), tests | Particles move between frames |
| The same frame always draws the same; looping systems repeat exactly every loop, and the first frame is already full | Tests | Each particle is worked out from its number, so no state passes between frames |
| One-shot systems (bursts that start and end empty) | Tests | |
| Several emitters per system; point, line, box, circle and ring shapes | Clicked (added Explosion), tests | |
| Rate, bursts, lifetime, speed, direction, spread, outward speed | Tests | |
| Gravity, wind, drag, turbulence, swirl, pull or push towards a point | Tests (gravity) | Shift+click on the preview sets the pull point; not clicked |
| Bounce on a floor row, or off solid art in the layers below | Tests | |
| Pixel, round, spark, star particles, or a picture from another layer (its frames play over the particle's life) | Tests (picture) | Pictures turn in quarter turns only, which keeps their pixels |
| Stepped colour ramps, dithered or see-through fades, additive blending, snap to palette, masks | Tests | |
| 12 built-in presets | Tests | Each one draws something within a second |
| Bake to frames | Run in the app | Baked frames match the live frames pixel for pixel; undo brings the system back |
| Import a ParticleCraft real-time `.vfx.json` (panel, or File › Open from the Craft exchange folder) | Tests, all 26 ParticleCraft presets | Front view only. Mesh, path and cone shapes become points; extra force nodes and flipbook textures aren't brought across, and the import says so |
| Export a real-time `.vfx.json`, or send it to the exchange folder | Tests | Writes both the node graph ParticleCraft edits and the compiled layers the games play. 16 pixels a metre |

## Phase 7, Water & Weather Studio: version 0.7

Tested on 2026-11-08. 196 automated tests pass, 18 of them in `tests/weather.test.ts`. The snow reference link in the
brief is for an unrelated video, so this phase follows the brief's feature lists. Frames were also rendered to images
and looked at: rain past a sky layer onto a roof and the ground, snowfall settling, a blizzard, rain seen from below.

| Feature | State | Evidence or limit |
|---|---|---|
| Rain and snow live on a layer (canvas, playback, exports); the same frame always draws the same, loops are exact | Clicked, tests | Each drop falls a whole number of times per loop, from a new column each time |
| Moods: drizzle, light rain, heavy rain, storm, looking up into rain, light snow, snowfall, blizzard, big flakes | Clicked (light rain, snowfall), tests | Every mood draws something |
| Density, speed and speed variety, wind, flutter or drift, streak length, flake size | Tests (density, wind) | |
| Far, middle and near layers; split into a front layer at the top and a back layer | Clicked (split), tests | Far drops hide behind solid art. The back layer must be moved under the character by hand |
| Perspective (drops fan out as if looking up) | Seen, tests | |
| Landing on the ground row or on chosen layers below; full-canvas layers (a sky) left out by default | Clicked, tests | A test caught that a sky layer stopped all the rain at the top row |
| Splashes on tops of things; ripples on puddles painted on the weather layer | Seen, tests | Drops blown into a wall's side just stop. Over the Water shader, drops touching the water make its own ripples |
| Snow settling on surfaces open to the sky, steady (loops) or building up over the animation, with a shaded edge | Seen, tests | Not on puddles. Settled snow isn't itself a surface for flakes |
| Flakes that stay a moment where they land; your own flake picture from a layer | Tests | |
| Bake to frames | Run in the app, tests | Matches the live frames pixel for pixel, also with a front layer above |
| Save just the weather as transparent PNG frames (zip) | Built | Not clicked: it opens a save dialog |
| Water & Weather Studio workspace (Weather and Shaders panels) | Built | |

## Phase 8, Node Editor: version 0.8

Tested on 2026-11-08. 211 automated tests pass, 15 of them in `tests/nodes.test.ts`. In the app: started from the
Moving light preset, inserted a node after the selected one, dragged a wire, disconnected one, moved a node, fed a
setting from Maths in the inspector, undid it, deleted a node (the chain closes up), baked, and switched presets.

| Feature | State | Evidence or limit |
|---|---|---|
| A node graph on a layer, live (canvas, playback, exports) | Clicked, tests | Moving light changes 508 pixels between frames 1 and 3 |
| Inputs: this layer, another layer (hidden too), everything below, colour, noise (loops), gradient | Tests | |
| Animation: Time (progress, wave, frame, seconds), Number, Maths, fed into any number setting | Clicked, tests | Numbers are linked from the inspector, shown as dashed wires |
| Every registered effect and shader as a node, plus palette snap | Tests | Effects added later (plugins) appear automatically |
| Lighting: height map, normal map, light | Seen, tests | One light per Light node; chain them for more |
| Masks and compositing: mask (pixels or brightness), blend (all blend modes), silhouette, move | Tests | |
| Particles and weather nodes (presets) | Tests | Full control stays in their own panels |
| Wiring: drag to connect, click to disconnect, loops and wrong types refused, new link replaces old | Clicked, tests | |
| Each node shows a preview of its result on this frame; failing nodes are marked and passed over | Seen, tests | |
| 6 presets, saved presets, export and import `.spritenodes.json` (checked on import) | Tests (presets, import checks) | Saving files not clicked: it opens a save dialog |
| Bake to frames | Run in the app | Matches the live frames pixel for pixel |
| Node Editor workspace | Seen | On a small window the graph is cramped; it scrolls |

## Phase 9, Polish: version 1.0

Built as 0.9 and released as 1.0.0 on 2026-11-08, the first version with all nine phases of the plan.

Tested on 2026-11-08. 219 automated tests pass, 8 of them in `tests/polish.test.ts`.

| Feature | State | Evidence or limit |
|---|---|---|
| Live effects kept per document, frame and layer; reused for playback and redraws | Tests, measured | 128×128, 24 frames, water + fire + rain + node light: 7.8 → 0.6 ms a frame on replay, 7.7 → 0.5 ms for a small redraw. Same pixels with and without (test). Only the 3 newest documents keep results, within a memory budget |
| While drawing on one layer, other shaded layers can show as before the stroke | Tests | On by default; off in the Performance panel |
| Performance panel: time this frame per layer, time the whole loop, cache use, failures, settings | Clicked | Includes a canvas-only switch for live effects (slower machines) |
| A live effect that fails is passed over and listed; settings missing from older files take defaults | Tests | A test caught a water shader saved without settings crashing the frame |
| A panel that fails shows a message in that panel; the rest keeps working | Seen | Found when the Tutorials panel crashed the whole window |
| Menus close after choosing a workspace, and on Escape | Clicked | |
| Saved preferences keep lists as lists | Fixed | Lists were being turned into objects |
| Tutorials: 5 lessons on practice sprites, steps ticked by what you actually do | Run in the app | All five run end to end. Shown once on first launch; View › Tutorials after that |
| .aseprite export keeps what live effects show (drawn into those layers, with a note) | Tests | Read back, every frame matches the live frames. .spritecraft keeps them live; PNG, GIF, sheets and sequences draw them |
| Installer: per user, no administrator rights, Start menu and desktop shortcuts, Apps & features entry, uninstaller, updates in place | Run (sandbox) | Installed files match the zip; installing while SpriteCraft is open is refused cleanly; uninstalling removes files, shortcuts and the entry and keeps sprites. Tested in a test folder with a test registry key, not on the real Start menu. Unsigned, so Windows SmartScreen may warn the first time |

## Not in this version

Tilemap editing, an on-canvas gizmo for warp regions, animation events and separate tracks per property row in the
timeline, smooth skinned bends (a bend is a hinge between rigid pieces), painting depth directly, large-canvas performance measurements,
per-layer normal maps (one normal map for the whole picture), lights per layer, a node-based shader editor, GPU
shaders, water hiding what stands in it, particles in 3D or with ParticleCraft's extra force nodes, lightning and fog, wet surfaces, node groups (a graph inside a node), zooming the node view, GPU rendering of live effects, a signed installer, and
tutorials for the rig beyond a first look.
