'use strict'

/**
 * Self-contained checks for `scripts/shell-utils.cjs` (no test runner, no deps):
 *
 *     node scripts/shell-utils.test.cjs
 */

const { parseServerUrl, parseProxyServer, systemProxyEnv, tail, startupFailureMessage } = require('./shell-utils.cjs')

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

/** `reg query` output shape, including the blank lines it really prints. */
const regOut = (name, type, value) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ${name}    ${type}    ${value}\r\n\r\n`
const regRunner = (values) => (_file, args) => {
  const name = args[args.length - 1]
  if (values[name] === undefined) return { status: 1, stdout: '', stderr: 'not found' }
  return { status: 0, stdout: regOut(name, values[name][0], values[name][1]), stderr: '' }
}

console.log('== parseServerUrl ==')
const token = 'http://127.0.0.1:50895/?token=xrG8Sh05Ra5zeNEur3IqcZd9uOwLpZa_alhE6jELOlc'
check('0.1.5 带 token 的启动行', JSON.stringify(parseServerUrl(`dsh web: ${token}\n`)) === JSON.stringify({ url: token, port: 50895 }))
const lan = `${token} (LAN: http://192.168.1.5:50895/?token=abc)`
check('带 LAN 后缀（窗口要加载 token URL，不能带上后缀）', parseServerUrl(`dsh web: ${lan}\n`)?.url === token, parseServerUrl(`dsh web: ${lan}\n`)?.url)
check('旧版无 token 行仍可解析', parseServerUrl('dsh web: http://127.0.0.1:3080\n')?.port === 3080)
check('多行取最后一条', parseServerUrl('dsh web: http://127.0.0.1:1/?token=a\nnoise\ndsh web: http://127.0.0.1:2/?token=b\n')?.port === 2)
check('没有启动行 -> undefined', parseServerUrl('starting up\n') === undefined)
check('端口非法 -> undefined', parseServerUrl('dsh web: http://127.0.0.1:0/?token=a\n') === undefined)
check('非字符串 -> undefined', parseServerUrl(undefined) === undefined)

console.log('\n== parseProxyServer ==')
check('裸 host:port 同时用于 http/https', JSON.stringify(parseProxyServer('127.0.0.1:7890')) === JSON.stringify({ http: '127.0.0.1:7890', https: '127.0.0.1:7890' }))
check('按协议分开', JSON.stringify(parseProxyServer('http=127.0.0.1:7890;https=127.0.0.2:7891')) === JSON.stringify({ http: '127.0.0.1:7890', https: '127.0.0.2:7891' }))
check('只写 http 时 https 复用', JSON.stringify(parseProxyServer('http=127.0.0.1:7890')) === JSON.stringify({ http: '127.0.0.1:7890', https: '127.0.0.1:7890' }))
check('空值 -> undefined', parseProxyServer('   ') === undefined)
check('无协议也无 host:port 形态 -> undefined', parseProxyServer('http=') === undefined)

console.log('\n== systemProxyEnv ==')
check('非 win32 不注入', JSON.stringify(systemProxyEnv({ platform: 'linux', env: {}, run: regRunner({}) })) === '{}')
const win = (env, values) => systemProxyEnv({ platform: 'win32', env, run: regRunner(values) })
let out = win({}, { ProxyEnable: ['REG_DWORD', '0x1'], ProxyServer: ['REG_SZ', '127.0.0.1:7890'] })
check('启用系统代理时注入 HTTP(S)_PROXY', out.HTTP_PROXY === 'http://127.0.0.1:7890' && out.HTTPS_PROXY === 'http://127.0.0.1:7890', JSON.stringify(out))
check('总是排除回环（否则窗口/服务自身会被代理）', out.NO_PROXY === '127.0.0.1,localhost,::1', out.NO_PROXY)
check('ProxyEnable=0 不注入', win({}, { ProxyEnable: ['REG_DWORD', '0x0'], ProxyServer: ['REG_SZ', '127.0.0.1:7890'] }).HTTP_PROXY === undefined)
check('已有显式 env 时尊重用户设置', win({ HTTPS_PROXY: 'http://corp:8080' }, { ProxyEnable: ['REG_DWORD', '0x1'], ProxyServer: ['REG_SZ', '127.0.0.1:7890'] }).HTTPS_PROXY === undefined)
out = win({ NO_PROXY: 'example.com' }, { ProxyEnable: ['REG_DWORD', '0x1'], ProxyServer: ['REG_SZ', 'http=127.0.0.1:7890;https=127.0.0.1:7891'] })
check('合并已有 NO_PROXY', out.NO_PROXY === '127.0.0.1,localhost,::1,example.com', out.NO_PROXY)
check('按协议分别注入', out.HTTP_PROXY === 'http://127.0.0.1:7890' && out.HTTPS_PROXY === 'http://127.0.0.1:7891', JSON.stringify(out))
check('代理未启用时不写 HTTP_PROXY/HTTPS_PROXY 键', !('HTTP_PROXY' in win({}, { ProxyEnable: ['REG_DWORD', '0x0'] })))
check('reg 查询失败不抛错', win({}, {}).HTTP_PROXY === undefined)

console.log('\n== tail / startupFailureMessage ==')
check('tail 只取最后 n 行', tail('a\nb\nc\nd', 2) === 'c\nd')
check('tail 空输入', tail('') === '')
const msg = startupFailureMessage('服务未在超时内就绪', 'line1\nline2\nboom: 具体原因', 'C:\\Temp\\deepseek-harness.log')
check('失败文案含原因', msg.includes('boom: 具体原因'), msg)
check('失败文案含日志路径（GUI 无 stdout）', msg.includes('C:\\Temp\\deepseek-harness.log'), msg)

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
