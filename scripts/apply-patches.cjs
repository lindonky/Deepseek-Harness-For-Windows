'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Patch sources always live in this repo. The install to patch defaults to this
// repo's own `node_modules`, but another copy can be named — e.g. an app that is
// already installed:
//     node scripts/apply-patches.cjs "C:/Users/me/AppData/Local/Programs/DeepSeek Harness/resources/app"
const repoRoot = path.resolve(__dirname, '..')
const installRoot = process.argv[2] === undefined ? repoRoot : path.resolve(process.argv[2])

/** Verbatim replacements: `from` is copied over `to`. */
const replacements = [
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

/** Source transforms: `from` exports `(source) => source` and rewrites `to` in place. */
const transforms = [
  {
    from: 'patches/dsh-llm-deepseek/flash-model.cjs',
    to: 'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
    why: 'Publish the current DeepSeek-Flash model in the model picker',
  },
  {
    from: 'patches/dsh-base/llm-retry-policy.cjs',
    to: 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
    why: 'Tolerate longer API outages instead of aborting the task (8 retries, 1s-30s backoff)',
  },
  {
    from: 'patches/dsh-host-directory-picker-native/owner-pid.cjs',
    to: 'node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/index.js',
    why: 'Tell the folder-dialog worker which window should own the dialog',
  },
  {
    from: 'patches/dsh-host-directory-picker-native/owner-window.cjs',
    to: 'node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs',
    why: 'Own the folder dialog by the harness window so Windows keeps it in front',
  },
]

let failed = false

for (const entry of replacements) {
  const from = path.join(repoRoot, entry.from)
  const to = path.join(installRoot, entry.to)
  if (!fs.existsSync(from)) {
    console.error(`[dsh-patch] missing source: ${entry.from}`)
    failed = true
    continue
  }
  if (!fs.existsSync(path.dirname(to))) {
    console.error(`[dsh-patch] target package is not installed: ${entry.to}`)
    failed = true
    continue
  }
  fs.copyFileSync(from, to)
  console.log(`[dsh-patch] applied ${entry.to} (${entry.why})`)
}

for (const entry of transforms) {
  const from = path.join(repoRoot, entry.from)
  const to = path.join(installRoot, entry.to)
  if (!fs.existsSync(from)) {
    console.error(`[dsh-patch] missing source: ${entry.from}`)
    failed = true
    continue
  }
  if (!fs.existsSync(to)) {
    console.error(`[dsh-patch] target package is not installed: ${entry.to}`)
    failed = true
    continue
  }
  // Re-applying must be a no-op: a transform returns its source unchanged when
  // its change is already present, and throws when the vendor layout moved.
  const transform = require(from)
  const before = fs.readFileSync(to, 'utf8')
  const after = transform(before)
  if (after === before) {
    console.log(`[dsh-patch] already applied ${entry.to}`)
    continue
  }
  fs.writeFileSync(to, after)
  console.log(`[dsh-patch] applied ${entry.to} (${entry.why})`)
}

if (failed) process.exitCode = 1
