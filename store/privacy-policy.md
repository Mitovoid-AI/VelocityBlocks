# Velocity Blocks: Privacy Policy

Last updated: 21 October 2026

Velocity Blocks is a single-player racing game made by Mitovoid-AI. This policy covers the Android
app (package `com.velocityblocks.game`), both the version from Google Play and the APK published on
GitHub.

## What the app collects

Nothing. The app has no account system, no analytics, no advertising SDK and no crash reporting
service, and it does not send any data to us or to anyone else.

## Update check (APK from GitHub only)

If you installed the app from an APK file (for example one downloaded from the project's GitHub
releases) rather than from Google Play, the app checks for a newer version at most once a day: it makes
one request to `api.github.com` (GitHub's public API) for the latest release of the project. No personal
data, identifiers or game data are sent with it. As with any web request, GitHub sees your IP address
and the request itself, under the [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
The app keeps the time of the last check, and a version you chose to skip, on your device. If you tap
Download, the APK opens in your browser, which downloads it from GitHub.

The version installed from Google Play never makes this request: Google Play handles its updates.

## Purchases

The app offers one optional in-app purchase, the **Full Game**. The purchase is made and processed
entirely by **Google Play**: your payment details, Google account and order history are handled by
Google under the [Google Privacy Policy](https://policies.google.com/privacy), and we do not receive
them. The app only asks Google Play on your phone whether the Full Game is owned, and keeps a yes/no
note of the answer on your device so the purchase works offline. We collect no personal data in
connection with purchases.

## What stays on your device

The app keeps the following on your phone only, in the app's private storage:

- your driver name, car colour and vehicle choice;
- your profile photo, if you choose one (from your gallery or camera). It is shrunk to 192 × 192
  pixels and is only shown inside the game;
- your settings, personal-best times, medals, replays/ghosts and the tracks you build;
- whether the Full Game is unlocked (a yes/no note; "Reset records" does not remove it, and Restore
  purchases in the game brings it back after a reinstall).

Uninstalling the app, or clearing its data in Android settings, deletes all of it. "Reset records"
in the game's Settings deletes your times, medals and ghosts.

## Permissions

- **Internet**: required by the app framework (Capacitor). The game itself sends nothing over the
  network, except the once-a-day update check of the APK version described above; Google Play's
  billing service uses it for purchases.
- **Billing** (`com.android.vending.BILLING`): lets the app open Google Play's purchase screen for the
  Full Game.
- **Vibrate**: short vibrations on checkpoints.
- The photo picker and camera are opened only when you tap Gallery or Camera in your driver profile;
  the app does not request camera or storage permissions for this.

## Children

The game contains no ads, chat or user-to-user features in the Android app and collects no personal
data, so it is suitable for all ages. The one in-app purchase goes through Google Play, where parents
can require approval for purchases (Family Link, or Play Store > Settings > Authentication).

## Changes

If a future version adds online features (for example leaderboards), this policy will be updated
before that version is released, and the change will be described here.

## Contact

Questions: open an issue at https://github.com/Mitovoid-AI/VelocityBlocks/issues
