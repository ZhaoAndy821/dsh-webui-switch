/**
 * Web-profile process control.
 *
 * Three facts decide every operation, and none of them is assumed:
 *
 *  1. whether the port is actually serving (a TCP connect, not a stored pid);
 *  2. which process owns it (netstat's own LISTENING row);
 *  3. whether that process really is the Web profile (its own command line).
 *
 * The third check is the safety fence: a port held by anything else is reported
 * but never stopped, because "stop the WebUI" must not become "kill whatever
 * happens to hold this port".
 */
import { execFile, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { dshHome, fallbackCwd, resolveLauncher, webProfileArgs } from './launcher.js'
import { clearStopFiles, pruneStopFiles, readStopReady, requestStop, writeStopOverlay } from './web-stop.js'
import { isAlive, sendConsoleCtrl, treeKill, waitForExit } from './windows-stop.js'

const run = promisify(execFile)

/** Grace between the console Ctrl+C and the forced tree kill. */
export const DEFAULT_STOP_GRACE_MS = 5000
/** How long `start` waits for the port to answer. */
export const DEFAULT_START_TIMEOUT_MS = 90000
/** Poll interval while waiting for a port. */
const POLL_INTERVAL_MS = 250

/**
 * Whether something is accepting connections on a loopback port.
 * @param port - TCP port.
 * @param timeoutMs - connect timeout.
 * @returns true when the port accepts a connection.
 */
export function portListening(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, '127.0.0.1')
  })
}

/**
 * How the child is launched, without launching it.
 *
 * The child is created with `detached: true`, which on Windows means
 * DETACHED_PROCESS: it owns **no console of its own** and it survives the
 * Desktop application that started it. A process with no console cannot be sent
 * a console control event at all, so the graceful stop does not travel over the
 * console: the profile is asked to leave from inside, through the overlay
 * `writeStopOverlay` writes and `--patch` mounts (see web-stop.js).
 *
 * Giving the child a console so a Ctrl+C could reach it was tried and measured
 * three ways - `cmd /c start`, `Start-Process -WindowStyle Hidden`, and
 * `CreateProcessW` with CREATE_NEW_CONSOLE - and is deliberately not used:
 * `AttachConsole` succeeded and the helper reported the event as delivered in
 * every case, and the target acted on none of them. A CTRL_BREAK *was* acted on,
 * but this harness registers SIGINT and SIGTERM only, so that is an immediate
 * exit wearing a graceful name. A graceful stop that has not been observed must
 * not be promised.
 *
 * @param launcher - resolved launcher.
 * @param options.port - port the Web app serves.
 * @param options.profile - profile to boot.
 * @param options.patchPath - overlay mounting the stop handshake, or undefined.
 * @returns the spawn plan.
 */
export function spawnPlan(launcher, options) {
  return {
    command: launcher.node,
    args: webProfileArgs(launcher, options.profile, options.port, options.patchPath),
    detached: true,
    windowsHide: true,
  }
}

/**
 * The process currently listening on a port, according to netstat.
 * @param port - TCP port.
 * @returns the owning pid, or undefined.
 */
export async function listeningPid(port) {
  const { stdout } = await run('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 15000 })
  const pattern = new RegExp('^\\s*TCP\\s+\\S*:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$', 'im')
  for (const line of stdout.split(/\r?\n/)) {
    const match = pattern.exec(line)
    if (match !== null) return Number(match[1])
  }
  return undefined
}

/**
 * One process's own command line.
 * @param pid - process id.
 * @returns the command line, or undefined when it cannot be read.
 */
export async function commandLineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 20000,
    })
    const text = stdout.trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * Whether a command line is the Web profile launcher.
 * @param commandLine - full command line.
 * @param profile - profile name that must be selected.
 * @returns true when the line boots that profile through the dsh launcher.
 */
export function isWebProfileCommand(commandLine, profile) {
  const kind = classifyCommand(commandLine, profile)
  return kind === 'launcher' || kind === 'shim'
}

/** How a command line was recognised. */
export const COMMAND_KINDS = /** @type {const} */ (['launcher', 'shim', 'foreign', 'unknown'])

/**
 * Classify the process holding the port.
 *
 * Two spellings reach the same profile and both must be recognised, because a
 * refusal here means the control cannot stop the very WebUI it exists for:
 *
 *   launcher  node .../@deepseek-ai/dsh/lib/bin.js --profile web --port 4115
 *   shim      cmd.exe /c ""...\\dsh.cmd" web --port 4115"   (what npm installs)
 *
 * Anything that does not select this profile is 'foreign' and is never stopped.
 *
 * @param commandLine - full command line, or undefined when unreadable.
 * @param profile - profile name that must be selected.
 * @returns one of COMMAND_KINDS.
 */
export function classifyCommand(commandLine, profile) {
  if (typeof commandLine !== 'string' || commandLine === '') return 'unknown'
  const name = String(profile)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Both spellings the launcher accepts: "--profile web" and the npm shim's
  // positional "dsh web". A path separator, a quote, or whitespace may precede
  // the executable name in either.
  const selectsProfile =
    new RegExp(String.raw`--profile[= ]"?${escaped}"?(?:\s|$)`, 'i').test(commandLine) ||
    new RegExp(String.raw`[\\/"]dsh(?:\.(?:cmd|ps1|bat))?"?[\s]+${escaped}(?:\s|$)`, 'i').test(commandLine)
  if (!selectsProfile) return 'foreign'
  if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(commandLine)) return 'launcher'
  if (/[\\/"]dsh(?:\.(?:cmd|ps1|bat))?"?(?:\s|$)/i.test(commandLine)) return 'shim'
  // Selects the profile but shows no dsh identity: some other program that
  // happens to take a --profile flag. Never treated as the Web profile.
  return 'unknown'
}

/**
 * Report a classification as the single detail word the client branches on.
 * @param kind - one of COMMAND_KINDS.
 * @returns the detail value.
 */
function describeKind(kind) {
  if (kind === 'launcher' || kind === 'shim') return 'web-profile'
  if (kind === 'foreign') return 'foreign-listener'
  return 'unknown-command'
}

/**
 * Whether a command line read immediately before acting still belongs to the
 * Web profile.
 *
 * The pid is resolved once, and Windows recycles pids; re-reading the command
 * line at action time is what keeps a recycled number from being signalled or
 * killed.
 *
 * The check is strict: a pid this plugin recorded is re-checked too, because a
 * recorded pid is exactly the one that can have been recycled. An unreadable line
 * is not a reason to refuse - the fence that refuses a foreign listener already ran.
 *
 * @param commandLine - the line read at action time, or undefined when unreadable.
 * @param profile - profile the line must select.
 * @returns false only when the line is readable and clearly something else.
 */
export function stillSameTarget(commandLine, profile) {
  return classifyCommand(commandLine, profile) !== 'foreign'
}

/** Path of this plugin's state file. */
export function statePath(env = process.env) {
  return join(dshHome(env), 'webui-switch', 'state.json')
}

/**
 * Read the recorded start, if any.
 * @param env - process environment.
 * @returns the recorded state or undefined.
 */
export function readState(env = process.env) {
  const path = statePath(env)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Record or clear this plugin's start.
 * @param state - state to persist, or undefined to remove the file.
 * @param env - process environment.
 */
export function writeState(state, env = process.env) {
  const path = statePath(env)
  if (state === undefined) {
    try {
      unlinkSync(path)
    } catch {
      /* an absent state file is the desired end state */
    }
    return
  }
  mkdirSync(join(dshHome(env), 'webui-switch'), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

/**
 * Describe the Web profile as it stands right now.
 *
 * @param options.port - port the Web app is expected to serve.
 * @param options.profile - profile name.
 * @param options.env - process environment.
 * @returns a state object safe to hand to the client verbatim.
 */
export async function status(options) {
  const { port, profile } = options
  const env = options.env ?? process.env
  const recorded = readState(env)
  const serving = await portListening(port)

  if (!serving) {
    return {
      running: false,
      port,
      profile,
      url: `http://127.0.0.1:${port}`,
      pid: undefined,
      since: undefined,
      startedBy: undefined,
      recorded: recorded !== undefined,
      detail: recorded !== undefined && isAlive(recorded.pid) ? 'recorded-process-alive' : 'port-closed',
    }
  }

  const pid = await listeningPid(port)
  const commandLine = pid === undefined ? undefined : await commandLineOf(pid)
  const ours = recorded !== undefined && recorded.pid === pid
  return {
    running: true,
    port,
    profile,
    url: `http://127.0.0.1:${port}`,
    pid,
    commandLine,
    since: ours ? recorded.startedAt : undefined,
    startedBy: ours ? 'dsh-webui-switch' : 'external',
    recorded: ours,
    kind: classifyCommand(commandLine, profile),
    detail: ours ? 'web-profile' : describeKind(classifyCommand(commandLine, profile)),
  }
}

/**
 * Boot the Web profile and wait until it serves.
 *
 * An already-serving port is adopted, never duplicated: a second `dsh web` on
 * the same home would contend for the same session store.
 *
 * @param options.port - port to serve on.
 * @param options.profile - profile to boot.
 * @param options.cwd - workspace root the profile boots in.
 * @param options.timeoutMs - how long to wait for the port.
 * @param options.env - process environment.
 * @returns the resulting status, plus the launcher used.
 */
export async function start(options) {
  const env = options.env ?? process.env
  const port = options.port
  const profile = options.profile

  const before = await status({ port, profile, env })
  if (before.running) {
    return { ...before, started: false, reason: 'already-serving' }
  }

  const launcher = await resolveLauncher({ env, dshScript: options.dshScript, node: options.node })
  if (!launcher.ok) {
    return { ...before, started: false, reason: 'launcher-unresolved', detail: launcher.reason }
  }

  const home = dshHome(env)
  const logDir = join(home, 'logs', 'webui-switch')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, 'webui.log')
  const logFd = openSync(logFile, 'a')

  const cwd = options.cwd ?? fallbackCwd()
  // Mount the stop handshake into the profile being booted. The overlay is
  // rewritten on every start, so it always names the file this installation
  // runs, and nothing has to be installed into the profile itself. Records left
  // by processes that no longer exist are swept first.
  pruneStopFiles(env)
  const patchPath = writeStopOverlay({ env })
  const plan = spawnPlan(launcher, { port, profile, patchPath })

  let child
  try {
    child = spawn(plan.command, plan.args, {
      cwd,
      detached: plan.detached,
      windowsHide: plan.windowsHide,
      stdio: ['ignore', logFd, logFd],
      env: { ...env },
    })
  } finally {
    // The child owns its own copy of the log handle from here on.
    try {
      closeSync(logFd)
    } catch {
      /* a handle the spawn already consumed needs no second close */
    }
  }
  child.unref()

  const startedAt = new Date().toISOString()
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS)
  let serving = false
  while (Date.now() < deadline) {
    if (await portListening(port)) {
      serving = true
      break
    }
    if (child.pid !== undefined && !isAlive(child.pid) && !(await portListening(port))) break
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  if (!serving) {
    return {
      running: false,
      port,
      profile,
      url: `http://127.0.0.1:${port}`,
      started: true,
      reason: child.pid !== undefined && !isAlive(child.pid) ? 'exited' : 'timeout',
      pid: child.pid,
      logFile,
    }
  }

  const state = {
    // The port owner, not the launcher we spawned: in console mode cmd.exe is
    // only the window that hands off to node, and stopping targets the pid the
    // port actually answers for.
    pid: (await listeningPid(port)) ?? child.pid,
    port,
    profile,
    startedAt,
    logFile,
    node: launcher.node,
    script: launcher.script,
    launcherSource: launcher.source,
  }
  writeState(state, env)
  const after = await status({ port, profile, env })
  return { ...after, started: true, reason: 'started', logFile, launcher: launcher.source }
}

/**
 * Stop the Web profile: ask it to leave, and terminate the tree if it will not.
 *
 * Rung 1 is the stop handshake. A profile booted by this plugin mounts
 * web-stop.js through the overlay `start` writes, and that row answers a request
 * file by calling `ctx.appExit(0)` - the launcher's own bounded shutdown, which
 * disposes the Cordis tree before the process exits. The request is only written
 * when the target pid left a ready record, so a profile that cannot answer (an
 * older one, or one whose overlay did not mount) is never made to wait.
 *
 * Rung 2 is kept for a profile somebody else started in a terminal: it owns a
 * console, and there the harness turns the console's Ctrl+C into the same
 * graceful teardown. The event cannot be aimed, so it is generated only when the
 * console holds nobody except the target; a shared console makes the helper exit
 * 4 and nothing is sent. A profile this plugin started never has a console, so
 * this rung is skipped for it rather than attempted and reported as delivered.
 *
 * Rung 3 terminates the process tree. The pid's command line is re-read
 * immediately before acting - recorded pids included - so a recycled pid is
 * refused as 'target-changed' instead of being signalled, and a port held by
 * something that is not the Web profile is refused rather than stopped.
 *
 * @param options.pid - process to stop, or undefined to resolve it.
 * @param options.port - port used to resolve the process.
 * @param options.profile - profile the command line must select.
 * @param options.graceMs - wait for a graceful exit before the forced kill.
 * @param options.force - skip both graceful rungs and kill directly.
 * @param options.env - process environment.
 * @returns what was attempted and what happened.
 */
export async function stop(options) {
  const env = options.env ?? process.env
  const current = await status({ port: options.port, profile: options.profile, env })
  const pid = options.pid ?? current.pid

  if (pid === undefined || !isAlive(pid)) {
    writeState(undefined, env)
    return { stopped: false, reason: 'not-running', status: current }
  }
  const recorded = readState(env)
  const isOurs = recorded !== undefined && recorded.pid === pid
  if (current.kind === 'foreign' && !isOurs) {
    return { stopped: false, reason: 'foreign-listener', status: current }
  }

  // Re-read at action time: the pid above was resolved a moment ago and Windows
  // recycles pids, so the number may no longer be the Web profile it was.
  const fresh = await commandLineOf(pid)
  if (!stillSameTarget(fresh, options.profile)) {
    return { stopped: false, reason: 'target-changed', pid, status: current }
  }

  const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS
  const steps = []
  if (options.force !== true) {
    // Rung 1: the profile answers for its own pid, so the ready record is the
    // proof that a request will be read rather than ignored.
    if (readStopReady(pid, env) !== undefined) {
      const path = requestStop(pid, env)
      steps.push({ step: 'app-exit-request', requested: true, path })
      const gone = await waitForExit(pid, graceMs)
      steps.push({ step: 'wait-grace', gone })
      if (gone) {
        writeState(undefined, env)
        clearStopFiles(pid, env)
        return { stopped: true, reason: 'app-exit', pid, steps, status: await status(options) }
      }
      clearStopFiles(pid, env)
    }

    // Rung 2: only a profile this plugin did not start can own a console.
    if (!isOurs) {
      const delivered = await sendConsoleCtrl(pid, 0)
      steps.push({ step: 'console-ctrl-c', ...delivered })
      if (delivered.delivered) {
        const gone = await waitForExit(pid, graceMs)
        steps.push({ step: 'wait-grace', gone })
        if (gone) {
          writeState(undefined, env)
          return { stopped: true, reason: 'console-exit', pid, steps, status: await status(options) }
        }
      }
    }
  }

  const killed = await treeKill(pid)
  steps.push({ step: 'terminate-tree', ...killed })
  const gone = killed.killed ? await waitForExit(pid, 5000) : true
  if (gone) {
    writeState(undefined, env)
    clearStopFiles(pid, env)
  }
  return {
    stopped: gone,
    reason: gone ? 'terminated' : 'terminate-failed',
    pid,
    steps,
    status: await status({ port: options.port, profile: options.profile, env }),
  }
}
