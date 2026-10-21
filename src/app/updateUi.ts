// The "Update X.Y.Z available" pop-up (sideloaded Android installs only, see platform/updates.ts).
// Everything from GitHub (version, notes, file name) is untrusted: it is escaped here, never set as HTML.
//
// The GitHub build (Android 7+) updates inside the game: Update now downloads the APK with a progress bar in
// the pop-up, then opens Android's installer on it (after "Install unknown apps" is allowed once). Older app
// builds and Android 6 open the APK's address in the browser instead, as before.

import {
  cancelApkDownload,
  downloadApk,
  DownloadCancelled,
  inAppUpdates,
  installApk,
  openExternalUrl,
  type InstallState,
} from '../platform/native';
import { sizeText, type UpdateChecker, type UpdateInfo } from '../platform/updates';
import { closePopup, esc, showPopup, toast } from '../ui/dom';

/** Under the notes when the update downloads in the browser: what Download does, and the Android prompt to expect. */
export const INSTALL_HINT =
  'Download opens your browser. When it finishes, open the APK to install it; Android may ask you to allow installs from this source first.';
/** Under the notes when the update downloads in the game. */
export const IN_APP_HINT =
  'The update downloads here, then Android asks you to confirm the install. The first time, it may ask you to allow installs from Velocity Blocks. Your records and tracks are kept.';

export function updatePopupHtml(info: UpdateInfo, current: string, inApp = false): string {
  const size = sizeText(info.apk.size);
  const notes = info.notes ? esc(info.notes) : '<span class="muted">No release notes.</span>';
  return `<div class="panel upd-panel">
    <h2 class="upd-title">Update ${esc(info.version)} available</h2>
    <div class="muted upd-sub">You have ${esc(current)}.${size ? ` Download: ${esc(size)}.` : ''}</div>
    <div class="upd-notes" tabindex="0" aria-label="Release notes">${notes}</div>
    <div class="muted upd-hint">${esc(inApp ? IN_APP_HINT : INSTALL_HINT)}</div>
    <div class="upd-actions">
      <button class="btn small primary" data-act="download">${inApp ? 'Update now' : 'Download'}</button>
      <button class="btn small" data-act="back">Later</button>
      <button class="btn small" data-act="skip">Skip this version</button>
    </div>
  </div>`;
}

/** "3.1 / 8.3 MB · 37%" (or just the bytes when the total is unknown). */
export function progressText(received: number, total: number): string {
  const mb = (b: number) => (b / (1024 * 1024)).toFixed(1);
  if (!(total > 0)) return `${mb(received)} MB`;
  const pct = Math.min(100, Math.floor((received / total) * 100));
  return `${mb(received)} / ${mb(total)} MB · ${pct}%`;
}

/** The in-app steps after Update now: downloading, ready to install, and a failed download. */
export type StepView =
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'install'; state: 'ready' | InstallState }
  | { kind: 'failed'; reason: string };

export function stepHtml(info: UpdateInfo, v: StepView): string {
  const title = `<h2 class="upd-title">Update ${esc(info.version)}</h2>`;
  if (v.kind === 'downloading') {
    const pct = v.total > 0 ? Math.min(100, (v.received / v.total) * 100) : 0;
    return `<div class="panel upd-panel">
      ${title}
      <div class="muted upd-sub">Downloading…</div>
      <div class="upd-bar${v.total > 0 ? '' : ' busy'}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="upd-prog">${esc(progressText(v.received, v.total))}</div>
      <div class="upd-actions"><button class="btn small" data-act="back">Cancel</button></div>
    </div>`;
  }
  if (v.kind === 'failed') {
    return `<div class="panel upd-panel">
      ${title}
      <div class="upd-sub">The download didn't finish: ${esc(v.reason)}.</div>
      <div class="muted upd-hint">Check your connection and try again, or download it in your browser.</div>
      <div class="upd-actions">
        <button class="btn small primary" data-act="download">Try again</button>
        <button class="btn small" data-act="browser">Use the browser</button>
        <button class="btn small" data-act="back">Later</button>
      </div>
    </div>`;
  }
  const say: Record<'ready' | InstallState, string> = {
    ready: 'Downloaded. Opening the installer…',
    installing: "Tap Install in Android's window. The game closes and the new version opens with your records and tracks.",
    permission: 'Allow "Install unknown apps" for Velocity Blocks, then come back: the install starts by itself.',
    denied: 'Android needs that permission to install the update. Tap Install to try again.',
    failed: "The installer didn't open. Tap Install to try again.",
  };
  return `<div class="panel upd-panel">
    ${title}
    <div class="upd-bar done"><i style="width:100%"></i></div>
    <div class="upd-sub">${esc(say[v.state])}</div>
    <div class="upd-actions">
      <button class="btn small primary" data-act="install">Install</button>
      <button class="btn small" data-act="back">Later</button>
    </div>
  </div>`;
}

let support: Promise<boolean> | null = null;

/**
 * Show the offer. Later (and Android Back) closes it; Skip this version silences this tag's automatic offer.
 * `answered` runs once the player has chosen (an update started, Later or Skip).
 */
export function showUpdatePopup(checker: UpdateChecker, info: UpdateInfo, answered: () => void = () => {}): void {
  support ??= inAppUpdates();
  void support.then((inApp) => openUpdatePopup(checker, info, inApp, answered));
}

function openUpdatePopup(checker: UpdateChecker, info: UpdateInfo, inApp: boolean, answered: () => void): void {
  let busy = false;
  let downloading = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    answered();
  };
  const close = () => {
    closePopup();
    finish();
  };
  const show = (v: StepView) => {
    if (!popup.isConnected) return;
    popup.innerHTML = stepHtml(info, v);
  };
  const browser = () => {
    if (busy) return;
    busy = true;
    void openExternalUrl(info.apk.url).then((ok) => {
      busy = false;
      if (!ok) {
        toast("Couldn't open the browser for the download", 3200);
        return;
      }
      close();
      toast('Downloading in your browser. Open the APK when it finishes.', 3600);
    });
  };
  const install = () => {
    if (busy) return;
    busy = true;
    void installApk((later) => show({ kind: 'install', state: later })).then((state) => {
      busy = false;
      show({ kind: 'install', state });
    });
  };
  const download = () => {
    if (downloading) return;
    downloading = true;
    // Answered: the automatic offer is not shown again on the next visit to the home page.
    finish();
    show({ kind: 'downloading', received: 0, total: info.apk.size });
    let last = 0;
    downloadApk(info.apk.url, info.apk.size, (received, total) => {
      const bar = popup.querySelector<HTMLElement>('.upd-bar');
      const text = popup.querySelector<HTMLElement>('.upd-prog');
      if (!bar || !text || received < last) return;
      last = received;
      const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;
      bar.classList.toggle('busy', !(total > 0));
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      bar.firstElementChild?.setAttribute('style', `width:${pct.toFixed(1)}%`);
      text.textContent = progressText(received, total);
    }).then(
      () => {
        downloading = false;
        show({ kind: 'install', state: 'ready' });
        install();
      },
      (e: unknown) => {
        downloading = false;
        if (e instanceof DownloadCancelled) return;
        const reason = e instanceof Error && e.message ? e.message : 'unknown error';
        show({ kind: 'failed', reason: reason.replace(/[.\s]+$/, '') });
      },
    );
  };
  const popup = showPopup(updatePopupHtml(info, checker.current, inApp), 'dim', {
    download: () => (inApp ? download() : browser()),
    browser,
    install,
    back: () => {
      if (downloading) {
        cancelApkDownload();
        downloading = false;
        toast('Update cancelled', 2200);
      }
      close();
    },
    skip: () => {
      checker.skip(info.tag);
      close();
      toast(`Skipped version ${info.version}. Settings > Check for updates still finds it.`, 3200);
    },
  });
}
