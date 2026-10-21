// The GitHub release update check for APK installs (src/platform/updates.ts) and its pop-up
// (src/app/updateUi.ts): version compare, the APK pick, the 24 h throttle, Skip this version, who checks
// at all (APK install vs Google Play vs web/portal/dev), escaping of the release notes, and every failure.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IN_APP_HINT, INSTALL_HINT, progressText, stepHtml, updatePopupHtml } from '../src/app/updateUi';
import { installSource, openExternalUrl } from '../src/platform/native';
import {
  autoCheckDue,
  CHECK_INTERVAL_MS,
  compareVersions,
  DOWNLOAD_PREFIX,
  fetchLatest,
  localUpdatePersist,
  NOTES_MAX,
  parseVersion,
  pickApkAsset,
  plainNotes,
  releaseUpdate,
  RELEASES_URL,
  runtimeChannel,
  sizeText,
  UpdateChecker,
  updateChannel,
  type ChannelEnv,
  type FetchFn,
  type UpdateChannel,
  type UpdateInfo,
  type UpdatePersist,
  type UpdateState,
} from '../src/platform/updates';

const apkUrl = (tag: string, name = `VelocityBlocks-${tag}.apk`) => `${DOWNLOAD_PREFIX}${tag}/${name}`;

/** A GitHub "latest release" answer. */
function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    name: `Velocity Blocks ${tag}`,
    draft: false,
    prerelease: false,
    body: 'Faster menus.',
    html_url: `https://github.com/Mitovoid-AI/VelocityBlocks/releases/tag/${tag}`,
    assets: [
      { name: 'checksums.txt', browser_download_url: apkUrl(tag, 'checksums.txt'), size: 100 },
      { name: `VelocityBlocks-${tag}.apk`, browser_download_url: apkUrl(tag), size: 31_000_000 },
    ],
    ...extra,
  };
}

const res = (status: number, json: unknown = null) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(json),
});

class MemPersist implements UpdatePersist {
  state: UpdateState = { lastCheck: 0, skipped: null };
  saves = 0;
  load(): UpdateState {
    return { ...this.state };
  }
  save(s: UpdateState): void {
    this.saves++;
    this.state = { ...s };
  }
}

function checker(opts: { channel?: UpdateChannel; fetch?: FetchFn; now?: () => number; current?: string; persist?: MemPersist } = {}) {
  const persist = opts.persist ?? new MemPersist();
  const fetch = vi.fn(opts.fetch ?? (() => Promise.resolve(res(200, release('v1.3.0')))));
  const c = new UpdateChecker({
    channel: () => Promise.resolve(opts.channel ?? 'sideload'),
    persist,
    fetch,
    now: opts.now ?? (() => 1_000_000_000_000),
    current: opts.current ?? '1.2.0',
    timeoutMs: 50,
  });
  return { c, fetch, persist };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('versions', () => {
  it('parses plain tags with or without v, and a missing patch as 0', () => {
    expect(parseVersion('v1.3.0')).toEqual([1, 3, 0]);
    expect(parseVersion('1.3.0')).toEqual([1, 3, 0]);
    expect(parseVersion('V2.10.7')).toEqual([2, 10, 7]);
    expect(parseVersion('1.3')).toEqual([1, 3, 0]);
    expect(parseVersion(' v1.3.1 ')).toEqual([1, 3, 1]);
  });

  it('rejects pre-releases and anything that is not a version', () => {
    for (const bad of ['v1.3.0-beta', '1.3.0+5', 'v1', 'latest', '', 'v1.2.3.4', 'vv1.2.0', null, 13, undefined]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  it('compares numerically, major before minor before patch', () => {
    const cmp = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));
    expect(cmp('1.3.0', '1.2.0')).toBe(1);
    expect(cmp('1.2.0', '1.3.0')).toBe(-1);
    expect(cmp('1.10.0', '1.9.9')).toBe(1); // not string order
    expect(cmp('2.0.0', '1.99.99')).toBe(1);
    expect(cmp('1.2.10', '1.2.9')).toBe(1);
    expect(cmp('v1.2', '1.2.0')).toBe(0);
  });
});

describe('release answer', () => {
  it('offers a newer release with its first .apk asset', () => {
    const info = releaseUpdate(release('v1.3.0'), '1.2.0');
    expect(info).toEqual({
      version: '1.3.0',
      tag: 'v1.3.0',
      notes: 'Faster menus.',
      apk: { name: 'VelocityBlocks-v1.3.0.apk', url: apkUrl('v1.3.0'), size: 31_000_000 },
    });
  });

  it('offers nothing for the same or an older version', () => {
    expect(releaseUpdate(release('v1.2.0'), '1.2.0')).toBeNull();
    expect(releaseUpdate(release('v1.1.9'), '1.2.0')).toBeNull();
  });

  it('ignores drafts, pre-releases and non-version tags', () => {
    expect(releaseUpdate(release('v1.3.0', { draft: true }), '1.2.0')).toBeNull();
    expect(releaseUpdate(release('v1.3.0', { prerelease: true }), '1.2.0')).toBeNull();
    expect(releaseUpdate(release('v1.3.0-rc1'), '1.2.0')).toBeNull();
    expect(releaseUpdate(release('nightly'), '1.2.0')).toBeNull();
  });

  it('offers nothing without an APK, and nothing for garbage', () => {
    expect(releaseUpdate(release('v1.3.0', { assets: [] }), '1.2.0')).toBeNull();
    expect(releaseUpdate(release('v1.3.0', { assets: undefined }), '1.2.0')).toBeNull();
    for (const junk of [null, undefined, 'v1.3.0', 42, [], { message: 'API rate limit exceeded' }]) {
      expect(releaseUpdate(junk, '1.2.0')).toBeNull();
    }
  });

  it('picks the first asset ending in .apk', () => {
    const a = pickApkAsset([
      { name: 'notes.md', browser_download_url: apkUrl('v1', 'notes.md') },
      { name: 'VB.APK', browser_download_url: apkUrl('v1', 'VB.APK'), size: 5 },
      { name: 'second.apk', browser_download_url: apkUrl('v1', 'second.apk') },
    ]);
    expect(a).toEqual({ name: 'VB.APK', url: apkUrl('v1', 'VB.APK'), size: 5 });
    expect(pickApkAsset([{ name: 'game.apk.sha256', browser_download_url: apkUrl('v1', 'x') }])).toBeNull();
    expect(pickApkAsset([{ name: 'game.aab', browser_download_url: apkUrl('v1', 'game.aab') }])).toBeNull();
  });

  it('only takes downloads from this repo over https', () => {
    for (const url of [
      'https://evil.example/VelocityBlocks.apk',
      'http://github.com/Mitovoid-AI/VelocityBlocks/releases/download/v1/x.apk',
      'https://github.com/someone-else/VelocityBlocks/releases/download/v1/x.apk',
      'javascript:alert(1)//.apk',
      42,
    ]) {
      expect(pickApkAsset([{ name: 'x.apk', browser_download_url: url }])).toBeNull();
    }
    // A bad one first does not hide a good one after it.
    expect(pickApkAsset([{ name: 'x.apk', browser_download_url: 'https://evil.example/x.apk' }, { name: 'y.apk', browser_download_url: apkUrl('v1', 'y.apk') }])?.name).toBe('y.apk');
    // Size: missing or nonsense counts as unknown.
    expect(pickApkAsset([{ name: 'y.apk', browser_download_url: apkUrl('v1', 'y.apk'), size: -3 }])?.size).toBe(0);
  });
});

describe('release notes', () => {
  it('turns light Markdown into plain text', () => {
    const body = '## What\'s new\r\n\r\n- **Faster** menus\r\n- See [the issue](https://github.com/x/y/issues/1)\r\n<!-- hidden -->\r\n\r\n\r\n\r\nThanks __all__';
    expect(plainNotes(body)).toBe("What's new\n\n- Faster menus\n- See the issue\n\nThanks all");
  });

  it('cuts long notes at a word, with an ellipsis', () => {
    const t = plainNotes('word '.repeat(400));
    expect(t.length).toBeLessThanOrEqual(NOTES_MAX + 1);
    expect(t.endsWith('word…')).toBe(true);
    expect(plainNotes('x'.repeat(1000), 50)).toBe(`${'x'.repeat(50)}…`);
  });

  it('is empty for no body, and drops control characters', () => {
    expect(plainNotes(null)).toBe('');
    expect(plainNotes(undefined)).toBe('');
    expect(plainNotes(7)).toBe('');
    expect(plainNotes('a\u0000b\u0007c\u001bd')).toBe('abcd');
  });

  it('keeps HTML in the notes as text: the pop-up escapes everything from GitHub', () => {
    const evil: UpdateInfo = {
      version: '1.3.0',
      tag: 'v1.3.0"><img src=x onerror=alert(1)>',
      notes: plainNotes('<script>alert(1)</script><img src=x onerror="alert(2)"> & \'quotes\''),
      apk: { name: '<b>x</b>.apk', url: apkUrl('v1.3.0'), size: 0 },
    };
    const html = updatePopupHtml(evil, '1.2.0');
    expect(html).not.toMatch(/<script|<img|onerror="/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp; &#39;quotes&#39;');
    // Parsed as a page, nothing but the panel's own elements exists.
    expect(html.match(/<(\w+)/g)!.map((t) => t.slice(1)).sort()).toEqual(['button', 'button', 'button', 'div', 'div', 'div', 'div', 'div', 'h2']);
  });

  it('shows the version, the size, the install hint and the three buttons', () => {
    const info = releaseUpdate(release('v1.3.0'), '1.2.0')!;
    const html = updatePopupHtml(info, '1.2.0');
    expect(html).toContain('Update 1.3.0 available');
    expect(html).toContain('You have 1.2.0.');
    expect(html).toContain('29.6 MB');
    expect(html).toContain('allow installs from this source');
    expect(INSTALL_HINT).toContain('allow installs from this source');
    expect(html).toMatch(/data-act="download"[^>]*>Download</);
    // Later is the pop-up's Back (Android Back presses it).
    expect(html).toMatch(/data-act="back"[^>]*>Later</);
    expect(html).toMatch(/data-act="skip"[^>]*>Skip this version</);
    expect(updatePopupHtml({ ...info, notes: '' }, '1.2.0')).toContain('No release notes.');
  });

  it('sizes read in MB or KB', () => {
    expect(sizeText(31_000_000)).toBe('29.6 MB');
    expect(sizeText(2048)).toBe('2 KB');
    expect(sizeText(0)).toBe('');
    expect(sizeText(NaN)).toBe('');
  });

  it('updates inside the app: Update now, then a progress bar, then Install', () => {
    const info = releaseUpdate(release('v1.3.0'), '1.2.0')!;
    const html = updatePopupHtml(info, '1.2.0', true);
    expect(html).toMatch(/data-act="download"[^>]*>Update now</);
    expect(html).toContain(IN_APP_HINT.slice(0, 30));
    expect(html).not.toContain('opens your browser');
    const dl = stepHtml(info, { kind: 'downloading', received: 3 * 1024 * 1024, total: 8 * 1024 * 1024 });
    expect(dl).toContain('aria-valuenow="38"');
    expect(dl).toContain('width:37.5%');
    expect(dl).toContain('3.0 / 8.0 MB · 37%');
    // Cancel is the pop-up's Back while downloading.
    expect(dl).toMatch(/data-act="back"[^>]*>Cancel</);
    expect(stepHtml(info, { kind: 'downloading', received: 0, total: 0 })).toContain('upd-bar busy');
    const ready = stepHtml(info, { kind: 'install', state: 'permission' });
    expect(ready).toMatch(/data-act="install"[^>]*>Install</);
    expect(ready).toContain('Install unknown apps');
    const failed = stepHtml(info, { kind: 'failed', reason: '<b>HTTP 500</b>' });
    expect(failed).not.toContain('<b>');
    expect(failed).toMatch(/data-act="browser"/);
    expect(progressText(1024 * 1024, 0)).toBe('1.0 MB');
    expect(progressText(9, 8)).toContain('100%');
  });
});

describe('who checks', () => {
  const env = (over: Partial<ChannelEnv> = {}): ChannelEnv => ({
    platform: 'android',
    native: true,
    ads: 'none',
    dev: false,
    install: { known: true, installer: 'com.google.android.packageinstaller' },
    ...over,
  });

  it('an APK install on Android checks (package installer, file manager, adb)', () => {
    expect(updateChannel(env())).toBe('sideload');
    expect(updateChannel(env({ install: { known: true, installer: 'com.mi.android.globalFileexplorer' } }))).toBe('sideload');
    expect(updateChannel(env({ install: { known: true, installer: null } }))).toBe('sideload');
  });

  it('a Google Play install never does', () => {
    expect(updateChannel(env({ install: { known: true, installer: 'com.android.vending' } }))).toBe('play');
    expect(updateChannel(env({ install: { known: true, installer: 'com.google.android.feedback' } }))).toBe('play');
  });

  it('an install source Android would not tell counts as Play: no check', () => {
    expect(updateChannel(env({ install: { known: false, installer: null } }))).toBe('off');
  });

  it('web, portal, dev and iOS builds never check', () => {
    expect(updateChannel(env({ platform: 'web', native: false }))).toBe('off');
    expect(updateChannel(env({ native: false }))).toBe('off');
    expect(updateChannel(env({ platform: 'ios' }))).toBe('off');
    for (const ads of ['crazygames', 'poki', 'adtest']) expect(updateChannel(env({ ads }))).toBe('off');
    expect(updateChannel(env({ dev: true }))).toBe('off');
  });

  it('the running test build (no Android plugin, dev) is off', async () => {
    await expect(runtimeChannel()).resolves.toBe('off');
    await expect(installSource()).resolves.toEqual({ known: false, installer: null });
    await expect(openExternalUrl(apkUrl('v1.3.0'))).resolves.toBe(false);
  });

  it('Play and off installs never fetch, automatically or from Settings', async () => {
    for (const channel of ['play', 'off'] as const) {
      const { c, fetch, persist } = checker({ channel });
      await expect(c.auto()).resolves.toBeNull();
      await expect(c.manual()).resolves.toMatchObject({ kind: 'error' });
      expect(fetch).not.toHaveBeenCalled();
      expect(persist.saves).toBe(0);
      expect(c.channelNow).toBe(channel);
    }
  });

  it('a channel lookup that fails counts as off', async () => {
    const fetch = vi.fn();
    const c = new UpdateChecker({ channel: () => Promise.reject(new Error('no plugin')), persist: new MemPersist(), fetch });
    await expect(c.auto()).resolves.toBeNull();
    expect(c.channelNow).toBe('off');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('automatic check', () => {
  it('asks GitHub once, unauthenticated, and offers the newer version', async () => {
    const { c, fetch, persist } = checker();
    const info = await c.auto();
    expect(info?.version).toBe('1.3.0');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(RELEASES_URL);
    expect(url).toBe('https://api.github.com/repos/Mitovoid-AI/VelocityBlocks/releases/latest');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
    expect(persist.state.lastCheck).toBe(1_000_000_000_000);
  });

  it('runs at most once per 24 h', async () => {
    let now = 1_000_000_000_000;
    const { c, fetch } = checker({ now: () => now });
    await c.auto();
    now += CHECK_INTERVAL_MS - 1;
    await expect(c.auto()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(c.auto()).resolves.not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a failed check also waits a day (no retry on every launch while offline)', async () => {
    let now = 5_000_000;
    const { c, fetch } = checker({ now: () => now, fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(c.auto()).resolves.toBeNull();
    now += 60_000;
    await expect(c.auto()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('autoCheckDue: never checked, a day later, or a clock that went back', () => {
    const t = 10 * CHECK_INTERVAL_MS;
    expect(autoCheckDue({ lastCheck: 0, skipped: null }, t)).toBe(true);
    expect(autoCheckDue({ lastCheck: t, skipped: null }, t + CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(autoCheckDue({ lastCheck: t, skipped: null }, t + CHECK_INTERVAL_MS)).toBe(true);
    expect(autoCheckDue({ lastCheck: t, skipped: null }, t - 1000)).toBe(true);
  });

  it('Skip this version silences that tag, but not a later one, and not the Settings button', async () => {
    let now = 1_000_000_000_000;
    let latest = 'v1.3.0';
    const { c } = checker({ now: () => now, fetch: () => Promise.resolve(res(200, release(latest))) });
    const info = await c.auto();
    c.skip(info!.tag);
    now += CHECK_INTERVAL_MS;
    await expect(c.auto()).resolves.toBeNull();
    // Settings > Check for updates still finds it.
    await expect(c.manual()).resolves.toMatchObject({ kind: 'update', info: { tag: 'v1.3.0' } });
    latest = 'v1.3.1';
    now += CHECK_INTERVAL_MS;
    await expect(c.auto()).resolves.toMatchObject({ tag: 'v1.3.1' });
  });

  it('nothing newer: no offer', async () => {
    const { c } = checker({ fetch: () => Promise.resolve(res(200, release('v1.2.0'))) });
    await expect(c.auto()).resolves.toBeNull();
  });

  it('two checks at once share one request', async () => {
    const { c, fetch } = checker();
    const [a, b] = await Promise.all([c.manual(), c.manual()]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('failures are silent', () => {
  it('offline, rate limit, server error, bad JSON: error, never a throw', async () => {
    const cases: FetchFn[] = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(res(403, { message: 'API rate limit exceeded' })),
      () => Promise.resolve(res(429)),
      () => Promise.resolve(res(500)),
      () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }),
      () => {
        throw new Error('sync throw');
      },
    ];
    for (const f of cases) {
      const r = await fetchLatest(f, '1.2.0', 50);
      expect(r.kind).toBe('error');
      const { c } = checker({ fetch: f });
      await expect(c.auto()).resolves.toBeNull();
    }
  });

  it('no release yet (404) is up to date', async () => {
    await expect(fetchLatest(() => Promise.resolve(res(404, { message: 'Not Found' })), '1.2.0')).resolves.toEqual({ kind: 'current' });
  });

  it('gives up after the timeout and aborts the request', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const p = fetchLatest(
      (_u, init) => {
        signal = init.signal ?? undefined;
        return new Promise(() => {}); // never answers
      },
      '1.2.0',
      8000,
    );
    await vi.advanceTimersByTimeAsync(7999);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ kind: 'error', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it('a body that never arrives also times out', async () => {
    vi.useFakeTimers();
    const p = fetchLatest(() => Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }), '1.2.0', 8000);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p).resolves.toMatchObject({ kind: 'error' });
  });
});

describe('stored state', () => {
  const ls = () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
    });
    return map;
  };

  it('round-trips last check and the skipped tag under vb.update', () => {
    const map = ls();
    expect(localUpdatePersist.load()).toEqual({ lastCheck: 0, skipped: null });
    localUpdatePersist.save({ lastCheck: 123, skipped: 'v1.3.0' });
    expect(JSON.parse(map.get('vb.update')!)).toEqual({ lastCheck: 123, skipped: 'v1.3.0' });
    expect(localUpdatePersist.load()).toEqual({ lastCheck: 123, skipped: 'v1.3.0' });
  });

  it('reads corrupt or odd values as never checked', () => {
    const map = ls();
    for (const raw of ['{', '"x"', 'null', '{"lastCheck":"soon","skipped":5}', '[1,2]']) {
      map.set('vb.update', raw);
      expect(localUpdatePersist.load()).toEqual({ lastCheck: 0, skipped: null });
    }
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    });
    expect(localUpdatePersist.load()).toEqual({ lastCheck: 0, skipped: null });
    expect(() => localUpdatePersist.save({ lastCheck: 1, skipped: null })).not.toThrow();
  });
});
