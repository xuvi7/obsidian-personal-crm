const host = () => document.getElementById("modal-host");
export class Modal {
  constructor(app) {
    this.app = app;
    this.modalEl = document.createElement("div"); this.modalEl.className = "modal";
    this.titleEl = document.createElement("div"); this.titleEl.className = "modal-title";
    this.contentEl = document.createElement("div"); this.contentEl.className = "modal-content";
    this.modalEl.appendChild(this.titleEl); this.modalEl.appendChild(this.contentEl);
    this.scope = { register: () => {} };
  }
  open() { host().appendChild(this.modalEl); this.onOpen && this.onOpen(); }
  close() { this.onClose && this.onClose(); this.modalEl.remove(); }
}
export class SuggestModal extends Modal { setPlaceholder() {} }
export class FuzzySuggestModal extends Modal { setPlaceholder() {} }
export class Setting {
  constructor(container) {
    this.settingEl = document.createElement("div");
    this.settingEl.className = "setting-item";
    this.infoEl = this.settingEl.appendChild(document.createElement("div"));
    this.infoEl.className = "setting-item-info";
    this.nameElx = this.infoEl.appendChild(document.createElement("div"));
    this.nameElx.className = "setting-item-name";
    this.descEl = this.infoEl.appendChild(document.createElement("div"));
    this.descEl.className = "setting-item-description";
    this.controlEl = this.settingEl.appendChild(document.createElement("div"));
    this.controlEl.className = "setting-item-control";
    container.appendChild(this.settingEl);
  }
  setName(n) { this.nameElx.textContent = n; return this; }
  setDesc(d) { if (typeof d === "string") this.descEl.textContent = d; else this.descEl.appendChild(d); return this; }
  setHeading() { this.settingEl.classList.add("setting-item-heading"); return this; }
  setClass(c) { this.settingEl.classList.add(c); return this; }
  addText(cb) {
    const input = this.controlEl.appendChild(document.createElement("input"));
    const api = { inputEl: input,
      setValue(v){ input.value = v; return api; },
      setPlaceholder(p){ input.placeholder = p; return api; },
      onChange(fn){ input.addEventListener("input", () => fn(input.value)); return api; } };
    cb(api); return this;
  }
  addButton(cb) {
    const btn = this.controlEl.appendChild(document.createElement("button"));
    const api = { buttonEl: btn,
      setButtonText(t){ btn.textContent = t; return api; },
      setCta(){ btn.classList.add("mod-cta"); return api; },
      setDestructive(){ btn.classList.add("mod-warning"); return api; },
      setWarning(){ btn.classList.add("mod-warning"); return api; },
      setDisabled(d){ btn.disabled = !!d; return api; },
      setTooltip(t){ btn.title = t; return api; },
      onClick(fn){ btn.addEventListener("click", fn); return api; } };
    cb(api); return this;
  }
  addToggle(cb){ const i=this.controlEl.appendChild(document.createElement("input")); i.type="checkbox";
    const api={setValue(v){i.checked=!!v;return api;},onChange(fn){i.addEventListener("change",()=>fn(i.checked));return api;}}; cb(api); return this; }
  addSlider(cb){ const i=this.controlEl.appendChild(document.createElement("input")); i.type="range";
    const api={setLimits(){return api;},setValue(v){i.value=v;return api;},onChange(){return api;}}; cb(api); return this; }
  addDropdown(cb){ const s=this.controlEl.appendChild(document.createElement("select"));
    const api={addOption(v,t){const o=document.createElement("option");o.value=v;o.textContent=t;s.appendChild(o);return api;},setValue(v){s.value=v;return api;},onChange(){return api;}}; cb(api); return this; }
  addExtraButton(cb){ const b=this.controlEl.appendChild(document.createElement("button")); b.textContent="⋯";
    const api={setIcon(){return api;},setTooltip(t){b.title=t;return api;},onClick(fn){b.addEventListener("click",fn);return api;}}; cb(api); return this; }
  addColorPicker(cb){ const i=this.controlEl.appendChild(document.createElement("input")); i.type="color";
    const api={setValue(v){i.value=v;return api;},onChange(){return api;}}; cb(api); return this; }
  get nameEl(){ return this.nameElx; }
}
export class Component { load(){} unload(){} }
export class Notice { constructor(m){ console.log("[notice]", m); } hide(){} }
export class TFile { constructor(p){ this.path = p ?? ""; this.basename = (this.path.split("/").pop()||"").replace(/\.md$/,""); } }
// The harness needs to construct a real TFile: the plugin guards on `instanceof`.
if (typeof window !== "undefined") window.__TFile = TFile;
export class TFolder { }
export class ItemView { constructor(l){ this.leaf=l; this.contentEl=l.contentEl; } register(){} }
export class PluginSettingTab { constructor(a,p){ this.app=a; this.plugin=p; } update(){} }
export class AbstractInputSuggest { constructor(){} close(){} }
export class ButtonComponent { }
// Crude markdown -> HTML, enough to judge the preview's look.
export const MarkdownRenderer = { render: async (app, md, el) => {
  const html = md.split(/\n/).map(l => {
    if (/^#{1,6}\s/.test(l)) { const n = l.match(/^#+/)[0].length; return `<h${n}>${l.replace(/^#+\s*/,"")}</h${n}>`; }
    if (/^\s*-\s/.test(l)) return `<li>${l.replace(/^\s*-\s*/,"")}</li>`;
    return l.trim() ? `<p>${l}</p>` : "";
  }).join("");
  el.innerHTML = html.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");
} };
export const Platform = { isMobile: false, isPhone: false, isDesktop: true };
export const moment = () => ({ isValid: () => false, format: () => "" });
export function getAllTags(){ return []; }
export function getLinkpath(l){ return l; }
export function normalizePath(p){ return p; }
export function debounce(fn){ return fn; }
export function setIcon(el, name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox","0 0 24 24"); svg.classList.add("svg-icon"); svg.dataset.icon = name;
  const p = document.createElementNS("http://www.w3.org/2000/svg","path");
  p.setAttribute("d","M5 12l4 4 10-10"); p.setAttribute("stroke","currentColor");
  p.setAttribute("stroke-width","2"); p.setAttribute("fill","none");
  svg.appendChild(p); el.appendChild(svg);
}
