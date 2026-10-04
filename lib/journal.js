/**
 * Append-only lifecycle journal for the Web profile.
 *
 * Why this file exists (measured, twice). The Web profile's termination on
 * 2026-09-27 11:47:46 and again on 2026-10-04 10:59:27 left no usable record of
 * *how* the process ended: the plugin returned its stop ladder to the caller and
 * persisted nothing, the spawned child's exit code was never observed, and the
 * profile half had no way to say "I was asked to leave". A post-mortem could
 * only bracket the death between two unrelated writes, so both incidents ended
 * with "the trigger is not established".
 *
 * One JSON object per line, appended by **both** halves of the handshake:
 *
 *   1. the Desktop Host (this package's host half, in the app's own process);
 *   2. the Web profile itself (web-stop.js, inside the process being watched).
 *
 * Every record carries `at`, `source` and `pid` of the writer, then the event:
 *
 *   profile-spawned   a child was created (pid, port, launcher, previous record)
 *   profile-serving   the port answered (pid, startedAt, logFile)
 *   start-failed      the child never served (pid, reason)
 *   alive             heartbeat from the host half (pid, port, uptimeMs)
 *   stop-requested    a stop was asked for (target, caller, force)
 *   stop-step         one rung of the ladder and its result
 *   stop-finished     the ladder ended (stopped, reason)
 *   profile-exit      the child ended (code, signal, uptimeMs, requested)
 *   state-cleared     the start record was removed
 *   state-kept        the record described somebody else and was left alone
 *   handshake-ready   the profile mounted the stop handshake (profile pid, port)
 *   stop-seen         the profile saw a stop request in its own process
 *   app-exit          the profile called ctx.appExit(0)
 *   handshake-gone    the profile disposed the handshake (orderly teardown)
 *   action-requested  an HTTP action arrived (action, caller identity)
 *   action-result     that action's answer (status, ok)
 *
 * Two rules make this safe to add to a control path: a record that cannot be
 * written never throws (the journal must not be able to break the control it
 * exists to explain), and the file is rotated at JOURNAL_MAX_BYTES keeping
 * JOURNAL_KEEP older generations. The heartbeat (60 s, unref'd) is what dates a
 * death that no other artefact recorded.
 *
 * @module dsh-webui-switch/journal
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './launcher.js'

/** Older generations kept beside the active journal. */
export const JOURNAL_KEEP = 2
/** Size at which the active journal is rotated, in bytes. */
export const JOURNAL_MAX_BYTES = 1024 * 1024
/** Interval of the liveness heartbeat written by both halves. */
export const HEARTBEAT_MS = 60000

/**
 * Directory holding the control's files. Same path web-stop.js resolves; kept
 * here so this module can be imported by that file without a cycle.
 * @param env - process environment.
 * @returns absolute directory.
 */
export function switchDir(env = process.env) {
  return join(dshHome(env), 'webui-switch')
}

/** The active journal's file name, inside whichever directory owns it. */
const JOURNAL_NAME = 'journal.jsonl'

/**
 * The active journal inside an already-resolved directory.
 * @param dir - resolved switch directory.
 * @returns absolute path.
 */
export function journalFile(dir) {
  return join(dir, JOURNAL_NAME)
}

/**
 * One rotated generation inside an already-resolved directory.
 * @param n - 1 is the newest generation.
 * @param dir - resolved switch directory.
 * @returns absolute path.
 */
export function rotatedJournalFile(n, dir) {
  return join(dir, 'journal.' + String(n) + '.jsonl')
}

/**
 * The active journal file.
 * @param env - process environment.
 * @returns absolute path.
 */
export function journalPath(env = process.env) {
  return journalFile(switchDir(env))
}

/**
 * One rotated generation.
 * @param n - 1 is the newest generation.
 * @param env - process environment.
 * @returns absolute path.
 */
export function rotatedJournalPath(n, env = process.env) {
  return rotatedJournalFile(n, switchDir(env))
}

/**
 * Move the active journal aside when it has grown past its bound.
 * @param dir - resolved switch directory.
 */
function rotate(dir) {
  const path = journalFile(dir)
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < JOURNAL_MAX_BYTES) return
  try {
    rmSync(rotatedJournalFile(JOURNAL_KEEP, dir), { force: true })
    for (let n = JOURNAL_KEEP - 1; n >= 1; n -= 1) {
      const from = rotatedJournalFile(n, dir)
      if (existsSync(from)) renameSync(from, rotatedJournalFile(n + 1, dir))
    }
    renameSync(path, rotatedJournalFile(1, dir))
  } catch {
    /* rotation is best effort: the next append retries it */
  }
}

/**
 * Heartbeat interval actually used.
 *
 * DSH_WEBUI_SWITCH_HEARTBEAT_MS overrides it so a test can observe the beat
 * without waiting a minute; 200 ms is the floor, because a heartbeat tighter
 * than that would fill the journal faster than it explains anything.
 *
 * @param env - process environment.
 * @returns interval in milliseconds.
 */
export function heartbeatMs(env = process.env) {
  const value = Number(env.DSH_WEBUI_SWITCH_HEARTBEAT_MS)
  return Number.isInteger(value) && value >= 200 ? value : HEARTBEAT_MS
}

/**
 * Append one lifecycle record.
 *
 * A long-lived writer should pass `dir` once, resolved at mount, rather than an
 * environment object it keeps resolving at every write. Measured 2026-10-04: a
 * heartbeat interval outlived the test that created it, its environment was
 * restored underneath it, and the next beat resolved a *different* home - the
 * real one - and wrote there. Pinning the directory is what makes that class of
 * leak impossible rather than merely unlikely.
 *
 * @param record - event fields; `at`, `source` and the writer pid are added.
 * @param options.env - process environment, resolved per call.
 * @param options.dir - already-resolved switch directory, preferred for timers.
 * @param options.source - 'host' (Desktop Host half) or 'profile' (Web profile).
 * @returns true when the line reached the file.
 */
export function appendJournal(record, options = {}) {
  const source = options.source ?? 'host'
  const dir = options.dir ?? switchDir(options.env ?? process.env)
  const line = JSON.stringify({ at: new Date().toISOString(), source, pid: process.pid, ...record }) + '\n'
  try {
    mkdirSync(dir, { recursive: true })
    rotate(dir)
    appendFileSync(journalFile(dir), line, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Read the most recent records, oldest first.
 * @param env - process environment.
 * @param limit - how many trailing records to return.
 * @returns parsed records; a torn line is skipped rather than thrown.
 */
export function readJournal(env = process.env, limit = 40) {
  const records = []
  const files = []
  for (let n = JOURNAL_KEEP; n >= 1; n -= 1) files.push(rotatedJournalPath(n, env))
  files.push(journalPath(env))
  for (const file of files) {
    if (!existsSync(file)) continue
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line))
      } catch {
        /* a torn line is not a reason to lose the rest */
      }
    }
  }
  return records.slice(-limit)
}
