#!/usr/bin/env node
/**
 * Test double for the Web profile launcher.
 *
 * It speaks only the parts of the contract this plugin depends on: accept
 * "--profile <name> --patch <file> --port <n>", hold the port open, and leave
 * on a console Ctrl+C the way a graceful application does. Writing to a marker
 * file makes the exit path observable, so a test can tell a graceful exit from
 * a kill.
 *
 * With DSH_WEBUI_TEST_COMPANION=1 it also plays the profile half of the stop
 * handshake - the record and the request file lib/web-stop.js defines - so the
 * ladder's first rung can be tested without booting a real profile.
 */
import net from 'node:net'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const portIndex = argv.indexOf('--port')
const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 0
const marker = process.env.DSH_WEBUI_TEST_MARKER
if (marker) writeFileSync(marker, String(process.pid), 'utf8')

const server = net.createServer((socket) => socket.end())
server.listen(port, '127.0.0.1', () => {
  if (marker) appendFileSync(marker, '\nlistening ' + String(process.pid), 'utf8')
})

let stopping = false
function leave(reason, code) {
  if (stopping) return
  stopping = true
  if (marker) appendFileSync(marker, '\n' + reason, 'utf8')
  server.close(() => process.exit(code))
}

process.on('SIGINT', () => leave('sigint', 0))
process.on('SIGTERM', () => leave('sigterm', 0))

// The profile half of the handshake, when this run is asked to play it: record
// that this pid answers, then leave through the same file a real profile polls.
if (process.env.DSH_WEBUI_TEST_COMPANION === '1') {
  const { switchDir, stopReadyPath, stopRequestPath } = await import('../../lib/web-stop.js')
  const ready = stopReadyPath(process.pid)
  const request = stopRequestPath(process.pid)
  mkdirSync(switchDir(), { recursive: true })
  writeFileSync(ready, JSON.stringify({ pid: process.pid }) + '\n', 'utf8')
  const timer = setInterval(() => {
    if (!existsSync(request)) return
    clearInterval(timer)
    rmSync(request, { force: true })
    rmSync(ready, { force: true })
    leave('app-exit', 0)
  }, 100)
}
