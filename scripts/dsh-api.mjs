#!/usr/bin/env node
// Debug client for the running DeepSeek Harness (0.1.5+ wire protocol).
//
// What changed in 0.1.5, and why this tool was rewritten:
//   * the route is `POST /api/<namespace>/<method>` (was `POST /api/<method>`)
//   * the payload must be `{ args: {…} }` — one plain object, no array
//   * every request needs the browser session cookie, exchanged from the
//     `?token=` URL the server prints at startup (a bare request answers 401)
//
// Usage:
//   node scripts/dsh-api.mjs session/list '{}'
//   node scripts/dsh-api.mjs settings/describe '{}'
//   node scripts/dsh-api.mjs session/history '{"_request":{"sessionId":"…"}}'
//
// `args` is passed through verbatim: 0.1.5 descriptors are strict and differ per
// endpoint — session/* and most controllers expect `{ _request: {…} }`, while
// settings/describe rejects it — so this tool does not guess an envelope.
//
// Target discovery, first hit wins:
//   DSH_URL   full tokenized URL, e.g. http://127.0.0.1:50895/?token=…
//   DSH_LOG   log file to read the last `dsh web:` line from (default:
//             <tmpdir>/deepseek-harness.log, where the desktop shell logs)
//   DSH_PORT + DSH_TOKEN

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { parseServerUrl } = require('./shell-utils.cjs')

const [method, argsJson] = process.argv.slice(2)
if (method === undefined || !method.includes('/')) {
  console.error('用法: node scripts/dsh-api.mjs <namespace/method> \'<json args>\'')
  console.error('例:   node scripts/dsh-api.mjs session/list \'{}\'')
  process.exit(2)
}

let args = {}
if (argsJson !== undefined && argsJson.trim().length > 0) {
  try {
    args = JSON.parse(argsJson)
  } catch (error) {
    console.error(`args 不是合法 JSON: ${error.message}`)
    process.exit(2)
  }
}

/** Locate the running server: explicit URL, then the shell's log, then port+token. */
function resolveTarget() {
  if (process.env.DSH_URL) return process.env.DSH_URL
  const logFile = process.env.DSH_LOG ?? path.join(os.tmpdir(), 'deepseek-harness.log')
  try {
    const parsed = parseServerUrl(fs.readFileSync(logFile, 'utf8'))
    if (parsed !== undefined) return parsed.url
  } catch {
    /* fall through to the explicit port form */
  }
  if (process.env.DSH_PORT && process.env.DSH_TOKEN) {
    return `http://127.0.0.1:${process.env.DSH_PORT}/?token=${process.env.DSH_TOKEN}`
  }
  console.error('找不到运行中的 harness。请用 DSH_URL=<带 token 的地址> 指定，')
  console.error(`或确认壳的日志里有 "dsh web:" 行：${logFile}`)
  process.exit(2)
}

const tokenUrl = resolveTarget()
const origin = new URL(tokenUrl).origin

// The token is accepted only on `GET /?token=…`, which answers 303 with the
// signed session cookie; every /api request then carries that cookie.
const handshake = await fetch(tokenUrl, { redirect: 'manual' })
const setCookie = handshake.headers.getSetCookie?.() ?? []
const cookie = setCookie.map((entry) => entry.split(';')[0]).find((entry) => entry.length > 0)
if (setCookie.length === 0) {
  console.error(`认证失败：HTTP ${handshake.status}（token 可能已过期——每次启动都会换新的）`)
  process.exit(1)
}

const rpcId = `zcode-${Date.now()}`
const response = await fetch(`${origin}/api/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
})
const body = await response.json().catch(() => undefined)
if (body === undefined) {
  console.error(`HTTP ${response.status}：响应不是 JSON`)
  process.exitCode = 1
} else {
  console.log(JSON.stringify(body, null, 2))
  process.exitCode = body?.result?.ok === true ? 0 : 1
}
