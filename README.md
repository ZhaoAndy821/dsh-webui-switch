# dsh-webui-switch

Start, watch, and stop the Web profile from the Desktop application.

The Desktop application runs one Host process; the Web profile is a second one.
This plugin puts that second process behind a single control at the left of the
conversation header: a state dot, the WebUI's condition, and a switch that
starts or stops it. Nothing else about the Desktop application changes.

The profile it starts is **windowless and detached**: no console window opens,
nothing is left on screen after a start or a stop, and its output is appended to
`$DSH_HOME/logs/webui-switch/webui.log`. Its lifetime is the process's, not a
terminal's.

## What it does

| Control | Result |
| --- | --- |
| click while stopped | boots `dsh --profile web --port 4115`, waits for the port to answer, dot turns green |
| click while running | asks first, then stops it: the windowless profile it started is terminated as a process tree; a profile you started yourself in a terminal gets a console Ctrl+C first; dot turns grey |
| "Open" | opens the WebUI in a browser |

The control is read-only about anything it did not start: a port held by another
program is reported as such and never stopped.

## Install

The `desktop` profile is owned by the Electron application, and the CLI refuses
it on purpose, so this script writes the same two facts the application's own
Plugins page would write.

```powershell
# close the Desktop application first
node scripts\install.mjs --dry-run     # print the plan
node scripts\install.mjs --via link    # link: spec + node_modules junction
# start the Desktop application
```

`--via pnpm` (the default) runs the package manager the application itself uses
(`resources/runtime/pnpm`) in the profile directory instead, which is what the
in-app **Plugins → Add plugin** dialog does with an absolute path.

Undo: `node scripts\install.mjs --remove`.

## Configuration

Defaults are correct for a single local WebUI. Override them with a patch row in
the profile's `cordis.patch.yml`:

```yaml
- id: webui-switch
  config:
    port: 4115
    profile: web
    cwd: C:/Users/you/projects
    startTimeoutMs: 90000
    stopGraceMs: 5000
```

`cwd` is the workspace root the booted profile runs in. `port` is the port the
control watches, starts, and stops; it is never inferred. `stopGraceMs` is the
grace after a console event was *generated*, so it applies only to the console
rung; a profile this plugin started is terminated without waiting for it.

## How it is built

Two halves, per the harness's own plugin model.

**Host half** (`lib/index.js`, mounted by `cordis.patch.yml`) owns the process
and answers two routes on the application's authenticated `/api` channel:

- `GET  /api/plugins/dsh-webui-switch/state`
- `POST /api/plugins/dsh-webui-switch/action` with `{"action":"start"|"stop"}`

Stopping requires an explicit `confirm: true` in the request body. The control
sends it only after the human accepts the prompt, and the host refuses a bare
`{"action":"stop"}` with `428` - a request that skipped the human is not obeyed.
Stopping can end the process that is serving the caller's own session, so the
acknowledgement is the guard, not the dialog.

It reaches the routes through `'connection/request'`, the waterfall the
connection plugin dispatches after its Host/Origin fence and browser
authentication have already passed, so the plugin inherits that authentication
instead of inventing a token. `ctx.connection` is deliberately not used: the connection service is
constructed inside that plugin's own `apply()` and never provided on the
context, so waiting for it would leave this entry permanently inactive — which
is exactly what makes a Desktop application refuse to boot.

**Client half** (`lib/client.js`, declared by `dsh.client`) registers one
component into the `conversation.header.leading` slot and polls the state route
every three seconds. It owns no process and holds no privileged state.

## Stopping, precisely

**The normal case has no terminal.** The control boots the Web profile with
`detached: true` (on Windows DETACHED_PROCESS) and `windowsHide`, so no console
window opens, nothing is left on screen after the click, and the profile's output
is appended to `$DSH_HOME/logs/webui-switch/webui.log`. The child therefore owns
**no console**, and no console control event can reach it at all.

**So the profile is asked to leave from inside.** Every start writes an overlay
(`$DSH_HOME/webui-switch/web-stop.patch.yml`) and passes it as `--patch`, which
mounts this package's Web-profile half - `lib/web-stop.js`, named by its own
`file:` URL so the row resolves wherever the package is installed. That row
injects the launcher's public `ctx.appExit`,

> "a way to ask the process to exit once the tree has shut down, wired to the
> launcher's shutdown controller" - `@deepseek-ai/dsh-cmdline`

records that it can answer (`web-stop.<pid>.ready`) and polls for a request
(`stop.<pid>.request`). A stop writes that request and waits `stopGraceMs`: the row
calls `ctx.appExit(0)`, the launcher disposes the whole Cordis tree - every plugin
flushes and releases what it holds - and the process exits with code 0. Measured
against a real profile: **3.5 s from request to gone, exit code 0**, request, record
and state file all cleared, and no `.tmp` or lock left under the profile's home.
The same profile terminated by a tree kill exits 1, which is the outcome this rung
exists to avoid: a hard kill cuts in-flight state writes, and a real profile has
been observed to leave an orphaned `.tmp` payload and a held lock behind that way.

**Why a console Ctrl+C is still tried - but only for a profile this plugin did not
start.** A `dsh web` you ran yourself in a terminal owns a console, and the harness
turns that console's Ctrl+C into a graceful teardown:

```js
process.on('SIGTERM', () => interrupt(0))
process.on('SIGINT', () => interrupt(130))
```

where `interrupt` aborts a signal controller and calls
`createProcessShutdown(dispose).interrupt(code)` - a graceful teardown with a
five-second cap before the process is forced out. That rung is a broadcast, not a
targeted signal: `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` reaches **every
process that shares the console** - "this signal cannot be limited to a specific
process group" - so it is generated only when the console holds nobody except the
target and this helper; a shared or unjudgeable console makes the helper refuse
with exit 4 and the ladder escalates, so nothing else on that console is ever
signalled. It is skipped entirely for a profile this plugin started, which has no
console to send it to.

**Giving a started profile its own console was measured and rejected.** Three
launchers were tried - `cmd /c start`, `Start-Process -WindowStyle Hidden`, and
`CreateProcessW` with `CREATE_NEW_CONSOLE`, with and without
`CREATE_NEW_PROCESS_GROUP` (which Windows ignores beside `CREATE_NEW_CONSOLE`). In
all three, `AttachConsole` succeeded and the helper reported the event as delivered,
and in all three the target acted on none of them. A `CTRL_BREAK` *was* acted on -
and killed the helper on its way out - but this harness registers `SIGINT` and
`SIGTERM` only, so Ctrl+Break is an immediate exit wearing a graceful name.
Promising a graceful stop that has not been observed would be worse than saying so.

Stopping therefore walks a ladder and reports which step ended it:

1. **app-exit request** - the handshake above. The request is written only when the
   target left a ready record, so a profile that cannot answer (an older one, or one
   whose overlay did not mount) is never made to wait out a grace it cannot use.
2. **console Ctrl+C** - `AttachConsole` + `GenerateConsoleCtrlEvent`, for a target
   this plugin did not start (see above).
3. **terminate the tree** - `taskkill /T /F`: after `stopGraceMs` when a graceful
   rung was attempted and the profile did not leave, and immediately when no
   graceful rung applies.

## Known limitations

- **Stopping cuts the turn in flight.** DSH persists each turn as it completes,
  but a turn that is mid-flight when the process is terminated is lost. The
  control asks for confirmation first.
- **A stop is a real process exit.** Confirming it ends the Web profile, and
  with it any session that profile is serving - including the one you are reading
  this in. Sessions are persisted, so re-opening the WebUI brings them back, but
  a turn in flight is lost.
- **Nothing is left on screen, and there is no terminal.** The booted WebUI is
  windowless and detached: no console window opens, nothing stays visible after a
  start or a stop, and its output goes to
  `$DSH_HOME/logs/webui-switch/webui.log` instead. The header control is the only
  interface; if you want the profile in a terminal of your own, start `dsh web`
  on the port the control watches and it will adopt that instance.
- **How it stops depends on who started it.** A profile this plugin started is asked
  to leave through the stop handshake: it disposes its tree and exits 0. If it does
  not answer - an older profile, or a handshake that did not mount - it is
  terminated as a process tree. A profile you started in a terminal has no
  handshake, so the console rung applies there instead, and it is a broadcast - the
  event reaches every process sharing that console, so anything else in the same
  terminal receives it too. Success there means the event was generated, not that
  the profile acted on it; when it does not, the ladder escalates to a tree kill.
- **A profile killed from outside leaves its record.** The handshake files are keyed
  by pid; a record whose process no longer exists is swept at the next start rather
  than trusted, and only the pid that wrote it can be answered.
- **The pid is resolved once, then checked again.** Windows recycles pids, so the
  command line of the process about to be stopped is re-read immediately before
  acting - including for a pid this plugin recorded itself, which is exactly the
  one that can have been recycled. A readable line that no longer selects the
  watched profile is refused as `target-changed` instead of being signalled or
  killed; an unreadable line is not a reason to refuse.
- **Not published to npm.** `package.json` sets `"private": true` on purpose: this
  plugin is installed from the repository by `scripts/install.mjs`, not from a
  registry.
- **One WebUI.** The control watches exactly one port. A second instance on
  another port is neither adopted nor stopped.
- **The profile is booted as a child of the Desktop Host.** Closing the Desktop
  application leaves the WebUI running, which is the intent; the control is then
  unreachable until the application is started again.

## Tests

```powershell
node test\smoke.mjs    # host half, against a test-double launcher
node test\host.mjs     # request handling, on a context that records what it registers
node test\client.mjs   # client half, loaded the way the module system loads it
```

`test/client.mjs` loads the real client bundle from the profile's `node_modules`;
set `DSH_PROFILE_MODULES` to that directory when the suite runs outside the
profile. Counts today: smoke 18 passed / 1 skipped (the skip is the opt-in live
probe, `DSH_WEBUI_LIVE_PORT`), host 11 passed, client 6 passed.

No suite boots a real profile or touches a process you are working in. One
check is opt-in: set `DSH_WEBUI_LIVE_PORT=<port>` to have `test\smoke.mjs`
probe a Web profile you started yourself. The probe only reads it - it never
stops what it finds - and it is skipped unless the variable is set.
