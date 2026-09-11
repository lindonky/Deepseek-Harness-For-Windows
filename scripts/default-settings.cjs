'use strict'

/**
 * First-run defaults for the user-settings document (`$DSH_HOME/settings.yaml`).
 *
 * Scope is deliberately tiny: only `locale.preference`, only on a system that
 * already speaks Chinese, only when the key is absent, and never by creating
 * the file (`dsh` owns it and seeds it during onboarding).
 *
 * Why pin a value upstream already resolves from the browser: the locale plugin
 * delegates to the browser when unset, which is right for a general installer,
 * but it also means a Chinese user on an English Windows install would land in
 * English. Writing the explicit preference keeps this build Chinese-first for
 * its audience while leaving every other system untouched.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sectionBounds, writeAtomic } = require('./settings-file.cjs')

const LOCALE_KEY = 'locale'
const LOCALE_FIELD = 'preference'
const CHINESE_LOCALE = 'zh-CN'

function dshHome() {
  const override = process.env.DSH_HOME
  return override !== undefined && override.trim().length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), '.dsh')
}

/**
 * Add `locale.preference` when this build should open in Chinese.
 * @param options - injectable seams for tests (`locale`, `settingsFile`, `dshHome`).
 * @returns `{ status }` describing what happened; never throws.
 */
function ensureDefaultLocale(options = {}) {
  try {
    const locale = options.locale ?? 'en'
    if (typeof locale !== 'string' || !locale.toLowerCase().startsWith('zh')) return { status: 'not-chinese-system' }

    const file = options.settingsFile ?? path.join(dshHome(), 'settings.yaml')
    if (!fs.existsSync(file)) return { status: 'no-settings' }

    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    if (sectionBounds(lines, LOCALE_KEY) !== undefined) return { status: 'already-configured' }

    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    const block = [
      '',
      `${LOCALE_KEY}:`,
      `  ${LOCALE_FIELD}: ${CHINESE_LOCALE}`,
    ]
    writeAtomic(file, [...lines, ...block].join(eol) + eol)
    return { status: 'written' }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

module.exports = { ensureDefaultLocale, CHINESE_LOCALE }
