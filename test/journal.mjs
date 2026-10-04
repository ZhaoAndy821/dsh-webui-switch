#!/usr/bin/env node
/**
 * Self-test for the lifecycle journal.
 *
 * The two terminations this journal exists for - 2026-09-27 11:47:46 and
 * 2026-10-04 10:59:27 - both ended with "the trigger is not established",
 * because nothing on disk said whether the profile had been asked to leave or
 * had simply disappeared. These tests assert the difference is now readable:
 * an externally killed child and a child that answered the handshake must
 * produce different journals, and the reader must tell them apart. A journal
 * that cannot make that distinction would be worse than none, so the pair is
 * asserted together on purpose.
 *
 * Run: node test/journal.mjs
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  JOURNAL_KEEP,
  JOURNAL_MAX_BYTES,
  appendJournal,
  journalPath,
  readJournal,
  rotatedJournalPath,
} from '../lib/journal.js'
import { clearStateFor, clearStaleState, readState, start, stop, writeState } from '../lib/webui-process.js'
import { apply as applyProfileHalf, readStopReady, requestStop, stopRequestPath } from '../lib/web-stop.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DUMMY = join(HERE, 'fixtures', 'dummy-web.js')

let passed = 0
let failed = 0
async function test_(name, body) {
  try {
    await body()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + name + '\n       ' + String(error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n       ') : error))
  }
}

/** A port nothing is listening on right now. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Poll until a predicate holds, or fail the test on the deadline. */
async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('timed out waiting for ' + what)
}

/** A profile-half context: effect() keeps the disposer, get() answers appExit. */
function fakeProfileContext() {
  let disposer
  const exits = []
  return {
    exits,
    get(name) {
      return name === 'appExit' ? (code) => exits.push(code) : undefined
    },
    effect(fn) {
      disposer = fn()
      return () => {}
    },
    dispose() {
      if (typeof disposer === 'function') disposer()
    },
  }
}

/** Run a body with the profile-half environment, then put the process back. */
async function withProfileEnv(home, body) {
  const saved = { ...process.env }
  process.env.DSH_HOME = home
  process.env.DSH_WEBUI_SWITCH_PORT = '4115'
  process.env.DSH_WEBUI_SWITCH_HEARTBEAT_MS = '250'
  try {
    return await body()
  } finally {
    for (const key of ['DSH_HOME', 'DSH_WEBUI_SWITCH_PORT', 'DSH_WEBUI_SWITCH_HEARTBEAT_MS']) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

const work = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-'))
const baseEnv = { ...process.env, DSH_HOME: work, DSH_WEBUI_SWITCH_HEARTBEAT_MS: '300' }

console.log('dsh-webui-switch journal self-test')

await test_('a record round-trips with its writer, source and time', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-unit-'))
  const env = { DSH_HOME: home }
  assert.equal(appendJournal({ event: 'probe', detail: 'one' }, { env, source: 'host' }), true)
  assert.equal(appendJournal({ event: 'probe', detail: 'two' }, { env, source: 'profile' }), true)
  const records = readJournal(env, 10)
  assert.equal(records.length, 2)
  assert.equal(records[0].event, 'probe')
  assert.equal(records[0].detail, 'one')
  assert.equal(records[0].source, 'host')
  assert.equal(records[1].source, 'profile')
  assert.equal(records[0].pid, process.pid, 'the writer pid is part of every line')
  assert.equal(Number.isNaN(Date.parse(records[0].at)), false, 'at must be a timestamp')
})

await test_('the journal rotates and keeps a bounded number of generations', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-rotate-'))
  const env = { DSH_HOME: home }
  mkdirSync(join(home, 'webui-switch'), { recursive: true })
  // Fill the active file past its bound without writing a megabyte of records.
  writeFileSync(journalPath(env), 'x'.repeat(JOURNAL_MAX_BYTES + 1), 'utf8')
  writeFileSync(rotatedJournalPath(1, env), 'generation one\n', 'utf8')
  writeFileSync(rotatedJournalPath(JOURNAL_KEEP, env), 'the oldest generation\n', 'utf8')
  appendJournal({ event: 'after-rotation' }, { env })
  const newest = readJournal(env, 5)
  assert.equal(newest[newest.length - 1].event, 'after-rotation', 'the new record lands in the active file')
  assert.equal(
    readFileSync(rotatedJournalPath(2, env), 'utf8').includes('generation one'),
    true,
    'each rotation shifts the generations by one',
  )
  assert.equal(
    readJournal(env, 5000).some((r) => r && r.event === 'after-rotation'),
    true,
    'an unparseable rotated line never hides the records that follow it',
  )
})

await test_('a journal that cannot be written never throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-broken-'))
  // A file where the directory must be: every write path fails.
  writeFileSync(join(home, 'webui-switch'), 'not a directory', 'utf8')
  const env = { DSH_HOME: home }
  assert.equal(appendJournal({ event: 'nowhere' }, { env }), false, 'the control must survive an unwritable journal')
  assert.deepEqual(readJournal(env, 5), [])
})

await test_('a stop that targeted somebody else keeps the live record', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-state-'))
  const env = { DSH_HOME: home }
  writeState({ pid: process.pid, port: 4115, startedAt: '2026-10-04T02:00:22.000Z' }, env)
  assert.equal(clearStateFor(999999, env), false, 'another pid must not delete this record')
  assert.equal(readState(env)?.pid, process.pid, 'the record is evidence, not garbage')
  assert.equal(clearStateFor(process.pid, env), true)
  assert.equal(readState(env), undefined)
})

await test_('a stale record is dropped, a live one is kept', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-stale-'))
  const env = { DSH_HOME: home }
  writeState({ pid: process.pid, port: 4115 }, env)
  assert.equal(clearStaleState(env), false, 'a live pid keeps its record even with the port closed')
  assert.equal(readState(env)?.pid, process.pid)
  writeState({ pid: 999999, port: 4115 }, env)
  assert.equal(clearStaleState(env), true)
  assert.equal(readState(env), undefined)
})

await test_('the profile half journals the handshake, the request and the exit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-profile-'))
  await withProfileEnv(home, async () => {
    const ctx = fakeProfileContext()
    // The disposal must run even when an assertion throws: a leaked heartbeat
    // interval kept beating after its environment was restored on 2026-10-04 and
    // wrote 31 records into the real DSH home. This finally is the regression.
    try {
      applyProfileHalf(ctx)
      await waitFor(() => readJournal({ DSH_HOME: home }, 50).some((r) => r.event === 'alive'), 3000, 'a profile heartbeat')
      const opened = readJournal({ DSH_HOME: home }, 50)
      assert.equal(opened.some((r) => r.event === 'handshake-ready' && r.source === 'profile'), true, 'mounting the handshake is recorded')
      assert.equal(opened.some((r) => r.event === 'alive'), true, 'the profile says it is alive')
      // A writer that cannot quote the nonce is refused, and the refusal is a
      // record: this is the case that used to be indistinguishable from the
      // plugin's own stop.
      writeFileSync(
        stopRequestPath(process.pid),
        JSON.stringify({ pid: process.pid, requestedAt: new Date().toISOString() }),
        'utf8',
      )
      await waitFor(
        () => readJournal({ DSH_HOME: home }, 80).some((r) => r.event === 'stop-ignored'),
        3000,
        'the refusal record',
      )
      assert.equal(ctx.exits.length, 0, 'an unsigned request must not end the profile')
      const ignored = readJournal({ DSH_HOME: home }, 80).find((r) => r.event === 'stop-ignored')
      assert.equal(ignored.reason, 'wrong-nonce')
      assert.equal(ignored.content.includes('requestedAt'), true, 'the refused bytes are quoted')
      assert.equal(Number.isNaN(Date.parse(ignored.requestBorn)), false, 'the filesystem timestamp is kept')

      // The signed request - the one the host half writes - is obeyed.
      const ready = readStopReady(process.pid)
      assert.equal(typeof ready.nonce, 'string', 'the ready record publishes a nonce')
      requestStop(process.pid, undefined, ready.nonce)
      await waitFor(() => ctx.exits.length > 0, 3000, 'appExit to be called')
      await waitFor(() => readJournal({ DSH_HOME: home }, 120).some((r) => r.event === 'app-exit'), 3000, 'the exit record')
      const seen = readJournal({ DSH_HOME: home }, 120)
      const stopSeen = seen.find((r) => r.event === 'stop-seen')
      assert.equal(stopSeen !== undefined, true, 'seeing the signed request is recorded before it acts')
      assert.equal(stopSeen.content.includes(ready.nonce), true, 'the obeyed request is quoted with its nonce')
      const exit = seen.find((r) => r.event === 'app-exit')
      assert.equal(exit.handled, true, 'this fake context provides appExit')
      assert.equal(ctx.exits[0], 0, 'the launcher is asked to leave with code 0')
    } finally {
      ctx.dispose()
    }
    await waitFor(() => readJournal({ DSH_HOME: home }, 80).some((r) => r.event === 'handshake-gone'), 3000, 'the disposal record')
  })
})

await test_('a heartbeat keeps writing to the home the profile started in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-pin-'))
  const other = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-other-'))
  await withProfileEnv(home, async () => {
    const ctx = fakeProfileContext()
    try {
      applyProfileHalf(ctx)
      await waitFor(() => readJournal({ DSH_HOME: home }, 20).some((r) => r.event === 'alive'), 3000, 'a heartbeat')
      // Move the environment underneath the live writer, which is exactly what a
      // leaked interval sees once its owning test has restored process.env.
      process.env.DSH_HOME = other
      const beforeHome = readJournal({ DSH_HOME: home }, 300).length
      const beforeOther = readJournal({ DSH_HOME: other }, 300).length
      await waitFor(
        () => readJournal({ DSH_HOME: home }, 300).length > beforeHome,
        3000,
        'the pinned home to keep receiving beats',
      )
      assert.equal(
        readJournal({ DSH_HOME: other }, 300).length,
        beforeOther,
        'a beat must never follow the environment into another home',
      )
    } finally {
      ctx.dispose()
    }
  })
})

await test_('a disposed profile stops beating even if the environment moves', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-disposed-'))
  const other = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-journal-disposed-other-'))
  await withProfileEnv(home, async () => {
    const ctx = fakeProfileContext()
    applyProfileHalf(ctx)
    await waitFor(() => readJournal({ DSH_HOME: home }, 20).some((r) => r.event === 'alive'), 3000, 'a heartbeat')
    ctx.dispose()
    process.env.DSH_HOME = other
    const homeCount = readJournal({ DSH_HOME: home }, 400).length
    const otherCount = readJournal({ DSH_HOME: other }, 400).length
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(readJournal({ DSH_HOME: other }, 400).length, otherCount, 'a disposed writer must not follow the environment')
    assert.equal(readJournal({ DSH_HOME: home }, 400).length, homeCount, 'and must not keep beating where it was')
  })
})

await test_('a profile killed from outside is journalled as unexplained, not as a stop', async () => {
  const port = await freePort()
  const env = { ...baseEnv, DSH_WEBUI_TEST_MARKER: join(work, 'marker-killed.txt') }
  const booted = await start({ port, profile: 'web', env, dshScript: DUMMY, timeoutMs: 30000 })
  assert.equal(booted.running, true, 'the fixture should serve: ' + JSON.stringify(booted))
  const pid = booted.pid
  await waitFor(() => readJournal(env, 200).some((r) => r.event === 'alive' && r.source === 'host'), 4000, 'a host heartbeat')
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  await waitFor(() => readJournal(env, 200).some((r) => r.event === 'profile-exit' && r.pid === pid), 8000, 'the exit record')
  const records = readJournal(env, 200)
  const exit = records.find((r) => r.event === 'profile-exit' && r.pid === pid)
  assert.equal(exit.requested, false, 'nothing asked this profile to leave')
  assert.equal(records.some((r) => r.event === 'stop-requested' && r.target === pid), false, 'no stop was requested')
  assert.equal(records.some((r) => r.event === 'stop-seen'), false, 'and the profile never saw a request')
  assert.equal(typeof exit.uptimeMs, 'number', 'uptime is what dates the death')
  assert.ok(
    exit.code !== 0 || exit.signal !== null,
    'a forced end must not be recorded as a clean exit: ' + JSON.stringify(exit),
  )
  assert.equal(records.some((r) => r.event === 'profile-spawned' && r.pid === pid), true)
})

await test_('a requested stop is journalled as requested on both sides', async () => {
  const port = await freePort()
  const env = {
    ...baseEnv,
    DSH_WEBUI_TEST_MARKER: join(work, 'marker-stopped.txt'),
    DSH_WEBUI_TEST_COMPANION: '1',
  }
  const booted = await start({ port, profile: 'web', env, dshScript: DUMMY, timeoutMs: 30000 })
  assert.equal(booted.running, true, 'the fixture should serve: ' + JSON.stringify(booted))
  const pid = booted.pid
  const stopped = await stop({ port, profile: 'web', env, graceMs: 8000 })
  assert.equal(stopped.stopped, true, 'stop should succeed: ' + JSON.stringify(stopped))
  assert.equal(stopped.reason, 'app-exit', 'the handshake should answer: ' + JSON.stringify(stopped.steps))
  const records = readJournal(env, 300)
  assert.equal(records.some((r) => r.event === 'stop-requested' && r.target === pid), true, 'the request is recorded')
  const exit = records.find((r) => r.event === 'profile-exit' && r.pid === pid)
  assert.equal(exit.requested, true, 'the exit is attributed to that request, not to a mystery')
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
