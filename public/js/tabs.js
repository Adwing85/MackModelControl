import { boatTag, cmdButton, fmtClock, fmtDuration, h, icon, renderIfChanged, setAttr, setData, setText } from './ui.js';

const TAB_KEY = 'mmc-tab';

const SIM_FAULT_TARGETS = {
  sensor: () => true,
  stuck: () => true,
  jam: (c) => Boolean(c.axes),
  lock: (c) => Boolean(c.lock),
  restraints: (c) => c.type === 'station',
};

function storage(fn) {
  try {
    return fn(window.localStorage);
  } catch {
    return null;
  }
}

function fmtValue(v) {
  if (v === true) return ['true', 'true'];
  if (v === false) return ['false', 'false'];
  if (v === null || v === undefined) return ['null', 'false'];
  if (typeof v === 'number') return [String(Number.isInteger(v) ? v : v.toFixed(2)), v === 0 ? 'false' : 'value'];
  return [String(v), 'value'];
}

/** Register im unteren Bereich: Meldungen, Blöcke & Boote, Ereignisse, E/A-Diagnose, Simulation, Statistik. */
export class BottomTabs {
  constructor(root, { config, io, typeLabels, simulation }) {
    this.root = root;
    this.config = config;
    this.typeLabels = typeLabels;
    this.names = new Map(config.sections.map((c) => [c.id, c.name]));
    this.events = new Map();
    this.highlighted = null;

    const defs = [
      ['alarms', 'Meldungen'],
      ['blocks', 'Blöcke & Boote'],
      ['events', 'Ereignisse'],
      ['io', 'E/A-Diagnose'],
      ...(simulation ? [['sim', 'Simulation']] : []),
      ['stats', 'Statistik'],
    ];
    this.tabs = {};
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const panels = h('div', { class: 'tab-panels' });
    for (const [key, label] of defs) {
      const badge = h('span', { class: 'badge', hidden: true });
      const btn = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => this.show(key) }, label, badge);
      const panel = h('div', { class: 'tab-panel', role: 'tabpanel', hidden: true });
      tabBar.append(btn);
      panels.append(panel);
      this.tabs[key] = { btn, panel, badge };
    }
    root.append(tabBar, panels);

    this.buildAlarms();
    this.buildBlocks();
    this.buildEvents();
    this.buildIo(io);
    if (simulation) this.buildSim();
    this.buildStats();

    const saved = storage((ls) => ls.getItem(TAB_KEY));
    this.show(saved && this.tabs[saved] ? saved : 'alarms');
  }

  show(key) {
    if (!this.tabs[key]) return;
    this.active = key;
    for (const [k, t] of Object.entries(this.tabs)) {
      t.btn.setAttribute('aria-selected', String(k === key));
      t.panel.hidden = k !== key;
    }
    storage((ls) => ls.setItem(TAB_KEY, key));
    if (this.last) this.update(this.last);
  }

  highlightSection(id) {
    this.highlighted = id;
    this.show('blocks');
    const row = this.blockRows.get(id)?.row;
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
    }
  }

  update(snap) {
    this.last = snap;
    this.updateBadges(snap);
    for (const ev of snap.events) this.events.set(ev.seq, ev);
    if (this.events.size > 300) {
      const keys = [...this.events.keys()].sort((a, b) => a - b);
      for (const k of keys.slice(0, keys.length - 300)) this.events.delete(k);
    }
    switch (this.active) {
      case 'alarms':
        return this.updateAlarms(snap);
      case 'blocks':
        return this.updateBlocks(snap);
      case 'events':
        return this.updateEvents(snap);
      case 'io':
        return this.updateIo(snap);
      case 'sim':
        return this.updateSim(snap);
      case 'stats':
        return this.updateStats(snap);
      default:
        return undefined;
    }
  }

  updateBadges(snap) {
    const items = snap.alarms.items;
    const b = this.tabs.alarms.badge;
    b.hidden = items.length === 0;
    setText(b, String(items.length));
    setData(b, 'tone', items.some((a) => a.severity === 'fault') ? 'fault' : items.length ? 'warn' : null);
    if (this.tabs.sim) {
      const n = snap.sim ? Object.values(snap.sim.faults).reduce((sum, list) => sum + list.length, 0) + (snap.sim.estopPressed ? 1 : 0) : 0;
      this.tabs.sim.badge.hidden = n === 0;
      setText(this.tabs.sim.badge, String(n));
      setData(this.tabs.sim.badge, 'tone', n ? 'warn' : null);
    }
  }

  // ------------------------------------------------------------ Meldungen

  buildAlarms() {
    const p = this.tabs.alarms.panel;
    this.alarmSummary = h('span', { class: 'muted' });
    this.alarmBody = h('tbody');
    this.alarmEmpty = h('div', { class: 'empty', text: 'Keine Meldungen – Anlage in Ordnung.' });
    p.append(
      h('div', { class: 'tab-toolbar' }, this.alarmSummary, h('span', { class: 'spacer' }), cmdButton([icon('check'), 'Alle quittieren'], 'reset', {}, 'reset', { cls: 'btn btn-sm btn-lamp btn-reset' })),
      h(
        'div',
        { class: 'table-wrap' },
        h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Zeit', 'Klasse', 'Element', 'Meldung', 'Zustand'].map((t) => h('th', { text: t })))), this.alarmBody),
      ),
      this.alarmEmpty,
    );
  }

  updateAlarms(snap) {
    const { items, version } = snap.alarms;
    const active = items.filter((a) => a.active).length;
    setText(this.alarmSummary, items.length ? `${items.length} Meldung${items.length === 1 ? '' : 'en'}, davon ${active} anstehend` : 'Keine Meldungen');
    this.alarmEmpty.hidden = items.length > 0;
    renderIfChanged(this.alarmBody, version, () =>
      items.map((a) =>
        h(
          'tr',
          { 'data-tone': a.severity, 'data-active': String(a.active) },
          h('td', { class: 'mono', text: fmtClock(a.time) }),
          h('td', {}, h('span', { class: 'chip', 'data-tone': a.severity, text: a.severity === 'fault' ? 'Störung' : 'Warnung' })),
          h('td', { text: a.section ? this.names.get(a.section) ?? a.section : 'Anlage' }),
          h('td', { text: a.count > 1 ? `${a.text} (${a.count}×)` : a.text }),
          h('td', { class: 'muted', text: `${a.active ? 'steht an' : 'gegangen'} · ${a.acknowledged ? 'quittiert' : 'nicht quittiert'}` }),
        ),
      ),
    );
  }

  // ------------------------------------------------------------ Blöcke & Boote

  buildBlocks() {
    const p = this.tabs.blocks.panel;
    this.blockRows = new Map();
    const body = h('tbody');
    for (const c of this.config.sections) {
      const cells = {
        occ: h('td'),
        sensor: h('td'),
        brake: h('td'),
        drive: h('td'),
      };
      const actions = h(
        'td',
        {},
        h(
          'div',
          { class: 'actions' },
          cmdButton('Weiterfahren', 'manual.advance', { section: c.id }, `sections.${c.id}.advance`, { cls: 'btn btn-xs manual-only' }),
          cmdButton('Eintragen', 'tracking.add', { section: c.id }, `sections.${c.id}.trackAdd`, {
            cls: 'btn btn-xs',
            confirm: `Ein Boot in „${c.name}“ in die Fahrzeugverfolgung eintragen? Nur ausführen, wenn sich dort tatsächlich ein Boot befindet.`,
          }),
          cmdButton('Austragen', 'tracking.remove', { section: c.id }, `sections.${c.id}.trackRemove`, {
            cls: 'btn btn-xs',
            confirm: `Das Boot in „${c.name}“ aus der Fahrzeugverfolgung austragen? Nur ausführen, wenn der Abschnitt tatsächlich leer ist.`,
            danger: true,
          }),
        ),
      );
      const row = h(
        'tr',
        { 'data-section': c.id },
        h('td', {}, h('strong', { text: c.short }), ' ', c.name),
        h('td', { class: 'muted', text: this.typeLabels[c.type] ?? c.type }),
        cells.occ,
        cells.sensor,
        cells.brake,
        cells.drive,
        actions,
      );
      body.append(row);
      this.blockRows.set(c.id, { row, ...cells });
    }
    this.boatBody = h('tbody');
    p.append(
      h(
        'div',
        { class: 'tab-toolbar' },
        h('span', { class: 'muted', text: 'Belegung der Blöcke laut Fahrzeugverfolgung und Sensoren.' }),
        h('span', { class: 'spacer' }),
        cmdButton([icon('rescan'), 'Verfolgung neu einlesen'], 'tracking.rescan', {}, 'rescan', {
          confirm: 'Die Fahrzeugverfolgung wird aus den Haltesensoren neu aufgebaut. Laufende Fahrten werden verworfen. Fortfahren?',
          danger: true,
        }),
      ),
      h(
        'div',
        { class: 'split' },
        h(
          'div',
          { class: 'table-wrap' },
          h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Abschnitt', 'Typ', 'Belegung', 'Haltesensor', 'Bremse', 'Antrieb', ''].map((t) => h('th', { text: t })))), body),
        ),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Boot', 'Position', 'Fahrten'].map((t) => h('th', { text: t })))), this.boatBody)),
      ),
    );
  }

  updateBlocks(snap) {
    const boatName = (id) => snap.boats.find((b) => b.id === id)?.name ?? `Boot ${id}`;
    for (const st of snap.sections) {
      const r = this.blockRows.get(st.id);
      if (!r) continue;
      r.row.classList.toggle('sel', this.highlighted === st.id);
      setData(r.row, 'tone', st.alarm);
      const occKey = `${st.boat}|${st.incoming}|${st.outgoing}|${st.alarm}`;
      renderIfChanged(r.occ, occKey, () => {
        if (st.boat) return [boatTag(st.boat), ' ', st.outgoing ? `${boatName(st.boat)} fährt aus` : boatName(st.boat)];
        if (st.incoming) return h('span', { class: 'chip', 'data-tone': 'move' }, `reserviert · ${boatName(st.incoming)}`);
        return h('span', { class: 'muted', text: 'frei' });
      });
      renderIfChanged(r.sensor, String(st.present), () => [h('span', { class: st.present ? 'led on' : 'led' }), st.present ? ' belegt' : ' frei']);
      renderIfChanged(r.brake, String(st.brakeOpen), () => [h('span', { class: st.brakeOpen ? 'led on' : 'led', 'data-tone': 'move' }), st.brakeOpen ? ' gelüftet' : ' geschlossen']);
      renderIfChanged(r.drive, String(st.drive), () => [h('span', { class: st.drive ? 'led on' : 'led', 'data-tone': 'move' }), st.drive ? ' ein' : ' aus']);
    }
    for (const btn of this.tabs.blocks.panel.querySelectorAll('.manual-only')) btn.hidden = snap.mode !== 'manual';

    const key = snap.boats.map((b) => `${b.id}:${b.section}:${b.transfer?.to}:${b.rides}`).join('|');
    renderIfChanged(this.boatBody, key, () =>
      snap.boats.map((b) =>
        h(
          'tr',
          {},
          h('td', {}, boatTag(b.id), ' ', b.name),
          h('td', { text: b.transfer ? `${this.names.get(b.transfer.from)} → ${this.names.get(b.transfer.to)}` : b.section ? this.names.get(b.section) : 'nicht auf der Strecke' }),
          h('td', { class: 'num', text: String(b.rides) }),
        ),
      ),
    );
  }

  // ------------------------------------------------------------ Ereignisse

  buildEvents() {
    this.eventList = h('ul', { class: 'events' });
    this.tabs.events.panel.append(this.eventList);
  }

  updateEvents() {
    const list = [...this.events.values()].sort((a, b) => b.seq - a.seq);
    renderIfChanged(this.eventList, list[0]?.seq ?? 0, () =>
      list.map((ev) =>
        h('li', {}, h('span', { class: 'ev-time mono', text: fmtClock(ev.time) }), h('span', { class: 'ev-dot', 'data-level': ev.level }), h('span', { text: ev.text })),
      ),
    );
  }

  // ------------------------------------------------------------ E/A-Diagnose

  buildIo(io) {
    this.ioCells = { inputs: new Map(), outputs: new Map() };
    const table = (rows, kind) => {
      const body = h('tbody');
      for (const r of rows) {
        const val = h('span', { class: 'io-val', text: '–' });
        const tr = h('tr', {}, h('td', {}, h('div', { class: 'io-key', text: r.key }), h('div', { class: 'io-desc', text: r.desc })), h('td', { class: 'num' }, val));
        body.append(tr);
        this.ioCells[kind].set(r.key, { tr, val, last: undefined });
      }
      return h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Signal' }), h('th', { class: 'num', text: 'Wert' }))), body);
    };
    this.ioInfo = h('span', { class: 'muted' });
    this.tabs.io.panel.append(
      h('div', { class: 'tab-toolbar' }, this.ioInfo),
      h(
        'div',
        { class: 'io-grid' },
        h('div', {}, h('h4', { text: 'Eingänge · Hardware → Steuerung' }), table(io.inputs, 'inputs')),
        h('div', {}, h('h4', { text: 'Ausgänge · Steuerung → Hardware' }), table(io.outputs, 'outputs')),
      ),
    );
  }

  updateIo(snap) {
    const info = snap.io;
    setText(this.ioInfo, `Treiber: ${info.label} · ${snap.ioOk ? 'verbunden' : 'keine Daten'}${info.lastError ? ` · letzter Fehler: ${info.lastError}` : ''}`);
    for (const kind of ['inputs', 'outputs']) {
      for (const [key, cell] of this.ioCells[kind]) {
        const v = info[kind]?.[key];
        if (cell.last === v) continue;
        const [text, tone] = fmtValue(v);
        setText(cell.val, text);
        setData(cell.val, 'kind', tone);
        if (cell.last !== undefined) {
          cell.tr.classList.remove('changed');
          void cell.tr.offsetWidth;
          cell.tr.classList.add('changed');
        }
        cell.last = v;
      }
    }
  }

  // ------------------------------------------------------------ Simulation

  buildSim() {
    const p = this.tabs.sim.panel;
    this.speedBtns = [0.5, 1, 2, 4].map((f) => cmdButton(`${String(f).replace('.', ',')}×`, 'sim.speed', { factor: f }, null, { cls: 'btn btn-sm' }));
    this.estopBtn = cmdButton('Not-Halt-Taster drücken', 'sim.estop', { pressed: true }, null, { cls: 'btn btn-sm btn-danger' });
    this.faultChips = [];
    const faultBlocks = Object.entries(SIM_FAULT_TARGETS).map(([kind, applies]) => {
      const chips = this.config.sections.filter(applies).map((c) => {
        const chip = h('button', { class: 'chip chip-btn', type: 'button', 'data-cmd': 'sim.fault', 'aria-pressed': 'false' }, c.short);
        chip.title = c.name;
        this.faultChips.push({ chip, kind, section: c.id });
        return chip;
      });
      const label = h('h4', { 'data-kind': kind });
      this.faultLabels ??= {};
      this.faultLabels[kind] = label;
      return h('div', { class: 'sim-block' }, label, h('div', { class: 'chips' }, chips));
    });
    this.violationBox = h('div');
    this.simTime = h('span', { class: 'muted' });
    p.append(
      h(
        'div',
        { class: 'tab-toolbar' },
        h('span', { class: 'muted', text: 'Die Simulation ersetzt das Modell. Störungen hier einspielen, um Bedienung und Meldungen zu üben.' }),
        h('span', { class: 'spacer' }),
        cmdButton('Störungen aufheben', 'sim.clearFaults', {}, null, { cls: 'btn btn-sm' }),
        cmdButton([icon('rescan'), 'Simulation zurücksetzen'], 'sim.reset', {}, null, {
          cls: 'btn btn-sm',
          confirm: 'Simulation und Steuerung werden in den Ausgangszustand versetzt (Boote zurück auf Startpositionen, Meldungen gelöscht).',
          danger: true,
        }),
      ),
      h(
        'div',
        { class: 'sim-grid' },
        h('div', { class: 'sim-block' }, h('h4', { text: 'Geschwindigkeit' }), h('div', { class: 'speed-btns' }, this.speedBtns), this.simTime),
        h('div', { class: 'sim-block' }, h('h4', { text: 'Not-Halt-Taster am Modell' }), this.estopBtn),
        ...faultBlocks,
        h('div', { class: 'sim-block' }, h('h4', { text: 'Prüfung der Verriegelungen' }), this.violationBox),
      ),
    );
  }

  updateSim(snap) {
    const sim = snap.sim;
    if (!sim) return;
    this.speedBtns.forEach((btn) => btn.setAttribute('aria-pressed', String(JSON.parse(btn.dataset.params).factor === sim.speed)));
    setText(this.simTime, `Simulierte Zeit: ${fmtDuration(sim.time)}`);
    setText(this.estopBtn, sim.estopPressed ? 'Taster gedrückt – entriegeln' : 'Not-Halt-Taster drücken');
    this.estopBtn.dataset.params = JSON.stringify({ pressed: !sim.estopPressed });
    this.estopBtn.classList.toggle('lit', sim.estopPressed);
    for (const [kind, label] of Object.entries(this.faultLabels)) setText(label, sim.faultLabels[kind] ?? kind);
    for (const { chip, kind, section } of this.faultChips) {
      const on = sim.faults[kind]?.includes(section) ?? false;
      setAttr(chip, 'aria-pressed', String(on));
      chip.dataset.params = JSON.stringify({ kind, section, active: !on });
    }
    const key = sim.violations.map((v) => `${v.time}${v.text}`).join('|');
    renderIfChanged(this.violationBox, key, () =>
      sim.violations.length
        ? sim.violations
            .slice()
            .reverse()
            .map((v) => h('div', { class: 'violation', text: `${fmtDuration(v.time)} · ${v.text}` }))
        : h('div', { class: 'violation-ok', text: '✓ Keine Kollision und keine Fahrt ohne Gleisanschluss festgestellt' }),
    );
  }

  // ------------------------------------------------------------ Statistik

  buildStats() {
    const kpi = (label) => {
      const v = h('div', { class: 'kpi-v mono', text: '–' });
      return { el: h('div', { class: 'kpi' }, v, h('div', { class: 'kpi-k', text: label })), v };
    };
    this.kpis = {
      dispatches: kpi('Abfahrten'),
      laps: kpi('Runden beendet'),
      perHour: kpi('Abfahrten / Stunde'),
      lastInterval: kpi('Letzter Abfahrtstakt'),
      runSeconds: kpi('Fahrbetrieb'),
      uptime: kpi('Steuerung läuft seit'),
    };
    this.statsBoats = h('tbody');
    this.tabs.stats.panel.append(
      h('div', { class: 'kpis' }, Object.values(this.kpis).map((k) => k.el)),
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Boot' }), h('th', { class: 'num', text: 'Fahrten' }))), this.statsBoats),
    );
  }

  updateStats(snap) {
    const st = snap.stats;
    setText(this.kpis.dispatches.v, String(st.dispatches));
    setText(this.kpis.laps.v, String(st.laps));
    setText(this.kpis.perHour.v, st.perHour == null ? '–' : String(st.perHour));
    setText(this.kpis.lastInterval.v, st.lastInterval == null ? '–' : `${String(st.lastInterval).replace('.', ',')} s`);
    setText(this.kpis.runSeconds.v, fmtDuration(st.runSeconds));
    setText(this.kpis.uptime.v, fmtDuration(snap.uptime));
    const key = snap.boats.map((b) => `${b.id}:${b.rides}`).join('|');
    renderIfChanged(this.statsBoats, key, () => snap.boats.map((b) => h('tr', {}, h('td', {}, boatTag(b.id), ' ', b.name), h('td', { class: 'num', text: String(b.rides) }))));
  }
}
