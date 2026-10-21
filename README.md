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

- **24-track campaign** in three sets, Stadium (A01-A12), Desert (D01-D06: sand, dunes, mesas, sunsets)
  and Water (W01-W06: bridges and jumps over lakes and rivers, splash zones), each graded White → Black,
  with Author / Gold / Silver / Bronze medals.
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
- **Track editor:** 15 block types (water and splash zones too) on a 32 × 32 grid with 8 height levels. Rotate, erase, undo,
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
- `npm run release:apk` builds the APK for a GitHub release and prints the `gh release create` command (see
  [Releasing a new version](#releasing-a-new-version)).
- `scripts/build-vehicles.ts [id...]` rebuilds the Realistic vehicles (`public/vehicles/*.glb` and
  `CREDITS.md`) from the authors' unzipped Sketchfab glTF downloads in `../assets-src/<folder>/`
  (never committed; override with `VB_ASSETS_SRC`) with gltfpack 1.3 (`../tools/gltfpack/gltfpack.exe`
  or `GLTFPACK`). It bakes each vehicle into the game's frame, names the wheels, strips material
  extensions, whitens baked paint, then compresses (meshopt geometry, KTX2 textures) and checks the
  phone budget. `tests/vehicleAssets.test.ts` checks the shipped files again.

## Browser builds with ads (CrazyGames, Poki)

The plain web build (`npm run build` → `dist/`) and the Android and iOS apps have no ads. Every browser build
has the whole game unlocked; only the Android app sells the [Full Game](#full-game-android-in-app-purchase). Each
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

**Android** (JDK 17 + Android SDK 35; the app runs on Android 6.0 / API 23 and up, the minimum of Google Play Billing Library 9):

```bash
cd android
gradlew.bat assembleGithubDebug   # Windows  (./gradlew on macOS/Linux)
# → android/app/build/outputs/apk/github/debug/app-github-debug.apk
```

For a Play Store release, create a keystore, configure `signingConfigs` in
`android/app/build.gradle`, and run `gradlew bundlePlayRelease`.

The app has two flavors with the same package name: `github` (the APK on GitHub Releases, which downloads and
installs its own updates and alone declares `REQUEST_INSTALL_PACKAGES`) and `play` (the `.aab` for Google Play,
which Play updates; Play forbids self-updates and that permission).

**iOS** needs macOS with Xcode 15+ and CocoaPods:

```bash
npx cap sync ios
cd ios/App && pod install
npx cap open ios            # select a team and signing, then Run or Archive
```

Both apps lock to landscape, hide the system bars and keep the screen awake while running.

**iPhone and iPad without the App Store:** Apple doesn't allow installing apps from a file, so the GitHub
releases have no iOS build. The website sends iPhone and iPad visitors to the browser game (`/play/`), which
Safari's **Add to Home Screen** turns into a full-screen app with its own icon (`apple-touch-icon.png` and the
`apple-mobile-web-app-*` tags in `index.html`). An App Store release needs the Xcode project above, a Mac and
an Apple Developer account.

## Windows app (Electron)

The Windows app is the same web build (`npm run build`) in an Electron window: `desktop/main.cjs` serves
`dist/` from `app://game/` (module scripts and the models don't load from `file://`), keeps links to other
sites in the default browser, toggles full screen with F11, and once a day checks the latest GitHub release.
The installed app downloads the new installer (progress on the taskbar button) and runs it; the portable
`.exe` opens the download in the browser. Records live in that origin's storage under
`%APPDATA%\Velocity Blocks`, shared by both builds and kept by updates and uninstalls.

```bash
npm run release:windows                 # type-check, build the game, pack both (about 100 MB each: Chromium)
npm run release:windows -- --no-build   # pack the dist/ that is already there
npm run desktop:run                     # run the last packed app with Electron, without installing
```

It makes `builds/VelocityBlocks-Setup-X.Y.Z.exe` (NSIS installer: choose the folder, Start menu and desktop
shortcuts, uninstaller) and `builds/VelocityBlocks-X.Y.Z-Portable.exe`, plus copies named
`VelocityBlocks-Setup.exe` and `VelocityBlocks-Portable.exe`, the fixed names the website's buttons and the
update check use, and prints the `gh release upload` command. The files are not code-signed, so SmartScreen
warns on the first run (More info > Run anyway) until a signing certificate is added. In the app the game is
the plain web build: everything unlocked, no in-game update pop-up (the window does that).

## Version

The version is set in one place: `"version"` in `package.json` (`X.Y.Z`). Everything else reads it:

- the web bundle gets it as `__APP_VERSION__` (`vite.config.ts` → `src/platform/appVersion.ts`), shown at the
  bottom of Settings (the line debug builds tap 7 times for the Full Game dev switch);
- `android/app/build.gradle` reads `package.json` for `versionName` (`1.2.0`) and computes
  `versionCode = X*10000 + Y*100 + Z` (1.2.0 → 10200), so a newer version always has a larger code. Google
  Play's last upload before this was versionCode 3 (1.2). Y and Z must stay under 100; the build stops otherwise.

`tests/appVersion.test.ts` fails if `build.gradle` hard-codes a version again, if `package-lock.json` disagrees,
or if the version cannot make a valid versionCode. (iOS still has its own `MARKETING_VERSION` in Xcode.)

## Updates (APK installs)

The Android app installed from an APK (a GitHub release, shared by hand) checks for a newer release by itself.
The Google Play app never does: Play updates it, and Play's policy forbids an app updating itself any other
way. The web, portal and `npm run dev` builds and iOS never check.

- **Who checks:** `src/platform/updates.ts` asks the app's plugin who installed it
  (`PackageManager.getInstallSourceInfo` on Android 11+, `getInstallerPackageName` below). Google Play
  (`com.android.vending`, `com.google.android.feedback`) or an installer Android will not name: no check.
  Anything else (the package installer, a file manager, `adb`) is an APK install.
- **When:** a few seconds after the menu is up, at most once every 24 hours (the last check time is kept in
  `vb.update`, which Reset records does not touch). It is one unauthenticated `GET` of
  `https://api.github.com/repos/Mitovoid-AI/VelocityBlocks/releases/latest` with an 8 s timeout. Offline,
  rate-limited (GitHub allows 60 unauthenticated requests an hour per IP) or any other failure: nothing is shown.
- **What it offers:** a release whose tag (`vX.Y.Z`) is newer than the app's version and that has an `.apk`
  asset from this repo's releases. Drafts and pre-releases are ignored. On the home page a pop-up says
  "Update X.Y.Z available" with the release notes (plain text, cut to 600 characters) and **Update now**,
  **Later** (also Android Back) and **Skip this version** (that tag is not offered again automatically).
- **Update now** (the `github` build on Android 7+) downloads the APK inside the game with a progress bar
  (`VbNativePlugin.downloadUpdate`, only from this repo's release downloads), checks it is this app at a higher
  versionCode, and opens Android's installer on it. The first time, Android asks to allow installs from
  Velocity Blocks ("Install unknown apps"); coming back with it allowed starts the install. Only the `github`
  flavor declares `REQUEST_INSTALL_PACKAGES`. On Android 6 and in app builds before 1.2.2 the button opens the
  APK's address in the browser instead, which downloads it for the player to open.
- **Settings > Check for updates** (APK installs only) checks at once and says "You're up to date", shows
  the pop-up (a skipped version too), or says it couldn't check.
- An update only installs over an APK signed with the **same key**: a debug-signed build updates debug
  builds, a release-signed build updates release builds. Switching keys means uninstalling first, which
  deletes progress. APKs released before 1.2.0 have no update check: install 1.2.0 or later by hand once.
- `npm run dev` with `?update=demo` shows the pop-up with sample data (no request), to check its layout.

## Releasing a new version

1. Bump `"version"` in `package.json` (and the root `version` in `package-lock.json`, e.g. with
   `npm version 1.3.0 --no-git-tag-version`). Run `npm run typecheck` and `npm test`.
2. Build the APK and get the publish command:

   ```bash
   npm run release:apk -- --notes "Faster menus, a new Desert track"   # release-signed: needs android/keystore.properties
   npm run release:apk -- --debug --notes-file notes.md               # debug-signed, like the APKs shared so far
   ```

   It runs `npm run build`, `npx cap sync android` and gradle (`assembleGithubRelease` or `assembleGithubDebug`), copies the
   APK to `builds/VelocityBlocks-vX.Y.Z.apk` and prints a command like this (it never publishes by itself):

   ```bash
   gh release create v1.3.0 "builds/VelocityBlocks-v1.3.0.apk" --repo Mitovoid-AI/VelocityBlocks --title "Velocity Blocks 1.3.0" --notes "Faster menus, a new Desert track"
   ```

3. Check the APK on a phone, then run the printed command (needs the [GitHub CLI](https://cli.github.com/),
   `gh auth login`). The tag must be `v` + the package.json version. Do not mark it as a draft or a pre-release:
   the apps only see the latest full release. The notes are what the update pop-up shows. Installed GitHub
   APKs (1.2.2 and later, Android 7+) download the update inside the game with a progress bar and open
   Android's installer; older ones open the download in the browser.
4. For Windows, `npm run release:windows` builds the installer and the portable `.exe` with the same version;
   run the `gh release upload` command it prints to attach them to the same release.
5. For Google Play, `npm run android:release` builds the `.aab` with the same version (Play installs never
   see the GitHub release).
6. Rebuild and publish the website (`npm run site:deploy`) and commit `docs/`, so the browser game matches.

## Website

The project site, https://mitovoid-ai.github.io/VelocityBlocks/, is a plain HTML/CSS/JS landing page (no
framework) with the web game under `/play/`. Its source is in `site/`: `index.html`, `styles.css`, `script.js`,
`404.html`, `.nojekyll`, the icons and the screenshots in `site/img/` (real 1280 × 720 captures, each with a
640 px copy). `site/privacy.html` is generated from `store/privacy-policy.md`; edit the Markdown.

The built site is committed in `docs/` (pages plus the game in `docs/play/`, about 5.5 MB): a ready-to-serve
static folder, so a host never needs the source. Rebuild and commit it after changing `site/` or the game.

```bash
npm run site:build              # type-check, render privacy.html, copy site/ to docs/ and build the game into docs/play/
npm run site:serve              # http://localhost:5371/VelocityBlocks/ (the same path as GitHub Pages)
npm run site:serve -- --root    # http://localhost:5371/ (docs/ at the top, as Vercel serves it)
npm run site:deploy -- --dry-run   # everything except the push
npm run site:deploy             # build and publish docs/ to the gh-pages branch
```

**Vercel:** import the repository, set **Root Directory** to `docs`, **Framework Preset** to *Other*, and leave
the build command and output directory empty (no build runs; only `docs/` is deployed).
`docs/vercel.json` (from `site/vercel.json`) adds trailing slashes, so `/play` becomes `/play/` and the
game's relative paths resolve, and sets caching and content types for the game files. Vercel redeploys on
every push to `main`.

- The download buttons link to `releases/latest/download/VelocityBlocks.apk`, so every new release is picked
  up without touching the site, as long as the release has an asset with exactly that name. `script.js` asks
  the GitHub API for the latest release only to show its version and size; offline or rate-limited, the
  static text stays and the buttons still work.
- The game in `play/` is the plain ad-free web build (everything unlocked) with a relative base; the build
  checks that the realistic models and the KTX2 transcoder are in it.
- `site:deploy` works in a temporary repository: it puts `docs/` on top of the current `gh-pages`
  (creating the branch the first time) and pushes without `--force`; your checkout and branches are not
  touched. Once, in the repository settings: **Pages > Build and deployment > Deploy from a branch >
  `gh-pages` / (root)**.
- `node scripts/build-site.mjs --no-game` rebuilds only the pages (keeps the last `play/`), for quick edits.

## Full Game (Android in-app purchase)

The Android app is free to play, with one optional, one-time purchase through Google Play: the
**Full Game** (a non-consumable "managed product" with the id `full_game`).

Only copies installed **from Google Play** sell it. An APK installed any other way (the GitHub release
APKs, a file shared over chat, adb) has everything unlocked, like the web build: Google only bills Play
installs, and the code is MIT anyway. The app asks Android who installed it (`isSideloadInstall` in
`src/app/fullGame.ts`); when Android won't say, it behaves like a Play install.

| Free | Full Game |
| --- | --- |
| The whole Stadium campaign (A01-A12) | The other Desert and Water tracks (D02-D06, W02-W06) |
| The first track of each themed set (D01, W01) | The Bike and the Truck, with their own records and medals |
| The Car with its four bodies (Racer, Buggy, Muscle, Formula) | The Realistic models (Sport, Coupe, Sedan, Cafe Racer, LCT 3000 '95) |
| The track editor and My tracks | |

The lock rule is data-driven (`src/app/fullGame.ts`): a campaign track needs the Full Game when it is
not in the Stadium set and not the first track of its set, unless its data says otherwise (`premium`).
The classes come from `PREMIUM_VEHICLES` (`src/core/vehicles.ts`) and the models from their `premium`
flag (`src/core/vehicleModels.ts`). Locked cards, classes and models carry a padlock and open the Full
Game screen; every race start (menus, Next track, Retry, replays, editor test drives) goes through
`App.startRace`, which refuses a locked one. A saved profile that points at a locked class or model
races the Car / Classic look and keeps its choice, so a purchase brings it straight back.

**Which builds sell it**

- **Browser builds** (`npm run dev`, the plain web build, CrazyGames, Poki): everything is unlocked.
  The portal builds earn from ads instead, and the code is MIT, so anyone can build it for free.
- **iOS**: no App Store product is set up, so everything is unlocked there too.
- **Android release builds**: Google Play billing only.
- **Android debug builds**: Google Play billing, plus a hidden developer switch: Settings > tap the
  version line 7 times > Follow store / Owned / Not owned.
- `npm run dev` with `?iap=free` or `?iap=owned` acts as a debug Android build with a fake store (a
  confirm dialog stands in for Google Play), to try the screens and the purchase flow in a browser.

**How it works.** Billing is [`cordova-plugin-purchase`](https://github.com/j3k0/cordova-plugin-purchase)
13.18.0 (CdvPurchase v13, Google Play Billing Library 9), which Capacitor runs as a Cordova plugin:
`npm run cap:sync` installs its native part and the `com.android.vending.BILLING` permission.
`src/platform/purchases.ts` is a thin wrapper: it registers `full_game`, reads the price, runs the
purchase, acknowledges (finishes) approved purchases, handles pending payments, Restore purchases,
cancellations and errors, and never throws when the plugin or Google Play is missing. There is no
receipt server: the entitlement is stored on the device (`vb.fullgame`, untouched by Reset records)
so the game works offline, and it is checked against Google Play's purchase list on every start (a
refunded purchase locks again).

What has to be set up in the Play Console (product, price, license testers, internal testing) is in
[`store/play-store-listing.md`](store/play-store-listing.md#in-app-purchase-full-game).

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
  app/        app shell + menus, race, replay, editor modes, Full Game rules and store screen
  ads/        browser-build ads: network-agnostic wrapper, CrazyGames, Poki and test adapters
  platform/   native bridges: the app's own Android plugin, Google Play billing (purchases.ts),
              the app version and the GitHub update check for APK installs (updates.ts)
  ui/         HUD, DOM helpers, styles
tests/        vitest suites
scripts/      dev tools (see above), site build/serve/deploy
site/         the GitHub Pages site (see Website); docs/ is its build
desktop/      the Windows app: Electron main process and icon (see Windows app)
android/ ios/ Capacitor native projects
```

## Track text format (campaign authoring)

`St` start, `F` finish, `C` checkpoint, `S` straight, `B` boost, `T` turbo, `R`/`L` tight curve,
`R2`/`L2` wide curve, `U`/`D` slope up/down (2 cells, 1 level), `J` jump ramp, `G` gap,
`W` splash zone (shallow water that drags the car), `@n` set level, `x3` repeat.
Example: `St Sx2 C Sx2 R2 Sx2 C S L2 Sx2 F`.

Themes and water (the Desert and Water sets): `!desert`, `!water` set the track's theme (look, and sand
off the road in the desert), `!sunset` a low orange sun. `~` is a gap with water in it that runs on
sideways as a river (`~2`: at most 2 cells to each side), `~S` (any block) puts the river under that
block (a bridge, or a causeway at ground level), and `!lake` floods every floor cell not next to a
ground-level road. A car that drops into water is respawned at the last checkpoint. Water cells are
blocks too (`~` in track files and the editor palette). `scripts/campaign-gates.ts` runs the campaign
acceptance gates on new tracks (or trial codes) before the tables are regenerated.

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

[MIT](LICENSE) © 2026 Mitovoid-AI, for the code. Because the code is MIT, anyone may build and play the whole game for
free from source (the web and portal builds have everything unlocked); the Google Play purchase pays
for the convenience of the store build and supports development. The vehicle models in `public/vehicles/` are
CC BY 4.0 (see [Third-party assets](#third-party-assets)).

TrackMania is a trademark of Ubisoft and Nadeo. Velocity Blocks is an independent project and is
not affiliated with or endorsed by them.
