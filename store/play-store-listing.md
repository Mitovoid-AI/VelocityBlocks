# Google Play listing: Velocity Blocks (draft)

## App details
- **App name** (30 chars max): Velocity Blocks
- **Package**: com.velocityblocks.game
- **Category**: Game › Racing
- **Tags**: Racing, Time trial, Arcade, Track builder, Offline
- **Content rating**: Everyone (no violence, no ads, no user interaction, no data collected)
- **Price**: Free · **Contains ads**: No · **In-app purchases**: No

## Short description (80 chars max)
Build block tracks, race the clock, beat the author medal. Cars, bikes & trucks.

## Full description (4000 chars max)
Snap road blocks together, drive them flat out, and chase the hidden Author medal.

Velocity Blocks is a fast time-attack racer in the spirit of the classic block-track racers. Every
track is a sprint against the clock: hit every checkpoint, take the jumps, and shave off tenths
until you beat the author time.

🏁 12-TRACK CAMPAIGN
From the White series warm-ups to the Black series Grand Tour. Earn Bronze, Silver and Gold, then
unlock the secret Author medal by beating the developer's own time.

🚗 CARS, BIKES AND TRUCKS
Pick a car, a bike or a truck. Each one handles differently and keeps its own records and medals.

⚡ NITRO
Fire your nitro on the straights. It recharges six seconds after every boost.

🏎️ REAL HANDLING
Downforce that grips harder the faster you go, traction control, ABS and a brake-tap drift.
Turn on the racing line to see where to brake.

👻 GHOSTS AND REPLAYS
Race against your own best run and watch it back from trackside cameras.

🧱 TRACK EDITOR
Build your own tracks on a 32 × 32 grid with curves, slopes, boost pads and jumps,
test-drive them and share them as files.

🎮 YOUR CONTROLS
Steering buttons, an on-screen wheel or tilt steering, analog gas and brake bars, keyboard and
gamepad support. Optional walls on every road for a friendlier ride.

📴 FULLY OFFLINE
No account, no ads, no data collection. Your photo and progress never leave your phone.

Open source (MIT): github.com/Mitovoid-AI/VelocityBlocks

## Store assets checklist
- [ ] App icon 512 × 512 PNG (from public/icon.svg; scripts/make-icons.mjs)
- [ ] Feature graphic 1024 × 500 PNG
- [ ] Phone screenshots, landscape 1920 × 1080 (4-8): home, race with HUD, nitro boost, racing line,
      results with medals, garage with bike/truck, track editor
- [ ] Privacy policy URL: publish store/privacy-policy.md (e.g. GitHub Pages) and paste the URL
- [ ] Data safety form: "No data collected", "No data shared"
- [ ] Target audience: 13+ is simplest (no "Designed for Families" review); the content suits all ages

## What only you can do
- Create a Google Play Console developer account (one-time US$25) and the app entry.
- Create the upload keystore and keep its passwords (I set up the build to read them from a
  local, uncommitted keystore.properties file; I never handle the passwords).
- Upload the signed .aab, fill the content-rating and data-safety questionnaires, and submit.
- New personal accounts must run a closed test with at least 12 testers for 14 days before
  production access.
