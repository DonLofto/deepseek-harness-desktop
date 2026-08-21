#!/usr/bin/env node
/**
 * Stage the desktop app's self-contained runtime: download the target
 * platform's Node binary, deploy the harness closure, and prune artifacts the
 * packaged app never loads (foreign-platform binaries, source trees). Runs at
 * build/CI time (needs network and a built workspace); the app falls back to
 * `DSH_DESKTOP_DSH_BIN`, then the repository's built CLI, when the staged
 * bundle is absent.
 *
 * Prerequisite: build the repo first (`pnpm run build`), so the deployed
 * `@deepseek-ai/dsh` carries its `lib/` artifacts.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { globSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_DIR = join(APP_DIR, 'vendor')
/** Workspace root; owns `pnpm-workspace.yaml`, the lockfile, and the store. */
const WORKSPACE_ROOT = join(APP_DIR, '..', '..')
/** Workspace node_modules of the deploy root (`@deepseek-ai/dsh`, apps/cli). */
const CLI_NODE_MODULES = join(APP_DIR, '..', 'cli', 'node_modules')
const NODE_VERSION = process.env.DSH_DESKTOP_NODE_VERSION ?? 'v22.19.0'

/**
 * The single runtime staged for this installer. Each build job runs on a
 * runner whose architecture matches the installer it produces (macOS arm64,
 * Windows x64), so the host arch is the target arch and exactly one Node
 * runtime is bundled. `DSH_DESKTOP_ARCH` overrides it for a cross-build.
 * Staging a macOS runtime on Windows would copy its symlinked `bin/` entries
 * into the NSIS archive, which 7za rejects.
 */
const TARGETS = process.platform === 'win32'
  ? [{ platform: 'win32', arch: 'x64' }]
  : [{ platform: 'darwin', arch: process.env.DSH_DESKTOP_ARCH ?? process.arch }]

/** Node's distribution filename names Windows `win`, not `win32`. */
function distPlatform(platform) {
  return platform === 'win32' ? 'win' : platform
}

function distName(target) {
  return `node-${NODE_VERSION}-${distPlatform(target.platform)}-${target.arch}`
}

function run(command, args) {
  // Windows resolves `pnpm` to `pnpm.cmd`, which CreateProcess cannot run
  // without a shell; `tar` and the other commands are unaffected by shell:true.
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`)
}

async function fetchNode(target) {
  const ext = target.platform === 'win32' ? 'zip' : 'tar.gz'
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${distName(target)}.${ext}`
  const archive = join(VENDOR_DIR, `${distName(target)}.${ext}`)
  mkdirSync(VENDOR_DIR, { recursive: true })
  const response = await fetch(url)
  if (!response.ok || response.body === null) {
    throw new Error(`download failed (${response.status}): ${url}`)
  }
  await pipeline(response.body, createWriteStream(archive))
  return archive
}

function extractNode(target, archive) {
  const runtimeDir = join(VENDOR_DIR, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })
  // bsdtar — the `tar` on macOS and Windows — reads both tarballs and zip
  // archives, so one extractor covers every shipped target without the
  // `unzip` binary that Windows runners do not provide.
  run('tar', ['-xf', archive, '-C', runtimeDir])
  const flat = join(runtimeDir, `${target.platform}-${target.arch}`)
  rmSync(flat, { recursive: true, force: true })
  renameSync(join(runtimeDir, distName(target)), flat)
  // The C/C++ headers under include/ only exist for compiling native addons;
  // the bundled runtime never compiles, so they are dead weight.
  rmSync(join(flat, 'include'), { recursive: true, force: true })
  rmSync(archive, { force: true })
}

function deployHarness() {
  rmSync(join(VENDOR_DIR, 'harness'), { recursive: true, force: true })
  run('pnpm', [
    '--filter', '@deepseek-ai/dsh', 'deploy',
    '--legacy', '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    join(VENDOR_DIR, 'harness'),
  ])
}

/**
 * Return every `node_modules/<scope>/<name>` directory nested under `root`.
 * `pnpm deploy` hoists the closure, but a transitive dependency that declares
 * a conflicting version stays nested under its dependent (for example
 * `@mistralai/mistralai` under `@earendil-works/pi-ai`), so a single top-level
 * path would miss it.
 */
function findNested(root, scope, name) {
  const found = []
  const visit = (dir, depth) => {
    if (depth > 4) return
    const modules = join(dir, 'node_modules')
    if (!existsSync(modules)) return
    const scoped = join(modules, scope)
    if (existsSync(scoped)) {
      for (const entry of readdirSync(scoped)) {
        const candidate = join(scoped, entry)
        if (entry === name && statSync(candidate).isDirectory()) found.push(candidate)
      }
    }
    for (const entry of readdirSync(modules)) {
      if (entry === '.bin') continue
      const child = join(modules, entry)
      if (!statSync(child).isDirectory()) continue
      if (entry.startsWith('@')) {
        // A scoped directory (`@scope/`) holds packages one level deeper; the
        // nested dependency we seek can sit under any of them.
        for (const sub of readdirSync(child)) {
          const pkg = join(child, sub)
          if (statSync(pkg).isDirectory()) visit(pkg, depth + 1)
        }
      } else {
        visit(child, depth + 1)
      }
    }
  }
  visit(root, 0)
  return found
}

/**
 * Remove artifacts the deployed closure ships regardless of target but the
 * packaged app never loads:
 * - node-pty bundles prebuilds for every platform in one tarball; only the
 *   `${platform}-${arch}` directory for the staged target is ever required.
 * - `@mistralai/mistralai` publishes its whole source tree; only the compiled
 *   `esm/` entry its `default` export points at is imported at runtime.
 */
function pruneHarness(harnessDir, target) {
  const keep = `${target.platform}-${target.arch}`
  const prebuilds = join(harnessDir, 'node_modules', 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      if (entry !== keep) rmSync(join(prebuilds, entry), { recursive: true, force: true })
    }
  }
  for (const mistralaiDir of findNested(harnessDir, '@mistralai', 'mistralai')) {
    for (const sub of ['src', 'examples', 'tests', 'packages']) {
      rmSync(join(mistralaiDir, sub), { recursive: true, force: true })
    }
  }
}

/** Every package directory under `harness` ('.' for root) and `harness/node_modules`. */
function closurePackageDirs(harnessDir) {
  const dirs = ['.']
  const nodeModules = join(harnessDir, 'node_modules')
  if (!existsSync(nodeModules)) return dirs
  const scopes = readdirSync(nodeModules, { withFileTypes: true })
    .filter(entry => entry.name.startsWith('@') && entry.isDirectory())
    .map(entry => entry.name)
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.name.startsWith('@') && entry.isDirectory()) dirs.push(entry.name)
  }
  for (const scope of scopes) {
    for (const entry of readdirSync(join(nodeModules, scope), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${scope}/${entry.name}`)
    }
  }
  return dirs
}

/**
 * Restore workspace dependencies that `pnpm deploy --legacy` fails to
 * materialize: direct root dependencies hoisted beside the deploy source
 * (bundle and shell packages such as `@deepseek-ai/dsh-base` and
 * `@deepseek-ai/dsh-web-app`) and `link:`-overridden transitive vendored
 * packages such as `@deepseek-ai/cosmokit`. Anything a deployed package.json
 * declares that the staged closure cannot resolve is copied from the deploy
 * root's workspace `node_modules`, dereferenced, with package-local
 * `node_modules` omitted to keep one flat Cordis instance. Mirrors
 * `build-exe-for-python-sdk.ts`.
 */
function restoreLegacyHoists(harnessDir) {
  const restored = []
  let changed = true
  while (changed) {
    changed = false
    for (const packageDir of closurePackageDirs(harnessDir)) {
      const manifestPath = packageDir === '.'
        ? join(harnessDir, 'package.json')
        : join(harnessDir, 'node_modules', packageDir, 'package.json')
      let manifest
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        continue
      }
      const declared = { ...manifest.dependencies, ...manifest.optionalDependencies }
      for (const [name, spec] of Object.entries(declared)) {
        if (!runtimeRequired(name, spec)) continue
        if (resolvesInClosure(harnessDir, packageDir, name)) continue
        const destination = join(harnessDir, 'node_modules', name)
        const source = workspaceDependencySource(name)
        if (source === undefined) {
          throw new Error(
            `prepare-runtime: ${packageDir} declares ${name}, absent from the staged closure and from the deploy root`,
          )
        }
        mkdirSync(dirname(destination), { recursive: true })
        const nestedNodeModules = join(source, 'node_modules')
        cpSync(source, destination, {
          recursive: true,
          dereference: true,
          filter: (path) => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
        })
        restored.push(name)
        changed = true
      }
    }
  }
  if (restored.length > 0) {
    console.log(`prepare-runtime: restored legacy deploy hoists: ${[...new Set(restored)].sort().join(', ')}`)
  }
}

/** Whether `dependency` resolves from the package at `packageDir`, walking up to the flat root. */
function resolvesInClosure(harnessDir, packageDir, dependency) {
  let base = packageDir === '.' ? harnessDir : join(harnessDir, 'node_modules', packageDir)
  for (;;) {
    if (existsSync(join(base, 'node_modules', dependency))) return true
    if (base === harnessDir) return false
    base = dirname(base)
  }
}

/** Whether a dependency only a matching platform/arch native addon needs to resolve. */
function platformNativeAddon(dependency) {
  if (!/-(darwin|linux|win32|freebsd)-(x64|arm64|arm|ia32)/.test(dependency)) return false
  return !dependency.includes(`${process.platform}-${process.arch}`)
}

/** Required at runtime: skips optional platform addons for foreign OSes/arches. */
function runtimeRequired(name, spec) {
  if (spec.startsWith('workspace:') || spec.startsWith('link:') || name.startsWith('@deepseek-ai/')) {
    return !platformNativeAddon(name)
  }
  return false
}

/** `link:`-pinned workspace packages the legacy deploy never materializes. */
function workspaceOverrideTarget(dependency) {
  const yaml = readFileSync(join(WORKSPACE_ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const pattern = new RegExp(`^\\s*['"]${dependency.replace(/[/.]/g, '\\$&')}['"]\\s*:\\s*['"](link:[^'"]+)['"]`, 'm')
  const match = pattern.exec(yaml)
  return match === null ? undefined : match[1].replace(/^link:/, '')
}

/** The dereferenceable package source a missing dependency restores from. */
function workspaceDependencySource(dependency) {
  const pinned = workspaceOverrideTarget(dependency)
  if (pinned !== undefined) return join(WORKSPACE_ROOT, pinned)
  const hoisted = join(CLI_NODE_MODULES, dependency)
  if (existsSync(hoisted)) return hoisted
  const stored = globSync(join(WORKSPACE_ROOT, 'node_modules', '.pnpm', `*${dependency}*`, 'node_modules', dependency))
  if (stored.length > 0) return stored[0]
  return undefined
}

/**
 * `pnpm deploy --legacy` materializes `link:`-overridden workspace packages
 * (`@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`) as symlinks back to the
 * checkout. A packaged app has no such checkout, so replace every symlink under
 * the deployed closure with a dereferenced file copy and drop the `.bin` shims
 * the child never executes. Mirrors `build-exe-for-python-sdk.ts`.
 */
function materializeStagedLinks(harnessDir) {
  const nodeModules = join(harnessDir, 'node_modules')
  for (;;) {
    const link = findSymlink(nodeModules)
    if (link === undefined) break
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      rmSync(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      continue
    }
    const source = realpathSync(link)
    const nestedNodeModules = join(source, 'node_modules')
    rmSync(link, { recursive: true, force: true })
    cpSync(source, link, {
      recursive: true,
      dereference: true,
      filter: (path) => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
  }
}

/** Return the first symbolic link below a directory, if one exists. */
function findSymlink(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

for (const target of TARGETS) {
  try {
    const archive = await fetchNode(target)
    extractNode(target, archive)
    console.log(`prepare-runtime: staged Node ${NODE_VERSION} for ${target.platform}-${target.arch}`)
  } catch (error) {
    console.error(`prepare-runtime: Node ${target.platform}-${target.arch} failed: ${error.message}`)
  }
}

try {
  deployHarness()
  restoreLegacyHoists(join(VENDOR_DIR, 'harness'))
  materializeStagedLinks(join(VENDOR_DIR, 'harness'))
  pruneHarness(join(VENDOR_DIR, 'harness'), TARGETS[0])
  verifyClosure(join(VENDOR_DIR, 'harness'))
  console.log('prepare-runtime: staged harness closure')
} catch (error) {
  console.error(`prepare-runtime: harness deploy failed: ${error.message}`)
  process.exitCode = 1
}

/** Assert every declared dependency of every deployed package resolves in-closure. */
function verifyClosure(harnessDir) {
  const missing = []
  for (const packageDir of closurePackageDirs(harnessDir)) {
    const manifestPath = packageDir === '.'
      ? join(harnessDir, 'package.json')
      : join(harnessDir, 'node_modules', packageDir, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const declared = { ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const [name, spec] of Object.entries(declared)) {
      if (!runtimeRequired(name, spec)) continue
      if (!resolvesInClosure(harnessDir, packageDir, name)) missing.push(`${packageDir} -> ${name}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`staged harness closure is incomplete:\n${missing.sort().join('\n')}`)
  }
}
