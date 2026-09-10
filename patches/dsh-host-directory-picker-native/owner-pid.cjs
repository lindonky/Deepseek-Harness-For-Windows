'use strict'

// Source transform for `@deepseek-ai/dsh-host-directory-picker-native/lib/index.js`.
//
// The driver spawns the Win32 folder-dialog child and hands it nothing but the
// dialog title. A dialog created with a null owner is *not* guaranteed to reach
// the foreground: Windows only grants foreground activation to a process that
// already holds it (or was started by the holder), which the dialog worker — a
// grandchild of this server — usually is not. The dialog then opens *behind*
// the window the user just clicked, which reads as "选择目录没反应".
//
// This half of the fix passes the window owner down to the worker: the parent
// of this server process is the Electron main process, i.e. the process that
// owns the harness window. `DSH_DIALOG_OWNER_PID` is honored when the launching
// shell already set it (manual/debug override); otherwise the parent pid is
// used. Passing an owner is what makes `IFileDialog::Show` activate the dialog
// with its owner (see `owner-window.cjs` for the worker half).

/** Anchor on the worker environment; insertion preserves surrounding formatting. */
// The vendor bundle indents this block with tabs; keep them byte-exact.
const ANCHOR = [
  '\tconst env = {',
  '\t\t...process.env,',
  '\t\tDSH_DIALOG_TITLE: data.title',
  '\t};',
].join('\n')

const REPLACEMENT = [
  '\tconst env = {',
  '\t\t...process.env,',
  '\t\tDSH_DIALOG_OWNER_PID: process.env.DSH_DIALOG_OWNER_PID ?? String(process.ppid),',
  '\t\tDSH_DIALOG_TITLE: data.title',
  '\t};',
].join('\n')

/**
 * Let the dialog child resolve the window that should own the dialog.
 * @param source - contents of `dsh-host-directory-picker-native/lib/index.js`.
 * @returns the patched source; identical when the entry is already present.
 * @throws when the vendor spawn block cannot be found (layout changed).
 */
module.exports = function passDialogOwnerPid(source) {
  if (source.includes('DSH_DIALOG_OWNER_PID')) return source
  if (!source.includes(ANCHOR)) {
    throw new Error(
      'dsh-host-directory-picker-native: spawnDialogWorker env block not found; vendor layout changed, update patches/dsh-host-directory-picker-native/owner-pid.cjs'
    )
  }
  return source.replace(ANCHOR, REPLACEMENT)
}
