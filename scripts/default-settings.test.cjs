'use strict'

/**
 * Self-contained checks for `scripts/default-settings.cjs`:
 *
 *     node scripts/default-settings.test.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ensureDefaultLocale } = require('./default-settings.cjs')

const ROOT = path.join(os.tmpdir(), 'dsh-default-settings-test')
const SETTINGS = ['agent-default-model:', '  provider: deepseek-official', '  model: deepseek-flash', 'llm-pi-ai:', '  providers: {}', ''].join('\n')

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; console.log(`  FAIL  ${name}${extra === undefined ? '' : ` :: ${extra}`}`) }
}

function home(name, content) {
  const dir = path.join(ROOT, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'settings.yaml'), content)
  process.env.DSH_HOME = dir
  return dir
}
const reader = (dir) => {
  const file = path.join(dir, 'settings.yaml')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
}

console.log('== 中文系统：写入默认值 ==')
let dir = home('zh', SETTINGS)
let result = ensureDefaultLocale({ locale: 'zh-CN' })
let out = reader(dir)
check('status=written', result.status === 'written', JSON.stringify(result))
check('写入 locale.preference', out.includes('locale:\n  preference: zh-CN'), JSON.stringify(out.slice(-40)))
check('原有段落逐字节保留', out.startsWith(SETTINGS.trimEnd()), JSON.stringify(out.slice(0, 30)))
check('留了备份', fs.existsSync(path.join(dir, 'settings.yaml.bak-shell')))
check('无残留 tmp', !fs.existsSync(path.join(dir, 'settings.yaml.shell.tmp')))

console.log('\n== 幂等 ==')
const settled = reader(dir)
result = ensureDefaultLocale({ locale: 'zh-CN' })
check('status=already-configured', result.status === 'already-configured', JSON.stringify(result))
check('文件未变', reader(dir) === settled)

console.log('\n== 非中文系统：不动 ==')
dir = home('en', SETTINGS)
result = ensureDefaultLocale({ locale: 'en-US' })
check('status=not-chinese-system', result.status === 'not-chinese-system', JSON.stringify(result))
check('文件未变', reader(dir) === SETTINGS)

console.log('\n== 保守路径 ==')
dir = home('none', undefined)
result = ensureDefaultLocale({ locale: 'zh-CN' })
check('无 settings.yaml -> no-settings', result.status === 'no-settings', JSON.stringify(result))
check('不创建文件', !fs.existsSync(path.join(dir, 'settings.yaml')))
dir = home('exists', `${SETTINGS.trimEnd()}\nlocale:\n  preference: en\n`)
result = ensureDefaultLocale({ locale: 'zh-CN' })
check('已有 locale 段 -> already-configured', result.status === 'already-configured', JSON.stringify(result))
check('不覆盖用户选择', reader(dir).includes('preference: en'))

fs.rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
