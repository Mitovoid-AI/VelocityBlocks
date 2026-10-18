# Velocity Blocks

A single-player, block-built time-attack racer for **Web, Android and iOS**, inspired by the
TrackMania Nations Forever formula: snap road blocks together into a track, drive it as fast as
you can, take every checkpoint, and beat the author time. You can also build and share your own
tracks.

It's a clean-room build. The code, physics tuning, tracks, 3D models, textures and sounds are all
original, generated in code from scratch, and the game ships no third-party game assets. See
[`../analysis/REPORT.md`](../analysis/REPORT.md) for the static analysis of the original game and
how its design informed this one.

## Features

- **12-track campaign** (White → Black series) with Author / Gold / Silver / Bronze medals.
  Each track is checked by an autopilot that has to finish it, and that autopilot's time is the
  author time.
- **Arcade physics** at a fixed 100 Hz tick: a rigid body on four suspension rays with
  grip-limited tyres, a brake-tap drift, downforce, road adhesion over crests, boost and turbo pads,
  and jump ramps.
- **Off-road:** ground-level roads have no barriers, so you can drive onto the grass, which has
  less grip and tops out around 100 km/h. Raised decks keep their barriers, and gate posts,
  pillars and embankment sides are solid. A checkpoint only counts when you drive through its
  gate, between the posts, so a grass shortcut can't skip one.
- **Time attack rules:** a 3-2-1 countdown, a 10 ms timer, checkpoints in any order, a flying
  respawn at the last checkpoint (the clock keeps running), and an instant restart. A car stuck on
  its roof or side for 3 seconds goes back to the last checkpoint by itself (a warning bar on the
  HUD fills up first), or restarts if no checkpoint has been passed.
- **Driver profile:** the main menu is a home page with your profile card on top; tap it to edit.
  Set a photo (gallery or camera, cropped to 192 px and only used by the game, never uploaded),
  a name, the car colour and body style, the starting camera, tilt steering and auto-accelerate.
  A skippable setup page asks for the photo and name on first launch.
- **Body styles:** Racer, Buggy and Muscle. They are looks only: every body uses the same physics.
- **Photo badge:** your photo (or a dummy silhouette when none is set) floats above your car while
  you race and in replays, and a dimmed copy rides on the personal-best ghost. It hides in the
  hood camera and can be switched off in the profile.
- **Ghosts:** your personal-best run is saved and raced against; split times are shown against it
  at every checkpoint.
- **Replays** with chase, far and trackside cameras at 1x, 0.5x and 0.25x speed.
- **Track editor:** 13 block types on a 32 × 32 grid with 8 height levels. Rotate, erase, undo,
  route validation, an autopilot check, test drives (your first finish sets the author time), and
  save, export and import as `.vbtrack.json`.
- **Controls:** keyboard, gamepad, on-screen touch buttons, optional tilt steering and
  auto-accelerate (both in the driver profile).
- **Procedural everything:** textures drawn on canvas, a low-poly car built from primitives,
  Web Audio engine, tyre and wind sounds, and a stadium environment.

## Controls

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Accelerate | ↑ / W | RT, A | ▲ |
| Brake / reverse (tap while steering to drift) | ↓ / S / Space | LT, B, X | ▼ |
| Steer | ← → / A D | Left stick, D-pad | ◀ ▶ or tilt |
| Respawn at checkpoint | Backspace / R | Y | ⟲ CP |
| Restart | Enter / Delete | Back | ↻ Restart |
| Camera | C | LB | Cam |
| Ghost on/off | G | | Pause menu |
| Pause | Esc / P | Start | ❚❚ |

Editor: click to place (on touch, tap a cell, then tap it again to place), **R** to rotate, **PgUp/PgDn**
to change level, **X** to erase, **Ctrl+Z** to undo. Drag to pan, Shift-drag or right-drag to orbit,
and scroll or pinch to zoom. Arrow keys plus Enter work too.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # physics determinism, builder, campaign autopilot validation
npm run build      # type-check + production bundle in dist/
```

Helper scripts are TypeScript. vite-node is not a dependency, so bundle one with the installed
esbuild and run it with node, from the project root:

```bash
npx esbuild scripts/author-times.ts --bundle --platform=node --format=esm --outfile=<tmp>/author-times.mjs
node <tmp>/author-times.mjs     # writes src/track/authorTimes.json relative to the working directory
```

- `scripts/author-times.ts` regenerates `src/track/authorTimes.json`. Run it after any physics
  change, and bump `PHYSICS_VERSION` in `src/core/constants.ts`. It fails if the autopilot misses
  the finish or needs a respawn on any campaign track. A bump resets PBs, ghosts and medals
  (old ghosts are deleted at startup), but campaign unlocks are kept. Version 4 (off-road)
  also gave A02, A05, A08, A10 and A12 extra checkpoints.
- `scripts/check-campaign.ts` builds every campaign layout and reports overlaps.
- `scripts/layout.ts "<track code>"` prints an ASCII map of a track code.
- `scripts/diag.ts "<track code>" [seconds] [bot|gas]` prints a physics trace.
- `node scripts/make-icons.mjs` regenerates the Android and iOS icons and splash screens.

## Browser builds with ads (CrazyGames, Poki)

The plain web build (`npm run build` → `dist/`) and the Android and iOS apps have no ads. Each
game portal gets its own build with its ad SDK. The network is picked by the Vite mode, which
reads `VITE_ADS` from `.env.<mode>`:

```bash
npm run build:crazygames    # → dist-crazygames/  (zip its contents and upload on developer.crazygames.com)
npm run build:poki          # → dist-poki/        (upload to the Poki Inspector)
npm run build:web           # both
npm run dev:adtest          # local fake ads: try the breaks, the rewarded unlock and the banner
npm run dev:crazygames      # CrazyGames SDK in its localhost mode (placeholder ads, demo banners)
npm run dev:poki            # Poki SDK in debug mode
```

What the ads do (all in `src/ads/`, never while driving):

| Placement | When | CrazyGames | Poki |
| --- | --- | --- | --- |
| Interstitial | Before a race picked from the campaign or My tracks, and on **Next track**. Retry, Restart and editor test drives stay instant. The network decides how often one really plays (CrazyGames: about one per 3 minutes). | `midgame` | `commercialBreak` |
| Rewarded | The first locked campaign track offers **Watch an ad to unlock** (finishing the previous track still unlocks it for free). Hidden when an ad blocker is detected. | `rewarded` | `rewardedBreak` |
| Banner | Under the home, campaign and My tracks screens, which leave room for it. 728×90 on large screens, 320×50 on smaller ones, none on landscape phones. | `requestBanner` | none (Poki sells the ads around its game frame) |

Input is blocked while an ad is requested, the game freezes and mutes while one plays, and
`gameplayStart`/`gameplayStop` follow the race (paused, results and menus count as stopped).
A first author medal sends CrazyGames' `happytime`, and its `muteAudio` setting is honoured. If
the SDK is blocked or fails to load, the game starts after a few seconds and plays without ads.

## Mobile builds (Capacitor 6)

```bash
npm run cap:sync            # build web + copy into android/ and ios/
```

**Android** (JDK 17 + Android SDK 35):

```bash
cd android
gradlew.bat assembleDebug   # Windows  (./gradlew on macOS/Linux)
# → android/app/build/outputs/apk/debug/app-debug.apk
```

For a Play Store release, create a keystore, configure `signingConfigs` in
`android/app/build.gradle`, and run `gradlew bundleRelease`.

**iOS** needs macOS with Xcode 15+ and CocoaPods:

```bash
npx cap sync ios
cd ios/App && pod install
npx cap open ios            # select a team and signing, then Run or Archive
```

Both apps lock to landscape, hide the system bars and keep the screen awake while running.

## Project layout

```
src/
  core/       constants (grid 32 m x 8 m cells, 100 Hz tick), vector/quaternion maths
  track/      block catalogue, track model + surface/barrier queries, text builder,
              route tracer, campaign, JSON file format, author times
  physics/    vehicle simulation (pure TS, runs headless)
  game/       race session (timing, checkpoints, respawn), ghosts, autopilot, medals, storage
  render/     three.js world, procedural textures, track meshes, car, camera rig, smoke
  audio/      Web Audio engine/effects
  input/      keyboard, gamepad, touch, tilt
  app/        app shell + menus, race, replay, editor modes
  ads/        browser-build ads: network-agnostic wrapper, CrazyGames, Poki and test adapters
  ui/         HUD, DOM helpers, styles
tests/        vitest suites
scripts/      dev tools (see above)
android/ ios/ Capacitor native projects
```

## Track text format (campaign authoring)

`St` start, `F` finish, `C` checkpoint, `S` straight, `B` boost, `T` turbo, `R`/`L` tight curve,
`R2`/`L2` wide curve, `U`/`D` slope up/down (2 cells, 1 level), `J` jump ramp, `G` gap,
`@n` set level, `x3` repeat. Example: `St Sx2 C Sx2 R2 Sx2 C S L2 Sx2 F`.
