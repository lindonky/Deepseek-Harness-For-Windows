'use strict'

/**
 * Self-contained checks for `scripts/model-sync.cjs` (no test runner, no deps):
 *
 *     node scripts/model-sync.test.cjs
 *
 * Every case runs against a throwaway `$DSH_HOME` under the OS temp directory
 * and a stubbed `fetch`; the real credentials and settings are never touched.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { syncModelCatalog, displayName, readModelIds, writeModelList } = require('./model-sync.cjs')

/** Representative user settings: three sections, none of them `llm-deepseek`. */
const FIXTURE = [
  'ui-onboarding:',
  '  welcomeNoticeVersion: 2026-08-13.1',
  'agent-default-model:',
  '  provider: deepseek-official',
  '  model: deepseek-flash',
  '  reasoningEffort: high',
  'llm-pi-ai:',
  '  providers:',
  '    lingsuan:',
  '      displayName: Lingsuan Gemini',
  '      apiKeyEnv: LINGSUAN_API_KEY',
  '      api: openai-completions',
  '      baseURL: https://lingsuan.top/v1',
  '',
].join('\n')

const ROOT = path.join(os.tmpdir(), 'dsh-model-sync-test')
let pass = 0
let fail = 0

function check(name, ok, extra) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${extra === undefined ? '' : ` :: ${extra}`}`)
  }
}

/** Fresh throwaway `$DSH_HOME`; `content === undefined` leaves settings.yaml absent. */
function home(name, content) {
  const dir = path.join(ROOT, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'settings.yaml'), content)
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-test-key\n')
  process.env.DSH_HOME = dir
  delete process.env.DEEPSEEK_API_KEY
  return dir
}

const reader = (dir) => {
  const file = path.join(dir, 'settings.yaml')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
}

const stubModels = (ids) => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }),
  })
}

const stubStatus = (status) => {
  globalThis.fetch = async () => ({ ok: false, status, json: async () => ({}) })
}

/** Everything outside the `llm-deepseek:` section, ignoring trailing blanks. */
function stripSection(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === 'llm-deepseek:')
  if (start === -1) return text
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n+$/, '\n')
}

;(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true })

  console.log('== displayName ==')
  check('deepseek-flash', displayName('deepseek-flash') === 'DeepSeek-Flash', displayName('deepseek-flash'))
  check('deepseek-v4-pro', displayName('deepseek-v4-pro') === 'DeepSeek-V4-Pro', displayName('deepseek-v4-pro'))
  check('deepseek-v4-flash', displayName('deepseek-v4-flash') === 'DeepSeek-V4-Flash', displayName('deepseek-v4-flash'))

  console.log('\n== readModelIds / writeModelList ==')
  check('无段时返回 undefined', readModelIds(FIXTURE) === undefined)
  check('round-trip', JSON.stringify(readModelIds(writeModelList(FIXTURE, ['a-b', 'c-d']))) === JSON.stringify(['a-b', 'c-d']))

  console.log('\n== 首次同步（无 llm-deepseek 段）==')
  let dir = home('fresh', FIXTURE)
  stubModels(['deepseek-flash', 'deepseek-v4-pro'])
  let result = await syncModelCatalog()
  let out = reader(dir)
  check('status=updated', result.status === 'updated', JSON.stringify(result))
  check('写入接口返回的 id', out.includes('- id: deepseek-flash') && out.includes('- id: deepseek-v4-pro'))
  check('名称与官方风格一致', out.includes('name: DeepSeek-Flash') && out.includes('name: DeepSeek-V4-Pro'))
  check('其它段逐字节保留', stripSection(out) === stripSection(FIXTURE))
  check('留了备份', fs.readFileSync(path.join(dir, 'settings.yaml.bak-model-sync'), 'utf8') === FIXTURE)
  check('无残留 tmp', !fs.existsSync(path.join(dir, 'settings.yaml.model-sync.tmp')))

  console.log('\n== 再次同步应当幂等 ==')
  const settled = reader(dir)
  result = await syncModelCatalog()
  check('status=current', result.status === 'current', JSON.stringify(result))
  check('文件未改写', reader(dir) === settled)

  console.log('\n== 接口新增模型 ==')
  stubModels(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5-mini'])
  result = await syncModelCatalog()
  out = reader(dir)
  check('status=updated', result.status === 'updated', JSON.stringify(result))
  check('新增模型与名称', out.includes('- id: deepseek-v5-mini') && out.includes('name: DeepSeek-V5-Mini'))

  console.log('\n== 已下架模型必须消失，兄弟键必须保留 ==')
  const withSection = [
    'agent-default-model:',
    '  model: deepseek-flash',
    'llm-deepseek:',
    '  baseURL: https://gateway.example/v1',
    '  apiKeyEnv: MY_KEY',
    '  models:',
    '    - id: deepseek-v4-flash',
    '      name: DeepSeek-V4-Flash',
    '      contextWindow: 1000000',
    '    - id: deepseek-v4-pro',
    '      name: DeepSeek-V4-Pro',
    'llm-pi-ai:',
    '  providers: {}',
    '',
  ].join('\n')
  dir = home('existing', withSection)
  stubModels(['deepseek-flash', 'deepseek-v4-pro'])
  result = await syncModelCatalog()
  out = reader(dir)
  check('status=updated', result.status === 'updated', JSON.stringify(result))
  check('下架模型已移除', !out.includes('deepseek-v4-flash'))
  check('兄弟键 baseURL 保留', out.includes('baseURL: https://gateway.example/v1'))
  check('兄弟键 apiKeyEnv 保留', out.includes('apiKeyEnv: MY_KEY'))
  check('后续顶层段保留', out.trimEnd().endsWith('providers: {}'))
  check('models 块仍在 llm-deepseek 段内', /llm-deepseek:\n(  .*\n)+  models:\n(    .*\n?)+/.test(out))

  console.log('\n== models: [] 与 CRLF ==')
  dir = home('empty-list', 'llm-deepseek:\n  models: []\nllm-pi-ai:\n  providers: {}\n')
  stubModels(['deepseek-flash'])
  await syncModelCatalog()
  out = reader(dir)
  check('空列表被替换', out.includes('- id: deepseek-flash') && !out.includes('models: []'))
  check('后续段落保留', out.includes('providers: {}'))

  dir = home('crlf', FIXTURE.replace(/\n/g, '\r\n'))
  stubModels(['deepseek-flash'])
  await syncModelCatalog()
  out = reader(dir)
  check('CRLF 行尾保持', out.includes('\r\n') && !/(^|[^\r])\n/.test(out))

  console.log('\n== 保守路径一律不碰文件 ==')
  dir = home('failure', FIXTURE)
  const untouched = reader(dir)
  stubStatus(500)
  result = await syncModelCatalog()
  check('HTTP 500 -> failed', result.status === 'failed', JSON.stringify(result))
  check('500 不改文件', reader(dir) === untouched)
  stubModels([])
  result = await syncModelCatalog()
  check('空列表 -> empty', result.status === 'empty', JSON.stringify(result))
  check('空列表不改文件', reader(dir) === untouched)
  fs.rmSync(path.join(dir, '.credentials.yaml'))
  result = await syncModelCatalog()
  check('缺 key -> no-key', result.status === 'no-key', JSON.stringify(result))
  check('缺 key 不改文件', reader(dir) === untouched)

  dir = home('no-settings', undefined)
  stubModels(['deepseek-flash'])
  result = await syncModelCatalog()
  check('无 settings.yaml -> no-settings', result.status === 'no-settings', JSON.stringify(result))
  check('不创建 settings.yaml', !fs.existsSync(path.join(dir, 'settings.yaml')))

  console.log('\n== 环境变量里的 key 优先 ==')
  dir = home('env-key', FIXTURE)
  process.env.DEEPSEEK_API_KEY = 'sk-from-env'
  let authorization
  globalThis.fetch = async (_url, init) => {
    authorization = init.headers.authorization
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-flash' }] }) }
  }
  await syncModelCatalog()
  check('使用 DEEPSEEK_API_KEY 环境变量', authorization === 'Bearer sk-from-env', authorization)
  delete process.env.DEEPSEEK_API_KEY

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
})()
