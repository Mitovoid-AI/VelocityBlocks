#!/usr/bin/env node
// The key the released APKs are signed with, kept at android/signing/debug.keystore (git-ignored). Gradle signs
// debug builds with it when it is there (android/app/build.gradle), and GitHub Actions writes the same file from
// the ANDROID_DEBUG_KEYSTORE_BASE64 secret, so local test APKs and released APKs carry the same signature.
//
//   npm run signing:import -- <path/to/debug.keystore>   copy a keystore here, after checking it is the released key
//   npm run signing:check                                 is android/signing/debug.keystore the released key?
//   npm run signing:upload                                put it in the repository secret (needs gh auth login)
//
// "The released key" is APK_CERT_SHA256 in .github/workflows/release.yml (one place). A debug keystore's
// passwords are Android's defaults (android / androiddebugkey).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Mitovoid-AI/VelocityBlocks';
const SECRET = 'ANDROID_DEBUG_KEYSTORE_BASE64';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = join(root, 'android', 'signing', 'debug.keystore');
const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const expected = /APK_CERT_SHA256:\s*([0-9a-f]{64})/.exec(workflow)?.[1];

const fail = (msg) => {
  console.error(`signing: ${msg}`);
  process.exit(1);
};
if (!expected) fail('no APK_CERT_SHA256 in .github/workflows/release.yml');

/** SHA-256 of the keystore's certificate (lowercase hex), from keytool. */
function certOf(file) {
  const keytool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'keytool') : 'keytool';
  const r = spawnSync(keytool, ['-list', '-v', '-keystore', file, '-storepass', 'android', '-alias', 'androiddebugkey'], { encoding: 'utf8' });
  if (r.error) fail(`keytool did not run (${r.error.message}): set JAVA_HOME to a JDK`);
  const m = /SHA256:\s*([0-9A-F:]{95})/i.exec(r.stdout ?? '');
  if (!m) fail(`could not read ${file} as a debug keystore (password android, alias androiddebugkey):\n${r.stdout}${r.stderr}`);
  return m[1].replace(/:/g, '').toLowerCase();
}

function check(file) {
  if (!existsSync(file)) fail(`${file} does not exist: npm run signing:import -- <path/to/debug.keystore>`);
  const cert = certOf(file);
  if (cert !== expected) fail(`${file} is a different key (${cert}), not the released one (${expected}): APKs signed with it cannot update the installed apps`);
  console.log(`${file}: the released key (${cert.slice(0, 16)}...)`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'import') {
  if (!arg) fail('usage: npm run signing:import -- <path/to/debug.keystore>');
  check(arg);
  mkdirSync(dirname(store), { recursive: true });
  copyFileSync(arg, store);
  console.log(`copied to ${store}: debug builds are now signed with it`);
} else if (cmd === 'check') {
  check(store);
} else if (cmd === 'upload') {
  check(store);
  const b64 = readFileSync(store).toString('base64');
  // The value goes in on stdin, never on the command line.
  const r = spawnSync('gh', ['secret', 'set', SECRET, '--repo', REPO], { input: b64, encoding: 'utf8' });
  if (r.status !== 0) fail(`gh secret set failed: ${r.stderr || r.error?.message}`);
  console.log(`secret ${SECRET} set on ${REPO}`);
} else {
  fail('usage: signing:import <file> | signing:check | signing:upload');
}
