'use strict'

/**
 * Shared YAML-surgery helpers for the shell's settings tweaks.
 *
 * `settings.yaml` is the user's document: every writer here must preserve the
 * sections it does not own byte-for-byte, write atomically, and keep a backup.
 */

const fs = require('node:fs')

/** True when the line opens a new top-level mapping key. */
function isTopLevel(line) {
  return line.length > 0 && !/^\s/.test(line) && !line.startsWith('#')
}

/** Bounds of a top-level `<key>:` section, or undefined when absent. */
function sectionBounds(lines, key) {
  const start = lines.findIndex((line) => line.trim() === `${key}:`)
  if (start === -1) return undefined
  let end = start + 1
  while (end < lines.length && !isTopLevel(lines[end])) end += 1
  return { start, end }
}

/** Write `next` in place: temp file + rename, with one rolling backup. */
function writeAtomic(file, next, backupSuffix = '.bak-shell') {
  const tmp = `${file}.shell.tmp`
  fs.writeFileSync(tmp, next)
  try {
    fs.copyFileSync(file, `${file}${backupSuffix}`)
  } catch {}
  fs.renameSync(tmp, file)
}

module.exports = { isTopLevel, sectionBounds, writeAtomic }
