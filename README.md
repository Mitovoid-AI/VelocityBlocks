# Velocity Blocks

A single-player, block-built time-attack racer for **Web, Android and iOS**, inspired by the
TrackMania Nations Forever formula: snap road blocks together into a track, drive it as fast as
you can, take every checkpoint, and beat the author time. You can also build and share your own
tracks.

It's a clean-room build. The code, physics tuning, tracks, textures, sounds and the Classic vehicles
are all original, generated in code from scratch. The optional Realistic vehicles are the one
exception: third-party 3D models used under CC BY 4.0 (see [Third-party assets](#third-party-assets)).

Velocity Blocks is open source under the [MIT License](LICENSE). The MIT license covers the code
only; the vehicle models in `public/vehicles/` keep their own license.

## Features

- **12-track campaign** (White → Black series) with Author / Gold / Silver / Bronze medals.
  Each track is checked by an autopilot that has to finish it, and that autopilot's time is the
  author time.
- **Arcade physics with F1-style handling** at a fixed 100 Hz tick: a rigid body on four
  suspension rays with slip-angle tyres, rear-wheel drive, aero downforce through the springs (fast
  corners hold more grip than slow ones), ABS brakes, steering lock that eases off with speed,
  traction control (Normal, or Low to let the rear wheels spin), a brake-tap drift, road adhesion
  over crests, boost and turbo pads, and jump ramps.
- **Racing line:** an optional coloured line on the road (green: full throttle, yellow: lift, red:
  brake) from a pace driver that plans with the car's real grip and braking limits. The 12 campaign
  lines are precomputed; custom tracks get theirs worked out in the background. Toggle it in the
  pause menu.
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
  a name, the car colour and body style, the starting camera, steering, pedals, traction control,
  the racing line and auto-accelerate. A skippable setup page asks for the photo and name on first
  launch.
- **Body styles:** Racer, Buggy, Muscle and Formula (open wheels, wings and halo). They are looks
  only: every body uses the same physics.
- **Photo badge:** your photo (or a dummy silhouette when none is set) floats above your car while
  you race and in replays, and a dimmed copy rides on the personal-best ghost. It hides in the
  hood camera and can be switched off in the profile.
- **Ghosts:** your personal-best run is saved and raced against; split times are shown against it
  at every checkpoint.
- **Replays** with chase, far and trackside cameras at 1x, 0.5x and 0.25x speed.
- **Track editor:** 13 block types on a 32 × 32 grid with 8 height levels. Rotate, erase, undo,
  route validation, an autopilot check, test drives (your first finish sets the author time), and
  save, export and import as `.vbtrack.json`.
- **Controls:** keyboard, gamepad (analog triggers) and touch. On touch, steer with the ◀ ▶ buttons,
  an on-screen steering wheel or by tilting the device (gyro), and drive with analog gas and brake
  bars on the side (or round on/off pedals). Switch steering from the pause menu, Settings or the
  driver profile. Auto-accelerate is in the driver profile.
- **Android pause handling:** the touch controls keep out of the system gesture strips (and ask
  Android to exclude them from the back gesture), a Back swipe that the system takes from a thumb
  on the controls is ignored during a race (tap ❚❚ to pause), and a brief loss of focus (a
  notification, an overlay) no longer pauses the race. The pause screen says why it paused, with a
  small diagnostics line.
- **Procedural everything:** textures drawn on canvas (asphalt with a roughness map, kerbs, turf,
  concrete), cars built from lofted and rounded parts with real wheels and lamp glow, a stadium
  with stands, roofs, floodlights, LED boards, trees and hills, a sky with clouds, image-based
  lighting, soft shadows, and bloom on High (desktop). Web Audio engine, tyre and wind sounds.
  Graphics quality: Low, Medium (phones) and High. Append `?fps` to the URL for a frame-rate overlay.

## Controls

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Accelerate | ↑ / W | RT, A | ▲ |
| Brake / reverse (tap while steering to drift) | ↓ / S / Space | LT, B, X | ▼ |
| Steer | ← → / A D | Left stick, D-pad | ◀ ▶, wheel or tilt |
| Respawn at checkpoint | Backspace / R | Y | ⟲ CP |
| Restart | Enter / Delete | Back | ↻ Restart |
| Camera | C | LB | Cam |
| Ghost on/off | G | | Pause menu |
| Racing line on/off | | | Pause menu |
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
  (old ghosts are deleted at startup), but campaign unlocks are kept, and custom-track author
  times are cleared once. Version 4 (off-road) also gave A02, A05, A08, A10 and A12 extra
  checkpoints; version 6 is the F1-style handling.
- `scripts/racing-lines.ts` regenerates `src/track/racingLines.json` (the precomputed campaign
  racing lines). Run it after `author-times.ts`; the campaign tests fail while it is stale.
- `scripts/handling-bench.ts [all|accel|brake|skid|corner|power|drift|grass|bot|touch]` prints the
  handling numbers (top speed, 0-100, braking distances, cornering limits, drift, author totals).
- `scripts/check-campaign.ts` builds every campaign layout and reports overlaps.
- `scripts/layout.ts "<track code>"` prints an ASCII map of a track code.
- `scripts/diag.ts "<track code>" [seconds] [bot|gas]` prints a physics trace.
- `node scripts/make-icons.mjs` regenerates the Android and iOS icons and splash screens.
- `scripts/build-vehicles.ts [id...]` rebuilds the Realistic vehicles (`public/vehicles/*.glb` and
  `CREDITS.md`) from the authors' unzipped Sketchfab glTF downloads in `../assets-src/<folder>/`
  (never committed; override with `VB_ASSETS_SRC`) with gltfpack 1.3 (`../tools/gltfpack/gltfpack.exe`
  or `GLTFPACK`). It bakes each vehicle into the game's frame, names the wheels, strips material
  extensions, whitens baked paint, then compresses (meshopt geometry, KTX2 textures) and checks the
  phone budget. `tests/vehicleAssets.test.ts` checks the shipped files again.

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

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck` and
`npm test`, and add tests in `tests/` for physics, timing or track-format changes. A change to the
physics must also bump `PHYSICS_VERSION`, because records and ghosts from older versions no longer
match.

## Third-party assets

The Realistic vehicles (Profile > Vehicle > Realistic) are 3D models by other authors, used under the
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) license. They are
**not** covered by the MIT license. The game credits them in Settings > Credits, and
[`public/vehicles/CREDITS.md`](public/vehicles/CREDITS.md) lists each source, its author, the
attribution line from the download and what was changed.

- "Generic passenger car pack" by Comrade1280
  (https://sketchfab.com/3d-models/generic-passenger-car-pack-20f9af9b8a404d5cb022ac6fe87f21f5):
  the Sport, Coupe and Sedan.
- "Cafe Racer" by Milin Andrei (https://sketchfab.com/3d-models/cafe-racer-c02dec85ac0541b8ab6dd56098706b50):
  the Realistic bike (its rider is the game's own).
- "LCT 3000 '95 - Low poly model" by Daniel Zhabotinsky
  (https://sketchfab.com/3d-models/lct-3000-95-low-poly-model-663a0953c038434a918cb85725c88ffa):
  the Realistic truck.

The KTX2 texture transcoder that loads them (three.js `examples/jsm/libs/basis`, Apache-2.0) is
bundled from the `three` package by the build.

## License

[MIT](LICENSE) © 2026 Mitovoid-AI, for the code. The vehicle models in `public/vehicles/` are
CC BY 4.0 (see [Third-party assets](#third-party-assets)).

TrackMania is a trademark of Ubisoft and Nadeo. Velocity Blocks is an independent project and is
not affiliated with or endorsed by them.
