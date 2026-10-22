import { buildElementCard } from './elements.js';
import { buildStationPanel } from './station.js';
import { Synoptic } from './synoptic.js';
import { BottomTabs } from './tabs.js';
import { $, $$, confirmAction, fmtClock, setAttr, setData, setText, toast } from './ui.js';

const MOVABLE = new Set(['turntable', 'rotatingLift', 'catchCarLift']);
const THEME_KEY = 'mmc-theme';

const app = {
  snap: null,
  lastMsg: 0,
  online: true,
  frame: 0,
  selected: null,
  cards: new Map(),
  stations: new Map(),
  synoptic: null,
  tabs: null,
  jog: null,
};

// ------------------------------------------------------------------ Befehle

async function send(type, params = {}, { quiet = false } = {}) {
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...params }),
    });
    const data = await res.json();
    if (!quiet) {
      if (!data.ok) toast(data.message ?? 'Befehl abgelehnt', 'error');
      else if (data.message) toast(data.message, 'ok');
    }
    return data;
  } catch {
    if (!quiet) toast('Keine Verbindung zur Steuerung', 'error');
    return { ok: false };
  }
}

function wireCommands() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.confirm) {
      const confirmed = await confirmAction({
        title: btn.textContent.trim() || 'Bestätigen',
        text: btn.dataset.confirm,
        confirmLabel: 'Ausführen',
        danger: 'danger' in btn.dataset,
      });
      if (!confirmed) return;
    }
    let params = {};
    try {
      params = btn.dataset.params ? JSON.parse(btn.dataset.params) : {};
    } catch {
      params = {};
    }
    send(btn.dataset.cmd, params);
  });

  // Not-Halt reagiert bereits beim Drücken, nicht erst beim Loslassen.
  const estop = $('#btnEstop');
  estop.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    send('estop');
  });
  estop.addEventListener('click', (e) => {
    if (e.detail === 0) send('estop');
  });

  // Tippbetrieb (Totmannfunktion): wiederholtes Senden, Stopp beim Loslassen.
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-jog]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    stopJog();
    const params = { section: btn.dataset.section, axis: btn.dataset.axis, dir: Number(btn.dataset.jog) };
    send('manual.jog', params);
    app.jog = { btn, params, timer: setInterval(() => send('manual.jog', params, { quiet: true }), 150) };
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, stopJog);
  window.addEventListener('blur', stopJog);
  document.addEventListener('visibilitychange', stopJog);
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-jog]')) e.preventDefault();
  });
}

function stopJog() {
  if (!app.jog) return;
  clearInterval(app.jog.timer);
  send('manual.jog', { ...app.jog.params, dir: 0 }, { quiet: true });
  app.jog = null;
}

// ------------------------------------------------------------------ Darstellung

function lookup(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

function scheduleRender() {
  if (app.frame) return;
  app.frame = requestAnimationFrame(() => {
    app.frame = 0;
    render();
  });
}

function render() {
  const snap = app.snap;
  if (!snap) return;

  const stateEl = $('#state');
  setData(stateEl, 'code', snap.state.code);
  setText($('#stateLabel'), snap.state.label);
  setText($('#stateHint'), snap.state.hint);
  const modeLabel = $('#modeLabel');
  setText(modeLabel, snap.mode === 'auto' ? 'Automatik' : 'Handbetrieb');
  setData(modeLabel, 'mode', snap.mode);
  const ioLed = $('#ioLed');
  ioLed.classList.add('on');
  setData(ioLed, 'tone', snap.ioOk ? null : 'fault');
  setText($('#ioLabel'), snap.io?.label ?? '–');
  document.body.classList.toggle('mode-manual', snap.mode === 'manual');

  for (const el of $$('[data-can]')) {
    const reason = lookup(snap.can, el.dataset.can);
    const disabled = reason !== null;
    if (el.disabled !== disabled) el.disabled = disabled;
    setAttr(el, 'title', disabled ? reason ?? 'Nicht verfügbar' : null);
  }
  for (const seg of $$('.seg')) seg.classList.toggle('active', seg.dataset.mode === snap.mode);

  const auto = snap.mode === 'auto';
  $('#btnStart').classList.toggle('lit', auto && snap.runState === 'running');
  $('#btnStart').classList.toggle('blink', snap.can.start === null);
  $('#btnStop').classList.toggle('lit', auto && snap.runState === 'stopping');
  $('#btnCycle').classList.toggle('lit', auto && snap.runState === 'ending');
  $('#btnReset').classList.toggle('blink', snap.alarms.unacknowledged || (snap.estop.latched && snap.estop.circuitOk));
  $('#btnEstop').classList.toggle('latched', snap.estop.latched);

  renderAlarmLine(snap);

  app.synoptic.update(snap, app.selected);
  const byId = new Map(snap.sections.map((x) => [x.id, x]));
  for (const [id, card] of app.cards) card.update(byId.get(id), snap);
  for (const [id, panel] of app.stations) panel.update(byId.get(id), snap);
  app.tabs.update(snap);
}

function renderAlarmLine(snap) {
  const line = $('#alarmLine');
  const pending = snap.alarms.items.filter((a) => a.active || !a.acknowledged);
  if (!pending.length) {
    line.hidden = true;
    return;
  }
  const rank = (a) => (a.severity === 'fault' ? 0 : 2) + (a.acknowledged ? 1 : 0);
  const top = [...pending].sort((a, b) => rank(a) - rank(b) || b.time - a.time)[0];
  line.hidden = false;
  setData(line, 'tone', top.severity === 'fault' ? 'fault' : 'warn');
  setData(line, 'ack', String(top.acknowledged));
  setText($('#alarmLineTime'), fmtClock(top.time));
  setText($('#alarmLineText'), top.text);
  setText($('#alarmLineMore'), pending.length > 1 ? `+ ${pending.length - 1} weitere` : top.acknowledged ? 'quittiert' : 'nicht quittiert');
}

function select(id) {
  app.selected = id;
  const target = app.cards.get(id)?.el ?? app.stations.get(id)?.el;
  if (target) {
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  } else {
    app.tabs.highlightSection(id);
    $('#bottom').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  scheduleRender();
}

// ------------------------------------------------------------------ Verbindung

function connect() {
  const source = new EventSource('/api/stream');
  source.onmessage = (e) => {
    try {
      app.snap = JSON.parse(e.data);
    } catch {
      return;
    }
    app.lastMsg = Date.now();
    setOnline(true);
    scheduleRender();
  };
  // EventSource verbindet sich nach Abbruch selbstständig neu.
}

function setOnline(online) {
  if (app.online === online) return;
  app.online = online;
  $('#offline').hidden = online;
  if (!online) stopJog();
}

// ------------------------------------------------------------------ Darstellungsoptionen

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  $('#themeBtn use').setAttribute('href', t === 'light' ? '#i-moon' : '#i-sun');
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // Speicher nicht verfügbar – Einstellung gilt nur für diese Sitzung.
  }
}

function wireChrome() {
  applyTheme(readTheme() ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  $('#fullBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast('Vollbild nicht verfügbar', 'error'));
  });
  $('#alarmLine').addEventListener('click', () => {
    app.tabs.show('alarms');
    $('#bottom').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  const tickClock = () => setText($('#clock'), fmtClock(Date.now()));
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => {
    if (Date.now() - app.lastMsg > 2500) setOnline(false);
  }, 500);
}

// ------------------------------------------------------------------ Start

async function loadConfig() {
  for (;;) {
    try {
      const res = await fetch('/api/config');
      if (res.ok) return await res.json();
    } catch {
      // Server noch nicht erreichbar
    }
    setOnline(false);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function boot() {
  wireChrome();
  const { config, io, typeLabels, driver } = await loadConfig();
  document.title = `${config.name} · ${config.subtitle}`;
  setText($('#rideName'), config.name);
  setText($('#rideSub'), config.subtitle);

  app.synoptic = new Synoptic($('#synoptic'), config, { onSelect: select });
  const elements = $('#elements');
  for (const cfg of config.sections.filter((c) => MOVABLE.has(c.type))) {
    const card = buildElementCard(cfg, typeLabels);
    app.cards.set(cfg.id, card);
    elements.append(card.el);
  }
  const stations = $('#stations');
  for (const cfg of config.sections.filter((c) => c.type === 'station')) {
    const panel = buildStationPanel(cfg, send);
    app.stations.set(cfg.id, panel);
    stations.append(panel.el);
  }
  app.tabs = new BottomTabs($('#bottom'), { config, io, typeLabels, simulation: driver === 'simulation' });

  wireCommands();
  connect();
}

boot();
