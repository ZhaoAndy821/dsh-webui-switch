#!/usr/bin/env node
/**
 * Test double for the Web profile launcher.
 *
 * It speaks only the part of the contract this plugin depends on: accept
 * "--profile <name> --port <n>", hold the port open, and leave on a console
 * Ctrl+C the way a graceful application does. Writing to a marker file makes
 * the exit path observable, so a test can tell a graceful exit from a kill.
 */
import net from 'node:net'
import { appendFileSync, writeFileSync } from 'node:fs'

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
