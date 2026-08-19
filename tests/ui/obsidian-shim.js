// Minimal browser shim for the Obsidian API surface the dashboard view touches.
export class ItemView {
  constructor(leaf) { this.leaf = leaf; this.contentEl = leaf.contentEl; }
  register() {}
}
export class TFile { }
export class TFolder { }
export class Modal {
  constructor(app){
    this.app = app;
    this.modalEl = document.createElement("div");
    this.titleEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.scope = { register(){} };
  }
  // Record what a click opened, so the harness can assert on it.
  open(){ (window.__opened ??= []).push(this.constructor.name); }
  close(){}
}
export class SuggestModal extends Modal { setPlaceholder(){} }
export class FuzzySuggestModal extends Modal { setPlaceholder(){} }
export class AbstractInputSuggest { constructor(){} close(){} }
export class PluginSettingTab { constructor(app, plugin){ this.app=app; this.plugin=plugin; } update(){} }
export class Component { load(){} unload(){} }
export class Notice { constructor(){} hide(){} }
export class ButtonComponent { }
export class Setting {
  constructor(el){ this.el = el; }
  setName(){return this;} setDesc(){return this;} setHeading(){return this;} setClass(){return this;}
  addText(cb){ cb({setValue:()=>this,setPlaceholder:()=>this,onChange:()=>this,inputEl:document.createElement("input")}); return this; }
  addToggle(cb){ cb({setValue:()=>this,onChange:()=>this}); return this; }
  addSlider(cb){ cb({setLimits:()=>this,setValue:()=>this,onChange:()=>this}); return this; }
  addDropdown(cb){ cb({addOption:()=>this,setValue:()=>this,onChange:()=>this}); return this; }
  addButton(cb){ cb({setButtonText:()=>this,setCta:()=>this,setDestructive:()=>this,setWarning:()=>this,setDisabled:()=>this,onClick:()=>this,buttonEl:document.createElement("button")}); return this; }
  addExtraButton(cb){ cb({setIcon:()=>this,setTooltip:()=>this,onClick:()=>this}); return this; }
  addColorPicker(cb){ cb({setValue:()=>this,onChange:()=>this}); return this; }
  get nameEl(){ return document.createElement("div"); }
}
export const MarkdownRenderer = { render: async () => {} };
export const Platform = { isMobile: false, isPhone: false, isDesktop: true };
export const moment = () => ({ isValid: () => false, format: () => "" });
export function getAllTags(){ return []; }
export function getLinkpath(l){ return l; }
export function normalizePath(p){ return p; }
// A real debounce, matching Obsidian's signature. A passthrough here would have made
// the search input look more expensive than it is.
export function debounce(fn, timeout = 0, resetTimer = false) {
  let handle = null;
  return function (...args) {
    if (handle !== null) { if (!resetTimer) return; clearTimeout(handle); }
    handle = setTimeout(() => { handle = null; fn.apply(this, args); }, timeout);
  };
}
/**
 * A stand-in for Lucide icons, shaped like the real ones.
 *
 * Obsidian's setIcon() inserts an SVG carrying ~8 attributes and several child
 * shapes. A two-element stub made icon creation look nearly free, which hid how much
 * of a large render it accounts for — the same failure as approximating the app's
 * button selectors. This mirrors the real shape so the cost is comparable.
 */
export function setIcon(el, name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({
    xmlns: NS, width: "24", height: "24", viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round",
    "stroke-linejoin": "round", class: "svg-icon lucide-" + name,
  })) svg.setAttribute(k, v);
  svg.setAttribute("data-icon", name);
  // Three shapes, which is typical for a Lucide glyph.
  for (const d of ["M3 12h18", "M12 3v18", "M7 7l10 10"]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "9");
  svg.appendChild(circle);
  el.appendChild(svg);
}
