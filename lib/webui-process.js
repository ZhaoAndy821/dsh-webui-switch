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
import { appendJournal, heartbeatMs, readJournal, switchDir } from './journal.js'
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

/** Children this process started and has not yet seen exit, by pid. */
const liveChildren = new Map()
/** Pids a stop request was written for, so their exit record can say so. */
const stopRequestedPids = new Set()

/**
 * Record one lifecycle fact in the journal. Never throws and never blocks.
 * @param record - event fields.
 * @param env - process environment.
 */
function note(record, env) {
  appendJournal(record, { env, source: 'host' })
}

/** Forget stop requests whose process is gone, so a recycled pid cannot inherit one. */
function sweepStopRequested() {
  for (const pid of [...stopRequestedPids]) {
    if (!isAlive(pid)) stopRequestedPids.delete(pid)
  }
}

/**
 * Watch a spawned profile so its end is recorded even when nothing asked it to
 * leave.
 *
 * This is the datum both the 2026-09-27 and the 2026-10-04 terminations were
 * missing: a heartbeat while it lives - which dates the death when no other
 * artefact did - and code/signal/uptime the moment it ends, which separates an
 * orderly exit from a kill. The interval is unref'd: a heartbeat must never
 * hold the Desktop Host open.
 *
 * @param child - result of spawn().
 * @param info.env - process environment.
 * @param info.port - port the profile serves.
 * @param info.profile - profile name.
 * @param info.logFile - captured stdout/stderr.
 * @param info.spawnedAt - Date.now() at spawn.
 */
function watchChild(child, info) {
  const pid = child.pid
  if (pid === undefined || liveChildren.has(pid)) return
  // Pinned at watch time: this interval outlives the call that started it, and a
  // beat must never resolve a different home later (see journal.js).
  const dir = switchDir(info.env)
  const beat = (record) => appendJournal(record, { dir, source: 'host' })
  const timer = setInterval(() => {
    beat({ event: 'alive', pid, port: info.port, profile: info.profile, uptimeMs: Date.now() - info.spawnedAt })
  }, heartbeatMs(info.env))
  if (typeof timer.unref === 'function') timer.unref()
  liveChildren.set(pid, { child, timer })
  child.on('error', (error) => {
    note({ event: 'profile-spawn-error', pid, detail: String(error?.message ?? error) }, info.env)
  })
  child.on('exit', (code, signal) => {
    clearInterval(timer)
    liveChildren.delete(pid)
    beat({
      event: 'profile-exit',
      pid,
      port: info.port,
      profile: info.profile,
      code,
      signal,
      uptimeMs: Date.now() - info.spawnedAt,
      requested: stopRequestedPids.has(pid),
    })
    stopRequestedPids.delete(pid)
  })
}

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
 * Clear the start record, but only when it describes the process that ended.
 *
 * Measured 2026-09-27: a stop-path call that targeted a test pid reached
 * writeState(undefined) with the real DSH home and deleted the record of the
 * profile that was still serving, after which the control reported the live
 * WebUI as external. A record that belongs to another pid is evidence, not
 * garbage: it is kept, and the refusal is journalled.
 *
 * @param pid - process that ended, or undefined to clear unconditionally.
 * @param env - process environment.
 * @returns true when the record was removed.
 */
export function clearStateFor(pid, env = process.env) {
  const recorded = readState(env)
  if (recorded === undefined) return false
  if (pid !== undefined && recorded.pid !== pid) {
    note({ event: 'state-kept', reason: 'record-describes-another-pid', recorded: recorded.pid, target: pid }, env)
    return false
  }
  writeState(undefined, env)
  note({ event: 'state-cleared', cleared: recorded.pid, recordedSince: recorded.startedAt }, env)
  return true
}

/**
 * Drop a record whose process no longer exists.
 *
 * A stop that finds nothing serving used to clear unconditionally, which is how
 * a fixture stop wiped the live record. A closed port says nothing about a
 * recorded pid that is still alive, so that case keeps the record and says so.
 *
 * @param env - process environment.
 * @returns true when a stale record was removed.
 */
export function clearStaleState(env = process.env) {
  const recorded = readState(env)
  if (recorded === undefined) return false
  if (isAlive(recorded.pid)) {
    note({ event: 'state-kept', reason: 'recorded-process-alive', recorded: recorded.pid }, env)
    return false
  }
  return clearStateFor(recorded.pid, env)
}

/** Profiles this host adopted from the record rather than spawning, by pid. */
const adoptedProfiles = new Map()

/**
 * Adopt a recorded profile this host did not spawn.
 *
 * The host only watches children it started, so a profile that outlives its own
 * host - an application restart leaves it serving - dies unrecorded: the journal
 * keeps its last heartbeat and nothing else. That is how the 2026-10-09 14:00
 * restart orphaned pid 17040, whose death at 2026-10-10 20:09:26 could be dated
 * but not explained: no host was watching, so no exit record existed.
 *
 * Two fences run before anything is written, because a recorded pid is exactly
 * the kind of number Windows recycles:
 *
 *  - the command line is re-read and must not be foreign (the same
 *    stillSameTarget fence stop() applies before it signals anything);
 *  - the profile's own heartbeat must be recent, unless the record is younger
 *    than one heartbeat window and simply has not beaten yet.
 *
 * Both fences are re-checked while adopted, so a pid recycled after the profile
 * died cannot make the heartbeat outlive the process: silence from the profile
 * half ends the adoption even while isAlive still answers.
 *
 * @param env - process environment.
 * @returns adopted: whether a live record was taken over, and a disposer.
 */
export async function adoptRecordedProfile(env = process.env) {
  const recorded = readState(env)
  const adoptedPid = recorded !== undefined && typeof recorded.pid === 'number' ? recorded.pid : undefined
  const dispose = () => {
    if (adoptedPid === undefined) return
    const entry = adoptedProfiles.get(adoptedPid)
    if (entry !== undefined) {
      clearInterval(entry.timer)
      clearInterval(entry.check)
      clearInterval(entry.confirm)
      adoptedProfiles.delete(adoptedPid)
    }
  }
  if (recorded === undefined || adoptedPid === undefined) return { adopted: false, reason: 'no-record', dispose }
  if (adoptedPid === process.pid) return { adopted: false, reason: 'self', dispose }
  if (adoptedProfiles.has(adoptedPid) || liveChildren.has(adoptedPid)) {
    return { adopted: false, reason: 'already-watched', dispose }
  }

  // Pinned at adoption time: this outlives the call that started it.
  const dir = switchDir(env)
  const beat = (record) => appendJournal(record, { dir, source: 'host' })
  const startedAt = Date.parse(String(recorded.startedAt ?? ''))
  const uptime = () => (Number.isNaN(startedAt) ? undefined : Date.now() - startedAt)
  const adoptedAt = Date.now()
  const info = { pid: adoptedPid, port: recorded.port, profile: recorded.profile, inherited: true }
  // How long the profile half may be silent before its silence is evidence: three
  // heartbeats plus slack for the write itself.
  const windowMs = heartbeatMs(env) * 3 + 5000

  /**
   * Newest heartbeat the profile half wrote for this pid, and its age.
   *
   * The maximum is computed rather than taken from the first matching record:
   * readJournal returns the window in write order (oldest first), so "first match"
   * is the oldest beat in it - which measured a live, beating profile as silent
   * and refused to adopt it (review of fed1fd7, 2026-10-10).
   */
  const lastProfileBeat = () => {
    let newest
    // A beat dated ahead of the present is not evidence of anything: the profile
    // half and this host share a clock, so such a record is a skew artefact (a
    // backwards clock step, a hand-edited journal). It is ignored rather than
    // clamped - clamping it made every tick look like fresh evidence and slid the
    // deadline forward for ever (review round 6), while letting it through let one
    // bogus record mask every real beat behind it (round 5). One second of slack
    // covers the sub-second gap between a write and this read.
    const ceiling = Date.now() + 1000
    for (const record of readJournal(env, 400)) {
      if (record.source !== 'profile' || record.pid !== adoptedPid || record.event !== 'alive') continue
      const at = Date.parse(String(record.at ?? ''))
      if (Number.isNaN(at) || at > ceiling) continue
      if (newest === undefined || at > newest) newest = at
    }
    return newest === undefined ? undefined : { at: newest, ageMs: Date.now() - newest }
  }

  const exitRecord = (reason) => {
    const requested = stopRequestedPids.has(adoptedPid)
    stopRequestedPids.delete(adoptedPid)
    const record = {
      event: 'profile-exit',
      ...info,
      code: null,
      codeUnavailable: 'inherited-process',
      uptimeMs: uptime(),
      requested,
    }
    if (reason !== undefined) record.reason = reason
    beat(record)
  }

  if (!isAlive(adoptedPid)) {
    // Announced once per record, not once per boot: a restarted host must not
    // re-announce a death the journal already holds.
    const announced = readJournal(env, 400).some(
      (record) => record.event === 'profile-exit' && record.pid === adoptedPid && record.reason === 'gone-before-adoption',
    )
    if (!announced) {
      exitRecord('gone-before-adoption')
    } else {
      note({ event: 'profile-exit-known', pid: adoptedPid, reason: 'gone-before-adoption' }, env)
    }
    return { adopted: false, reason: 'gone-before-adoption', dispose }
  }

  const observed = await commandLineOf(adoptedPid)
  if (!stillSameTarget(observed, recorded.profile)) {
    // Readable and clearly something else: the number was recycled.
    beat({
      event: 'profile-unadopted',
      pid: adoptedPid,
      port: recorded.port,
      profile: recorded.profile,
      reason: 'target-changed',
      observed: observed ?? null,
    })
    return { adopted: false, reason: 'target-changed', dispose }
  }
  const young = !Number.isNaN(startedAt) && Date.now() - startedAt < windowMs
  const latest = lastProfileBeat()
  if (!young && (latest === undefined || latest.ageMs > windowMs)) {
    beat({
      event: 'profile-unadopted',
      pid: adoptedPid,
      port: recorded.port,
      profile: recorded.profile,
      reason: 'no-recent-profile-beat',
      ageMs: latest?.ageMs ?? null,
    })
    return { adopted: false, reason: 'no-recent-profile-beat', dispose }
  }

  const finish = (reason) => {
    clearInterval(timer)
    clearInterval(check)
    clearInterval(confirm)
    adoptedProfiles.delete(adoptedPid)
    exitRecord(reason)
  }

  const timer = setInterval(() => beat({ event: 'alive', ...info, uptimeMs: uptime() }), heartbeatMs(env))
  // Death is checked more often than the beat is written: the point of adopting
  // is dating the end, and a one-minute resolution would blur it. A live pid
  // cannot be recycled, so this check needs no fence of its own.
  const check = setInterval(() => {
    if (!isAlive(adoptedPid)) finish('process-gone')
  }, 1000)
  // The other direction: a pid that stays alive but stops being this profile.
  // Silence from the profile half is the evidence the pid alone cannot give.
  // When the profile was last known to be alive, and the newest beat already
  // credited. Only a plausible beat (one not dated ahead of the present, see
  // lastProfileBeat) is ever credited, and each one exactly once at its own time,
  // which is what makes this safe in every direction the reviews measured:
  //
  //  - a record whose start lies ahead of the present cannot postpone anything: with
  //    no plausible beat, the deadline is one window after the adoption (round 3,
  //    N1);
  //  - a profile that keeps beating re-credits on every beat, so it is never
  //    declared dead while it beats (round 4, N2);
  //  - a single implausible beat can neither mask the real ones behind it (round 5)
  //    nor renew the credit by being clamped to "now" on every tick (round 6).
  let knownAliveAt = adoptedAt
  let creditedBeatAt = 0
  const confirm = setInterval(() => {
    if (!isAlive(adoptedPid)) {
      finish('process-gone')
      return
    }
    const latest = lastProfileBeat()
    if (latest !== undefined && latest.at > creditedBeatAt) {
      creditedBeatAt = latest.at
      knownAliveAt = Math.max(knownAliveAt, latest.at)
    }
    if (Date.now() - knownAliveAt > windowMs) finish('profile-heartbeat-stopped')
  }, Math.min(heartbeatMs(env), 30000))
  for (const handle of [timer, check, confirm]) {
    if (typeof handle.unref === 'function') handle.unref()
  }
  adoptedProfiles.set(adoptedPid, { timer, check, confirm })
  beat({ event: 'profile-adopted', ...info, uptimeMs: uptime() })
  return { adopted: true, pid: adoptedPid, dispose }
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

  sweepStopRequested()
  const before = await status({ port, profile, env })
  if (before.running) {
    note({ event: 'start-skipped', reason: 'already-serving', pid: before.pid, port, profile }, env)
    return { ...before, started: false, reason: 'already-serving' }
  }

  // The record this start is about to replace. It is the only place the pid and
  // start time of the previous generation survive, and reading it here is why a
  // post-mortem no longer has to recover them from a node warning in the log.
  const previous = readState(env)

  const launcher = await resolveLauncher({ env, dshScript: options.dshScript, node: options.node })
  if (!launcher.ok) {
    note({ event: 'start-failed', reason: 'launcher-unresolved', detail: launcher.reason }, env)
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
  const spawnedAt = Date.now()
  try {
    child = spawn(plan.command, plan.args, {
      cwd,
      detached: plan.detached,
      windowsHide: plan.windowsHide,
      stdio: ['ignore', logFd, logFd],
      // DSH_WEBUI_SWITCH_PORT is what the profile half records in its ready
      // record (web-stop.js); without it that record's port is always null.
      env: { ...env, DSH_WEBUI_SWITCH_PORT: String(port) },
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
  watchChild(child, { env, port, profile, logFile, spawnedAt })
  note(
    { event: 'profile-spawned', pid: child.pid, port, profile, logFile, launcher: launcher.source, previous },
    env,
  )

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
    const reason = child.pid !== undefined && !isAlive(child.pid) ? 'exited' : 'timeout'
    note({ event: 'start-failed', reason, pid: child.pid, port, profile, logFile }, env)
    return {
      running: false,
      port,
      profile,
      url: `http://127.0.0.1:${port}`,
      started: true,
      reason,
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
  note(
    {
      event: 'profile-serving',
      pid: state.pid,
      port,
      profile,
      startedAt,
      logFile,
      replaced: previous === undefined ? undefined : previous.pid,
    },
    env,
  )
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
  sweepStopRequested()
  const current = await status({ port: options.port, profile: options.profile, env })
  const pid = options.pid ?? current.pid
  note(
    {
      event: 'stop-requested',
      target: pid,
      port: options.port,
      profile: options.profile,
      force: options.force === true,
      // Whether this host will observe the exit at all: a spawned child and an
      // adopted profile both get a profile-exit record, anything else does not,
      // and the journal must not read as if it had.
      observed: liveChildren.has(pid) || adoptedProfiles.has(pid),
      caller: options.caller,
    },
    env,
  )

  if (pid === undefined || !isAlive(pid)) {
    clearStaleState(env)
    note({ event: 'stop-finished', target: pid, stopped: false, reason: 'not-running' }, env)
    return { stopped: false, reason: 'not-running', status: current }
  }
  const recorded = readState(env)
  const isOurs = recorded !== undefined && recorded.pid === pid
  if (current.kind === 'foreign' && !isOurs) {
    note({ event: 'stop-finished', target: pid, stopped: false, reason: 'foreign-listener' }, env)
    return { stopped: false, reason: 'foreign-listener', status: current }
  }

  // Re-read at action time: the pid above was resolved a moment ago and Windows
  // recycles pids, so the number may no longer be the Web profile it was.
  const fresh = await commandLineOf(pid)
  if (!stillSameTarget(fresh, options.profile)) {
    note({ event: 'stop-finished', target: pid, stopped: false, reason: 'target-changed' }, env)
    return { stopped: false, reason: 'target-changed', pid, status: current }
  }

  const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS
  const steps = []
  if (options.force !== true) {
    // Rung 1: the profile answers for its own pid, so the ready record is the
    // proof that a request will be read rather than ignored.
    const ready = readStopReady(pid, env)
    if (ready !== undefined) {
      // Marked before the file is written: the exit record of a profile that
      // honours the request must not read as an unexplained death.
      stopRequestedPids.add(pid)
      // The nonce the profile published at mount; an undefined one is a profile
      // from an earlier version, and the pid alone is what it can check.
      const path = requestStop(pid, env, ready.nonce)
      steps.push({ step: 'app-exit-request', requested: true, path })
      note({ event: 'stop-step', target: pid, step: 'app-exit-request', path }, env)
      const gone = await waitForExit(pid, graceMs)
      steps.push({ step: 'wait-grace', gone })
      note({ event: 'stop-step', target: pid, step: 'wait-grace', gone }, env)
      if (gone) {
        clearStateFor(pid, env)
        clearStopFiles(pid, env)
        note({ event: 'stop-finished', target: pid, stopped: true, reason: 'app-exit' }, env)
        return { stopped: true, reason: 'app-exit', pid, steps, status: await status(options) }
      }
      note({ event: 'stop-step', target: pid, step: 'handshake-timeout', graceMs }, env)
      clearStopFiles(pid, env)
    }

    // Rung 2: only a profile this plugin did not start can own a console.
    if (!isOurs) {
      const delivered = await sendConsoleCtrl(pid, 0)
      steps.push({ step: 'console-ctrl-c', ...delivered })
      note({ event: 'stop-step', target: pid, step: 'console-ctrl-c', ...delivered }, env)
      if (delivered.delivered) {
        const gone = await waitForExit(pid, graceMs)
        steps.push({ step: 'wait-grace', gone })
        note({ event: 'stop-step', target: pid, step: 'wait-grace', gone }, env)
        if (gone) {
          clearStateFor(pid, env)
          note({ event: 'stop-finished', target: pid, stopped: true, reason: 'console-exit' }, env)
          return { stopped: true, reason: 'console-exit', pid, steps, status: await status(options) }
        }
      }
    }
  }

  const killed = await treeKill(pid)
  steps.push({ step: 'terminate-tree', ...killed })
  note({ event: 'stop-step', target: pid, step: 'terminate-tree', ...killed }, env)
  const gone = killed.killed ? await waitForExit(pid, 5000) : true
  if (gone) {
    clearStateFor(pid, env)
    clearStopFiles(pid, env)
  }
  const reason = gone ? 'terminated' : 'terminate-failed'
  note({ event: 'stop-finished', target: pid, stopped: gone, reason }, env)
  return {
    stopped: gone,
    reason,
    pid,
    steps,
    status: await status({ port: options.port, profile: options.profile, env }),
  }
}
