// Run: the .vscode/launch.json and .vscode/tasks.json of the folder you're in, as play buttons.
// Each configuration, compound or task opens in its own tab; a compound splits that tab,
// one terminal per configuration. No debugger: each one runs as a plain command.
// preLaunchTask runs the real task from tasks.json first (else, for .NET, `dotnet build`).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, terminals, focused, run, exec, hc, readTextFile, theme, notify, window, home, nextCommand } from "herdr";

const ICON = "mods/launch";
// The colors of VS Code's debug toolbar (debugIcon.startForeground, restartForeground, stopForeground).
const VSC = { green: "#89d185", red: "#f48771" };
const IS_WIN = () => window()?.platform === "windows";
const SEP = () => (IS_WIN() ? "\\" : "/");
const KIND = { c: "compuesto", k: "configuración", t: "tarea" };

// ---- where we are -----------------------------------------------------------

function currentDir() {
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || spaces().find((s) => s.active)?.folder || null;
}

function parentOf(dir) {
  const d = dir.replace(/[\\/]+$/, "");
  const i = Math.max(d.lastIndexOf("\\"), d.lastIndexOf("/"));
  if (i <= 0) return null;
  const up = d.slice(0, i);
  return /^[A-Za-z]:$/.test(up) ? up + "\\" : up;
}

const join = (dir, ...parts) => [dir.replace(/[\\/]+$/, ""), ...parts].join(SEP());
const baseName = (dir) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop();

// ---- JSON with comments and trailing commas ---------------------------------

function parseJsonc(text) {
  let out = "", i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// ---- turning a configuration or task into steps -----------------------------
// A step is { cwd, env: [[k, v]], line }; steps run in order and stop at the first failure.

function resolver(ws) {
  return (v) => typeof v !== "string" ? v : v
    .replace(/\$\{workspaceFolder\}/g, ws)
    .replace(/\$\{workspaceRoot\}/g, ws)
    .replace(/\$\{workspaceFolderBasename\}/g, baseName(ws))
    .replace(/\$\{userHome\}/g, home())
    .replace(/\$\{pathSeparator\}/g, SEP())
    .replace(/\$\{\/\}/g, SEP());
}
// Variables only VS Code can answer (an input box, a command, the open file).
const askVar = (v) => typeof v === "string" && /\$\{(input|command|file|selectedText|lineNumber|relativeFile)[^}]*\}/.exec(v)?.[0];

// A single-quoted shell word: PowerShell doubles ', sh closes and reopens.
const quote = (s) => IS_WIN() ? `'${String(s).replace(/'/g, "''")}'` : `'${String(s).replace(/'/g, `'\\''`)}'`;
// ${env:NAME} inside a command line: the shell's own variable.
const envRefs = (s) => s.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, IS_WIN() ? "$env:$1" : "$$$1");
const words = (list) => (list ?? []).map((a) => quote(a)).join(" ");
// A program name as the first word: bare when plain, else called through & (pwsh) or quoted.
const program = (c) => /^[A-Za-z0-9_.\-]+$/.test(c) ? c : IS_WIN() ? `& ${quote(c)}` : quote(c);
const valueOf = (a) => (a && typeof a === "object" ? a.value : a);
const envList = (env, r) => Object.entries(env ?? {}).map(([k, v]) => [k, r(String(v))]);

// The task with its platform's overrides (windows / osx / linux) on top.
function forPlatform(task) {
  const os = IS_WIN() ? "windows" : window()?.platform === "macos" ? "osx" : "linux";
  const o = task[os];
  if (!o) return task;
  return { ...task, ...o, options: { ...(task.options ?? {}), ...(o.options ?? {}), env: { ...(task.options?.env ?? {}), ...(o.options?.env ?? {}) } } };
}

// Steps for a task (its dependsOn first), or { unsupported: why }.
function taskSteps(label, ws, tasks, seen = new Set()) {
  const raw = tasks.find((t) => t.label === label);
  if (!raw) return { unsupported: `no existe la tarea "${label}" en tasks.json` };
  if (seen.has(label)) return { unsupported: `dependencia circular en "${label}"` };
  seen.add(label);
  const t = forPlatform(raw);
  const r = resolver(ws);
  const steps = [];
  for (const dep of [].concat(t.dependsOn ?? [])) {
    const d = taskSteps(typeof dep === "string" ? dep : dep?.label ?? dep?.task, ws, tasks, seen);
    if (d.unsupported) return d;
    steps.push(...d);
  }
  const cwd = r(t.options?.cwd) || ws;
  const env = envList(t.options?.env, r);
  const type = t.type ?? "process";
  const command = r(valueOf(t.command));
  const args = (t.args ?? []).map((a) => r(valueOf(a)));
  const ask = [command, ...args, t.options?.cwd].map(askVar).find(Boolean);
  if (ask) return { unsupported: `usa ${ask}, que solo VS Code puede resolver` };
  if (type === "npm") {
    if (!t.script) return { unsupported: "tarea npm sin script" };
    steps.push({ cwd: t.path ? join(ws, t.path) : cwd, env, line: `npm run ${quote(t.script)}` });
  } else if (type === "shell" || type === "process") {
    if (command) {
      // A shell task's command may be a whole command line; a process task's is one program.
      const line = type === "shell" && !args.length ? envRefs(command) : `${program(command)} ${words(args)}`.trim();
      steps.push({ cwd, env, line });
    } else if (!steps.length) return { unsupported: "tarea sin command" };
  } else {
    return { unsupported: `tipo de tarea "${type}" no soportado` };
  }
  return steps;
}

// Steps for a launch configuration, plus its cwd and serverReadyAction, or { unsupported }.
function plan(cfg, ws, tasks) {
  const r = resolver(ws);
  const cwd = r(cfg.cwd) || ws;
  const env = envList(cfg.env, r);
  const type = cfg.type ?? "";
  const pre = cfg.preLaunchTask ? taskSteps(cfg.preLaunchTask, ws, tasks) : null;
  if (pre?.unsupported && tasks.length) return pre;
  const before = pre && !pre.unsupported ? pre : [];
  let line;
  if (type === "node-terminal") {
    if (!cfg.command) return { unsupported: "node-terminal sin command" };
    line = envRefs(r(cfg.command));
  } else if (type === "coreclr" || type === "dotnet") {
    const dll = r(cfg.program);
    if (!dll) return { unsupported: "coreclr sin program" };
    // No preLaunchTask to build it: build the project that makes the dll (the folder above bin/).
    if (!before.length) {
      const m = /^(.*?)[\\/]bin[\\/]/i.exec(dll);
      before.push({ cwd, env: [], line: `dotnet build ${quote(m ? m[1] : cwd)}` });
    }
    line = `dotnet ${quote(dll)} ${words(cfg.args?.map(r))}`.trim();
  } else if (type === "node" || type === "pwa-node") {
    const exe = r(cfg.runtimeExecutable) || "node";
    const main = r(cfg.program);
    if (!main && !cfg.runtimeArgs) return { unsupported: "node sin program" };
    line = `${program(exe)} ${words(cfg.runtimeArgs?.map(r))} ${main ? quote(main) : ""} ${words(cfg.args?.map(r))}`.replace(/\s+/g, " ").trim();
  } else if (type === "python" || type === "debugpy") {
    const py = IS_WIN() ? "python" : "python3";
    const target = cfg.module ? `-m ${quote(cfg.module)}` : cfg.program ? quote(r(cfg.program)) : null;
    if (!target) return { unsupported: "python sin program ni module" };
    line = `${py} ${target} ${words(cfg.args?.map(r))}`.trim();
  } else {
    return { unsupported: `tipo "${type}" no soportado` };
  }
  return { cwd, steps: [...before, { cwd, env, line }], ready: cfg.serverReadyAction };
}

// UTF-16LE base64, for pwsh -EncodedCommand: no quoting problems at all.
function utf16Base64(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); bytes.push(c & 255, c >> 8); }
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (b === undefined ? "=" : A[(n >> 6) & 63]) + (c === undefined ? "=" : A[n & 63]);
  }
  return out;
}

// The terminal's argv: a shell that runs the steps in order, stops at the first failure,
// and stays open so the output (or the error) stays readable.
function argvFor(name, steps) {
  if (IS_WIN()) {
    const one = (s) => [
      `$global:LASTEXITCODE = 0`,
      `Set-Location -LiteralPath ${quote(s.cwd)}`,
      ...s.env.map(([k, v]) => `$env:${k} = ${quote(v)}`),
      s.line,
    ].join("\n");
    let body = one(steps.at(-1));
    for (let i = steps.length - 2; i >= 0; i--) {
      body = `${one(steps[i])}\nif ($LASTEXITCODE -eq 0) {\n${body}\n} else { Write-Host ${quote("✖ falló: " + steps[i].line)} -ForegroundColor Red }`;
    }
    const script = [
      `$Host.UI.RawUI.WindowTitle = ${quote(name)}`,
      `Write-Host ${quote("▶ " + name)} -ForegroundColor Cyan`,
      body,
    ].join("\n");
    return ["pwsh", "-NoLogo", "-NoExit", "-EncodedCommand", utf16Base64(script)];
  }
  const body = steps.map((s) => [`cd ${quote(s.cwd)}`, ...s.env.map(([k, v]) => `export ${k}=${quote(v)}`), s.line].join(" && ")).join(" && ");
  return ["sh", "-c", `echo ${quote("▶ " + name)}\n${body}\nexec "\${SHELL:-sh}"`];
}

function openUrl(url) {
  const w = window()?.platform;
  if (w === "windows") return exec("rundll32", ["url.dll,FileProtocolHandler", url]);
  return exec(w === "macos" ? "open" : "xdg-open", [url]);
}

// ---- the panel ----------------------------------------------------------------

export default class Launch extends View {
  init(_props, cx) {
    this.dir = null;       // the folder we looked from
    this.ws = null;        // the folder holding .vscode
    this.files = {};       // launch / tasks -> { path, text, data, error }
    this.searching = false;
    this.tabs = {};        // "<ws>|<kind>|<name>" -> tab id
    try { this.tabs = JSON.parse(localStorage.getItem("tabs") ?? "{}"); } catch { this.tabs = {}; }
    this.pending = [];     // started, tab not listed yet
    this.locate(cx);
    // Edits to the files, and moving to another folder.
    cx.timer.every(2500, (cx) => this.locate(cx));
    cx.timer.every(500, (cx) => { if (this.pending.length) { this.settle(cx); cx.notify(); } });
    // Keys and `herdr-app do launch.<cmd>`: c1 / k1 / t1 start compound / configuration / task 1;
    // stop-c1, restart-t2, ...
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const m = /^(?:(stop|restart)-)?([ckt])(\d+)$/.exec(c);
        const item = m && this.items(m[2])[+m[3] - 1];
        if (!item) continue;
        if (m[1] === "stop") this.stop(item, cx);
        else if (m[1] === "restart") this.restart(item, cx);
        else this.start(item, cx);
      }
    });
  }

  locate(cx) {
    const dir = currentDir();
    if (this.searching) return;
    const sameDir = dir === this.dir;
    this.searching = true;
    cx.spawn(async (cx) => {
      try {
        let ws = sameDir ? this.ws : null;
        if (!sameDir) {
          this.dir = dir;
          // The nearest folder up with a .vscode/launch.json or tasks.json.
          for (let d = dir; d && !ws; d = parentOf(d)) {
            for (const f of ["launch.json", "tasks.json"]) {
              if (!ws && (await readTextFile(join(d, ".vscode", f)).catch(() => null)) != null) ws = d.replace(/[\\/]+$/, "") || d;
            }
          }
        }
        if (ws !== this.ws) { this.ws = ws; this.files = {}; }
        if (!ws) return;
        for (const kind of ["launch", "tasks"]) {
          const path = join(ws, ".vscode", `${kind}.json`);
          const text = await readTextFile(path).catch(() => null);
          if (this.files[kind]?.text === text && this.files[kind]?.path === path) continue;
          const f = { path, text, data: null, error: null };
          if (text != null) {
            try { f.data = parseJsonc(text); } catch (e) { f.error = `${kind}.json no es válido: ${e.message ?? e}`; }
          }
          this.files[kind] = f;
        }
      } finally {
        this.searching = false;
        cx.notify();
      }
    });
  }

  configs() { const c = this.files.launch?.data?.configurations; return Array.isArray(c) ? c : []; }
  compoundList() { const c = this.files.launch?.data?.compounds; return Array.isArray(c) ? c : []; }
  taskList() { const t = this.files.tasks?.data?.tasks; return Array.isArray(t) ? t : []; }

  // The rows of one kind: c compounds, k configurations, t tasks (hidden ones left out).
  items(kind) {
    const list = kind === "c" ? this.compoundList() : kind === "k" ? this.configs() : this.taskList().filter((t) => !t.hide);
    return list.map((cfg, index) => ({ kind, cfg, index, name: (kind === "t" ? cfg.label : cfg.name) ?? "(sin nombre)" }));
  }

  key(item) { return `${this.ws}|${item.kind}|${item.name}`; }

  allTabs() { return spaces().flatMap((s) => s.tabs.map((t) => ({ ...t, space: s.id }))); }

  // The tab this item opened, if it's still there.
  tabOf(item) {
    const id = this.tabs[this.key(item)];
    return id ? this.allTabs().find((t) => t.id === id) ?? null : null;
  }

  forget(item) {
    delete this.tabs[this.key(item)];
    // And tabs that are gone.
    const live = new Set(this.allTabs().map((t) => t.id));
    for (const [k, v] of Object.entries(this.tabs)) if (!live.has(v)) delete this.tabs[k];
    localStorage.setItem("tabs", JSON.stringify(this.tabs));
  }

  // What an item runs: one entry per terminal, each { name, cwd, steps, ready }, or { unsupported }.
  plans(item) {
    const tasks = this.taskList();
    if (item.kind === "t") {
      const steps = taskSteps(item.name, this.ws, tasks);
      return steps.unsupported ? steps : [{ name: item.name, cwd: steps[0]?.cwd ?? this.ws, steps }];
    }
    const cfgs = item.kind === "k" ? [item.cfg] : (item.cfg.configurations ?? [])
      .map((n) => this.configs().find((c) => c.name === (typeof n === "string" ? n : n?.name))).filter(Boolean);
    if (!cfgs.length) return { unsupported: "ninguna configuración encontrada" };
    const out = [];
    for (const c of cfgs) {
      const p = plan(c, this.ws, tasks);
      if (p.unsupported) { if (item.kind === "k") return p; continue; }
      out.push({ name: c.name, ...p });
    }
    return out.length ? out : { unsupported: "ninguna de sus configuraciones se puede ejecutar" };
  }

  start(item, cx) {
    const plans = this.plans(item);
    if (plans.unsupported) {
      notify({ title: item.name, body: plans.unsupported, level: "warning" });
      return;
    }
    // The tabs there are now: the new one is the one with this name that isn't among them.
    // (focused() is a snapshot: right after run() it still names the old tab.)
    const before = new Set(this.allTabs().map((t) => t.id));
    const argvs = plans.map((p) => argvFor(p.name, p.steps));
    // One tab for the item; each extra configuration splits it.
    run("tab.new", { name: item.name, folder: plans[0].cwd, argv: argvs[0] });
    plans.slice(1).forEach((p, i) => run("terminal.open", { argv: argvs[i + 1], folder: p.cwd, place: i === 0 ? "right" : "down" }));
    this.forget(item);
    const key = this.key(item);
    this.pending = this.pending.filter((p) => p.key !== key);
    this.pending.push({ key, name: item.name, before, plans, argvs, at: Date.now() });
    cx.notify();
  }

  // Finds the tabs started above once Herdr lists them.
  settle(cx) {
    if (!this.pending.length) return;
    const tabs = this.allTabs();
    this.pending = this.pending.filter((p) => {
      const tab = tabs.find((t) => !p.before.has(t.id) && t.name === p.name);
      if (!tab) return Date.now() - p.at < 20000;
      this.tabs[p.key] = tab.id;
      localStorage.setItem("tabs", JSON.stringify(this.tabs));
      // Each configuration's terminal: by its exact argv, else by pane order in the tab.
      const inTab = panes().filter((x) => x.tab === tab.id && x.terminal);
      const all = terminals();
      p.plans.forEach((x, i) => {
        if (!x.ready) return;
        const b64 = p.argvs[i].at(-1);
        const t = all.find((t) => Array.isArray(t.argv) && t.argv.at(-1) === b64)?.address ?? inTab[i]?.terminal;
        if (t) this.watchReady(x.name, t, x.ready, cx);
      });
      return false;
    });
  }

  stop(item, cx) {
    const tab = this.tabOf(item);
    if (tab) run("tab.close", { id: tab.id, confirmed: true });
    this.forget(item);
    cx.notify();
  }

  restart(item, cx) {
    this.stop(item, cx);
    this.start(item, cx);
  }

  // serverReadyAction: when the output matches, open the address (openExternally).
  watchReady(name, terminal, ready, cx) {
    if (ready.action && ready.action !== "openExternally") return;
    let re;
    try { re = new RegExp(ready.pattern ?? "listening on.* (https?://\\S+|[0-9]+)", "i"); } catch { return; }
    const format = ready.uriFormat ?? "%s";
    const started = Date.now();
    let done = false;
    const task = cx.timer.every(2000, (cx) => {
      if (done || Date.now() - started > 5 * 60000) { task.cancel(); return; }
      cx.spawn(async () => {
        const r = await hc(["read", terminal]).catch(() => null);
        const m = r?.stdout && re.exec(r.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
        if (!m || done) return;
        done = true;
        let value = m[1] ?? m[0];
        if (/^\d+$/.test(value)) value = `http://localhost:${value}`;
        const url = format.replace("%s", value);
        await openUrl(url).catch(() => notify({ title: name, body: `No pude abrir ${url}`, level: "warning" }));
      });
    });
  }

  editFile(kind) {
    const path = this.files[kind]?.path;
    if (!path) return;
    const open = IS_WIN() ? exec("cmd", ["/c", "code", "-g", path]) : exec("code", ["-g", path]);
    open.catch(() => notify({ title: `${kind}.json`, body: path, level: "info" }));
  }

  // ---- drawing ----

  iconButton(id, icon, tip, onClick, t, color) {
    return div()
      .id(id)
      .flex_none()
      .p(3)
      .rounded(4)
      .text_color(color ?? t.dim)
      .hover((s) => color ? s.bg(t.hover) : s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation?.(); onClick(cx); })
      .child(svg(`${ICON}/${icon}.svg`).size(12));
  }

  row(item, t) {
    const tab = this.tabOf(item);
    const plans = this.plans(item);
    const bad = plans.unsupported ?? null;
    const sub = item.kind === "c" ? plans.length ? plans.map((p) => p.name).join(" + ") : null
      : item.kind === "t" ? item.cfg.detail ?? null : null;
    const id = `${item.kind}-${item.index}`;
    return h_flex()
      .id(id)
      .px(8)
      .py(4)
      .gap(6)
      .items_center()
      .rounded(6)
      .when(Boolean(tab?.active && spaces().find((s) => s.id === tab.space)?.active), (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .when(Boolean(tab), (el) => el.cursor_pointer().on_click(() => {
        run("space.select", { id: tab.space });
        run("tab.select", { id: tab.id });
      }))
      .when(!tab && !bad, (el) => el.cursor_pointer().on_click((_e, cx) => this.start(item, cx)))
      .when(Boolean(bad), (el) => el.tooltip(bad))
      .when(Boolean(sub) && !bad, (el) => el.tooltip(sub))
      .child(div().w(6).h(6).rounded(3).flex_none().bg(tab ? t.working : "#00000000"))
      .child(
        v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(bad ? t.dim : t.foreground).child(item.name))
          .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))),
      )
      .when(Boolean(tab), (el) => el
        .child(this.iconButton(`${id}-re`, "rotate", "Reiniciar", (cx) => this.restart(item, cx), t, VSC.green))
        .child(this.iconButton(`${id}-st`, "square", "Detener (cierra la pestaña)", (cx) => this.stop(item, cx), t, VSC.red)))
      .when(!tab && !bad, (el) => el
        .child(this.iconButton(`${id}-go`, "play", `Ejecutar ${KIND[item.kind]} en una pestaña nueva`, (cx) => this.start(item, cx), t, VSC.green)));
  }

  section(label, kind) {
    const t = theme();
    return h_flex().px(8).pt(8).h(26).flex_none().items_center().justify_between()
      .child(div().text_size(11).font_medium().text_color(t.dim).child(label))
      .when(Boolean(kind), (el) => el.child(
        this.iconButton(`ed-${kind}-${label}`, "edit", `Abrir ${kind}.json en VS Code`, () => this.editFile(kind), t)));
  }

  render(cx) {
    const t = theme();
    // A different focused folder: look again right away (the timer catches the rest).
    if (currentDir() !== this.dir && !this.searching) this.locate(cx);
    this.settle(cx);

    const groups = [
      ["Compuestos", "c", "launch"],
      ["Configuraciones", "k", "launch"],
      ["Tareas", "t", "tasks"],
    ];
    const body = [];
    for (const kind of ["launch", "tasks"]) {
      const e = this.files[kind]?.error;
      if (e) body.push(div().px(8).pt(6).text_size(12).text_color(t.blocked).child(e));
    }
    for (const [label, kind, file] of groups) {
      const items = this.items(kind);
      if (!items.length) continue;
      body.push(this.section(label, kind !== "c" ? file : null), ...items.map((i) => this.row(i, t)));
    }
    if (!this.ws) body.push(div().px(8).text_size(12).text_color(t.dim).child("No hay .vscode/launch.json ni tasks.json en esta carpeta ni en las de arriba."));
    else if (!body.length) body.push(div().px(8).text_size(12).text_color(t.dim).child("launch.json y tasks.json no tienen nada que ejecutar."));

    const header = h_flex()
      .px(16).h(41).pt(14).pb(5).flex_none().items_center().gap(6)
      .child(div().flex_none().text_size(11.5).font_medium().text_color(t.dim).child("Run"))
      .when(Boolean(this.ws), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(baseName(this.ws))));

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .child(header)
      .child(v_flex().id("ln-list").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().children(body));
  }
}
