#!/usr/bin/env node
/**
 * Self-test for the host half's process control.
 *
 * The launcher is replaced by test/fixtures/dummy-web.js, so the suite proves
 * the mechanism - spawn, adopt a live port, deliver a console Ctrl+C, escalate,
 * and refuse a port this plugin does not own - without booting a profile and
 * without touching any process the user is working in.
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWebProfileCommand, listeningPid, portListening, start, status, stop, spawnPlan } from '../lib/webui-process.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DUMMY = join(HERE, 'fixtures', 'dummy-web.js')

let passed = 0
let failed = 0
let skipped = 0
async function test_(name, body) {
  try {
    const outcome = await body()
    if (outcome === 'skip') {
      skipped += 1
      console.log('  skip ' + name)
      return
    }
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

const work = mkdtempSync(join(tmpdir(), 'dsh-webui-switch-test-'))
const env = { ...process.env, DSH_HOME: work }

console.log('dsh-webui-switch self-test')

// The command lines below stand in for a real launch: the user profile segment
// is a placeholder, and the port is the documented default. Only the shape of
// each line matters here - the launcher path, the npm shim, the --profile=
// spelling - because that shape is what the classifier has to recognise.
await test_('isWebProfileCommand accepts the real launcher grammar', () => {
  assert.equal(
    isWebProfileCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile web --port 4115', 'web'),
    true,
  )
  assert.equal(
    isWebProfileCommand('node "C:/Users/you/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile=web --port 4115', 'web'),
    true,
    'the --profile=<name> spelling the launcher also accepts',
  )
})

await test_('isWebProfileCommand refuses another profile and other programs', () => {
  assert.equal(isWebProfileCommand('node bin.js --profile tui', 'web'), false)
  assert.equal(isWebProfileCommand('node some-other-app.js --profile web', 'web'), false)
  assert.equal(
    isWebProfileCommand('cmd.exe /c ""C:\\Users\\you\\AppData\\Roaming\\npm\\dsh.cmd" web --port 4115', 'web'),
    true,
    'the npm shim spelling reaches the same profile and must be recognised',
  )
  assert.equal(isWebProfileCommand('cmd.exe /c ""C:\\somewhere\\other.cmd" web --port 4115', 'web'), false)
  assert.equal(isWebProfileCommand('', 'web'), false)
  assert.equal(isWebProfileCommand(undefined, 'web'), false)
})

await test_('portListening reports a closed port as closed', async () => {
  const port = await freePort()
  assert.equal(await portListening(port), false)
})

await test_('listeningPid names the owner of an open port', async () => {
  const port = await freePort()
  const holder = net.createServer()
  await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve))
  try {
    assert.equal(await portListening(port), true)
    assert.equal(await listeningPid(port), process.pid)
  } finally {
    await new Promise((resolve) => holder.close(resolve))
  }
})

await test_('the spawn plan gives the child no console, on purpose', () => {
  const launcher = { node: 'C:/node.exe', script: 'C:/dsh/lib/bin.js' }
  const plan = spawnPlan(launcher, { port: 4115, profile: 'web' })
  assert.equal(plan.command, 'C:/node.exe')
  assert.deepEqual(plan.args, ['C:/dsh/lib/bin.js', '--profile', 'web', '--port', '4115'])
  assert.equal(plan.detached, true)
  // A consoleless process cannot be sent the console control event that the
  // harness treats as a graceful stop, so the window is deliberately hidden and
  // stopping falls through to terminating the tree.
  assert.equal(plan.windowsHide, true)
})

await test_('status reports a stopped profile as not running', async () => {
  const port = await freePort()
  const view = await status({ port, profile: 'web', env })
  assert.equal(view.running, false)
  assert.equal(view.url, 'http://127.0.0.1:' + port)
  assert.equal(view.detail, 'port-closed')
})

await test_('stop on a stopped profile is a no-op, not an error', async () => {
  const port = await freePort()
  const result = await stop({ port, profile: 'web', env })
  assert.equal(result.stopped, false)
  assert.equal(result.reason, 'not-running')
})

await test_('stop refuses a port this plugin does not own', async () => {
  const port = await freePort()
  const holder = net.createServer()
  await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve))
  try {
    const result = await stop({ port, profile: 'web', env })
    assert.equal(result.stopped, false)
    assert.equal(result.reason, 'foreign-listener')
    assert.equal(holder.listening, true, 'the foreign listener must survive')
  } finally {
    await new Promise((resolve) => holder.close(resolve))
  }
})

await test_('start adopts a port that is already serving', async () => {
  const port = await freePort()
  const holder = net.createServer()
  await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve))
  try {
    const result = await start({ port, profile: 'web', env, dshScript: DUMMY })
    assert.equal(result.running, true)
    assert.equal(result.started, false)
    assert.equal(result.reason, 'already-serving')
  } finally {
    await new Promise((resolve) => holder.close(resolve))
  }
})

await test_('start boots the profile and stop ends it', async () => {
  const port = await freePort()
  const marker = join(work, 'marker-' + port + '.txt')
  process.env.DSH_WEBUI_TEST_MARKER = marker
  const scoped = { ...env, DSH_WEBUI_TEST_MARKER: marker }

  const booted = await start({ port, profile: 'web', env: scoped, dshScript: DUMMY, timeoutMs: 30000, console: 'hidden' })
  assert.equal(booted.running, true, 'the profile should be serving: ' + JSON.stringify(booted))
  assert.equal(booted.started, true)
  assert.equal(typeof booted.pid, 'number')
  assert.equal(existsSync(join(work, 'webui-switch', 'state.json')), true, 'the start must be recorded')

  const markerText = readFileSync(marker, 'utf8')
  assert.match(markerText, /listening/)

  const stopped = await stop({ port, profile: 'web', env: scoped, graceMs: 8000 })
  assert.equal(stopped.stopped, true, 'stop should succeed: ' + JSON.stringify(stopped))
  const consoleStep = stopped.steps.find((s) => s.step === 'console-ctrl-c')
  assert.notEqual(consoleStep, undefined, 'the console event must be attempted first: ' + JSON.stringify(stopped.steps))
  // A detached child owns no console, so the honest outcome for a child this
  // test spawned is the terminate step. What matters is that the ladder is
  // walked in order and that the process is gone afterwards.
  assert.equal(stopped.reason, 'terminated', 'unexpected stop reason: ' + JSON.stringify(stopped.steps))
  assert.equal(existsSync(join(work, 'webui-switch', 'state.json')), false, 'the record must be cleared')
  assert.equal(await portListening(port), false)
  delete process.env.DSH_WEBUI_TEST_MARKER
})

await test_('a process that ignores Ctrl+C is escalated to a tree kill', async () => {
  const stubborn = join(work, 'stubborn.js')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    stubborn,
    'import net from "node:net"\n' +
      'const port = Number(process.argv[process.argv.indexOf("--port") + 1])\n' +
      'const server = net.createServer((s) => s.end())\n' +
      'server.listen(port, "127.0.0.1")\n' +
      'process.on("SIGINT", () => {})\n',
    'utf8',
  )
  const port = await freePort()
  const booted = await start({ port, profile: 'web', env, dshScript: stubborn, timeoutMs: 30000, console: 'hidden' })
  assert.equal(booted.running, true, 'the stubborn process should be serving')
  const stopped = await stop({ port, profile: 'web', env, graceMs: 1500 })
  assert.equal(stopped.stopped, true, 'escalation should still stop it: ' + JSON.stringify(stopped.steps))
  assert.equal(stopped.reason, 'terminated')
  assert.equal(await portListening(port), false)
})

// Optional live section: a real Web profile, but only when the port is named
// on purpose. A published suite must not depend on - or reach into - whatever
// happens to be serving on the host that runs it. The probe is read-only; it
// never stops what it finds.
//
//   set DSH_WEBUI_LIVE_PORT=4115
const livePortEnv = process.env.DSH_WEBUI_LIVE_PORT
await test_('a real Web profile is recognised, not refused', async () => {
  if (livePortEnv === undefined || String(livePortEnv).trim() === '') {
    return 'skip'
  }
  const livePort = Number(livePortEnv)
  if (!(await portListening(livePort))) {
    return 'skip'
  }
  const view = await status({ port: livePort, profile: 'web' })
  assert.equal(view.running, true)
  assert.equal(view.kind, 'launcher', 'the real command line should classify as the dsh launcher: ' + view.commandLine)
  assert.equal(view.detail, 'web-profile', 'a real Web profile must never read as a foreign listener')
  assert.equal(view.url, 'http://127.0.0.1:' + livePort)
})

rmSync(work, { recursive: true, force: true })

console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped')
process.exit(failed === 0 ? 0 : 1)
