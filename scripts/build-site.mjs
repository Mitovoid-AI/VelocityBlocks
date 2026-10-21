// Builds the GitHub Pages site into docs/:
//   1. renders store/privacy-policy.md into site/privacy.html (generated, kept in the repo so site/ is complete);
//   2. copies site/ to docs/;
//   3. builds the web game (the plain, ad-free build) into docs/play/ with a relative base, so it runs from
//      https://mitovoid-ai.github.io/VelocityBlocks/play/ (realistic models and the KTX2 transcoder included).
//
//   npm run site:build                  type-check, then all of the above
//   node scripts/build-site.mjs --no-game   site pages only, for quick edits (keeps the play/ already built)
//
// Preview it under the same path as GitHub Pages: npm run site:serve → http://localhost:5371/VelocityBlocks/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'docs');
const PLAY = path.join(OUT, 'play');
const noGame = process.argv.includes('--no-game');

// ---------------------------------------------------------------- privacy.html from the policy's Markdown
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Inline Markdown: `code`, **bold**, [text](url). Escapes everything else. */
function inline(s) {
  const parts = s.split(/(`[^`]+`)/);
  return parts
    .map((p) => {
      if (/^`[^`]+`$/.test(p)) return `<code>${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
        .replace(/(^|[\s(])(https:\/\/[^\s)<]+[^\s)<.,;:])/g, (_, pre, u) => `${pre}<a href="${u}">${u}</a>`);
    })
    .join('');
}
/** The small Markdown subset the policy uses: headings, paragraphs and "- " lists. */
function markdown(md) {
  const out = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    if (list) out.push(`<ul>\n${list.map((li) => `  <li>${inline(li)}</li>`).join('\n')}\n</ul>`);
    list = null;
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
      (list ??= []).push(line.replace(/^\s*[-*]\s+/, ''));
    } else if (/^\s+\S/.test(line) && list) {
      list[list.length - 1] += ' ' + line.trim();
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}

function renderPrivacy() {
  const md = fs.readFileSync(path.join(ROOT, 'store', 'privacy-policy.md'), 'utf8');
  const body = markdown(md).replace(/^<h1>Velocity Blocks: Privacy Policy<\/h1>/, '<h1>Privacy policy</h1>');
  const html = `<!doctype html>
<!-- Generated from store/privacy-policy.md by scripts/build-site.mjs. Edit the Markdown, not this file. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy policy · Velocity Blocks</title>
<meta name="description" content="Velocity Blocks collects nothing. The APK checks GitHub for a new version at most once a day; that is all that leaves your phone.">
<link rel="canonical" href="https://mitovoid-ai.github.io/VelocityBlocks/privacy.html">
<meta name="theme-color" content="#0b1020">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<script>try { var t = localStorage.getItem("vb-site-theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,700;0,800;0,900;1,900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
</head>
<body style="padding-bottom:0">
<header class="top"><div class="wrap"><a class="brand" href="./"><img src="icon.svg" alt="" width="28" height="28">Velocity Blocks</a><a class="pill dark" href="./">Back</a></div></header>
<main class="doc">
<div class="wrap">
${body}
</div>
</main>
<footer>
  <div class="wrap">
    <span>© 2026 Mitovoid-AI</span>
    <a href="./">Home</a>
    <a href="https://github.com/Mitovoid-AI/VelocityBlocks">GitHub</a>
    <a href="https://github.com/Mitovoid-AI/VelocityBlocks/blob/main/store/privacy-policy.md">Source of this page</a>
  </div>
</footer>
</body>
</html>
`;
  fs.writeFileSync(path.join(SITE, 'privacy.html'), html);
}

// ---------------------------------------------------------------- checks on the game build
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
function checkGame() {
  const problems = [];
  const index = fs.readFileSync(path.join(PLAY, 'index.html'), 'utf8');
  // Root-absolute URLs would point at mitovoid-ai.github.io/assets/..., outside the project site.
  for (const m of index.matchAll(/(?:src|href)="(\/[^"]*)"/g)) problems.push(`play/index.html has a root-absolute URL: ${m[1]}`);
  const files = walk(PLAY).map((f) => path.relative(PLAY, f).replace(/\\/g, '/'));
  for (const v of ['sport', 'coupe', 'sedan', 'cafe', 'lct3000']) {
    if (!files.includes(`vehicles/${v}.glb`)) problems.push(`missing play/vehicles/${v}.glb`);
  }
  if (!files.some((f) => /basis_transcoder.*\.wasm$/.test(f))) problems.push('missing the Basis (KTX2) transcoder .wasm');
  if (!files.some((f) => /basis_transcoder.*\.js$/.test(f))) problems.push('missing the Basis (KTX2) transcoder .js');
  if (problems.length) {
    console.error('Game build check failed:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  return files.length;
}

function size(dir) {
  return walk(dir).reduce((n, f) => n + fs.statSync(f).size, 0);
}

// ---------------------------------------------------------------- main
renderPrivacy();
console.log('site/privacy.html rendered from store/privacy-policy.md');
// --no-game keeps the game from the last full build.
const keep = noGame && fs.existsSync(PLAY) ? fs.mkdtempSync(path.join(ROOT, '.site-play-')) : null;
if (keep) fs.renameSync(PLAY, path.join(keep, 'play'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SITE, OUT, { recursive: true });
if (keep) {
  fs.renameSync(path.join(keep, 'play'), PLAY);
  fs.rmSync(keep, { recursive: true, force: true });
}
console.log(`site/ copied to docs/`);

if (!noGame) {
  const { build } = await import('vite');
  // The vite.config.ts of the project is loaded as usual (define, KTX2 handling); these settings win over it.
  await build({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    mode: 'production',
    base: './',
    logLevel: 'warn',
    build: { outDir: PLAY, emptyOutDir: true },
  });
  const n = checkGame();
  console.log(`web game built into docs/play/ (${n} files)`);
}
console.log(`docs/: ${(size(OUT) / 1048576).toFixed(1)} MB. Preview: npm run site:serve, then open http://localhost:5371/VelocityBlocks/`);
