// Publishes docs/ to the gh-pages branch of the origin remote (GitHub Pages serves that branch at
// https://mitovoid-ai.github.io/VelocityBlocks/).
//
//   npm run site:deploy                      type-check, build the site and the web game, publish
//   npm run site:deploy -- --dry-run         everything except the push (prints what would be published)
//   npm run site:deploy -- --no-build        publish the docs/ that is already there
//   options: --remote <url>  --message "<text>"  --keep (keep the temporary repository)
//
// It works in a temporary repository outside the project: your checkout, branches and working tree are
// never touched. The new commit goes on top of the current gh-pages (a fast-forward push, never --force);
// the first deploy creates the branch. One-time GitHub setting: Settings > Pages > Build and deployment >
// Deploy from a branch > gh-pages, / (root).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'docs');
const BRANCH = 'gh-pages';
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = flag('--dry-run');

function run(cmd, cmdArgs, { cwd = ROOT, allowFail = false, quiet = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0 && !allowFail) {
    console.error(`\n${cmd} ${cmdArgs.join(' ')} failed (${r.status ?? r.error}).${r.stderr ? '\n' + r.stderr : ''}`);
    process.exit(1);
  }
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}
const git = (cwd, ...a) => run('git', a, { cwd });
const node = (...a) => {
  const r = spawnSync(process.execPath, a, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// 1. Build.
if (!flag('--no-build')) {
  console.log('Type-checking…');
  node(path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', ROOT);
  node(path.join(ROOT, 'scripts', 'build-site.mjs'));
}
for (const f of ['index.html', '404.html', '.nojekyll', 'privacy.html', 'play/index.html']) {
  if (!fs.existsSync(path.join(DIST, f))) {
    console.error(`docs/${f} is missing: run npm run site:build first (or drop --no-build).`);
    process.exit(1);
  }
}

// 2. What is being published.
const remote = opt('--remote') ?? git(ROOT, 'remote', 'get-url', 'origin').out;
const sha = git(ROOT, 'rev-parse', '--short', 'HEAD').out;
const dirty = git(ROOT, 'status', '--porcelain').out !== '';
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const message = opt('--message') ?? `Deploy site from ${sha}${dirty ? ' (with uncommitted changes)' : ''}, game ${version}`;
console.log(`Remote: ${remote}\nBranch: ${BRANCH}\nMessage: ${message}`);
if (dirty) console.warn('Note: the working tree has uncommitted changes; the site is built from them.');

// 3. A temporary repository on the current gh-pages (or a new orphan branch).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-gh-pages-'));
const cleanup = () => {
  if (flag('--keep')) console.log(`Kept the temporary repository: ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
};
try {
  git(tmp, 'init', '-q');
  // Publish the bytes as built (no line-ending conversion from a global core.autocrlf).
  git(tmp, 'config', 'core.autocrlf', 'false');
  git(tmp, 'config', 'core.safecrlf', 'false');
  git(tmp, 'remote', 'add', 'origin', remote);
  // Use the project's commit identity (falls back to the global one).
  for (const k of ['user.name', 'user.email']) {
    const v = run('git', ['config', k], { cwd: ROOT, allowFail: true, quiet: true }).out;
    if (v) git(tmp, 'config', k, v);
  }
  const exists = git(tmp, 'ls-remote', '--heads', 'origin', BRANCH).out !== '';
  if (exists) {
    git(tmp, 'fetch', '-q', '--depth', '1', 'origin', BRANCH);
    git(tmp, 'checkout', '-q', '-B', BRANCH, 'FETCH_HEAD');
    console.log(`On top of origin/${BRANCH}.`);
  } else {
    git(tmp, 'checkout', '-q', '--orphan', BRANCH);
    console.log(`origin has no ${BRANCH} branch yet: this deploy creates it.`);
  }

  // 4. Replace the branch's files with docs/.
  for (const e of fs.readdirSync(tmp)) if (e !== '.git') fs.rmSync(path.join(tmp, e), { recursive: true, force: true });
  fs.cpSync(DIST, tmp, { recursive: true });
  git(tmp, 'add', '-A');
  const changed = git(tmp, 'diff', '--cached', '--stat').out;
  if (exists && !changed) {
    console.log('Nothing changed since the last deploy.');
    cleanup();
    process.exit(0);
  }
  git(tmp, 'commit', '-q', '-m', message);
  const files = git(tmp, 'ls-files').out.split('\n').length;
  console.log(`\nCommit ready (${files} files):\n${(changed || '(new branch)').split('\n').slice(-1)[0]}`);

  // 5. Push (fast-forward only).
  if (dryRun) {
    console.log(`\nDry run: nothing pushed. Without --dry-run this commit goes to ${remote} as ${BRANCH} (fast-forward).`);
  } else {
    git(tmp, 'push', 'origin', `${BRANCH}:${BRANCH}`);
    console.log(`\nPublished. GitHub Pages updates in a minute or two: https://mitovoid-ai.github.io/VelocityBlocks/`);
  }
} finally {
  cleanup();
}
