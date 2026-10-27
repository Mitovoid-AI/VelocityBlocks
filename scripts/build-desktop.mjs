#!/usr/bin/env node
// Build Velocity Blocks for Windows: the web game in an Electron window (desktop/main.cjs), as
//   builds/VelocityBlocks-Setup-X.Y.Z.exe       an installer (Start menu and desktop shortcuts, uninstaller)
//   builds/VelocityBlocks-X.Y.Z-Portable.exe    one .exe that runs without installing
// plus the same two under fixed names (VelocityBlocks-Setup.exe, VelocityBlocks-Portable.exe) for the
// website's releases/latest/download/... links and the desktop app's own update check. It never publishes:
// it prints the `gh release upload` command.
//
//   npm run release:windows                 type-check, build the game, pack both
//   npm run release:windows -- --no-build   pack the dist/ that is already there
//
// The .exe files are not code-signed, so Windows SmartScreen shows "Windows protected your PC" on the
// first run (More info > Run anyway); the website says so.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Mitovoid-AI/VelocityBlocks';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'desktop-dist');
const STAGE = path.join(WORK, 'app');
const OUT = path.join(WORK, 'out');
const BUILDS = path.join(ROOT, 'builds');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const fail = (msg) => {
  console.error(`\nrelease:windows: ${msg}`);
  process.exit(1);
};

if (!process.argv.includes('--no-build')) {
  console.log('> npm run build');
  // shell: Windows runs npm only through cmd.exe.
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail('npm run build failed');
}
const dist = path.join(ROOT, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) fail('dist/index.html is missing: run npm run build first.');

// The app electron-builder packs: main.cjs, the game in www/, and a package.json of its own (no
// dependencies, so none of the project's node_modules end up in the app).
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'desktop', 'main.cjs'), path.join(STAGE, 'main.cjs'));
fs.cpSync(dist, path.join(STAGE, 'www'), { recursive: true });
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify(
    {
      name: 'velocity-blocks',
      productName: 'Velocity Blocks',
      version,
      description: 'Velocity Blocks: block-track time-attack racing',
      author: 'Mitovoid-AI',
      license: 'MIT',
      main: 'main.cjs',
    },
    null,
    2,
  ),
);

const { build, Platform } = await import('electron-builder');
await build({
  targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], 1 /* x64 */),
  config: {
    appId: 'com.velocityblocks.game',
    productName: 'Velocity Blocks',
    copyright: 'Copyright © 2026 Mitovoid-AI (MIT license)',
    electronVersion: pkg.devDependencies.electron,
    directories: { app: STAGE, output: OUT, buildResources: path.join(ROOT, 'desktop') },
    icon: path.join(ROOT, 'desktop', 'icon.png'),
    asar: true,
    // Only the staged app: without this, electron-builder looks for node_modules up in the project and packs
    // its dependencies (Capacitor, the purchase plugin, three.js), which the bundled game never loads.
    files: ['main.cjs', 'package.json', 'www/**/*', '!node_modules/**'],
    // Chromium's UI strings (context menus, dialogs) in English only: about 45 MB of locales less.
    electronLanguages: ['en-US'],
    compression: 'maximum',
    publish: null,
    win: { executableName: 'VelocityBlocks' },
    // Saved runs (.vbst) open in the installed game (desktop/main.cjs). The portable .exe registers nothing.
    fileAssociations: [{ ext: 'vbst', name: 'Velocity Blocks run', description: 'Velocity Blocks run', role: 'Viewer' }],
    // velocityblocks:// links (the browser game's "Open in the app"); the app also registers them when it starts.
    protocols: [{ name: 'Velocity Blocks run', schemes: ['velocityblocks'] }],
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Velocity Blocks',
      // Records live in the app's data folder: an uninstall (or an update) keeps them.
      deleteAppDataOnUninstall: false,
      artifactName: 'VelocityBlocks-Setup-${version}.${ext}',
    },
    portable: { artifactName: 'VelocityBlocks-${version}-Portable.${ext}' },
  },
});

fs.mkdirSync(BUILDS, { recursive: true });
const files = [];
for (const [from, versioned, fixed] of [
  [`VelocityBlocks-Setup-${version}.exe`, `VelocityBlocks-Setup-${version}.exe`, 'VelocityBlocks-Setup.exe'],
  [`VelocityBlocks-${version}-Portable.exe`, `VelocityBlocks-${version}-Portable.exe`, 'VelocityBlocks-Portable.exe'],
]) {
  const src = path.join(OUT, from);
  if (!fs.existsSync(src)) fail(`electron-builder made no ${from}`);
  for (const name of [versioned, fixed]) {
    fs.copyFileSync(src, path.join(BUILDS, name));
    files.push(`builds/${name}`);
  }
}
const mb = (f) => (fs.statSync(path.join(ROOT, f)).size / 1048576).toFixed(1);
console.log(`
Built (version ${version}):
${files.map((f) => `  ${f}  ${mb(f)} MB`).join('\n')}

Attach them to the v${version} release (run from ${ROOT}):

  gh release upload v${version} ${files.map((f) => `"${f}"`).join(' ')} --repo ${REPO} --clobber

The fixed names (VelocityBlocks-Setup.exe, VelocityBlocks-Portable.exe) are what the website's buttons and
the desktop app's update check look for in the latest release.
`);
