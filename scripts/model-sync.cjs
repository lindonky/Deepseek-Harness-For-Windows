'use strict'

/**
 * Startup model-catalog sync for the `deepseek-official` provider route.
 *
 * Why this exists: the harness ships a static `DEFAULT_MODELS` catalog, so a
 * model DeepSeek adds (or retires) on `api.deepseek.com/models` stays invisible
 * in the model picker until the vendor package is upgraded. This module mirrors
 * that endpoint into the *documented, hot-reloaded* user-settings section
 * (`$DSH_HOME/settings.yaml` -> `llm-deepseek.models`) on every launch.
 *
 * Contract:
 * - Fire-and-forget: `syncModelCatalog()` never rejects and never blocks the
 *   window; the caller does not await it.
 * - Additive: the endpoint's current ids replace the catalog, so retired ids
 *   disappear from the picker. Nothing else about the route changes — same
 *   provider (`deepseek-official`), same base URL, same `DEEPSEEK_API_KEY`
 *   credential. Catalog entries are advisory; the adapter still passes any
 *   model id through unchanged.
 * - Conservative: a missing settings file, missing key, unreachable endpoint,
 *   or empty model list leaves the existing catalog untouched.
 * - Non-destructive: only the `models:` sub-block of the `llm-deepseek:` section
 *   is rewritten, so sibling keys (`baseURL`, `apiKeyEnv`, …) and every other
 *   top-level section survive byte-for-byte.
 *
 * Note: `llm-deepseek.models` is a *replace*, not a merge — which is exactly
 * what lets a retired model disappear. Removing the section hands control back
 * to the built-in catalog.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** User-settings section owned by `@deepseek-ai/dsh-llm-deepseek`. */
const SECTION_KEY = 'llm-deepseek'
/** Credential name the route resolves (see the vendor package README). */
const API_KEY_NAME = 'DEEPSEEK_API_KEY'
/** Endpoint override honored by the vendor plugin. */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
/** Must match the plugin's `PUBLIC_BASE_URL`. */
const PUBLIC_BASE_URL = 'https://api.deepseek.com'
const REQUEST_TIMEOUT_MS = 10_000
const LOG_LIMIT_BYTES = 64 * 1024
const BACKUP_SUFFIX = '.bak-model-sync'

/** Resolve `$DSH_HOME`, defaulting to `~/.dsh` like `@deepseek-ai/dsh-home-paths`. */
function dshHome() {
  const override = process.env.DSH_HOME
  return override !== undefined && override.trim().length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), '.dsh')
}

/** Append one line of diagnostics; never throws (GUI stdout is invisible). */
function log(message) {
  console.log(`[model-sync] ${message}`)
  try {
    const file = path.join(dshHome(), 'model-sync.log')
    try {
      if (fs.statSync(file).size > LOG_LIMIT_BYTES) fs.writeFileSync(file, '')
    } catch {}
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}${os.EOL}`)
  } catch {}
}

/** Resolve the DeepSeek key the same way the adapter does, env layer first. */
function readApiKey() {
  const ambient = process.env[API_KEY_NAME]
  if (ambient !== undefined && ambient.trim().length > 0) return ambient.trim()
  try {
    const text = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8')
    const match = new RegExp(`^${API_KEY_NAME}:[ \\t]*(.+)$`, 'm').exec(text)
    if (match === null || match[1] === undefined) return undefined
    const value = match[1].trim().replace(/^['"]|['"]$/g, '')
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Turn a wire model id into a display name, mirroring the vendor's own style
 * (`deepseek-v4-pro` -> `DeepSeek-V4-Pro`). Only a label: the wire id is what
 * gets sent, and capability fields are deliberately left to adapter defaults
 * because `/models` reports no context window.
 */
function displayName(id) {
  return id
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part.toLowerCase() === 'deepseek') return 'DeepSeek'
      // Version-ish parts (`v4`, `3.6`) stay fully upper-case, words are title-cased.
      if (/^[a-z]*\d[\w.]*$/i.test(part)) return part.toUpperCase()
      return part[0].toUpperCase() + part.slice(1)
    })
    .join('-')
}

/** Fetch the advisory model ids; order preserved, duplicates dropped. */
async function fetchModelIds(baseURL, apiKey) {
  const response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GET /models returned HTTP ${response.status}`)
  const body = await response.json()
  const data = body !== null && typeof body === 'object' ? body.data : undefined
  if (!Array.isArray(data)) throw new Error('GET /models returned an unexpected body')
  const ids = []
  for (const entry of data) {
    const id = entry !== null && typeof entry === 'object' ? entry.id : undefined
    if (typeof id === 'string' && id.trim().length > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** True when the line opens a new top-level mapping key. */
function isTopLevel(line) {
  return line.length > 0 && !/^\s/.test(line) && !line.startsWith('#')
}

/** Bounds of the `llm-deepseek:` section, or undefined when absent. */
function sectionBounds(lines) {
  const start = lines.findIndex((line) => line.trim() === `${SECTION_KEY}:`)
  if (start === -1) return undefined
  let end = start + 1
  while (end < lines.length && !isTopLevel(lines[end])) end += 1
  return { start, end }
}

/** Read the ids currently pinned by `llm-deepseek.models`, if any. */
function readModelIds(text) {
  const lines = text.split(/\r?\n/)
  const bounds = sectionBounds(lines)
  if (bounds === undefined) return undefined
  const section = lines.slice(bounds.start + 1, bounds.end)
  const at = section.findIndex((line) => /^\s*models:/.test(line))
  if (at === -1) return undefined
  const ids = []
  for (let i = at + 1; i < section.length; i += 1) {
    const item = /^\s*-\s*id:\s*(.+?)\s*$/.exec(section[i])
    if (item !== null && item[1] !== undefined) {
      ids.push(item[1].replace(/^['"]|['"]$/g, ''))
      continue
    }
    if (section[i].trim() !== '' && !/^\s{4,}\S/.test(section[i])) break
  }
  return ids
}

/** Rewrite just the `models:` sub-block of `llm-deepseek:`, preserving the rest. */
function writeModelList(text, ids) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const block = ['  models:']
  for (const id of ids) block.push(`    - id: ${id}`, `      name: ${displayName(id)}`)

  const bounds = sectionBounds(lines)
  if (bounds === undefined) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    const tail = [...(lines.length > 0 ? [''] : []), `${SECTION_KEY}:`, ...block]
    return [...lines, ...tail].join(eol) + eol
  }

  const section = lines.slice(bounds.start + 1, bounds.end)
  const at = section.findIndex((line) => /^\s*models:/.test(line))
  if (at === -1) {
    return [...lines.slice(0, bounds.start + 1), ...block, ...lines.slice(bounds.start + 1)].join(eol)
  }

  const abs = bounds.start + 1 + at
  let end = abs + 1
  while (end < lines.length && !isTopLevel(lines[end]) && (lines[end].trim() === '' || /^\s{4,}\S/.test(lines[end]))) end += 1
  return [...lines.slice(0, abs), ...block, ...lines.slice(end)].join(eol)
}

/** Write the settings file in place, atomically and with one rolling backup. */
function writeSettings(file, next) {
  const tmp = `${file}.model-sync.tmp`
  fs.writeFileSync(tmp, next)
  try {
    fs.copyFileSync(file, `${file}${BACKUP_SUFFIX}`)
  } catch {}
  fs.renameSync(tmp, file)
}

/** Human-readable diff summary for the log line. */
function describeChange(before, after) {
  if (before === undefined) return `写入 ${after.length} 个模型：${after.join(', ')}`
  const added = after.filter((id) => !before.includes(id))
  const removed = before.filter((id) => !after.includes(id))
  const parts = []
  if (added.length > 0) parts.push(`新增 ${added.join(', ')}`)
  if (removed.length > 0) parts.push(`下架 ${removed.join(', ')}`)
  return parts.length > 0 ? parts.join('；') : '顺序变化'
}

/**
 * Mirror `api.deepseek.com/models` into `llm-deepseek.models`.
 * Resolves once the (bounded) work is done; never rejects.
 * @returns the outcome, for tests and callers that care.
 */
async function syncModelCatalog() {
  try {
    const settingsFile = path.join(dshHome(), 'settings.yaml')
    if (!fs.existsSync(settingsFile)) {
      // Never create the file: `dsh` owns it and seeds it during onboarding.
      log('settings.yaml 尚不存在，保持内置目录（下次启动再同步）')
      return { status: 'no-settings' }
    }

    const apiKey = readApiKey()
    if (apiKey === undefined) {
      log(`未找到 ${API_KEY_NAME}，保持现有目录`)
      return { status: 'no-key' }
    }

    const baseURL = (process.env[BASE_URL_ENV] ?? '').trim() || PUBLIC_BASE_URL
    const ids = await fetchModelIds(baseURL, apiKey)
    if (ids.length === 0) {
      log('接口未返回任何模型，保持现有目录')
      return { status: 'empty' }
    }

    const text = fs.readFileSync(settingsFile, 'utf8')
    const current = readModelIds(text)
    if (current !== undefined && current.length === ids.length && current.every((id, i) => id === ids[i])) {
      log(`模型目录已是最新（${ids.length} 个）`)
      return { status: 'current', models: ids }
    }

    const next = writeModelList(text, ids)
    if (next !== text) writeSettings(settingsFile, next)
    log(`模型目录已更新：${describeChange(current, ids)}`)
    return { status: 'updated', models: ids }
  } catch (error) {
    log(`同步失败（保持现有目录）：${error !== null && typeof error === 'object' && 'message' in error ? error.message : String(error)}`)
    return { status: 'failed' }
  }
}

module.exports = { syncModelCatalog, displayName, readModelIds, writeModelList }
