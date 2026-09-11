'use strict'

/**
 * Regenerate this wrapper's dependency list for a new `@deepseek-ai/dsh` release.
 *
 * Why this exists (handover doc §4.4): the dsh family declares most of its
 * runtime surface as **peerDependencies**, and electron-builder only packs
 * `dependencies` — it ignores peers entirely. The wrapper therefore has to
 * flatten every peer of the whole production closure into root `dependencies`.
 * Doing that by hand per release is how an installed exe ends up missing
 * `@deepseek-ai/cordis-plugin-group` and dies at boot.
 *
 * Usage:
 *   node scripts/sync-dsh-deps.cjs                 # newest `latest` on npm
 *   node scripts/sync-dsh-deps.cjs 0.1.5-rc.1      # or an explicit version
 *   node scripts/sync-dsh-deps.cjs 0.1.5-rc.1 --dry
 *   node scripts/sync-dsh-deps.cjs 0.1.5-rc.1 --no-scripts   # first pass of an upgrade
 *
 * It rewrites `package.json` (backup at `package.json.bak-deps`), installs, then
 * repeats the closure walk until no new peers appear. Renamed/removed
 * `@deepseek-ai/*` packages from the previous release are dropped first, so the
 * list always matches the new tree.
 */

const { execFileSync, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const MANIFEST = path.join(ROOT, 'package.json')
const BACKUP = path.join(ROOT, 'package.json.bak-deps')
const DSH = '@deepseek-ai/dsh'
const MAX_ROUNDS = 4

const args = process.argv.slice(2)
const dry = args.includes('--dry')
// `--no-scripts` skips lifecycle scripts, which is what the first install of a
// new dsh needs: the repo's postinstall applies source patches whose anchors
// belong to the *previous* release, so it must not run until those are updated.
const noScripts = args.includes('--no-scripts')
const version = args.find((arg) => !arg.startsWith('--'))

const log = (message) => console.log(`[dsh-deps] ${message}`)
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * Run npm as a Node script rather than through PATH: under Git Bash on Windows
 * `npm` is a shell script and `npm.cmd` is not on the spawn PATH, which makes a
 * bare execFileSync fail with ENOENT. `npm-cli.js` sits next to the running
 * node, so this works from any shell.
 */
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')

function npm(args_, stdio = 'inherit') {
  if (fs.existsSync(NPM_CLI)) return execFileSync(process.execPath, [NPM_CLI, ...args_], { cwd: ROOT, stdio })
  return execSync(['npm', ...args_].join(' '), { cwd: ROOT, stdio })
}

/** Newest published version, so an upgrade needs no hand-copied version string. */
function latestVersion() {
  const raw = npm(['view', DSH, 'dist-tags.latest', '--json'], 'pipe')
  return JSON.parse(raw.toString().trim())
}

/** Resolve `name` from `fromDir` the way Node does: nearest node_modules wins. */
function resolvePackage(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'))
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Every package reachable from the root's production dependencies.
 * devDependencies are deliberately not traversed: electron/electron-builder
 * peers must never be flattened into the shipped dependency list.
 */
function productionClosure(rootManifest) {
  const seen = new Map()
  const queue = Object.keys(rootManifest.dependencies ?? {}).map((name) => ({ name, from: ROOT }))
  while (queue.length > 0) {
    const { name, from } = queue.shift()
    if (seen.has(name)) continue
    const dir = resolvePackage(name, from)
    if (dir === undefined) {
      log(`warning: ${name} is declared but not installed; skipping its subtree`)
      continue
    }
    const manifest = readJson(path.join(dir, 'package.json'))
    seen.set(name, { dir, manifest })
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const child of Object.keys(manifest[field] ?? {})) queue.push({ name: child, from: dir })
    }
  }
  return seen
}

/** Peers declared anywhere in the closure that root `dependencies` does not carry. */
function missingPeers(closure, rootManifest) {
  const declared = new Set(Object.keys(rootManifest.dependencies ?? {}))
  const missing = new Map()
  for (const [owner, { manifest }] of closure) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (declared.has(name) || missing.has(name)) continue
      // A peer the closure already resolves needs no flattening; a missing one
      // is exactly what electron-builder would drop from the package.
      if (closure.has(name)) continue
      missing.set(name, { range, owner })
    }
  }
  return missing
}

function writeManifest(manifest) {
  manifest.dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))
  )
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}

function main() {
  const manifest = readJson(MANIFEST)
  const target = version ?? latestVersion()
  log(`target ${DSH}@${target}`)

  const dropped = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/') && name !== DSH)
  log(`dropping ${dropped.length} pinned @deepseek-ai/* entries (they are re-derived below)`)
  for (const name of dropped) delete manifest.dependencies[name]
  manifest.dependencies[DSH] = target

  fs.writeFileSync(BACKUP, `${JSON.stringify(readJson(MANIFEST), null, 2)}\n`)
  writeManifest(manifest)
  if (dry) {
    log('--dry: manifest rewritten, skipping install')
    return
  }

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    log(`round ${round}: npm install`)
    npm(['install', '--no-audit', '--no-fund', ...(noScripts ? ['--ignore-scripts'] : [])])

    const current = readJson(MANIFEST)
    const closure = productionClosure(current)
    const missing = missingPeers(closure, current)
    log(`round ${round}: closure=${closure.size} packages, newly needed peers=${missing.size}`)
    if (missing.size === 0) {
      log('done: every peer of the production closure is a root dependency')
      return
    }
    for (const [name, { range, owner }] of missing) {
      log(`  + ${name}@${range} (peer of ${owner})`)
      current.dependencies[name] = range
    }
    writeManifest(current)
  }
  log(`stopped after ${MAX_ROUNDS} rounds; run again if peers are still missing`)
}

main()
