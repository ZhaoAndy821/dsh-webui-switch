#!/usr/bin/env node
/**
 * Self-test for the client half.
 *
 * The bundle is loaded exactly the way the application's module system loads
 * it - a global `window.__ModuleLoader__.load({ id, factory })` whose factory
 * resolves externals through an injected require - and then driven far enough
 * to prove the two contracts that only fail at runtime: the entry id is the
 * package name, and the body registers into the slot it claims.
 *
 * React and react-dom/server are read from the profile's own node_modules, the
 * same copies the running application loads.
 *
 * Run: node test/client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// React is a peer of the browser bundle, supplied by whatever host runs it.
// Prefer this repository's own node_modules so the suite is self-contained;
// fall back to a local DSH profile, which is how it resolves when the
// repository itself has no install. Both can be overridden.
const moduleRoots = [
  process.env.DSH_PROFILE_MODULES,
  join(ROOT, 'node_modules'),
  join(homedir(), '.dsh', 'profiles', 'node_modules'),
].filter((entry) => typeof entry === 'string' && entry !== '')

/**
 * Load a module from the first root that has it.
 * @param id - module id.
 * @returns the module exports.
 */
function requireFromRoots(id) {
  const failures = []
  for (const modules of moduleRoots) {
    try {
      return createRequire(join(modules, 'noop.js'))(id)
    } catch (error) {
      failures.push(modules + ': ' + error.code)
    }
  }
  throw new Error(
    'cannot resolve ' + id + '. Tried ' + moduleRoots.join(', ') +
    '. Run "npm install" in the repository, or point DSH_PROFILE_MODULES at a ' +
    'directory that has it. (' + failures.join('; ') + ')',
  )
}

const react = requireFromRoots('react')
const { renderToStaticMarkup } = requireFromRoots('react-dom/server')

let passed = 0
let failed = 0
function test_(name, body) {
  try {
    body()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + name + '\n       ' + String(error && error.message ? error.message : error))
  }
}

console.log('dsh-webui-switch client self-test')

// The smallest surface the bundle touches: a loader, a document with a head,
// a navigator, and a base URI. Nothing here pretends to be a browser.
const registrations = []
const styleTags = []
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  URL,
  navigator: { language: 'zh-CN' },
  document: {
    baseURI: 'http://127.0.0.1:4115/',
    head: { appendChild: (tag) => { styleTags.push(tag); return tag } },
    createElement: () => ({ dataset: {}, set textContent(value) { this._text = value }, get textContent() { return this._text } }),
    querySelector: () => null,
  },
  window: {
    confirm: () => true,
    open: () => null,
    location: { href: 'http://127.0.0.1:4115/' },
  },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ running: false, detail: 'port-closed' }) }),
}
sandbox.window.document = sandbox.document
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = {
  load(entry) {
    sandbox.window.__loaded = entry
    return entry.factory((id) => {
      if (id !== 'react') throw new Error('the bundle requested an unexpected module: ' + id)
      return react
    })
  },
}
vm.createContext(sandbox)

const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

const entry = sandbox.window.__loaded
let exportsRef = null

test_('the bundle registers itself under the package name', () => {
  assert.notEqual(entry, undefined, 'window.__ModuleLoader__.load was never called')
  assert.equal(entry.id, PKG.name)
  assert.equal(typeof entry.factory, 'function')
})

test_('the factory exports a cordis plugin body', () => {
  exportsRef = entry.factory((id) => (id === 'react' ? react : undefined))
  assert.equal(typeof exportsRef.apply, 'function')
  assert.ok(Array.isArray(exportsRef.inject), 'inject must be a service list')
  assert.ok(exportsRef.inject.includes('slots'), 'the body registers UI, so it waits for the slots service')
})

test_('apply declares the header control into the claimed slot', () => {
  const declared = []
  const ctx = {
    slots: {
      register: (...args) => registrations.push(args),
      inject: (name, fn) => { declared.push(name); fn() },
    },
  }
  exportsRef.apply(ctx)
  assert.deepEqual(declared, ['conversation.header.leading'], 'the official contract is a declaration injection')
  assert.equal(registrations.length, 1, 'exactly one contribution')
  const [spec, component] = registrations[0]
  // Compared field by field: the bundle runs in its own realm, so a deep
  // strict comparison would fail on the prototype alone.
  assert.equal(spec.name, 'conversation.header.leading')
  assert.deepEqual(Object.keys(spec), ['name'], 'a single-kind seat takes no order or key')
  assert.equal(typeof component, 'function')
})

test_('the control renders a state the user can read', () => {
  const markup = renderToStaticMarkup(react.createElement(exportsRef.WebuiSwitch, {}))
  assert.match(markup, /dsh-webui-switch/, 'the control carries its own class')
  assert.match(markup, /data-state="unknown"/, 'before the first answer the state is unknown, not a guess')
  assert.ok(markup.includes('WebUI'), 'the label is present: ' + markup)
})

test_('the stylesheet is installed once, under the module system tag identity', () => {
  assert.equal(styleTags.length >= 1, true, 'apply() installs the stylesheet')
  const tag = styleTags[0]
  assert.equal(tag.dataset.plugin, PKG.name)
  assert.equal(tag.dataset.pluginCss, PKG.name + '/styles.css')
  assert.match(tag.textContent, /\.dsh-webui-switch\{/)
})

test_('the client addresses the host routes the host half registers', () => {
  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.match(host, /ROUTE_PREFIX = '\/plugins\/dsh-webui-switch'/)
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(client, /ROUTE_PREFIX = "api\/plugins\/dsh-webui-switch"/)
  assert.ok(!client.includes('127.0.0.1:4115'), 'the client must not hard-code a host or port')
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
