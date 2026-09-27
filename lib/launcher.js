/**
 * Resolve how to boot the Web profile.
 *
 * The Desktop Host cannot use its own bundled copy of the dsh launcher for a
 * second profile: that copy lives inside app.asar and the Web profile resolves
 * its own dependency graph under \$DSH_HOME. The launcher therefore answers the
 * same command the human would type - `node <dsh>/lib/bin.js --profile web --port N` -
 * with a script that is actually present on this machine, and reports which
 * candidate answered so a wrong choice is visible in the plugin's state.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** DSH home, honouring the launcher's own override. */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : join(homedir(), '.dsh')
}

/** First existing path, or undefined. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

/** Read a PATH entry list into absolute directories. */
function pathDirs(env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? ''
  return raw.split(delimiter).filter((entry) => entry !== '')
}

/** Locate an executable through PATH without spawning a shell. */
function findOnPath(name, env) {
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
  for (const dir of pathDirs(env)) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension.toLowerCase())
      if (existsSync(candidate)) return candidate
      const upper = join(dir, name + extension)
      if (existsSync(upper)) return upper
    }
  }
  return undefined
}

/**
 * Ask `where` for one executable; the first line is its path.
 * @param name - executable name.
 * @returns absolute path or undefined.
 */
async function whereExecutable(name) {
  try {
    const { stdout } = await run('where', [name], { windowsHide: true, timeout: 5000 })
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
    return first === undefined ? undefined : first
  } catch {
    return undefined
  }
}

/**
 * Recover the launcher script from an npm shim (`dsh.cmd` / `dsh.ps1`).
 * @param shim - shim path.
 * @returns the `@deepseek-ai/dsh/lib/bin.js` path it launches, or undefined.
 */
function scriptFromShim(shim) {
  let text
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return undefined
  }
  const match = /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.exec(text)
  if (match === null) return undefined
  const root = shim.slice(0, Math.max(0, shim.lastIndexOf('node_modules')))
  return join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * Candidate launcher scripts, most specific first.
 * @param env - process environment.
 * @param override - configured absolute script path.
 * @returns ordered absolute paths that need no probing.
 */
function scriptCandidates(env, override) {
  const home = dshHome(env)
  const appData = env.APPDATA
  return [
    override,
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    appData === undefined
      ? undefined
      : join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(home, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]
}

/**
 * Resolve the Node executable and the dsh launcher script.
 *
 * The profile copy is preferred over the global npm copy so the booted Web
 * profile runs against the same dependency graph this plugin was installed
 * into; the global copy is the fallback that makes the plugin work before it
 * has been installed anywhere.
 *
 * @param options - optional overrides and environment.
 * @returns the resolved launcher, or the reason it could not be resolved.
 */
export async function resolveLauncher(options = {}) {
  const env = options.env ?? process.env

  const nodeOverride = options.node
  const nodeFromPath = firstExisting([findOnPath('node', env), await whereExecutable('node')])
  const nodeIsElectron = /electron/i.test(process.versions.electron ?? '')
  const execPathIsNode = !nodeIsElectron && existsSync(process.execPath)
  const node = firstExisting([nodeOverride, nodeFromPath, execPathIsNode ? process.execPath : undefined])
  if (node === undefined) return { ok: false, reason: 'no-node' }

  const direct = firstExisting(scriptCandidates(env, options.dshScript))
  if (direct !== undefined) {
    return { ok: true, node, script: direct, source: options.dshScript === direct ? 'configured' : 'profile' }
  }

  const shim = firstExisting([findOnPath('dsh', env), await whereExecutable('dsh')])
  const fromShim = shim === undefined ? undefined : scriptFromShim(shim)
  const resolvedShim = firstExisting([fromShim])
  if (resolvedShim !== undefined) return { ok: true, node, script: resolvedShim, source: 'npm-shim' }

  return { ok: false, reason: 'no-dsh-launcher', node }
}

/**
 * Command that boots the Web profile, as argument vector.
 * @param launcher - resolved launcher.
 * @param profile - profile name.
 * @param port - TCP port the Web app serves.
 * @returns argv tail for execFile/spawn.
 */
export function webProfileArgs(launcher, profile, port) {
  return [launcher.script, '--profile', profile, '--port', String(port)]
}

/** Scratch path used when no workspace is configured. */
export function fallbackCwd() {
  return tmpdir()
}
