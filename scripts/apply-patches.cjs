'use strict'
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const targets = [
  {
    from: 'patches/dsh-subprocess-local/index.js',
    to: 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js',
    why: 'Windows process inspector for persistent PTY shells',
  },
  {
    from: 'patches/dsh-terminal-bash/index.js',
    to: 'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js',
    why: 'Git Bash autodetection and optional sandbox bypass on Windows',
  },
  {
    from: 'patches/dsh-minimal/agent.cordis.yml',
    to: 'node_modules/@deepseek-ai/dsh/config/agent-presets/minimal/agent.cordis.yml',
    why: 'Windows minimal preset shell path, sandbox mode, and tool description',
  },
]

let failed = false
for (const target of targets) {
  const from = path.join(root, target.from)
  const to = path.join(root, target.to)
  if (!fs.existsSync(from)) {
    console.error(`[dsh-patch] missing source: ${target.from}`)
    failed = true
    continue
  }
  if (!fs.existsSync(path.dirname(to))) {
    console.error(`[dsh-patch] target package is not installed: ${target.to}`)
    failed = true
    continue
  }
  fs.copyFileSync(from, to)
  console.log(`[dsh-patch] applied ${target.to} (${target.why})`)
}

if (failed) process.exitCode = 1
