#!/usr/bin/env node
/**
 * Self-test for the host half's request handling.
 *
 * The plugin is mounted on a context that records what it registers, and the
 * waterfall is driven with request/response doubles shaped like node:http. The
 * point is the seam, not the process work (test/smoke.mjs covers that): a
 * plugin that declares a service the Host never provides stops the Desktop
 * application from booting at all, so the regression is asserted directly.
 *
 * Run: node test/host.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

let passed = 0
let failed = 0
async function test_(name, body) {
  try {
    await body()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + name + '\n       ' + String(error && error.message ? error.message : error))
  }
}

/** A context that records listeners, effects, and child injections. */
function fakeContext() {
  const listeners = []
  const effects = []
  const injections = []
  return {
    listeners,
    effects,
    injections,
    on(event, listener) {
      listeners.push({ event, listener })
      return this
    },
    off() {},
    effect(fn, label) {
      // Cordis runs the effect body immediately and keeps its disposer.
      effects.push({ label, dispose: fn() })
      return () => {}
    },
    inject(names, fn) {
      injections.push({ names, fn })
    },
  }
}

/** node:http-shaped request double. */
function fakeRequest(method, url, body) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.destroyed = false
  request.destroy = () => { request.destroyed = true }
  if (body !== undefined) {
    const payload = Buffer.from(body, 'utf8')
    setImmediate(() => {
      request.emit('data', payload)
      request.emit('end')
    })
  } else {
    setImmediate(() => request.emit('end'))
  }
  return request
}

/** node:http-shaped response double that records what was written. */
function fakeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(payload) {
      this.ended = true
      this.body = payload === undefined ? undefined : payload.toString('utf8')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

/** Drive the waterfall and report whether the plugin answered. */
async function fire(ctx, method, url, body) {
  const request = fakeRequest(method, url, body)
  const response = fakeResponse()
  let delegated = false
  for (const entry of ctx.listeners) {
    if (entry.event !== 'connection/request') continue
    await entry.listener(request, response, async () => { delegated = true })
    if (response.ended) return { response, delegated }
  }
  return { response, delegated }
}

/**
 * A port nothing is listening on, chosen now rather than hard-coded: a fixed
 * port makes the suite depend on whatever the host happens to be running.
 * @returns a free TCP port.
 */
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

const freeTestPort = await freePort()

console.log('dsh-webui-switch host self-test')

await test_('the plugin declares no service the Host may never provide', () => {
  assert.deepEqual(plugin.inject, [], 'a pending inject keeps the entry inactive and stops the app booting')
  assert.equal(plugin.name, 'webui-switch')
})

await test_('apply registers the waterfall listener and the webServer child', () => {
  const ctx = fakeContext()
  plugin.apply(ctx, { port: freeTestPort, profile: 'web' })
  assert.equal(ctx.listeners.filter((l) => l.event === 'connection/request').length, 1)
  assert.equal(ctx.injections.length, 1)
  assert.deepEqual(ctx.injections[0].names, ['webServer'])
})

const mounted = fakeContext()
plugin.apply(mounted, { port: freeTestPort, profile: 'web' })

await test_('GET state answers with the current state', async () => {
  const { response, delegated } = await fire(mounted, 'GET', '/api/plugins/dsh-webui-switch/state')
  assert.equal(delegated, false, 'the plugin must answer its own path')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  const body = response.json()
  assert.equal(body.running, false, 'port ' + freeTestPort + ' is not serving in this test')
  assert.equal(body.url, 'http://127.0.0.1:' + freeTestPort)
})

await test_('a request for another route is passed along untouched', async () => {
  const { response, delegated } = await fire(mounted, 'GET', '/api/session/list')
  assert.equal(delegated, true, 'every other path must reach the shared bridge')
  assert.equal(response.ended, false)
})

await test_('the wrong method on our path is passed along too', async () => {
  const { delegated } = await fire(mounted, 'DELETE', '/api/plugins/dsh-webui-switch/state')
  assert.equal(delegated, true)
})

await test_('an unknown action is refused with 400', async () => {
  const { response } = await fire(mounted, 'POST', '/api/plugins/dsh-webui-switch/action', JSON.stringify({ action: 'explode' }))
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error, 'unknown-action')
})

await test_('a malformed body is refused with 400', async () => {
  const { response } = await fire(mounted, 'POST', '/api/plugins/dsh-webui-switch/action', '{not json')
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error, 'invalid-json')
})

await test_('a bare stop is refused: stopping needs an explicit confirmation', async () => {
  const { response } = await fire(mounted, 'POST', '/api/plugins/dsh-webui-switch/action', JSON.stringify({ action: 'stop' }))
  assert.equal(response.statusCode, 428, 'a request that skipped the human prompt must not be obeyed')
  assert.equal(response.json().error, 'confirmation-required')
})

await test_('a confirmed stop that has nothing to stop answers 409, not 200', async () => {
  const { response } = await fire(mounted, 'POST', '/api/plugins/dsh-webui-switch/action', JSON.stringify({ action: 'stop', confirm: true }))
  assert.equal(response.statusCode, 409)
  const body = response.json()
  assert.equal(body.ok, false)
  assert.equal(body.result.reason, 'not-running')
})

await test_('the client only ever confirms a stop after the human accepted', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(source.includes('confirm: confirmed === true'), 'the confirmation is sent explicitly')
  // The refusal path must not be reachable by clicking: no prompt means no stop.
  assert.match(source, /accepted = false/)
})

await test_('the client and the host agree on the route', () => {
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(client, /ROUTE_PREFIX = "api\/plugins\/dsh-webui-switch"/)
  assert.equal(plugin.ROUTE_PREFIX, '/plugins/dsh-webui-switch')
  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.ok(!host.includes('ctx.connection.fetch'), 'the Host never provides that service')
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
