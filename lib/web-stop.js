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
 *
 * Every step is also written to the shared lifecycle journal (journal.js), so a
 * post-mortem can tell a requested exit from a process that simply disappeared -
 * the question both the 2026-09-27 and the 2026-10-04 terminations left open.
 *
 * The request also carries a nonce this process generated at mount and recorded
 * only in its ready file, and a request whose body does not match the pid *and*
 * the nonce is refused and journalled instead of obeyed. That is not a privilege
 * boundary - anything running as this user can read the ready file - but it makes
 * an accidental writer (a stray script, a stale leftover, a test, a tool that
 * guessed the path) a visible no-op rather than a silent stop, which is what
 * "the WebUI stopped by itself" turned out to mean twice.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { appendJournal, heartbeatMs } from './journal.js'
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
export function requestStop(pid, env = process.env, nonce) {
  const path = stopRequestPath(pid, env)
  mkdirSync(dirname(path), { recursive: true })
  const body = { pid, requestedAt: new Date().toISOString() }
  if (typeof nonce === 'string' && nonce !== '') body.nonce = nonce
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n', 'utf8')
  return path
}

/**
 * Whether a request body is the one this profile is willing to obey.
 *
 * The profile published a nonce in its ready record; a request must quote it and
 * carry this pid. When the ready record has no nonce (a profile started by an
 * earlier host) the pid alone decides, which keeps an upgrade from stranding a
 * running profile.
 *
 * @param body - parsed request, or undefined when it was not JSON.
 * @param pid - this process.
 * @param nonce - the nonce this process published, or undefined.
 * @returns true when the request may end this process.
 */
export function acceptsStopRequest(body, pid, nonce) {
  if (typeof body !== 'object' || body === null) return false
  if (body.pid !== pid) return false
  if (typeof nonce !== 'string' || nonce === '') return true
  return body.nonce === nonce
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
 * What the request file itself says, read before it is removed.
 *
 * The file is the handshake's only channel, so whoever wrote it is the actor: a
 * request this plugin wrote carries `{ pid, requestedAt }`, while a file written
 * by anything else is exactly the case a post-mortem has to be able to see. The
 * timestamps are the filesystem's, not the caller's, and survive a writer that
 * lies in the body.
 *
 * @param path - request file path.
 * @returns the observed fields, or an empty object when it cannot be read.
 */
function observeRequest(path) {
  try {
    const stat = statSync(path)
    return {
      requestAt: stat.mtime.toISOString(),
      requestBorn: stat.birthtime.toISOString(),
      content: readFileSync(path, 'utf8').slice(0, 200),
    }
  } catch {
    return {}
  }
}

/**
 * The request file as JSON, or undefined when it is not an object.
 * @param content - raw bytes read from the request file.
 * @returns the parsed body, or undefined.
 */
function parseRequest(content) {
  if (typeof content !== 'string' || content.trim() === '') return undefined
  try {
    const parsed = JSON.parse(content)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
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
  const bootedAt = Date.now()
  const port = process.env.DSH_WEBUI_SWITCH_PORT ?? null
  // Published in the ready record only; a request must quote it (see apply()).
  const nonce = randomUUID()
  // Resolved once, at mount, and handed to every write below: a heartbeat that
  // outlives its owner must not follow a changed environment into another home
  // (measured 2026-10-04 - a leaked beat wrote into the real DSH home).
  const dir = switchDir(env)
  const ready = stopReadyPath(pid, env)
  const request = stopRequestPath(pid, env)
  mkdirSync(dir, { recursive: true })
  // A request that predates this mount belongs to an earlier process on this pid.
  rmSync(request, { force: true })
  writeFileSync(
    ready,
    JSON.stringify({ pid, startedAt: new Date().toISOString(), port, nonce }, null, 2) + '\n',
    'utf8',
  )
  // The profile's own heartbeat is what dates its death. The host half records
  // when the process ended; this records that it was alive right up to then, and
  // the pair is the difference between "was asked to leave" and "vanished".
  appendJournal(
    { event: 'handshake-ready', port, startedAt: new Date(bootedAt).toISOString() },
    { dir, source: 'profile' },
  )
  const beat = setInterval(() => {
    appendJournal({ event: 'alive', port, uptimeMs: Date.now() - bootedAt }, { dir, source: 'profile' })
  }, heartbeatMs(env))
  // A heartbeat must never be the reason this process cannot exit.
  if (typeof beat.unref === 'function') beat.unref()
  const timer = setInterval(() => {
    if (!existsSync(request)) return
    const observed = observeRequest(request)
    rmSync(request, { force: true })
    const body = parseRequest(observed.content)
    if (!acceptsStopRequest(body, pid, nonce)) {
      // Consumed and refused, not obeyed: the file is the only channel anything
      // on this machine can use to end this process, so a writer that cannot
      // quote the nonce has to be visible rather than effective. The poller
      // keeps running - a refusal must not disarm the handshake for the stop
      // this plugin will legitimately send later.
      appendJournal(
        {
          event: 'stop-ignored',
          port,
          reason: body === undefined ? 'not-json' : body.pid !== pid ? 'wrong-pid' : 'wrong-nonce',
          ...observed,
        },
        { dir, source: 'profile' },
      )
      return
    }
    clearInterval(timer)
    const exit = ctx.get('appExit')
    appendJournal({ event: 'stop-seen', port, ...observed }, { dir, source: 'profile' })
    appendJournal(
      { event: 'app-exit', port, code: 0, handled: typeof exit === 'function' },
      { dir, source: 'profile' },
    )
    if (typeof exit === 'function') exit(0)
  }, STOP_POLL_MS)
  ctx.effect(
    () => () => {
      clearInterval(timer)
      clearInterval(beat)
      rmSync(ready, { force: true })
      appendJournal({ event: 'handshake-gone', port, uptimeMs: Date.now() - bootedAt }, { dir, source: 'profile' })
    },
    'webui-switch-stop: stop request poller',
  )
}
