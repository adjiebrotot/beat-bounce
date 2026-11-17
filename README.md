# Beat Bounce

A marble bounces down a wall of bars and hits one bar exactly on each note of your MIDI file. Hang
photos, stickers and text on the wall, style the ball, and render an MP4 in your browser. The site
is static: your files stay in your browser.

The look comes from [anthem-bouncing](https://github.com/adjiebrotot/anthem-bouncing) (the physics
planner, the stage, the synth), and the app mechanics from
[Orchestra](https://github.com/adjiebrotot/orchestra) (MIDI files, the editor in the browser, the
MP4 render with WebCodecs).

## What you can do

- **Song.** Open a MIDI file (or drop it on the stage), or try the demo song. For each track,
  choose a role: **Bounce** (the ball hits a bar on each note), **Fill gaps** (bounces where the
  melody rests), **Backing** (strings, pad, brass, organ, bass or piano that only sound), or
  **Off**. Merge fast notes, play only chord tops, trim the song, and set the intro and outro.
- **Instruments.** Split the song into sections. Each section has an instrument (xylophone,
  marimba, glockenspiel, vibraphone, kalimba, steel pan, boomwhackers, music box, tubular bells),
  a label at the top of the video, and bar colours (preset, one colour, cycle, random, main colour
  with accents, or rainbow by pitch).
- **Ball.** Marble, earth, glass with a coloured core, metal, rubber, beach ball, neon, or any
  picture wrapped on the ball (a flag, a logo) with a focus point that faces the camera. Set its
  colours, size, shine and glow, and turn on a trail.
- **Wall art: the placement tool.** Add a **photo**, a **sticker** or **text**, then place it on
  the wall by hand:
  - Drag it to move it. Drag a corner to resize it. Drag the round handle to turn it (hold
    Shift for steps of 15°). Arrow keys nudge it, Delete removes it, Ctrl+D duplicates it.
  - **Photos:** your picture, a crop, and a frame: wood, black, white, gold, silver, painted,
    polaroid (with handwriting), canvas wrap, or none. Add a mat (passe-partout) and a caption
    plate.
  - **Stickers:** ten built-in stickers or your own PNG/SVG, with a die-cut border in any colour,
    glossy or matte.
  - **Text:** painted on the wall, raised letters that cast shadows, or neon. Choose the font,
    weight, colour, outline and alignment.
  - **Keep bars clear** makes the layout go around the art. **Feature it** makes the ball linger
    near it and the camera lean towards it.
  - **Film** view shows what the video shows at the playhead. **Overview** looks straight at the
    whole wall: drag to pan, scroll to zoom. It shows the path of the ball and the frame of the
    film camera, so you can see where art will be seen.
  - Drop a picture on the stage to hang it where you drop it.
- **Scene.** Wall surface (plaster, smooth, concrete, brick, planks) and colour, light direction,
  height and colour, exposure, tone mapping, vignette, the camera (distance, angle, field of view,
  smoothness), and the physics (gravity, room to the sides, bar length, rails for long rests).
- **Titles.** Title card, end card, watermark, section labels, and captions (for example lyrics)
  at the bottom of the video.
- **Video shape.** 16:9, 9:16 (Shorts, Reels, TikTok), 1:1 or 4:5. Narrow shapes get a narrower
  lane and keep the ball clear of the platform UI.
- **Render MP4.** 720p to 4K, 30 or 60 fps, Draft, High (anti-aliasing, motion blur, soft shadows
  and ambient occlusion) or Ultra. Render the first 10 seconds as a test first.
- **Projects.** The editor saves your project and files in the browser (IndexedDB). Undo and redo
  work for each change. **Project → Export** saves one `.json` file with the MIDI and the
  pictures inside; **Import** opens it on another computer.

If some bars may touch something (a dense passage, or art in the way), the Song tab says so.
**Find a clean layout** tries other seeds and a little more gravity until no bar touches.

## Keyboard

| Key | Action |
|---|---|
| Space | Play or pause |
| Left / Right | Seek 5 s (1 s with Shift); nudge the selected art |
| Up / Down | Nudge the selected art |
| Home | Back to the start |
| O | Film view or overview |
| Delete | Remove the selected art |
| Ctrl+D | Duplicate the selected art |
| Escape | Deselect |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |

## About the render

Each frame is a pure function of time, so the render does not run in real time: the page draws
each frame at full quality and encodes it with WebCodecs (H.264, else VP9 or AV1; AAC, else Opus),
then [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) writes the file. Before the render, each
encoder must encode a small test file, as in Orchestra, so a broken hardware encoder gives way to
a software one. Keep the tab open while it renders. Use a current Chrome, Edge or Safari; Firefox
can render too, with Opus audio.

The speed depends on the GPU: High draws 4 sub-frames per frame and Ultra 8. Without a GPU, WebGL
runs on the CPU and is much slower (in a test container with software WebGL, a 720p Draft render
ran at about 1 frame per second).

## Run locally

Needs Node.js 20.19 or newer and pnpm 10.

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # static site in dist/
pnpm typecheck
pnpm smoke        # headless Chromium smoke test, screenshots in out/smoke/ (add --render for an MP4)
```

`pnpm demo-midi` writes the demo song again (`tools/make-demo.mjs`: the public-domain "Ode to Joy"
theme, written out note by note).

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` builds the site and publishes it on each push to `main`.

1. In the repository settings, open **Pages** and set **Source** to **GitHub Actions**.
2. Optional: set a custom domain (for example `beat-bounce.adjiebrotots.com`) in the Pages
   settings, add a `CNAME` record for it at the DNS host, and put the domain in `public/CNAME`.
   The build uses relative paths, so it works on a custom domain and under `/beat-bounce/`.

## How it works

```text
MIDI file ─> core/midi ─> melody hits ─┐
project.json (your choices) ───────────┼─> core/plan (Web Worker) ─> Plan ─┬─> stage/ (three.js) ─> preview / MP4 frames
wall art footprints (obstacles) ───────┘   physics planner, camera,        └─> core/synth (Web Worker) ─> audio
                                            ball and bar tracks
```

- `src/core/` is pure (no DOM, no clock, seeded randomness): MIDI analysis, the choreography
  planner (ballistic flights, bars oriented by reflection, rails for rests, collision checks with
  backtracking), the film camera, the ornament footprints, and the synthesizer.
- `src/workers/` runs the planner and the synth off the main thread; only the newest request
  runs.
- `src/stage/` draws a plan with three.js: the anthem-bouncing look (sub-frame accumulation,
  realism-effects HBAO, texel-snapped soft shadows, bloom and filmic tone mapping), plus the ball
  styles, the trail and the wall art.
- `src/app/` holds the project store (undo, autosave), the assets in IndexedDB, the player and the
  MP4 render. `src/ui/` is the editor.

## Licenses

The libraries keep their own licenses (three.js MIT, postprocessing Zlib, @tonejs/midi MIT,
mp4-muxer MIT, realism-effects MIT, vendored in `src/vendor/`). `public/third-party-licenses.txt`
holds their texts (`node tools/licenses.mjs` writes it), and the Project menu links it. The
built-in stickers and the demo song were made for this project. You own the videos that you make.
