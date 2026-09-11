'use strict'

/**
 * Self-contained checks for `scripts/model-sync.cjs` (no test runner, no deps):
 *
 *     node scripts/model-sync.test.cjs
 *
 * Every case runs against a throwaway `$DSH_HOME` under the OS temp directory,
 * with an injected vendor catalog and stubbed fetch — the real settings file,
 * credentials and network are never touched.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { syncModelCatalog, displayName, readModelIds, writeModelList, removeModelList } = require('./model-sync.cjs')

const ROOT = path.join(os.tmpdir(), 'dsh-model-sync-test')

/** The shape 0.1.5 ships: rich metadata that must survive the sync. */
const VENDOR = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1000000, systemPromptUpdate: 'in-history', inputModalities: ['text', 'image'], imagePixelBudget: 640000, imageMaxBytes: 1048576 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.', contextWindow: 1000000, inputModalities: ['text'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding.', contextWindow: 1000000, inputModalities: ['text'] },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', contextWindow: 1000000, inputModalities: ['text', 'image'], imagePixelBudget: 640000, imageMaxBytes: 1048576 },
]

const SETTINGS = [
  'ui-onboarding:',
  '  welcomeNoticeVersion: 2026-08-13.1',
  'agent-default-model:',
  '  provider: deepseek-official',
  '  model: deepseek-flash',
  'llm-pi-ai:',
  '  providers:',
  '    lingsuan:',
  '      baseURL: https://lingsuan.top/v1',
  '',
].join('\n')

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
const stubModels = (ids) => async () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: ids.map((id) => ({ id })) }) })
const stubStatus = (status) => async () => ({ ok: false, status, json: async () => ({}) })
const run = (extra = {}) => syncModelCatalog({ vendorModels: VENDOR, appRoot: ROOT, ...extra })

/** Nested `llm-deepseek.models` ids as an array (no regex parsing in tests). */
function modelsIn(text) {
  const ids = readModelIds(text)
  return ids === undefined ? undefined : ids
}

;(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true })

  console.log('== displayName ==')
  check('deepseek-flash', displayName('deepseek-flash') === 'DeepSeek-Flash', displayName('deepseek-flash'))
  check('deepseek-v5-mini', displayName('deepseek-v5-mini') === 'DeepSeek-V5-Mini', displayName('deepseek-v5-mini'))

  console.log('\n== 结构工具 ==')
  check('无覆盖时 readModelIds 返回 undefined', readModelIds(SETTINGS) === undefined)
  const withModels = writeModelList(SETTINGS, VENDOR)
  check('round-trip', JSON.stringify(readModelIds(withModels)) === JSON.stringify(VENDOR.map((m) => m.id)), JSON.stringify(readModelIds(withModels)))
  check('写出的条目保留能力元数据', withModels.includes('inputModalities: ["text","image"]') && withModels.includes('imagePixelBudget: 640000'), withModels.slice(withModels.indexOf('models:')))
  check('其它段落逐字节保留', withModels.replace(/\nllm-deepseek:[\s\S]*$/, '').trimEnd() === SETTINGS.trimEnd(), JSON.stringify(withModels.replace(/\nllm-deepseek:[\s\S]*$/, '').slice(-40)))
  check('removeModelList 只留 models 时删整段', removeModelList(withModels).trimEnd() === SETTINGS.trimEnd(), removeModelList(withModels))

  console.log('\n== 接口 ⊆ vendor：不写覆盖 ==')
  let dir = home('subset', SETTINGS)
  let result = await run({ doFetch: stubModels(['deepseek-flash', 'deepseek-v4-pro']), apiKey: 'sk-test' })
  check('status=current', result.status === 'current', JSON.stringify(result))
  check('文件保持原样（不 pin 目录、不丢元数据）', reader(dir) === SETTINGS)

  console.log('\n== 接口有 vendor 之外的新模型：增量写入且保留元数据 ==')
  dir = home('additive', SETTINGS)
  result = await run({ doFetch: stubModels(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5-mini']), apiKey: 'sk-test' })
  let out = reader(dir)
  check('status=updated', result.status === 'updated', JSON.stringify(result))
  check('vendor 4 个 + 新 1 个都在', JSON.stringify(modelsIn(out)) === JSON.stringify(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp', 'deepseek-v5-mini']), JSON.stringify(modelsIn(out)))
  check('vision 条目仍在（不被镜像逻辑删掉）', out.includes('deepseek-v4-flash-vision-exp'))
  check('vision 的图片能力元数据保留', out.includes('name: "DeepSeek-V4-Flash-Vision-Exp"') && out.includes('imageMaxBytes: 1048576'))
  check('deepseek-flash 的 systemPromptUpdate 保留', out.includes('systemPromptUpdate: "in-history"'))
  check('新模型用默认（纯文本）能力', out.includes('id: "deepseek-v5-mini"') && out.includes('name: "DeepSeek-V5-Mini"'))
  check('其它段不受影响', out.includes('welcomeNoticeVersion: 2026-08-13.1') && out.includes('baseURL: https://lingsuan.top/v1'))
  check('留了备份', fs.existsSync(path.join(dir, 'settings.yaml.bak-model-sync')))
  check('无残留 tmp', !fs.existsSync(path.join(dir, 'settings.yaml.model-sync.tmp')))

  console.log('\n== 幂等 ==')
  const settled = reader(dir)
  result = await run({ doFetch: stubModels(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5-mini']), apiKey: 'sk-test' })
  check('status=current', result.status === 'current', JSON.stringify(result))
  check('文件未变', reader(dir) === settled)

  console.log('\n== 接口回到子集：撤掉我们的覆盖 ==')
  result = await run({ doFetch: stubModels(['deepseek-flash', 'deepseek-v4-pro']), apiKey: 'sk-test' })
  out = reader(dir)
  check('status=restored', result.status === 'restored', JSON.stringify(result))
  check('覆盖被移除，vendor 默认目录重新生效', modelsIn(out) === undefined, out)
  check('其它段完好', out.includes('llm-pi-ai:') && out.includes('baseURL: https://lingsuan.top/v1'))

  console.log('\n== 用户手写的条目：不许覆盖 ==')
  const userOwned = writeModelList(SETTINGS, [...VENDOR, { id: 'my-local-llama', name: 'My Local Llama' }])
  dir = home('user-managed', userOwned)
  result = await run({ doFetch: stubModels(['deepseek-flash', 'deepseek-v4-pro']), apiKey: 'sk-test' })
  check('status=user-managed', result.status === 'user-managed', JSON.stringify(result))
  check('文件未变', reader(dir) === userOwned)

  console.log('\n== 保守路径一律不碰文件 ==')
  dir = home('failure', SETTINGS)
  result = await run({ doFetch: stubStatus(500), apiKey: 'sk-test' })
  check('HTTP 500 -> failed', result.status === 'failed', JSON.stringify(result))
  check('500 不改文件', reader(dir) === SETTINGS)
  result = await run({ doFetch: stubModels([]), apiKey: 'sk-test' })
  check('空列表 -> empty', result.status === 'empty', JSON.stringify(result))
  check('空列表不改文件', reader(dir) === SETTINGS)
  dir = home('no-key', SETTINGS)
  fs.rmSync(path.join(dir, '.credentials.yaml'))
  result = await run({ doFetch: stubModels(['deepseek-v5-mini']) })
  check('无 key -> no-key', result.status === 'no-key', JSON.stringify(result))
  check('无 key 不改文件', reader(dir) === SETTINGS)
  dir = home('no-vendor', SETTINGS)
  result = await run({ doFetch: stubModels(['deepseek-v5-mini']), vendorModels: undefined, apiKey: 'sk-test', appRoot: path.join(ROOT, '不存在') })
  check('读不到 vendor 目录 -> no-vendor（宁可不做）', result.status === 'no-vendor', JSON.stringify(result))
  check('no-vendor 不改文件', reader(dir) === SETTINGS)

  dir = home('no-settings', undefined)
  result = await run({ doFetch: stubModels(['deepseek-v5-mini']), apiKey: 'sk-test' })
  check('无 settings.yaml -> no-settings', result.status === 'no-settings', JSON.stringify(result))
  check('不创建 settings.yaml', !fs.existsSync(path.join(dir, 'settings.yaml')))

  console.log('\n== 兄弟键保留 ==')
  const sibling = 'llm-deepseek:\n  baseURL: https://gateway.example/v1\n  models:\n    - id: "deepseek-v4-pro"\nllm-pi-ai:\n  providers: {}\n'
  dir = home('sibling', sibling)
  result = await run({ doFetch: stubModels(['deepseek-v5-mini']), apiKey: 'sk-test' })
  out = reader(dir)
  check('status=updated', result.status === 'updated', JSON.stringify(result))
  check('baseURL 兄弟键保留', out.includes('baseURL: https://gateway.example/v1'))
  check('models 被增量重写为 vendor + 新模型', out.includes('deepseek-v4-pro') && out.includes('deepseek-v5-mini'))
  check('后续顶层段保留', out.trimEnd().endsWith('providers: {}'))

  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
})()
