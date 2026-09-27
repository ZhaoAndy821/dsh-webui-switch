/**
 * dsh-webui-switch, client half.
 *
 * One control in the conversation header's leading seat: whether the Web
 * profile is serving, and the switch that starts or stops it. The control
 * owns no process. It asks the host half over the application's own
 * authenticated transport - the two routes the host registers below /api -
 * and renders whatever answer comes back, including "that port belongs to
 * something else", which is reported rather than acted on.
 *
 * Contract notes (read from the installed runtime, not assumed):
 *   - the entry id is the package name, and externals resolve through the
 *     injected require against the loader's module table;
 *   - "inject" names Cordis services the body waits for; the body registers
 *     UI through ctx.slots.register and nothing else;
 *   - the state is polled rather than pushed: the host half is a plain
 *     request/response pair, and a slightly stale dot is cheaper than a
 *     second socket.
 */
window.__ModuleLoader__.load({
  id: "dsh-webui-switch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useRef = react.useRef;

    var PLUGIN_ID = "dsh-webui-switch";
    var SLOT = "conversation.header.leading";
    var ROUTE_PREFIX = "api/plugins/dsh-webui-switch";
    var POLL_MS = 3000;

    var COPY = {
      en: {
        running: "WebUI running",
        stopped: "WebUI stopped",
        starting: "Starting WebUI...",
        stopping: "Stopping WebUI...",
        open: "Open",
        foreign: "Port held by another program",
        unknown: "WebUI state unknown",
        askStart: "Start the Web profile?",
        askStop: "Stop the Web profile? Running turns are cut off."
      },
      zh: {
        running: "WebUI 运行中",
        stopped: "WebUI 已停止",
        starting: "正在启动 WebUI...",
        stopping: "正在停止 WebUI...",
        open: "打开",
        foreign: "端口被其他程序占用",
        unknown: "WebUI 状态未知",
        askStart: "开启 Web 服务？",
        askStop: "暂停 Web 服务？正在运行的任务会被中断。"
      }
    };

    // One dictionary per document, chosen from the browser's own locale.
    var dictionary = (function () {
      var language = (typeof navigator !== "undefined" && navigator.language) || "en";
      return language.toLowerCase().indexOf("zh") === 0 ? COPY.zh : COPY.en;
    })();

    // Resolve a route against the page, so a mounted app keeps its prefix.
    function route(path) {
      return new URL(ROUTE_PREFIX + path, document.baseURI).toString();
    }

    // Ask the host half for the current state.
    async function readState() {
      var response = await fetch(route("/state"), {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error("state " + response.status);
      return await response.json();
    }

    // Ask the host half to start or stop the Web profile.
    async function sendAction(action, force, confirmed) {
      var response = await fetch(route("/action"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: action, force: force === true, confirm: confirmed === true })
      });
      var body = await response.json().catch(function () { return null; });
      if (body === null) throw new Error("action " + response.status);
      return body;
    }

    var STYLE = [
      "." + PLUGIN_ID + "{display:inline-flex;align-items:center;gap:6px;",
      "height:26px;padding:0 8px;border-radius:13px;cursor:pointer;",
      "border:1px solid var(--dsw-alias-border,rgba(127,127,127,.28));",
      "background:var(--dsw-alias-bg-base,transparent);color:inherit;",
      "font:inherit;font-size:12px;line-height:1;white-space:nowrap;",
      "user-select:none;transition:background .15s ease,border-color .15s ease}",
      "." + PLUGIN_ID + ":hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}",
      "." + PLUGIN_ID + "[data-busy='true']{cursor:progress;opacity:.75}",
      "." + PLUGIN_ID + "__dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;",
      "background:#9ca3af;box-shadow:0 0 0 2px rgba(156,163,175,.18)}",
      "." + PLUGIN_ID + "[data-state='running'] ." + PLUGIN_ID + "__dot{background:#22c55e;",
      "box-shadow:0 0 0 2px rgba(34,197,94,.18)}",
      "." + PLUGIN_ID + "[data-state='starting'] ." + PLUGIN_ID + "__dot,",
      "." + PLUGIN_ID + "[data-state='stopping'] ." + PLUGIN_ID + "__dot{background:#eab308;",
      "box-shadow:0 0 0 2px rgba(234,179,8,.2)}",
      "." + PLUGIN_ID + "[data-state='foreign'] ." + PLUGIN_ID + "__dot,",
      "." + PLUGIN_ID + "[data-state='error'] ." + PLUGIN_ID + "__dot{background:#ef4444;",
      "box-shadow:0 0 0 2px rgba(239,68,68,.2)}",
      "." + PLUGIN_ID + "__label{overflow:hidden;text-overflow:ellipsis}",
      "." + PLUGIN_ID + "__open{margin-left:2px;padding:0 4px;border-radius:9px;",
      "border:1px solid var(--dsw-alias-border,rgba(127,127,127,.28));",
      "font-size:11px;opacity:.8}",
      "." + PLUGIN_ID + "__open:hover{opacity:1}"
    ].join("");

    // Install the plugin's own stylesheet once per document, under the same
    // tag identity the client module system uses for plugin-owned CSS.
    function ensureStyle() {
      if (typeof document === "undefined") return;
      var tagId = PLUGIN_ID + "/styles.css";
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = tagId;
      tag.textContent = STYLE;
      document.head.appendChild(tag);
    }

    /**
     * The header control.
     * @returns the rendered control element.
     */
    function WebuiSwitch() {
      var viewState = useState(null);
      var view = viewState[0];
      var setView = viewState[1];
      var pendingState = useState(null);
      var pending = pendingState[0];
      var setPending = pendingState[1];
      var alive = useRef(true);

      var refresh = useCallback(async function () {
        try {
          setView(await readState());
        } catch (error) {
          setView({ running: false, detail: "error", error: String(error && error.message ? error.message : error) });
        }
      }, []);

      useEffect(function () {
        alive.current = true;
        ensureStyle();
        void refresh();
        var timer = setInterval(function () {
          if (alive.current && pending === null) void refresh();
        }, POLL_MS);
        return function () {
          alive.current = false;
          clearInterval(timer);
        };
      }, [refresh, pending]);

      var run = useCallback(async function (action, confirmed) {
        setPending(action);
        try {
          var body = await sendAction(action, false, confirmed === true);
          if (body && body.result) setView(body.result);
          else await refresh();
        } catch (error) {
          setView({ running: false, detail: "error", error: String(error && error.message ? error.message : error) });
        } finally {
          setPending(null);
          void refresh();
        }
      }, [refresh]);

      var onToggle = useCallback(function () {
        if (pending !== null) return;
        var action = view && view.running ? "stop" : "start";
        // A dialog we cannot show is not consent: without one, start still runs
        // (it only adds a process) but stop is abandoned.
        var accepted = true;
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          var question = action === "stop" ? dictionary.askStop : dictionary.askStart;
          accepted = window.confirm(question);
        } else if (action === "stop") {
          accepted = false;
        }
        if (!accepted) return;
        void run(action, action === "stop");
      }, [pending, view, run]);

      var onOpen = useCallback(function (event) {
        event.stopPropagation();
        if (!view || !view.url) return;
        window.open(view.url, "_blank", "noopener");
      }, [view]);

      var phase = pending !== null
        ? pending
        : view === null
          ? "unknown"
          : view.running
            ? "running"
            : "stopped";
      var label = pending === "start"
        ? dictionary.starting
        : pending === "stop"
          ? dictionary.stopping
          : view === null || view.detail === "error"
            ? dictionary.unknown
            : view.detail === "foreign-listener"
              ? dictionary.foreign
              : view.running
                ? dictionary.running
                : dictionary.stopped;
      var actionable = view !== null && view.detail !== "foreign-listener" && view.detail !== "error";

      return h(
        "div",
        {
          className: PLUGIN_ID,
          "data-state": phase,
          "data-busy": pending !== null ? "true" : "false",
          role: "button",
          tabIndex: 0,
          title: view && view.url ? view.url : "",
          onClick: actionable ? onToggle : undefined,
          onKeyDown: actionable
            ? function (event) {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggle();
                }
              }
            : undefined
        },
        h("span", { className: PLUGIN_ID + "__dot" }),
        h("span", { className: PLUGIN_ID + "__label" }, label),
        view && view.running
          ? h(
              "span",
              {
                className: PLUGIN_ID + "__open",
                role: "button",
                tabIndex: -1,
                onClick: onOpen
              },
              dictionary.open
            )
          : null
      );
    }

    // Cordis services this body waits for.
    var inject = ["slots"];

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyle();
      // The official contract for this seat (kind "single", scope "root",
      // registerOptions: [], occupants: []) is a declaration injection, not a
      // bare register: the slot is declared by the conversation header's own
      // entry and only exists while that entry is mounted.
      ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT }, WebuiSwitch));
    }

    exports.WebuiSwitch = WebuiSwitch;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
