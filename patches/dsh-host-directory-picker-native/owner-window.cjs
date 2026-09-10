'use strict'

// Source transform for `@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs`.
//
// Vendor layout being changed (all tabs in the bundle):
//   show: () => method(dialog, SLOT_SHOW, protoShow)(null),   <- ownerless dialog
//
// An ownerless `IFileDialog` is not guaranteed the foreground, so it can open
// *behind* the harness window and read as "选择目录没反应" ("picking a directory
// does nothing"). This transform resolves the harness window — the first visible
// top-level unowned window of `DSH_DIALOG_OWNER_PID`, set by the driver half
// (`owner-pid.cjs`) to the Electron main process — and passes it as the dialog
// owner, which is what makes Windows activate the dialog together with its owner.
//
// The resolution is best-effort and side-effect free: a missing/foreign pid, a
// failure inside EnumWindows, or a window-less launcher (a plain `dsh web` in a
// terminal) all return null, which is exactly the pre-patch behavior.

const SHOW_ANCHOR = '\t' + '\t' + '\t' + '\t' + 'show: () => method(dialog, SLOT_SHOW, protoShow)(null),'
const SHOW_REPLACEMENT = '\t' + '\t' + '\t' + '\t' + 'show: (owner) => method(dialog, SLOT_SHOW, protoShow)(owner ?? null),'

const BINDINGS_ANCHOR = '\t' + '\t' + 'currentThreadId: () => getCurrentThreadId(),'

const CALL_ANCHOR = '\t' + '\t' + '\t' + 'const shown = dialog.show();'
const CALL_REPLACEMENT = '\t' + '\t' + '\t' + 'const shown = dialog.show(bindings.resolveDialogOwner?.() ?? null);'

/** Inserted right after the thread-id binding, so it closes over `user32`/`koffi`. */
const RESOLVER = [
  BINDINGS_ANCHOR,
  '\t' + '\t' + '/**',
  '\t' + '\t' + ' * Resolve the window that should own the dialog: the first visible top-level',
  '\t' + '\t' + ' * unowned window of `DSH_DIALOG_OWNER_PID` (the harness window). The address',
  '\t' + '\t' + ' * is captured as a plain number so it outlives the enumeration callback.',
  '\t' + '\t' + ' * @returns a window handle usable by `Show`, or null to stay ownerless.',
  '\t' + '\t' + ' */',
  '\t' + '\t' + 'resolveDialogOwner: () => {',
  '\t' + '\t' + '\t' + 'const target = Number(process.env.DSH_DIALOG_OWNER_PID ?? "");',
  '\t' + '\t' + '\t' + 'if (!Number.isInteger(target) || target <= 0) return null;',
  '\t' + '\t' + '\t' + 'const enumWindows = user32.func("__stdcall", "EnumWindows", "int32", ["void *", "intptr"]);',
  '\t' + '\t' + '\t' + 'const getWindowThreadProcessId = user32.func("__stdcall", "GetWindowThreadProcessId", "uint32", ["void *", "_Out_ uint32 *"]);',
  '\t' + '\t' + '\t' + 'const isWindowVisible = user32.func("__stdcall", "IsWindowVisible", "int32", ["void *"]);',
  '\t' + '\t' + '\t' + 'const getWindow = user32.func("__stdcall", "GetWindow", "void *", ["void *", "uint32"]);',
  '\t' + '\t' + '\t' + 'const protoEnumProc = koffi.proto("int __stdcall DshOwnerEnumProc(void *hwnd, intptr lparam)");',
  '\t' + '\t' + '\t' + 'let owner = null;',
  '\t' + '\t' + '\t' + 'const callback = koffi.register((hwnd) => {',
  '\t' + '\t' + '\t' + '\t' + 'if (owner !== null) return 0;',
  '\t' + '\t' + '\t' + '\t' + 'const pid = [0];',
  '\t' + '\t' + '\t' + '\t' + 'getWindowThreadProcessId(hwnd, pid);',
  '\t' + '\t' + '\t' + '\t' + '/* GW_OWNER (4) === null selects top-level, not owned, windows. */',
  '\t' + '\t' + '\t' + '\t' + 'if (pid[0] === target && isWindowVisible(hwnd) !== 0 && getWindow(hwnd, 4) === null) owner = koffi.address(hwnd);',
  '\t' + '\t' + '\t' + '\t' + 'return owner === null ? 1 : 0;',
  '\t' + '\t' + '\t' + '}, koffi.pointer(protoEnumProc));',
  '\t' + '\t' + '\t' + 'try {',
  '\t' + '\t' + '\t' + '\t' + 'enumWindows(callback, 0);',
  '\t' + '\t' + '\t' + '} catch {',
  '\t' + '\t' + '\t' + '\t' + 'return null;',
  '\t' + '\t' + '\t' + '} finally {',
  '\t' + '\t' + '\t' + '\t' + 'koffi.unregister(callback);',
  '\t' + '\t' + '\t' + '}',
  '\t' + '\t' + '\t' + 'return owner;',
  '\t' + '\t' + '},',
].join('\n')

/**
 * Make the folder dialog owned by the harness window.
 * @param source - contents of `dsh-host-directory-picker-native/lib/worker.cjs`.
 * @returns the patched source; identical when already applied.
 * @throws when a vendor anchor is missing (layout changed).
 */
module.exports = function showDialogWithOwner(source) {
  if (source.includes('resolveDialogOwner')) return source
  for (const [label, anchor] of [['show call', SHOW_ANCHOR], ['bindings', BINDINGS_ANCHOR], ['Show site', CALL_ANCHOR]]) {
    if (!source.includes(anchor)) {
      throw new Error(
        'dsh-host-directory-picker-native: ' + label + ' anchor not found; vendor layout changed, update patches/dsh-host-directory-picker-native/owner-window.cjs'
      )
    }
  }
  return source
    .replace(SHOW_ANCHOR, SHOW_REPLACEMENT)
    .replace(BINDINGS_ANCHOR, RESOLVER)
    .replace(CALL_ANCHOR, CALL_REPLACEMENT)
}
