/**
 * dsh-webui-switch, host half.
 *
 * The Desktop application runs one Host process; the Web profile is a second
 * one. This plugin owns that second process from here: it starts it windowless
 * and detached with a --patch overlay that mounts this package's Web-profile
 * half, reports whether it is actually serving, and stops it - by asking that
 * half to leave through the launcher's ctx.appExit, by a console Ctrl+C for a
 * profile somebody else started in a terminal, or by terminating its process
 * tree when neither answers. The client half never touches a process; it asks
 * this plugin over the application's own transport.
 *
 * How it is reached, and why not ctx.connection:
 *
 *   `@deepseek-ai/dsh-client-connection` builds its HostConnectionService
 *   locally inside its own apply() - `new HostConnectionService(ctx, ...)` -
 *   and never provides it on the context. Declaring `inject: ['connection']`
 *   therefore waits forever, the entry never activates, and the Desktop
 *   application refuses to boot ("web boot: 1 entry did not activate"). That
 *   was measured, not assumed.
 *
 *   The supported seam is the event the same package dispatches:
 *   `'connection/request'(request, response, next)`, a waterfall fired after
 *   the Host/Origin fence and browser authentication have already passed, with
 *   the shared API bridge as its fallback. A listener that answers its own path
 *   and leaves every other path to `next()` is the documented way to add a
 *   route, and it inherits that authentication instead of inventing a token.
 *
 *   The listener is attached twice on purpose: once on this plugin's context,
 *   and once on the webServer child context when the profile has one. Cordis
 *   events reach ancestor listeners, so the first is normally enough; the
 *   second removes the dependency on that. A waterfall stops at the first
 *   listener that answers, so a request is never handled twice.
 *
 * Facts this half is built on (read from the installed runtime, not assumed):
 *   ctx.on('connection/request', ...) - waterfall, mode 'waterfall'.
 *   `dsh --profile <name> --port <n>`  - the launcher's own grammar; every
 *                                         argument after the profile is the
 *                                         app's, so --port reaches the web app.
 */
import { appendJournal } from './journal.js'
import {
  adoptRecordedProfile,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STOP_GRACE_MS,
  start,
  status,
  stop,
} from './webui-process.js'

/** Cordis plugin name; also the service row id in the profile patch. */
export const name = 'webui-switch'

/**
 * No service is required. The plugin must never be the reason an application
 * refuses to boot, so it declares no dependency that could stay pending.
 */
export const inject = []

/** Path this plugin answers, below the shared /api prefix. */
export const ROUTE_PREFIX = '/plugins/dsh-webui-switch'

/** Largest action body accepted; the payload is one verb and one flag. */
const MAX_BODY_BYTES = 64 * 1024

/** Resolved defaults for this deployment. */
const DEFAULTS = {
  port: 4115,
  profile: 'web',
  startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
  stopGraceMs: DEFAULT_STOP_GRACE_MS,
}

/**
 * Merge configuration with defaults, ignoring anything of the wrong shape.
 * @param config - the profile patch row's `config` value.
 * @returns a complete settings object.
 */
function settings(config) {
  const value = typeof config === 'object' && config !== null ? config : {}
  const port = Number(value.port)
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULTS.port,
    profile: typeof value.profile === 'string' && value.profile !== '' ? value.profile : DEFAULTS.profile,
    cwd: typeof value.cwd === 'string' && value.cwd !== '' ? value.cwd : undefined,
    dshScript: typeof value.dshScript === 'string' && value.dshScript !== '' ? value.dshScript : undefined,
    node: typeof value.node === 'string' && value.node !== '' ? value.node : undefined,
    startTimeoutMs:
      Number.isInteger(value.startTimeoutMs) && value.startTimeoutMs > 0
        ? value.startTimeoutMs
        : DEFAULTS.startTimeoutMs,
    stopGraceMs:
      Number.isInteger(value.stopGraceMs) && value.stopGraceMs >= 0
        ? value.stopGraceMs
        : DEFAULTS.stopGraceMs,
  }
}

/**
 * The shared channel's mount point. The waterfall is dispatched from the /api
 * prefix route with the untouched request URL, so the path seen here is
 * absolute from the server root - "/api/plugins/...", not the endpoint alone.
 */
const API_PREFIX = '/api'

/**
 * The request path with the shared channel's mount point and the query removed.
 * @param url - request URL.
 * @returns the endpoint path, or undefined when the URL is unusable.
 */
function routePath(url) {
  if (typeof url !== 'string') return undefined
  const path = url.split('?')[0]
  return path.startsWith(API_PREFIX + '/') ? path.slice(API_PREFIX.length) : path
}

/**
 * Whether this request is ours.
 * @param url - request URL, path and query.
 * @param method - request method.
 * @returns true when the request must be answered here.
 */
function owns(url, method) {
  const path = routePath(url)
  if (path === undefined || !path.startsWith(ROUTE_PREFIX)) return false
  if (path === ROUTE_PREFIX + '/state') return method === 'GET' || method === 'HEAD'
  if (path === ROUTE_PREFIX + '/action') return method === 'POST'
  return false
}

/**
 * Read a bounded JSON body.
 * @param request - incoming request.
 * @returns the parsed value, or undefined when it is absent or malformed.
 */
function readJson(request) {
  return new Promise((resolve) => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      resolve(undefined)
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(undefined)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        finish({})
        return
      }
      try {
        finish(JSON.parse(text))
      } catch {
        finish(undefined)
      }
    })
    request.on('error', () => finish(undefined))
  })
}

/**
 * Who is asking.
 *
 * The 2026-09-27 and 2026-10-04 terminations both ended with "the trigger is not
 * established" because nothing recorded the caller of a stop. The route sits
 * behind the app's Host/Origin fence and browser authentication, so the caller
 * is either the Desktop app's own page or something holding its credential -
 * both identify themselves in the headers below.
 *
 * @param request - incoming request.
 * @returns the identifying fields, never undefined values.
 */
function callerOf(request) {
  const headers = request.headers ?? {}
  return {
    address: request.socket?.remoteAddress ?? null,
    origin: headers.origin ?? null,
    referer: headers.referer ?? null,
    agent: headers['user-agent'] ?? null,
  }
}

/**
 * Answer one request.
 * @param options - resolved settings.
 * @param request - incoming request.
 * @param response - the response owned until this settles.
 * @param action - parsed body, when one was sent.
 * @param status - HTTP status for an error answer.
 */
async function answer(options, request, response, action, status) {
  const body = JSON.stringify(action)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

/**
 * Build the handler for one request.
 * @param options - resolved settings.
 * @returns a handler that never throws.
 */
function handler(options) {
  const env = process.env
  const describe = () => status({ port: options.port, profile: options.profile, env })
  return async function handle(request, response) {
    const url = request.url ?? ''
    const method = (request.method ?? 'GET').toUpperCase()
    try {
      if (!owns(url, method)) return false
      if (routePath(url) === ROUTE_PREFIX + '/state') {
        await answer(options, request, response, await describe(), 200)
        return true
      }
      const body = await readJson(request)
      if (body === undefined) {
        await answer(options, request, response, { ok: false, error: 'invalid-json' }, 400)
        return true
      }
      const verb = typeof body.action === 'string' ? body.action : undefined
      if (verb !== 'start' && verb !== 'stop') {
        await answer(options, request, response, { ok: false, error: 'unknown-action', action: verb ?? null }, 400)
        return true
      }
      // Stopping ends the process that may be serving the caller's own session,
      // so it takes an explicit acknowledgement. A request that did not come
      // from the control's own confirmation is refused rather than obeyed: the
      // client sends `confirm: true` only after the human accepted the prompt.
      if (verb === 'stop' && body.confirm !== true) {
        await answer(
          options,
          request,
          response,
          { ok: false, error: 'confirmation-required', action: verb },
          428,
        )
        return true
      }
      const common = { port: options.port, profile: options.profile, env }
      const caller = callerOf(request)
      appendJournal(
        {
          event: 'action-requested',
          action: verb,
          confirm: body.confirm === true,
          force: body.force === true,
          port: options.port,
          profile: options.profile,
          caller,
        },
        { env, source: 'host' },
      )
      if (verb === 'start') {
        const result = await start({
          ...common,
          cwd: options.cwd,
          dshScript: options.dshScript,
          node: options.node,
          timeoutMs: options.startTimeoutMs,
        })
        appendJournal(
          { event: 'action-result', action: verb, status: 200, ok: true, started: result.started, reason: result.reason },
          { env, source: 'host' },
        )
        await answer(options, request, response, { ok: true, action: verb, result }, 200)
        return true
      }
      const result = await stop({ ...common, force: body.force === true, graceMs: options.stopGraceMs, caller })
      appendJournal(
        {
          event: 'action-result',
          action: verb,
          status: result.stopped ? 200 : 409,
          ok: result.stopped,
          reason: result.reason,
        },
        { env, source: 'host' },
      )
      await answer(options, request, response, { ok: result.stopped, action: verb, result }, result.stopped ? 200 : 409)
      return true
    } catch (error) {
      await answer(
        options,
        request,
        response,
        { ok: false, error: 'plugin-failed', detail: String(error && error.message ? error.message : error) },
        500,
      )
      return true
    }
  }
}

/**
 * Attach the listener to a context.
 * @param target - context that receives the waterfall event.
 * @param handle - the handler.
 * @returns a disposer.
 */
function listen(target, handle) {
  const listener = async (request, response, next) => {
    const answered = await handle(request, response)
    if (answered === true) return
    await next()
  }
  target.on('connection/request', listener)
  return () => {
    if (typeof target.off === 'function') target.off('connection/request', listener)
  }
}

/**
 * Mount the plugin.
 * @param ctx - Host plugin context.
 * @param config - resolved row configuration.
 */
export function apply(ctx, config) {
  const options = settings(config)
  const handle = handler(options)
  // A profile can outlive the host that started it: an application restart leaves it
  // serving with nobody watching. Take over whatever the record still points at, so
  // its heartbeats continue and its end is recorded instead of merely implied.
  ctx.effect(() => {
    // Adoption reads the process table, so it resolves after this returns: the
    // effect hands back a disposer immediately and disposes the adoption too if
    // the host unloads while the fence is still running.
    let adopted
    let disposed = false
    void adoptRecordedProfile()
      .then((result) => {
        if (disposed) result.dispose()
        else adopted = result
      })
      .catch((error) => {
        appendJournal({ event: 'adopt-failed', detail: String(error?.message ?? error) }, { source: 'host' })
      })
    return () => {
      disposed = true
      if (adopted !== undefined) adopted.dispose()
    }
  }, 'webui-switch: adopt a profile that outlived its host')
  ctx.effect(() => listen(ctx, handle), 'webui-switch: connection/request')
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => listen(webCtx, handle), 'webui-switch: webServer connection/request')
  })
}
