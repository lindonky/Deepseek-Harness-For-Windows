'use strict'

/**
 * Pure helpers for the Electron shell (main.js), kept dependency-free so they
 * can be unit tested without launching Electron.
 *
 * Everything here exists because the harness must survive machines that differ
 * from the developer's: a launch URL that now carries an auth token, launch
 * directories that differ per user, and corporate/home proxies that only the
 * Windows registry knows about.
 */

const { spawnSync } = require('node:child_process')

/** The readiness line the dsh web bundle prints, token included. */
const URL_LINE = /dsh web:\s+(\S+)/

/**
 * Parse the `dsh web:` readiness line out of the server's stdout.
 *
 * 0.1.5 prints the tokenized URL: `dsh web: http://127.0.0.1:PORT/?token=...`,
 * and appends a display-only suffix when all-interfaces addresses exist:
 * ` (LAN: http://192.168.x.x:PORT/?token=...)`. The window must load the URL
 * *with* its token (a bare `/` answers 401), so the suffix is dropped by
 * matching a single non-space token.
 *
 * @param text - accumulated stdout from the server process.
 * @returns `{ url, port }` for the last readiness line, or undefined.
 */
function parseServerUrl(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  let match
  let last
  const pattern = new RegExp(URL_LINE.source, 'g')
  while ((match = pattern.exec(text)) !== null) last = match[1]
  if (last === undefined) return undefined
  let parsed
  try {
    parsed = new URL(last)
  } catch {
    return undefined
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { url: last, port }
}

/** Parse a WinINET `ProxyServer` value into per-scheme entries. */
function parseProxyServer(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const text = value.trim()
  if (!text.includes('=')) return { http: text, https: text }
  const entries = new Map()
  for (const part of text.split(';')) {
    const [scheme, address] = part.split('=')
    if (scheme !== undefined && address !== undefined && address.length > 0) entries.set(scheme.trim().toLowerCase(), address.trim())
  }
  const http = entries.get('http')
  const https = entries.get('https') ?? http
  if (http === undefined && https === undefined) return undefined
  return { http: http ?? https, https: https ?? http }
}

/** Read one registry value (HKCU only: the user's own proxy settings). */
function readRegistryValue(name, run) {
  const result = run(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name],
    { windowsHide: true, encoding: 'utf8' }
  )
  const stdout = result !== null && typeof result === 'object' ? result.stdout : undefined
  if (typeof stdout !== 'string') return undefined
  const match = /REG_\w+\s+(.+?)\s*$/m.exec(stdout)
  return match === null || match[1] === undefined ? undefined : match[1]
}

/**
 * Environment additions for the dsh server so its model calls follow the
 * machine's proxy. Node only honors `HTTP(S)_PROXY`/`NO_PROXY`; a desktop app
 * launched from Explorer does not inherit them, while Windows keeps the user's
 * proxy in the registry. Explicit process env always wins, and loopback is
 * always excluded so the shell's own 127.0.0.1 traffic never gets proxied.
 *
 * @param options - `env` to respect (default `process.env`), `run` for tests,
 *   `platform` for tests.
 * @returns the environment additions to merge (possibly empty).
 */
function systemProxyEnv(options = {}) {
  const env = options.env ?? process.env
  const run = options.run ?? spawnSync
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return {}

  const existing = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'].filter((name) => {
    const value = env[name]
    return typeof value === 'string' && value.length > 0
  })
  const additions = {}
  if (existing.length === 0) {
    const enabled = readRegistryValue('ProxyEnable', run)
    if (enabled !== undefined && /0x1\b/i.test(enabled)) {
      const parsed = parseProxyServer(readRegistryValue('ProxyServer', run))
      if (parsed !== undefined) {
        additions.HTTP_PROXY = `http://${parsed.http}`
        additions.HTTPS_PROXY = `http://${parsed.https}`
      }
    }
  }

  // Loopback must never be proxied: the window and the shell talk to 127.0.0.1.
  const bypass = ['127.0.0.1', 'localhost', '::1']
  const declared = env.NO_PROXY ?? env.no_proxy
  const merged = typeof declared === 'string' && declared.length > 0
    ? [...new Set([...bypass, ...declared.split(',').map((part) => part.trim()).filter(Boolean)])]
    : bypass
  additions.NO_PROXY = merged.join(',')
  if (typeof env.no_proxy === 'string' && env.no_proxy.length > 0) additions.no_proxy = env.no_proxy
  return additions
}

/** Keep the tail of a log for an error dialog without dumping megabytes. */
function tail(text, lines = 12) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const parts = text.trimEnd().split(/\r?\n/)
  return parts.slice(Math.max(0, parts.length - lines)).join('\n')
}

/**
 * Operator-facing failure text: the machine-specific detail lives in the log
 * file, because a packaged GUI has no visible stdout.
 */
function startupFailureMessage(what, detail, logFile) {
  const lines = [`Harness 启动失败：${what}`, '']
  const trimmed = tail(detail)
  if (trimmed.length > 0) lines.push(trimmed, '')
  lines.push(`完整日志：${logFile}`)
  return lines.join('\n')
}

module.exports = { parseServerUrl, parseProxyServer, systemProxyEnv, tail, startupFailureMessage }
