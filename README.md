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
is appended to `$DSH_HOME/logs/webui-switch/webui.log`. There is no terminal to
press Ctrl+C in: a profile this plugin started is stopped by **terminating its
process tree** (`taskkill /T /F`). Nothing waits on that path - the console rung
cannot attach to a process that has no console, so no `stopGraceMs` elapses; the
only delay is the helper's failed PowerShell start-up, about a second. That is the
path this plugin was built for.

**Why a console Ctrl+C is still tried first.** A Web profile somebody else started -
in practice a `dsh web` you ran yourself in a terminal - owns a console, and the
harness turns that console's Ctrl+C into a graceful teardown:

```js
process.on('SIGTERM', () => interrupt(0))
process.on('SIGINT', () => interrupt(130))
```

where `interrupt` aborts a signal controller and calls
`createProcessShutdown(dispose).interrupt(code)` - a graceful teardown with a
five-second cap before the process is forced out. For such a profile the plugin
offers that event before escalating, so that it can end the way the command line
would.

**That rung is a broadcast, not a targeted signal.** Windows cannot aim a
CTRL_C_EVENT at a process: `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` is
documented to reach **every process that shares the console** - "this signal cannot
be limited to a specific process group" - so anything else running in that terminal
receives it too. Success is also weaker than it sounds: the helper reports exit 0
when the event was *generated*, not when the target acted on it, and an inherited
"ignore Ctrl+C" attribute makes even a successful call a silent no-op - one of the
outcomes measured while building this.

Stopping therefore walks a ladder and reports which step ended it:

1. **console Ctrl+C** - `AttachConsole` + `GenerateConsoleCtrlEvent`. Attempted
   first; it can only land on a Web profile that owns a console, and the attempt
   itself is how that is discovered (a process without one makes the helper exit 2).
   It is generated only when the console holds nobody except the target at that
   moment, and only when that can be judged at all: a shared - or unjudgeable -
   console makes the helper refuse with exit 4 and the ladder escalates, so nothing
   else on that console is ever signalled.
2. **terminate the tree** - `taskkill /T /F`: immediately when no console event
   could be generated (always the case for a profile this plugin started), or after
   `stopGraceMs` when one was generated but the target did not leave.

A Web profile this plugin started has no console, so `AttachConsole` on it fails
rather than delivering anything and it is always stopped by step 2. Giving one a
console through `cmd /c start` was implemented and measured, and is deliberately
not used: the control event came back as delivered but the target did not act on
it, and the launch was not dependable. Promising a graceful stop that has not been
observed would be worse than saying so.

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
- **How it stops depends on who started it.** A profile this plugin started has no
  console, so it is always terminated as a process tree. A profile you started in a
  terminal owns a console: the first rung applies there, and it is a broadcast - the
  event reaches every process sharing that console, so anything else in the same
  terminal receives it too. Success means the event was generated, not that the
  profile acted on it; when it does not, the ladder escalates to a tree kill.
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
profile. Counts today: smoke 13 passed / 1 skipped (the skip is the opt-in live
probe, `DSH_WEBUI_LIVE_PORT`), host 11 passed, client 6 passed.

No suite boots a real profile or touches a process you are working in. One
check is opt-in: set `DSH_WEBUI_LIVE_PORT=<port>` to have `test\smoke.mjs`
probe a Web profile you started yourself. The probe only reads it - it never
stops what it finds - and it is skipped unless the variable is set.
