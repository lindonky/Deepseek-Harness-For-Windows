function writeSettings(file, next) {
  writeAtomic(file, next, BACKUP_SUFFIX)
}

'use strict'

/**
 * Startup model-catalog sync for the `deepseek-official` provider route.
 *
 * What this does now (0.1.5+ rules): the adapter ships a rich vendor catalog —
 * entries carry `inputModalities`, `imagePixelBudget` and `systemPromptUpdate`
 * — and the settings section's `models` array **replaces that list wholesale**.
 * Writing a naive mirror of `api.deepseek.com/models` therefore *deletes*
 * capability metadata and hides vendor-only models (the vision entry is not
 * advertised by the public endpoint), so this helper is strictly additive:
 *
 *   1. read the vendor catalog as structured data (the adapter's own
 *      `resolveAdapterOptions`), so vendor entries are carried over verbatim;
 *   2. ask the endpoint for its advisory ids;
 *   3. ids the vendor does not list yet are appended (text-only defaults, the
 *      safe assumption for an unknown model);
 *   4. when the endpoint adds nothing, any override we wrote earlier is
 *      *removed*, handing the catalog back to the vendor;
 *   5. a models list containing ids we do not manage (a hand-written entry)
 *      disables the sync rather than being clobbered.
 *
 * Contract: fire-and-forget (never rejects), never blocks the window, leaves
 * everything untouched on any failure, and only rewrites the `llm-deepseek:`
 * section's `models:` sub-block (sibling keys and other sections survive
 * byte-for-byte). Same provider route, same base URL, same `DEEPSEEK_API_KEY`.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { isTopLevel, sectionBounds, writeAtomic } = require('./settings-file.cjs')

/** User-settings section owned by `@deepseek-ai/dsh-llm-deepseek`. */
const SECTION_KEY = 'llm-deepseek'
const API_KEY_NAME = 'DEEPSEEK_API_KEY'
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
const PUBLIC_BASE_URL = 'https://api.deepseek.com'
const REQUEST_TIMEOUT_MS = 10_000
const LOG_LIMIT_BYTES = 64 * 1024
const BACKUP_SUFFIX = '.bak-model-sync'

/** Adapter entry, relative to the packaged app root (this file lives in scripts/). */
const ADAPTER_ENTRY = ['node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js']

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

/** `deepseek-v4-pro` -> `DeepSeek-V4-Pro`, for ids the vendor does not name. */
function displayName(id) {
  return id
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part.toLowerCase() === 'deepseek') return 'DeepSeek'
      if (/^[a-z]*\d[\w.]*$/i.test(part)) return part.toUpperCase()
      return part[0].toUpperCase() + part.slice(1)
    })
    .join('-')
}

/**
 * Read the vendor catalog as structured entries via the adapter's own resolver.
 * Any failure (missing package, changed exports, unbuilt tree) returns
 * undefined, which disables the sync for this boot.
 */
async function readVendorModels(appRoot) {
  const entry = path.join(appRoot, ...ADAPTER_ENTRY)
  if (!fs.existsSync(entry)) {
    log(`未找到适配器入口（${ADAPTER_ENTRY.join('/')}），跳过同步`)
    return undefined
  }
  try {
    const adapter = await import(pathToFileURL(entry).href)
    if (typeof adapter.resolveAdapterOptions !== 'function') {
      log('适配器未导出 resolveAdapterOptions，跳过同步')
      return undefined
    }
    const options = adapter.resolveAdapterOptions({}, undefined)
    if (!Array.isArray(options?.models) || options.models.length === 0) {
      log('适配器未公布模型目录，跳过同步')
      return undefined
    }
    return options.models
  } catch (error) {
    log(`读取 vendor 目录失败，跳过同步：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

async function fetchModelIds(baseURL, apiKey, doFetch) {
  const response = await doFetch(`${baseURL.replace(/\/+$/, '')}/models`, {
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

/** Ids currently pinned by `llm-deepseek.models`, or undefined when absent. */
function readModelIds(text) {
  const lines = text.split(/\r?\n/)
  const bounds = sectionBounds(lines, SECTION_KEY)
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

/** Render one catalog entry; strings are JSON-quoted so any name survives YAML. */
function renderEntry(entry, lines) {
  lines.push(`    - id: ${JSON.stringify(entry.id)}`)
  if (entry.name !== undefined) lines.push(`      name: ${JSON.stringify(entry.name)}`)
  if (entry.description !== undefined) lines.push(`      description: ${JSON.stringify(entry.description)}`)
  if (entry.contextWindow !== undefined) lines.push(`      contextWindow: ${String(entry.contextWindow)}`)
  if (entry.maxTokens !== undefined) lines.push(`      maxTokens: ${String(entry.maxTokens)}`)
  if (Array.isArray(entry.inputModalities)) lines.push(`      inputModalities: ${JSON.stringify(entry.inputModalities)}`)
  if (entry.imagePixelBudget !== undefined) {
    const value = typeof entry.imagePixelBudget === 'number' ? String(entry.imagePixelBudget) : JSON.stringify(entry.imagePixelBudget)
    lines.push(`      imagePixelBudget: ${value}`)
  }
  if (entry.imageMaxBytes !== undefined) lines.push(`      imageMaxBytes: ${String(entry.imageMaxBytes)}`)
  if (entry.systemPromptUpdate !== undefined) lines.push(`      systemPromptUpdate: ${JSON.stringify(entry.systemPromptUpdate)}`)
}

/** Rewrite just the `models:` sub-block of `llm-deepseek:`, preserving the rest. */
function writeModelList(text, entries) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const block = ['  models:']
  for (const entry of entries) renderEntry(entry, block)

  const bounds = sectionBounds(lines, SECTION_KEY)
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

/** Drop the `models:` sub-block (and the section, when it becomes empty). */
function removeModelList(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const bounds = sectionBounds(lines, SECTION_KEY)
  if (bounds === undefined) return text
  const section = lines.slice(bounds.start + 1, bounds.end)
  const at = section.findIndex((line) => /^\s*models:/.test(line))
  if (at === -1) return text
  const abs = bounds.start + 1 + at
  let end = abs + 1
  while (end < bounds.end && (lines[end].trim() === '' || /^\s{4,}\S/.test(lines[end]))) end += 1
  // Would the section keep any key besides `models:`? Judge on the section itself.
  const sectionRest = [...lines.slice(bounds.start + 1, abs), ...lines.slice(end, bounds.end)]
  if (sectionRest.some((line) => /^\s+\S/.test(line))) {
    return [...lines.slice(0, abs), ...lines.slice(end)].join(eol)
  }
  // Section would be left with only its key: drop the whole section.
  return [...lines.slice(0, bounds.start), ...lines.slice(bounds.end)].join(eol)
}

/**
 * Ids this helper added itself, remembered across boots.
 *
 * The settings `models` list is the only way to publish an extra model, and it
 * replaces the vendor list wholesale — so a later boot cannot tell a model *we*
 * appended from one the user hand-wrote. Remembering our own additions is what
 * lets a retired endpoint model disappear again without ever touching a
 * hand-written entry.
 */
function stateFile() {
  return path.join(dshHome(), '.model-sync-state.json')
}

function readAddedIds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    return Array.isArray(parsed?.added) ? parsed.added.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeAddedIds(added) {
  try {
    fs.writeFileSync(stateFile(), `${JSON.stringify({ added }, null, 2)}\n`)
  } catch (error) {
    log(`写入同步状态失败（不影响目录）：${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeSettings(file, next) {
  const tmp = `${file}.model-sync.tmp`
  fs.writeFileSync(tmp, next)
  try {
    fs.copyFileSync(file, `${file}${BACKUP_SUFFIX}`)
  } catch {}
  fs.renameSync(tmp, file)
}

function sameIds(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * Reconcile the vendor catalog with the endpoint's advisory list.
 * Never rejects; returns the outcome for tests and logging.
 * @param options - injectable seams for tests (`appRoot`, `doFetch`, `vendorModels`, `apiKey`).
 */
async function syncModelCatalog(options = {}) {
  try {
    const appRoot = options.appRoot ?? path.resolve(__dirname, '..')
    const settingsFile = path.join(dshHome(), 'settings.yaml')
    if (!fs.existsSync(settingsFile)) {
      // Never create the file: `dsh` owns it and seeds it during onboarding.
      log('settings.yaml 尚不存在，保持内置目录（下次启动再同步）')
      return { status: 'no-settings' }
    }

    const text = fs.readFileSync(settingsFile, 'utf8')
    const current = readModelIds(text)
    const vendor = options.vendorModels ?? (await readVendorModels(appRoot))
    if (vendor === undefined) return { status: 'no-vendor' }

    const vendorIds = new Set(vendor.map((entry) => entry.id))

    const apiKey = options.apiKey ?? readApiKey()
    if (apiKey === undefined) {
      log(`未找到 ${API_KEY_NAME}，跳过同步`)
      return { status: 'no-key' }
    }
    const baseURL = (process.env[BASE_URL_ENV] ?? '').trim() || PUBLIC_BASE_URL
    const ids = await fetchModelIds(baseURL, apiKey, options.doFetch ?? fetch)
    if (ids.length === 0) {
      log('接口未返回任何模型，保持现有目录')
      return { status: 'empty' }
    }

    // Anything the vendor lists, the endpoint lists, or we appended ourselves is
    // ours to reconcile; anything else is the user's and disables the sync.
    const previousAdded = readAddedIds()
    const managed = new Set([...vendorIds, ...ids, ...previousAdded])
    if (current !== undefined) {
      const unmanaged = current.filter((id) => !managed.has(id))
      if (unmanaged.length > 0) {
        log(`settings 的 models 含用户自定义条目（${unmanaged.join(', ')}），为避免覆盖而跳过同步`)
        return { status: 'user-managed' }
      }
    }

    // Endpoint ids the vendor does not list yet: append them (text-only
    // defaults) while carrying every vendor entry — metadata included — over.
    const appended = ids.filter((id) => !vendorIds.has(id))
    if (appended.length === 0) {
      if (current === undefined) {
        log(`vendor 目录已覆盖接口返回的 ${ids.length} 个模型，无需覆盖`)
        return { status: 'current', models: [...vendorIds] }
      }
      const next = removeModelList(text)
      if (next !== text) writeSettings(settingsFile, next)
      writeAddedIds([])
      log('接口没有 vendor 之外的新模型，已移除我们之前写入的覆盖')
      return { status: 'restored', models: [...vendorIds] }
    }

    const entries = [...vendor, ...appended.map((id) => ({ id, name: displayName(id) }))]
    const targetIds = entries.map((entry) => entry.id)
    if (current !== undefined && sameIds(current, targetIds)) {
      writeAddedIds(appended)
      log(`模型目录已是最新（${entries.length} 个）`)
      return { status: 'current', models: targetIds }
    }
    const next = writeModelList(text, entries)
    if (next !== text) writeSettings(settingsFile, next)
    writeAddedIds(appended)
    log(`模型目录已更新：新增 ${appended.join(', ')}（vendor 条目及其能力元数据原样保留）`)
    return { status: 'updated', models: targetIds }
  } catch (error) {
    log(`同步失败（保持现有目录）：${error !== null && typeof error === 'object' && 'message' in error ? error.message : String(error)}`)
    return { status: 'failed' }
  }
}

module.exports = { syncModelCatalog, displayName, readModelIds, writeModelList, removeModelList }
