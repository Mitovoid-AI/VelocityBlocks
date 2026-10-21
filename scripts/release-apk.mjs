#!/usr/bin/env node
// Build the Android APK for a GitHub release and print the `gh release create` command that publishes it.
// It never publishes anything itself. See README > "Releasing a new version".
//
//   npm run release:apk                          release-signed APK (needs android/keystore.properties)
//   npm run release:apk -- --debug               debug-signed APK (only installs over other debug builds)
//   npm run release:apk -- --notes "Faster menus, new Desert track"
//   npm run release:apk -- --notes-file notes.md
//   npm run release:apk -- --no-build            reuse the last APK gradle built, just copy it and print
//
// The version is package.json "version" (X.Y.Z); the tag is vX.Y.Z. The installed apps compare that tag
// with their own version (src/platform/updates.ts) and download the release's first .apk asset.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Mitovoid-AI/VelocityBlocks';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'android');
const win = process.platform === 'win32';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const fail = (msg) => {
  console.error(`\nrelease:apk: ${msg}`);
  process.exit(1);
};

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
if (!m || Number(m[2]) > 99 || Number(m[3]) > 99) fail(`package.json "version" must be X.Y.Z with Y and Z under 100, not "${version}"`);
const tag = `v${version}`;

const debug = flag('--debug');
const variant = debug ? 'debug' : 'release';
if (!debug && !existsSync(join(android, 'keystore.properties'))) {
  fail(
    'android/keystore.properties is missing, so a release APK would be unsigned and could not be installed.\n' +
      'Create it from android/keystore.properties.example, or build a debug-signed APK with --debug.',
  );
}

const run = (cmd, cmdArgs, cwd) => {
  console.log(`\n> ${cmd} ${cmdArgs.join(' ')}`);
  // shell: Windows runs npm, npx and gradlew.bat only through cmd.exe.
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`"${cmd} ${cmdArgs.join(' ')}" failed (exit ${r.status ?? r.signal ?? r.error?.message}).`);
};

if (!flag('--no-build')) {
  run('npm', ['run', 'build'], root);
  run('npx', ['cap', 'sync', 'android'], root);
  run(win ? '.\\gradlew.bat' : './gradlew', [debug ? 'assembleDebug' : 'assembleRelease'], android);
}

const built = join(android, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
if (!existsSync(built)) {
  const unsigned = join(android, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}-unsigned.apk`);
  fail(existsSync(unsigned) ? `only an unsigned APK was built (${relative(root, unsigned)}): check android/keystore.properties.` : `no APK at ${relative(root, built)}.`);
}

const outDir = join(root, 'builds');
mkdirSync(outDir, { recursive: true });
// The file players see on the release page: a clean name, whatever key signed it.
const apkName = `VelocityBlocks-${version}.apk`;
const apk = join(outDir, apkName);
copyFileSync(built, apk);
const apkRel = relative(root, apk).split('\\').join('/');
const mb = (statSync(apk).size / (1024 * 1024)).toFixed(1);

const notesFile = option('--notes-file');
const notes = option('--notes');
// Double quotes would end the argument in every shell: keep the one-line notes simple.
const notesArg = notesFile ? `--notes-file "${notesFile}"` : `--notes "${(notes ?? `Velocity Blocks ${version}`).replace(/"/g, "'")}"`;

console.log(`
Built ${apkRel} (${mb} MB, ${variant}-signed, version ${version}).

Publish it (run from ${root}):

  gh release create ${tag} "${apkRel}" --repo ${REPO} --title "Velocity Blocks ${version}" ${notesArg}

- The release notes (the --notes text or file) are what the update pop-up shows, cut to 600 characters.
- Do not add --draft or --prerelease: the apps only see the latest full release.
- Apps can only install this APK over one signed with the same key (${variant} key here).
`);
