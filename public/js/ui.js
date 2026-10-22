// Kleine DOM-Helfer ohne Framework. Texte werden ausschließlich über textContent gesetzt.

export const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  parent?.appendChild(el);
  return el;
}

function applyAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function icon(name, cls = 'icon') {
  const el = s('svg', { class: cls, 'aria-hidden': 'true' });
  s('use', { href: `#i-${name}` }, el);
  return el;
}

export function setText(el, text) {
  const value = String(text ?? '');
  if (el.textContent !== value) el.textContent = value;
}

export function setAttr(el, name, value) {
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const v = String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

export function setData(el, key, value) {
  if (value === null || value === undefined) {
    if (key in el.dataset) delete el.dataset[key];
    return;
  }
  const v = String(value);
  if (el.dataset[key] !== v) el.dataset[key] = v;
}

export function setTransform(el, value) {
  if (el.style.transform !== value) el.style.transform = value;
}

export const fmtClock = (t) => new Date(t).toLocaleTimeString('de-DE', { hour12: false });

export function fmtDuration(seconds) {
  const sec = Math.max(0, Math.round(seconds ?? 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function fmtNum(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return value.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');

export function boatColor(id) {
  return `var(--boat-${((id - 1) % 6) + 1})`;
}

export function boatTag(id) {
  const tag = h('span', { class: 'boat-tag', text: String(id) });
  tag.style.setProperty('--boat', boatColor(id));
  return tag;
}

/** Ersetzt den Inhalt nur, wenn sich der Schlüssel geändert hat (vermeidet Neuaufbau bei jedem Frame). */
export function renderIfChanged(el, key, build) {
  if (el.__renderKey === key) return false;
  el.__renderKey = key;
  el.replaceChildren(...[build()].flat());
  return true;
}

let toastRoot = null;

export function toast(message, kind = 'info') {
  toastRoot ??= document.getElementById('toasts');
  const el = h('div', { class: 'toast', 'data-kind': kind, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'warn' : 'check'), h('span', { text: message }));
  toastRoot.append(el);
  while (toastRoot.children.length > 4) toastRoot.firstElementChild.remove();
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 3000);
}

export function confirmAction({ title, text, confirmLabel = 'Ausführen', danger = false }) {
  const dialog = document.getElementById('confirmDialog');
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmText').textContent = text;
  const okBtn = document.getElementById('confirmOk');
  okBtn.textContent = confirmLabel;
  okBtn.classList.toggle('btn-danger', danger);
  okBtn.classList.toggle('btn-primary', !danger);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

/** Befehlstaster: Freigabe über data-can (Pfad in snapshot.can), Parameter als JSON. */
export function cmdButton(label, cmd, params = {}, canPath = null, { cls = 'btn btn-sm', confirm = null, danger = false } = {}) {
  return h(
    'button',
    {
      class: cls,
      type: 'button',
      'data-cmd': cmd,
      'data-params': JSON.stringify(params),
      'data-can': canPath,
      'data-confirm': confirm,
      'data-danger': danger || null,
    },
    label,
  );
}

/** Tipptaster (Totmann): sendet solange gedrückt, Steuerung stoppt ohne Wiederholung nach 400 ms. */
export function jogButton(label, section, axis, dir, canPath) {
  return h('button', { class: 'btn btn-sm jog', type: 'button', 'data-jog': dir, 'data-section': section, 'data-axis': axis, 'data-can': canPath, 'aria-label': `Tippen ${dir > 0 ? 'vorwärts' : 'rückwärts'}` }, label);
}
