/**
 * dsh-webui-switch, Web-profile half: leave the way Ctrl+C would.
 *
 * The Desktop control starts the Web profile detached, so the profile owns no
 * console and no console control event can reach it (measured: the helper in
 * windows-stop.js exits 2 on such a pid, and a private console created for it
 * still ignores CTRL_C). The launcher does provide one graceful seam, though:
 * `ctx.appExit` - "a way to ask the process to exit once the tree has shut
 * down, wired to the launcher's shutdown controller" (dsh-cmdline). Calling it
 * disposes the whole Cordis tree first, so every plugin flushes and releases
 * what it holds, and the process then exits with the code given.
 *
 * This row is mounted into the profile being booted by an overlay the host half
 * writes at start (`writeStopOverlay`), and it is how a stop request crosses
 * the process boundary:
 *
 *   host                                          Web profile
 *   stop.<pid>.request   ---- file, polled ---->   apply()
 *   web-stop.<pid>.ready <--- written at mount --- ctx.appExit(0)
 *
 * Both files are keyed by the pid that owns them, so two profiles can never
 * consume each other's request, and a record left behind by a process that no
 * longer exists is removed by the host half rather than acted on.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name; also the row id in the overlay this package writes. */
export const name = 'webui-switch-stop'

/**
 * The launcher provides `appExit` before any row mounts, so this row activates
 * exactly when a stop request can actually be answered.
 */
export const inject = ['appExit']

/** How often the request file is polled. One stat per interval while idle. */
export const STOP_POLL_MS = 250

/**
 * DSH home, honouring the launcher's own override.
 * @param env - process environment.
 * @returns the resolved home directory.
 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : join(homedir(), '.dsh')
}

/** Directory holding the handshake files. */
export function switchDir(env = process.env) {
  return join(dshHome(env), 'webui-switch')
}

/** The request a running profile polls for. */
export function stopRequestPath(pid, env = process.env) {
  return join(switchDir(env), 'stop.' + String(pid) + '.request')
}

/** The record a running profile writes when it can answer a request. */
export function stopReadyPath(pid, env = process.env) {
  return join(switchDir(env), 'web-stop.' + String(pid) + '.ready')
}

/** The overlay the host half passes as `--patch`. */
export function stopOverlayPath(env = process.env) {
  return join(switchDir(env), 'web-stop.patch.yml')
}

/**
 * Read the handshake a profile wrote at mount.
 * @param pid - process that must have written it.
 * @param env - process environment.
 * @returns the parsed record, or undefined when this pid left none.
 */
export function readStopReady(pid, env = process.env) {
  const path = stopReadyPath(pid, env)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed.pid === pid ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Remove both handshake files for one pid.
 * @param pid - process they belong to.
 * @param env - process environment.
 */
export function clearStopFiles(pid, env = process.env) {
  rmSync(stopReadyPath(pid, env), { force: true })
  rmSync(stopRequestPath(pid, env), { force: true })
}

/**
 * Remove handshake files whose process no longer exists.
 *
 * A profile terminated before it could dispose - a crash, or a taskkill from
 * outside this plugin - leaves its record behind. The record is keyed by a pid
 * that will never answer again, so it is swept at the next start instead of
 * being left for a recycled pid to inherit.
 *
 * @param env - process environment.
 * @returns how many files were removed.
 */
export function pruneStopFiles(env = process.env) {
  const dir = switchDir(env)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const match = /^(?:web-stop|stop)\.(\d+)\.(?:ready|request)$/.exec(name)
    if (match === null) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (error) {
      alive = error?.code === 'EPERM'
    }
    if (alive) continue
    rmSync(join(dir, name), { force: true })
    removed += 1
  }
  return removed
}

/**
 * Write the request a running profile polls for.
 * @param pid - process that must answer it.
 * @param env - process environment.
 * @returns the request path.
 */
export function requestStop(pid, env = process.env) {
  const path = stopRequestPath(pid, env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid, requestedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  return path
}

/**
 * Write the overlay that mounts this file into a profile being booted.
 *
 * The row names this module by its own `file:` URL: the loader imports a name
 * that does not start with `./` verbatim, which keeps the overlay valid no
 * matter how the profile or this package are installed or which drive they sit
 * on. The file is rewritten at every start and holds no state.
 *
 * @param options.env - process environment.
 * @param options.self - module URL to mount; defaults to this file.
 * @returns the overlay path to pass as `--patch`.
 */
export function writeStopOverlay({ env = process.env, self } = {}) {
  const url = self ?? new URL('./web-stop.js', import.meta.url).href
  const path = stopOverlayPath(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    [
      '# dsh-webui-switch stop handshake. Written at every start; safe to delete.',
      '# Mounts this package Web-profile half so a stop request disposes the tree',
      '# through ctx.appExit instead of terminating the process.',
      '- insert:',
      '    - id: webui-switch-stop',
      "      name: '" + url + "'",
      '',
    ].join('\n'),
    'utf8',
  )
  return path
}

/**
 * Mount the stop listener.
 *
 * The record is written before the first poll and removed on disposal, so the
 * host half only ever requests a stop from a profile that is listening.
 *
 * @param ctx - Web-profile plugin context carrying `appExit`.
 */
export function apply(ctx) {
  const env = process.env
  const pid = process.pid
  const ready = stopReadyPath(pid, env)
  const request = stopRequestPath(pid, env)
  mkdirSync(switchDir(env), { recursive: true })
  // A request that predates this mount belongs to an earlier process on this pid.
  rmSync(request, { force: true })
  writeFileSync(
    ready,
    JSON.stringify({ pid, startedAt: new Date().toISOString(), port: process.env.DSH_WEBUI_SWITCH_PORT ?? null }, null, 2) +
      '\n',
    'utf8',
  )
  const timer = setInterval(() => {
    if (!existsSync(request)) return
    clearInterval(timer)
    rmSync(request, { force: true })
    const exit = ctx.get('appExit')
    if (typeof exit === 'function') exit(0)
  }, STOP_POLL_MS)
  ctx.effect(
    () => () => {
      clearInterval(timer)
      rmSync(ready, { force: true })
    },
    'webui-switch-stop: stop request poller',
  )
}
