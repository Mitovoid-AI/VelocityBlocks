# Google Play listing: Velocity Blocks (draft)

## App details
- **App name** (30 chars max): Velocity Blocks
- **Package**: com.velocityblocks.game
- **Category**: Game › Racing
- **Tags**: Racing, Time trial, Arcade, Track builder, Offline
- **Content rating**: Everyone (no violence, no ads, no user interaction, no data collected; the
  questionnaire's "digital purchases" question is Yes)
- **Price**: Free · **Contains ads**: No · **In-app purchases**: Yes (one optional one-time purchase,
  the Full Game; see below)

## Short description (80 chars max)
Build block tracks, race the clock, beat the author medal. Cars, bikes & trucks.

## Full description (4000 chars max)
Snap road blocks together, drive them flat out, and chase the hidden Author medal.

Velocity Blocks is a fast time-attack racer in the spirit of the classic block-track racers. Every
track is a sprint against the clock: hit every checkpoint, take the jumps, and shave off tenths
until you beat the author time.

🏁 FREE STADIUM CAMPAIGN
12 tracks, from the White series warm-ups to the Black series Grand Tour. Earn Bronze, Silver and
Gold, then unlock the secret Author medal by beating the developer's own time. The first Desert and
Water tracks are free too.

⭐ FULL GAME (ONE-TIME PURCHASE)
One payment, no subscription, no ads: the rest of the Desert and Water tracks, the Bike and the
Truck, and the Realistic car, bike and truck models.

🚗 CARS, BIKES AND TRUCKS
Race the Car with four body styles for free. With the Full Game, add the Bike and the Truck: each
handles differently and keeps its own records and medals.

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
No account, no ads, no data collection. Your photo and progress never leave your phone. The Full
Game, once bought, works offline too.

Open source (MIT): github.com/Mitovoid-AI/VelocityBlocks

## Store assets checklist
- [ ] App icon 512 × 512 PNG (from public/icon.svg; scripts/make-icons.mjs)
- [ ] Feature graphic 1024 × 500 PNG
- [ ] Phone screenshots, landscape 1920 × 1080 (4-8): home, race with HUD, nitro boost, racing line,
      results with medals, garage with bike/truck, track editor
- [ ] Privacy policy URL: publish store/privacy-policy.md (e.g. GitHub Pages) and paste the URL
- [ ] Data safety form: "No data collected", "No data shared" (the app itself sends nothing; the
      purchase is processed by Google Play under Google's own privacy policy). Re-read Google's
      current Data safety help for apps that use Play Billing before submitting.
- [ ] Target audience: 13+ is simplest (no "Designed for Families" review); the content suits all ages

## In-app purchase: Full Game

One **one-time product** (a non-consumable "managed product"): the app sells nothing else.

- **Product ID**: `full_game` (must be exactly this; the app registers it in `src/platform/purchases.ts`)
- **Name**: Full Game
- **Description** (shown on Google Play's purchase sheet): "All Desert and Water tracks, the Bike and
  the Truck, and the Realistic vehicle models. One payment, yours to keep."
- **What it unlocks**: D02-D06 and W02-W06, the Bike and Truck classes, the Realistic models (Sport,
  Coupe, Sedan, Cafe Racer, LCT 3000 '95). Free without it: the Stadium campaign (A01-A12), D01 and
  W01, the Car with its four bodies, the track editor and My tracks.
- **Price**: your choice (for example US$2.99); Play converts it to local prices.
- The browser builds (CrazyGames, Poki, web) have everything unlocked and never show it.

### Play Console steps

1. **Payments profile.** Play Console > Settings > Payments profile: set up the merchant (payments)
   profile and its bank account and tax details. Products can't be sold until this is done.
2. **Upload a build that contains billing.** Build the release bundle (`npm run android:release`,
   with versionCode raised) and upload it to **Testing > Internal testing** (create a release, add the
   .aab, save and roll out to internal testing). Play only lets you create products once a build
   with the BILLING permission has been uploaded; the plugin adds that permission.
3. **Create the product.** Monetize with Play > Products > **One-time products** > Create one-time
   product. Product ID `full_game`, name "Full Game", the description above. Add a **purchase option**
   of type *Buy* (a plain purchase, not a rent), set the price (Set prices > pick the default price
   and let Play convert it for other countries), save, then **Activate** the product. Inactive or
   not-yet-propagated products show "The Full Game is not available in the store yet" in the app.
   New products can take a few hours to reach devices.
4. **License testers.** Play Console (home, all apps) > Settings > **License testing**: add the
   Google accounts that test purchases (one per line or as an email list) and keep the license
   response on *RESPOND_NORMALLY*. Their purchases use test cards ("Test card, always approves",
   "always declines", "slow test card, approves after a few minutes" for a pending payment) and are
   never charged.
5. **Internal testing track.** Testing > Internal testing > Testers: create an email list with the
   same accounts and copy the opt-in link. Each tester opens the link on the phone, accepts, and
   installs the app from Google Play (the account signed in to the Play Store must be a license
   tester). Purchases work only in an app Google Play knows about, with the product id it has.
6. **Test** on a real phone: Buy (approves, the thank-you appears, Bike/Truck/Realistic and D02+/W02+
   open), cancel the sheet, the slow card (Payment pending, then unlocks a few minutes later),
   Restore purchases after clearing the app's data, airplane mode after buying (still unlocked), and
   a refund: Order management > the test order > Refund, with "Remove entitlement" ticked; the next
   start of the app locks the content again.
7. **Production.** Promote the release from internal (and the required closed test) to production.
   The product is shared by every track; nothing else changes.

Debug builds of the app also have a developer switch (Settings > tap the version line 7 times:
Follow store / Owned / Not owned) to check the locked and unlocked screens without buying. Release
builds don't have it.

## What only you can do
- Create a Google Play Console developer account (one-time US$25) and the app entry.
- Create the upload keystore and keep its passwords (I set up the build to read them from a
  local, uncommitted keystore.properties file; I never handle the passwords).
- Upload the signed .aab, fill the content-rating and data-safety questionnaires, and submit.
- Set up the payments profile, create and price the `full_game` product, and add license testers
  (steps above). Only you can enter bank and tax details.
- New personal accounts must run a closed test with at least 12 testers for 14 days before
  production access.
