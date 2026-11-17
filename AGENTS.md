# AGENTS.md

Beat Bounce is a static web app (Vite, TypeScript, three.js r170, pnpm): a marble bounces down a
wall of bars, one bounce per melody note of a MIDI file, with user-placed wall art and an MP4
render in the browser. The look is ported from `adjiebrotot/anthem-bouncing`; the MIDI handling,
the editor model and the WebCodecs render follow `adjiebrotot/orchestra`. `README.md` describes
the features and the architecture.

## Rules

- **Pure core.** `src/core/` gets all inputs as arguments, reads no clock (a `now` function is
  passed in for timings), uses only seeded randomness (`core/rng.ts`), and touches no DOM. Its
  results are plain data, so it runs in the workers and in Node.
- **Frames are pure functions of time.** `Stage.renderAt(t)` must give the same frame for the
  same t, whatever the order of the calls. The MP4 render depends on this.
- **One plan.** The sound and the picture both come from one `Plan` (`core/plan.ts`). Put each
  rule about notes, hits and timing there, not in the stage or the synth.
- **Plan inputs.** `planInputOf()` lists everything that changes the layout or the sound. A
  change of anything else (colours of the ball, titles, the look of art) must not re-plan. Keep
  separate random streams for things that must not move the bars.
- **Wall art is placed by the user.** The planner treats art with `keepClear` as obstacles and
  art with `feature` as dwell zones and camera attractors. Do not move user art automatically,
  except the demo art in `App.#placeDemoArt`.
- **Projects stay loadable.** `normalizeProject()` fills new keys with defaults, so older saved
  and exported projects keep working. Add each new project key there.
- **Licenses.** Before you add a dependency, a font, a sound or a picture, check its license, add
  it to `tools/licenses.mjs`, and run the script. Pin exact versions.
- **Privacy.** The site makes no requests to other services and keeps the user's files in the
  browser.

## Work

- Commit on the session branch in small commits, one logical change each, with a Conventional
  Commit subject. Stage each path by its name, never `git add -A` or `git add .`.
- Before you finish: `pnpm typecheck`, `pnpm build`, and `pnpm smoke` (it starts and stops its own
  dev server and browser). For a change of the render, run `pnpm smoke --render`.
- A change of behaviour updates `README.md` in the same session.
- Stop each server and browser that you start.
