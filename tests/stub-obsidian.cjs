/**
 * Shared Obsidian stub + fake vault that really stores file text.
 * Used by the regression suites so they exercise the real bundled plugin.
 */
const path = require("path");
// The scratchpad has no node_modules; use the plugin repo's copy.
// From the repo's own devDependencies, so this works on any machine.
const moment = require("moment");

class TFile {
  constructor(p) {
    this.path = p;
    this.basename = path.basename(p, path.extname(p));
    this.extension = p.split(".").pop();
    this.stat = { ctime: Date.parse("2026-01-01"), mtime: Date.now() };
  }
}
class TFolder {
  constructor(p) {
    this.path = p;
    this.name = path.basename(p);
    this.children = [];
  }
}

class Stub {
  constructor(tag) { this.tag = tag; this.children = []; this.classes = new Set(); this.attrs = {}; this.text = ""; this.dataset = {}; }
  addClass(c) { this.classes.add(c); return this; }
  addClasses(cs) { cs.forEach((c) => this.classes.add(c)); return this; }
  removeClass(c) { this.classes.delete(c); return this; }
  toggleClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); return this; }
  hasClass(c) { return this.classes.has(c); }
  empty() { this.children = []; }
  // Real DOM moves a node when it's already parented; the sentinel relies on that to
  // stay last as rows are appended.
  appendChild(child) {
    const at = this.children.indexOf(child);
    if (at !== -1) this.children.splice(at, 1);
    this.children.push(child);
    child.parent = this;
    return child;
  }
  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at !== -1) this.children.splice(at, 1);
    return child;
  }
  prepend(child) { this.children.unshift(child); return child; }
  remove() { this.parent?.removeChild(this); }
  detach() {}
  show() { this.hidden = false; }
  hide() { this.hidden = true; }
  isShown() { return !this.hidden; }
  setText(t) { this.text = String(t); }
  appendText(t) { this.children.push(new Stub("#text")); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener() {}
  trigger() {}
  contains() { return false; }
  // Real enough for tests: `.class`, `tag`, `tag.class`, and comma-separated lists.
  // Returning [] unconditionally meant a test could "pass" against nothing.
  __matches(sel) {
    const parts = sel.trim().split(".");
    const tag = parts[0];
    const classes = parts.slice(1).filter(Boolean);
    if (tag && tag !== "*" && this.tag !== tag) return false;
    return classes.every((c) => this.classes.has(c));
  }
  querySelectorAll(sel) {
    const wanted = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.__matches && wanted.some((w) => child.__matches(w))) out.push(child);
        if (child.children) walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  createEl(tag, o) {
    const e = new Stub(tag);
    // The DomElementInfo fields Obsidian actually supports; `value` in particular was
    // missing, so an <option> came out valueless and a <select> read as "".
    if (o) {
      if (o.text != null) e.text = String(o.text);
      if (o.cls) String(o.cls).split(" ").forEach((c) => c && e.classes.add(c));
      if (o.attr) for (const [k, v] of Object.entries(o.attr)) e.attrs[k] = v;
      if (o.title !== undefined) e.title = o.title;
      if (o.value !== undefined) e.value = o.value;
      if (o.type !== undefined) e.type = o.type;
      if (o.href !== undefined) e.href = o.href;
      if (o.placeholder !== undefined) e.placeholder = o.placeholder;
    }
    this.children.push(e);
    return e;
  }
  createDiv(o) { return this.createEl("div", o); }
  createSpan(o) { return this.createEl("span", o); }
  setCssProps(props) { Object.assign(this.cssProps ??= {}, props); }
  setCssStyles(styles) { Object.assign(this.cssStyles ??= {}, styles); }
  get style() { return { setProperty() {}, removeProperty() {} }; }
  get inputEl() { return new Stub("input"); }
  get buttonEl() { return new Stub("button"); }
}

/** A chainable Obsidian component: every named method returns the component. */
function component(base, methods) {
  const self = { ...base };
  for (const name of methods) self[name] = () => self;
  return self;
}

// Obsidian exposes these as globals as well as element methods.
// The dashboard appends rows when a sentinel scrolls into view. In node there's no
// layout, so nothing ever intersects; tests drive appendChunk directly instead.
global.IntersectionObserver = class {
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.targets = []; }
  observe(el) { this.targets.push(el); }
  unobserve() {}
  disconnect() { this.targets = []; }
  /** Test hook: pretend the sentinel came into view. */
  __fire() { this.cb(this.targets.map((t) => ({ target: t, isIntersecting: true })), this); }
};

global.createEl = (tag, o) => { const e = new Stub(tag); if (o && o.text) e.text = o.text; if (o && o.cls) String(o.cls).split(" ").forEach((c) => e.classes.add(c)); return e; };
global.createDiv = (o) => global.createEl("div", o);
global.createSpan = (o) => global.createEl("span", o);

function makeStub(notices) {
  const stub = {
    Plugin: class {
      constructor(a, m) { this.app = a; this.manifest = m; }
      addCommand(c) { (this.__cmds ??= []).push(c); }
      addRibbonIcon() {} addSettingTab(t) { this.__tab = t; }
      addStatusBarItem() { return new Stub("div"); }
      registerView() {} registerEvent() {} registerDomEvent() {}
      // Plugin extends Component upstream, which is where register() comes from.
      register(cb) { (this.__disposers ??= []).push(cb); }
      addChild(c) { return c; } removeChild(c) { return c; }
      async loadData() { return this.__data ?? null; }
      async saveData(d) { this.__data = d; }
    },
    PluginSettingTab: class {
      constructor(a, p) { this.app = a; this.plugin = p; this.containerEl = new Stub("div"); this.__updates = 0; }
      update() { this.__updates++; this.settingDefinitions = this.getSettingDefinitions(); }
      getSettingDefinitions() { return []; }
      getControlValue() { return undefined; }
      setControlValue() {}
    },
    ItemView: class { constructor(l) { this.leaf = l; this.contentEl = new Stub("div"); } register() {} },
    Modal: class {
      constructor(a) { this.app = a; this.modalEl = new Stub("div"); this.contentEl = new Stub("div"); this.titleEl = new Stub("div"); this.scope = { register: (m, k, fn) => { (this.__keys ??= {})[k] = fn; } }; }
      open() { this.onOpen?.(); } close() { this.onClose?.(); }
    },
    SuggestModal: class { constructor(a) { this.app = a; } setPlaceholder() {} open() {} close() {} },
    FuzzySuggestModal: class { constructor(a) { this.app = a; } setPlaceholder() {} open() {} close() {} },
    AbstractInputSuggest: class { constructor(a, i) { this.app = a; this.inputEl = i; } close() {} },
    Component: class { load() { this.__loaded = true; } unload() { this.__loaded = false; } },
    Setting: class {
      constructor(c) { this.containerEl = c; }
      setName() { return this; } setDesc() { return this; } setHeading() { return this; }
      setClass() { return this; }
      // Each component's methods return the *component*, as Obsidian's do, so
      // `t.setValue(x).onChange(fn)` chains. Returning the Setting instead broke
      // any render path that chained, which made whole modals untestable here.
      addText(cb) { cb(component({ inputEl: new Stub("input") },
        ["setValue", "setPlaceholder", "setDisabled", "onChange"])); return this; }
      addTextArea(cb) { cb(component({ inputEl: new Stub("textarea") },
        ["setValue", "setPlaceholder", "onChange"])); return this; }
      addToggle(cb) { cb(component({ toggleEl: new Stub("div") },
        ["setValue", "setDisabled", "setTooltip", "onChange"])); return this; }
      addSlider(cb) { cb(component({ sliderEl: new Stub("input") },
        ["setLimits", "setValue", "setDynamicTooltip", "onChange"])); return this; }
      addDropdown(cb) { cb(component({ selectEl: new Stub("select") },
        ["addOption", "addOptions", "setValue", "setDisabled", "onChange"])); return this; }
      addButton(cb) { cb(component({ buttonEl: new Stub("button") },
        ["setButtonText", "setCta", "setWarning", "setDestructive", "setDisabled", "setTooltip", "setIcon", "onClick"])); return this; }
      addExtraButton(cb) { cb(component({ extraSettingsEl: new Stub("div") },
        ["setIcon", "setTooltip", "setDisabled", "onClick"])); return this; }
      addColorPicker(cb) { cb(component({}, ["setValue", "setValueRgb", "onChange"])); return this; }
      get nameEl() { return new Stub("div"); }
    },
    Notice: class {
      constructor(msg) {
        // createFragment() records the text it was given, so a fragment-based
        // notice stays readable to tests instead of collapsing to a placeholder.
        if (typeof msg === "string") notices.push(msg);
        else if (msg && Array.isArray(msg.__lines)) notices.push(msg.__lines.filter(Boolean).join(" "));
        else notices.push("[fragment]");
      }
      hide() {}
    },
    MarkdownRenderer: { render: async () => {} },
    TFile,
    TFolder,
    Platform: { isMobile: false, isPhone: false, isDesktop: true },
    getAllTags: (cache) => {
      const out = [];
      const t = cache?.frontmatter?.tags;
      if (t) for (const x of Array.isArray(t) ? t : [t]) out.push(`#${x}`);
      for (const x of cache?.tags ?? []) out.push(x.tag);
      return out;
    },
    getLinkpath: (l) => l.split("#")[0].split("|")[0],
    normalizePath: (p) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").normalize("NFC"),
    setIcon: () => {},
    debounce: (fn) => {
      const f = (...a) => fn(...a);
      f.cancel = () => {};
      return f;
    },
    moment,
  };
  return stub;
}

/** Minimal YAML for the frontmatter shapes this plugin reads and writes. */
function parseYaml(text) {
  const out = {};
  let key = null;
  for (const line of text.split("\n")) {
    const kv = /^([A-Za-z][\w \-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      out[key] = v === "" ? [] : coerce(v);
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(coerce(item[1].trim()));
    }
  }
  return out;
}
function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v.replace(/^["'](.*)["']$/, "$1");
}
function serializeYaml(obj) {
  let out = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      out += `${k}:\n`;
      for (const item of v) out += `  - ${item}\n`;
    } else out += `${k}: ${v}\n`;
  }
  return out;
}
function splitNote(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { fm: {}, body: content, fmEnd: 0 };
  return { fm: parseYaml(m[1]), body: content.slice(m[0].length), fmEnd: m[0].length };
}

/**
 * Compute the pieces of CachedMetadata the engine actually consumes: frontmatter,
 * links with offsets, sections, listItems, embeds and headings.
 */
function buildCache(content) {
  const { fm, fmEnd } = splitNote(content);
  const cache = { frontmatter: Object.keys(fm).length ? fm : undefined };

  const links = [];
  const embeds = [];
  const linkRe = /(!?)\[\[([^\]]+)\]\]/g;
  for (const m of content.matchAll(linkRe)) {
    const inner = m[2];
    const target = inner.split("|")[0];
    const rec = {
      link: target,
      displayText: inner.split("|")[1] ?? target,
      position: { start: { offset: m.index }, end: { offset: m.index + m[0].length } },
    };
    if (m[1] === "!") embeds.push(rec);
    else links.push(rec);
  }
  // Markdown-style links, which is what Obsidian writes with "Use [[Wikilinks]]"
  // off. Real Obsidian reports these in cache.links alongside wikilinks, with
  // `link` holding the target exactly as written — percent-encoding included — and
  // ![alt](x) going to embeds. External targets are not links at all.
  const mdRe = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;
  for (const m of content.matchAll(mdRe)) {
    let target = m[3];
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;   // http:, mailto:, obsidian:
    const rec = {
      link: target,
      displayText: m[2],
      position: { start: { offset: m.index }, end: { offset: m.index + m[0].length } },
    };
    if (m[1] === "!") embeds.push(rec);
    else links.push(rec);
  }

  // Document order, as Obsidian reports them; the open-loop walk relies on it.
  links.sort((a, b) => a.position.start.offset - b.position.start.offset);
  embeds.sort((a, b) => a.position.start.offset - b.position.start.offset);

  cache.links = links;
  cache.embeds = embeds;

  // Headings. Real Obsidian does not report `#` lines inside fenced code blocks,
  // so neither does this — otherwise the fence-awareness test would be vacuous.
  const headings = [];
  let offset = 0;
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        headings.push({
          heading: h[2],
          level: h[1].length,
          position: { start: { offset }, end: { offset: offset + line.length } },
        });
      }
    }
    offset += line.length + 1;
  }
  cache.headings = headings;

  // Sections: fenced code and blockquotes
  const sections = [];
  offset = fmEnd;
  const lines = content.slice(fmEnd).split("\n");
  let fenceStart = null;
  let pos = fmEnd;
  for (const line of lines) {
    const lineStart = pos;
    const lineEnd = pos + line.length;
    if (/^\s*```/.test(line)) {
      if (fenceStart === null) fenceStart = lineStart;
      else {
        sections.push({ type: "code", position: { start: { offset: fenceStart }, end: { offset: lineEnd } } });
        fenceStart = null;
      }
    } else if (fenceStart === null && /^\s*>/.test(line)) {
      sections.push({ type: "blockquote", position: { start: { offset: lineStart }, end: { offset: lineEnd } } });
    }
    pos = lineEnd + 1;
  }
  if (fenceStart !== null) {
    sections.push({ type: "code", position: { start: { offset: fenceStart }, end: { offset: content.length } } });
  }
  cache.sections = sections;

  // List items, with task state
  const listItems = [];
  pos = fmEnd;
  // Line numbers count from the top of the file, as Obsidian's cache reports them.
  let lineNo = content.slice(0, fmEnd).split("\n").length - 1;
  for (const line of lines) {
    const lineStart = pos;
    const lineEnd = pos + line.length;
    const li = /^\s*[-*+]\s+(?:\[(.)\]\s*)?/.exec(line);
    if (li) {
      listItems.push({
        task: li[1],
        position: {
          start: { offset: lineStart, line: lineNo },
          end: { offset: lineEnd, line: lineNo },
        },
      });
    }
    pos = lineEnd + 1;
    lineNo++;
  }
  cache.listItems = listItems;

  return cache;
}

/** A fake vault: real string storage, real-ish metadata cache. */
function makeVault() {
  const store = new Map();
  const files = [];
  const folders = new Map();

  function ensureFolders(p) {
    const parts = p.split("/");
    parts.pop();
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!folders.has(cur)) folders.set(cur, new TFolder(cur));
    }
  }

  function addFile(p, content = "") {
    const f = new TFile(p);
    files.push(f);
    store.set(p, content);
    ensureFolders(p);
    return f;
  }

  const app = {
    vault: {
      getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
      getFiles: () => files.slice(),
      getAllLoadedFiles: () => [...files, ...folders.values()],
      getAbstractFileByPath: (p) =>
        files.find((f) => f.path === p) ?? folders.get(p) ?? null,
      getFileByPath: (p) => files.find((f) => f.path === p) ?? null,
      read: async (f) => store.get(f.path) ?? "",
      cachedRead: async (f) => store.get(f.path) ?? "",
      modify: async (f, data) => { store.set(f.path, data); },
      create: async (p, content) => {
        if (files.some((f) => f.path === p)) throw new Error(`File already exists: ${p}`);
        return addFile(p, content);
      },
      createFolder: async (p) => {
        if (folders.has(p)) throw new Error(`Folder already exists: ${p}`);
        ensureFolders(p + "/x");
        folders.set(p, new TFolder(p));
      },
      process: async (f, fn) => {
        const next = fn(store.get(f.path) ?? "");
        store.set(f.path, next);
        return next;
      },
      on: () => ({}),
    },
    metadataCache: {
      getFileCache: (f) => {
        const c = store.get(f.path);
        return c === undefined ? null : buildCache(c);
      },
      getFirstLinkpathDest: (linkpath, _source) => {
        const want = linkpath.toLowerCase();
        // Exact basename match, then alias match — mirrors Obsidian's order.
        for (const f of files) {
          if (f.basename.toLowerCase() === want) return f;
        }
        for (const f of files) {
          const fm = splitNote(store.get(f.path) ?? "").fm;
          const a = fm.aliases ?? fm.alias;
          const list = Array.isArray(a) ? a : a ? [a] : [];
          if (list.some((x) => String(x).toLowerCase() === want)) return f;
        }
        return null;
      },
      resolvedLinks: {},
      on: () => ({}),
    },
    workspace: {
      onLayoutReady: (cb) => cb(),
      getLeavesOfType: () => [],
      getLeaf: () => ({ openFile: async () => {}, setViewState: async () => {} }),
      getActiveFile: () => null,
      revealLeaf: async () => {},
    },
    fileManager: {
      trashFile: async (file) => {
        const i = files.findIndex((f) => f.path === file.path);
        if (i >= 0) files.splice(i, 1);
        store.delete(file.path);
      },
      processFrontMatter: async (file, fn) => {
        const content = store.get(file.path) ?? "";
        const { fm, body } = splitNote(content);
        fn(fm);
        store.set(file.path, `---\n${serializeYaml(fm)}---\n${body}`);
      },
    },
  };

  return { app, store, files, addFile, splitNote };
}

// Obsidian exposes activeDocument (popout-window aware); Electron provides the
// element classes. Define them once so every suite has them.
if (typeof global.HTMLInputElement === "undefined") global.HTMLInputElement = class {};
if (typeof global.HTMLTextAreaElement === "undefined") global.HTMLTextAreaElement = class {};
if (typeof global.HTMLElement === "undefined") global.HTMLElement = class {};
if (typeof global.activeDocument === "undefined") global.activeDocument = { activeElement: null };

/** Obsidian's createFragment(): a DocumentFragment with the element helpers on it. */
if (typeof global.createFragment === "undefined") {
  global.createFragment = (fn) => {
    const node = new Stub("#fragment");
    node.__lines = [];
    const createEl = node.createEl.bind(node);
    node.createEl = (tag, o) => { if (tag === "div") node.__lines.push(o && o.text); return createEl(tag, o); };
    node.createDiv = (o) => node.createEl("div", o);
    node.createSpan = (o) => node.createEl("span", o);
    node.appendText = (t) => { node.__lines.push(t); return node; };
    node.appendChild = (c) => { node.children.push(c); return c; };
    Object.defineProperty(node, "textContent", {
      get: () => node.children.map((c) => c.text || "").join(" "),
    });
    fn(node);
    return node;
  };
}

module.exports = { makeStub, makeVault, Stub, TFile, TFolder, buildCache };
