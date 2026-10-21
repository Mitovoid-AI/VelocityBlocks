// The "Update X.Y.Z available" pop-up (sideloaded Android installs only, see platform/updates.ts).
// Everything from GitHub (version, notes, file name) is untrusted: it is escaped here, never set as HTML.

import { openExternalUrl } from '../platform/native';
import { sizeText, type UpdateChecker, type UpdateInfo } from '../platform/updates';
import { closePopup, esc, showPopup, toast } from '../ui/dom';

/** Under the notes: what Download does, and the one Android prompt to expect. */
export const INSTALL_HINT =
  'Download opens your browser. When it finishes, open the APK to install it; Android may ask you to allow installs from this source first.';

export function updatePopupHtml(info: UpdateInfo, current: string): string {
  const size = sizeText(info.apk.size);
  const notes = info.notes ? esc(info.notes) : '<span class="muted">No release notes.</span>';
  return `<div class="panel upd-panel">
    <h2 class="upd-title">Update ${esc(info.version)} available</h2>
    <div class="muted upd-sub">You have ${esc(current)}.${size ? ` Download: ${esc(size)}.` : ''}</div>
    <div class="upd-notes" tabindex="0" aria-label="Release notes">${notes}</div>
    <div class="muted upd-hint">${esc(INSTALL_HINT)}</div>
    <div class="upd-actions">
      <button class="btn small primary" data-act="download">Download</button>
      <button class="btn small" data-act="back">Later</button>
      <button class="btn small" data-act="skip">Skip this version</button>
    </div>
  </div>`;
}

/**
 * Show the offer. Later (and Android Back) closes it; Skip this version silences this tag's automatic offer.
 * `answered` runs once the player has chosen (Download opened the browser, Later or Skip).
 */
export function showUpdatePopup(checker: UpdateChecker, info: UpdateInfo, answered: () => void = () => {}): void {
  let opening = false;
  const close = () => {
    closePopup();
    answered();
  };
  showPopup(updatePopupHtml(info, checker.current), 'dim', {
    download: () => {
      if (opening) return;
      opening = true;
      void openExternalUrl(info.apk.url).then((ok) => {
        opening = false;
        if (!ok) {
          toast("Couldn't open the browser for the download", 3200);
          return;
        }
        close();
        toast('Downloading in your browser. Open the APK when it finishes.', 3600);
      });
    },
    back: close,
    skip: () => {
      checker.skip(info.tag);
      close();
      toast(`Skipped version ${info.version}. Settings > Check for updates still finds it.`, 3200);
    },
  });
}
