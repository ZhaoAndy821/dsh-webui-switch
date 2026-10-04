/**
 * Windows process stop: escalate from a console Ctrl+C to a tree kill.
 *
 * A Web profile this plugin started is detached and windowless, so it has no
 * console and the only way to stop it is to terminate its tree. A profile that
 * somebody else started in a terminal does own a console, and there the harness
 * turns Ctrl+C into a graceful teardown, so this module offers that event first -
 * but only when the console holds nobody except the target, because the event
 * cannot be aimed and would otherwise reach every process on it. It reports
 * precisely what happened either way, so the caller escalates instead of guessing:
 *
 *   4  the console is shared with other processes - refused, nothing was sent
 *   3  the interop shim could not be compiled (no compiler / constrained host)
 *   2  the target owns no console this process may attach to
 *   1  the console refused to generate the event
 *   0  the event was generated (see the note below - not the same as acted on)
 *
 * A process this plugin spawned detached owns **no** console: it is created with
 * `detached: true`, which on Windows is DETACHED_PROCESS, so `AttachConsole` on
 * it fails and the helper exits 2 - that is why such a profile is stopped by
 * terminating its tree. A process the human started in a terminal owns a console,
 * and there the event is delivered to **every process sharing that console**, not
 * to the target alone: CTRL_C_EVENT cannot be limited to a process group. Success
 * (exit 0) means the event was generated, not that the target acted on it.
 */
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Absolute path of the PowerShell helper shipped with this package. */
export const HELPER_SCRIPT = fileURLToPath(new URL('./send-console-ctrl.ps1', import.meta.url))

/** How long the helper may take, including PowerShell start-up. */
const HELPER_TIMEOUT_MS = 20000

/**
 * Ask whether a process is still alive.
 * @param pid - process id.
 * @returns true while the process exists.
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Deliver a console Ctrl+C (or another console event) to one process.
 * @param pid - target process id.
 * @param ctrlEvent - 0 for CTRL_C_EVENT, 1 for CTRL_BREAK_EVENT.
 * @returns `{ delivered, code, detail }` where code is the helper's exit code.
 */
export async function sendConsoleCtrl(pid, ctrlEvent = 0) {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGINT')
      return { delivered: true, code: 0, detail: 'posix-sigint' }
    } catch (error) {
      return { delivered: false, code: 1, detail: String(error) }
    }
  }
  try {
    await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        HELPER_SCRIPT,
        '-ProcessId',
        String(pid),
        '-CtrlEvent',
        String(ctrlEvent),
      ],
      // The helper compiles a C# shim, and csc.exe writes its MUICache under a
      // path it does not expand: measured 2026-10-04, a literal
      // "%SystemDrive%\ProgramData\..." directory appeared in whatever cwd the
      // helper was started from - the repository during tests, the application's
      // own directory in production. A stop must not litter the caller's tree.
      { windowsHide: true, timeout: HELPER_TIMEOUT_MS, cwd: tmpdir() },
    )
    return { delivered: true, code: 0, detail: 'console-ctrl-event' }
  } catch (error) {
    // execFile rejects with the child's exit code; a missing helper is a
    // different failure and must not be reported as "no console".
    const code = typeof error?.code === 'number' ? error.code : -1
    const detail = code === -1 ? String(error?.message ?? error) : (error?.stderr ?? '').toString().trim()
    return { delivered: false, code, detail }
  }
}

/**
 * Kill a process and every child it started.
 * @param pid - root process id.
 * @returns `{ killed, detail }`.
 */
export async function treeKill(pid) {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
      return { killed: true, detail: 'posix-group' }
    } catch (error) {
      if (error?.code === 'ESRCH') return { killed: false, detail: 'already-gone' }
      return { killed: false, detail: String(error) }
    }
  }
  try {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 })
    return { killed: true, detail: 'taskkill-tree' }
  } catch (error) {
    const stderr = (error?.stderr ?? '').toString()
    if (/not found|no running instance/i.test(stderr)) return { killed: false, detail: 'already-gone' }
    return { killed: false, detail: stderr.trim() || String(error?.message ?? error) }
  }
}

/**
 * Wait until a process is gone, or the deadline passes.
 * @param pid - process id.
 * @param timeoutMs - total wait.
 * @param intervalMs - poll interval.
 * @returns true once the process is gone.
 */
export async function waitForExit(pid, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return !isAlive(pid)
}
