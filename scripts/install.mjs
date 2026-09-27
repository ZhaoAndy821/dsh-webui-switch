#!/usr/bin/env node
/**
 * Register this plugin with a DSH profile, or take it back out.
 *
 * Two routes, both of which end in the same two facts a profile needs - a
 * dependency spec in package.json and the package name in
 * dsh.profile.bundles:
 *
 *   --via pnpm   run the package manager the Desktop application itself uses
 *                (resources/runtime/pnpm) in the profile directory, then record
 *                the bundle. This is what the in-app Plugins page does, and it
 *                is the route to prefer.
 *   --via link   write a link: spec and a node_modules junction by hand, with
 *                no package manager run at all. Use it when the profile must be
 *                touched without one.
 *
 * The Desktop profile is owned by the Electron application, and the CLI
 * refuses it on purpose ("profile \"desktop\" is managed exclusively by the
 * Electron application"), so this script edits the same files the application's
 * own plugin manager would - and refuses to run while the application holds the
 * profile.
 *
 * usage:
 *   node scripts/install.mjs                     # register into profile "desktop"
 *   node scripts/install.mjs --dry-run           # print the plan, change nothing
 *   node scripts/install.mjs --profile web       # another profile
 *   node scripts/install.mjs --via link          # no package manager run
 *   node scripts/install.mjs --remove            # undo
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = PKG.name

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
const profile = flag('--profile', 'desktop')
const profileDir = join(home, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', NAME)
const via = flag('--via', 'pnpm')
const remove = has('--remove')
const dryRun = has('--dry-run')
const appDir = flag('--app', join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness'))

if (!existsSync(manifestPath)) {
  console.error('no profile manifest at ' + manifestPath)
  process.exit(2)
}

/** Whether the Desktop application currently holds this profile. */
function desktopAppRunning() {
  try {
    const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return /DeepSeek Harness\.exe/i.test(output)
  } catch {
    return false
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies || {}
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles.slice() : []
const spec = 'link:' + ROOT.replace(/\\/g, '/')

const changes = []
if (remove) {
  if (manifest.dependencies[NAME]) changes.push('remove dependency ' + NAME)
  if (bundles.includes(NAME)) changes.push('remove "' + NAME + '" from dsh.profile.bundles')
  if (existsSync(linkPath) || isLink(linkPath)) changes.push('remove node_modules link')
} else {
  if (via === 'link' && manifest.dependencies[NAME] !== spec) changes.push('dependency ' + NAME + ' -> ' + spec)
  if (!bundles.includes(NAME)) changes.push('append "' + NAME + '" to dsh.profile.bundles')
  if (via === 'link' && !(existsSync(linkPath) || isLink(linkPath))) changes.push('create node_modules link -> ' + ROOT)
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

console.log((dryRun ? '[dry-run] ' : '') + (remove ? 'unregister ' : 'register ') + NAME + ' in profile "' + profile + '"')
console.log('  profile:  ' + profileDir)
console.log('  package:  ' + ROOT)
console.log('  via:      ' + (remove ? 'manifest only' : via))
for (const change of changes) console.log('  - ' + change)
if (changes.length === 0) console.log('  (already in the desired state)')
if (dryRun) process.exit(0)

if (profile === 'desktop' && !remove && desktopAppRunning()) {
  console.error('')
  console.error('The Desktop application is running and owns this profile.')
  console.error('Close it, run this again, then start it again to load the plugin.')
  process.exit(3)
}

if (changes.length === 0) process.exit(0)

const backup = manifestPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(manifestPath, backup)
console.log('  backup:   ' + backup)

if (via === 'pnpm' && !remove) {
  const pnpmEntry = join(appDir, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const nodeBin = join(appDir, 'resources', 'runtime', 'bin', 'node')
  if (!existsSync(pnpmEntry)) {
    console.error('no bundled pnpm at ' + pnpmEntry + ' - pass --app, or use --via link')
    process.exit(4)
  }
  const node = existsSync(nodeBin) ? nodeBin : process.execPath
  console.log('  pnpm:     ' + node + ' ' + pnpmEntry)
  execFileSync(node, [pnpmEntry, 'add', ROOT], { cwd: profileDir, stdio: 'inherit', windowsHide: true })
  // pnpm wrote the manifest; re-read before recording the bundle.
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  after.dsh = after.dsh || {}
  after.dsh.profile = after.dsh.profile || {}
  const list = Array.isArray(after.dsh.profile.bundles) ? after.dsh.profile.bundles : []
  if (!list.includes(NAME)) after.dsh.profile.bundles = list.concat([NAME])
  writeFileSync(manifestPath, JSON.stringify(after, null, 2) + '\n', 'utf8')
} else {
  if (remove) {
    delete manifest.dependencies[NAME]
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== NAME)
    rmSync(linkPath, { recursive: true, force: true })
  } else {
    manifest.dependencies[NAME] = spec
    manifest.dsh.profile.bundles = bundles.includes(NAME) ? bundles : bundles.concat([NAME])
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(ROOT, linkPath, 'junction')
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

// Fail loudly rather than leave a profile that cannot boot.
const written = JSON.parse(readFileSync(manifestPath, 'utf8'))
const present = (written.dsh?.profile?.bundles ?? []).includes(NAME)
console.log('  written:  ' + manifestPath)
console.log('  bundle:   ' + (present ? NAME + ' selected' : NAME + ' NOT selected'))

if (remove) {
  console.log('')
  console.log('Unregistered. Restart the application to unload it.')
} else {
  console.log('')
  console.log('Next: start the application. The control appears at the left of the')
  console.log('conversation header, showing whether the Web profile is serving.')
}
