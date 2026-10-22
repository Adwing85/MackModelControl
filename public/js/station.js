import { boatTag, cmdButton, h, icon, renderIfChanged, setAttr, setData, setText } from './ui.js';

const PHASES = [
  ['leer', 'Leer'],
  ['einfahrt', 'Einfahrt'],
  ['oeffnen', 'Öffnen'],
  ['beladen', 'Beladen'],
  ['schliessen', 'Schließen'],
  ['bereit', 'Bereit'],
  ['abfahrt', 'Abfahrt'],
];
const PHASE_LABEL = Object.fromEntries(PHASES);

const tile = (label, value) => h('div', { class: 'tile' }, h('span', { class: 'tile-k', text: label }), value);

/** Bahnhofspult: Ablaufanzeige, Bügel, Gates, Abfertigung, Auto-Abfertigung. */
export function buildStationPanel(cfg, send) {
  const id = cfg.id;
  const can = (key) => `stations.${id}.${key}`;
  const phaseChip = h('span', { class: 'chip', text: '–' });
  const phaseItems = PHASES.map(([key, label]) => h('li', { 'data-phase': key, text: label, title: label }));

  const boatV = h('span', { class: 'tile-v', text: '–' });
  const restraintsV = h('span', { class: 'tile-v', text: '–' });
  const gatesV = h('span', { class: 'tile-v', text: '–' });
  const restraintsTile = tile('Bügel', restraintsV);
  const gatesTile = tile('Gates', gatesV);

  const dwellText = h('span', { text: 'Verweilzeit' });
  const dwellValue = h('span', { class: 'mono', text: '–' });
  const dwellBar = h('span');

  const dispatch = cmdButton([icon('play'), 'Abfahrt'], 'station.dispatch', { station: id }, can('dispatch'), { cls: 'btn btn-lamp btn-dispatch' });
  const dispatchHint = h('p', { class: 'dispatch-hint' });

  const autoInput = h('input', { type: 'checkbox', 'aria-label': 'Auto-Abfertigung' });
  autoInput.addEventListener('change', () => send('station.settings', { autoDispatch: autoInput.checked }));
  const dwellOut = h('output', { class: 'mono', text: '–' });
  let dwell = cfg.dwellTime ?? 10;
  const step = (delta) => send('station.settings', { dwellTime: Math.min(600, Math.max(2, dwell + delta)) });

  const el = h(
    'section',
    { class: 'panel station-panel', 'data-section': id, 'aria-label': cfg.name },
    h('header', { class: 'panel-head' }, h('h2', { text: cfg.name }), phaseChip),
    h(
      'div',
      { class: 'station-body' },
      h('ol', { class: 'phases', 'aria-label': 'Ablauf' }, phaseItems),
      h('div', { class: 'tiles' }, tile('Boot', boatV), restraintsTile, gatesTile),
      h('div', { class: 'dwell' }, h('div', { class: 'dwell-row' }, dwellText, dwellValue), h('div', { class: 'bar' }, dwellBar)),
      h(
        'div',
        { class: 'btn-pair' },
        cmdButton([icon('unlock'), 'Bügel öffnen'], 'station.restraints', { station: id, open: true }, can('restraintsOpen')),
        cmdButton([icon('lock'), 'Bügel schließen'], 'station.restraints', { station: id, open: false }, can('restraintsClose')),
      ),
      h(
        'div',
        { class: 'btn-pair' },
        cmdButton('Gates öffnen', 'station.gates', { station: id, open: true }, can('gatesOpen')),
        cmdButton('Gates schließen', 'station.gates', { station: id, open: false }, can('gatesClose')),
      ),
      dispatch,
      dispatchHint,
      h(
        'div',
        { class: 'settings' },
        h(
          'label',
          { class: 'setting' },
          h('span', {}, 'Auto-Abfertigung', h('small', { text: 'Messebetrieb: Bügel schließen und abfahren nach Verweilzeit' })),
          h('span', { class: 'switch' }, autoInput, h('span')),
        ),
        h(
          'div',
          { class: 'setting' },
          h('span', {}, 'Verweilzeit', h('small', { text: 'Zeit zum Ein- und Aussteigen' })),
          h(
            'span',
            { class: 'stepper' },
            h('button', { class: 'btn btn-xs', type: 'button', 'aria-label': 'Verweilzeit verringern', onclick: () => step(-1) }, '−'),
            dwellOut,
            h('button', { class: 'btn btn-xs', type: 'button', 'aria-label': 'Verweilzeit erhöhen', onclick: () => step(1) }, '+'),
          ),
        ),
      ),
    ),
  );

  return {
    id,
    el,
    update(st, snap) {
      const phaseIndex = PHASES.findIndex(([key]) => key === st.phase);
      phaseItems.forEach((li, i) => {
        li.classList.toggle('current', i === phaseIndex);
        li.classList.toggle('done', st.boat !== null && i < phaseIndex);
      });
      setText(phaseChip, PHASE_LABEL[st.phase] ?? st.phase);
      setData(phaseChip, 'tone', st.alarm ?? (st.phase === 'bereit' ? 'ok' : st.phase === 'abfahrt' || st.phase === 'einfahrt' ? 'move' : null));

      const boatId = st.boat ?? st.incoming;
      renderIfChanged(boatV, String(boatId), () => (boatId ? [boatTag(boatId), snap.boats.find((b) => b.id === boatId)?.name ?? ''] : '–'));

      const r = st.restraints;
      const rText = r.locked ? 'verriegelt' : 'offen';
      const rPending = r.open === r.locked;
      // Während des Schaltens pulsiert die Kachel; der Text bleibt gleich breit.
      renderIfChanged(restraintsV, rText, () => [icon(r.locked ? 'lock' : 'unlock'), rText]);
      setData(restraintsTile, 'pending', rPending || null);
      setData(restraintsTile, 'tone', st.boat && !r.locked ? 'warn' : r.locked && st.boat ? 'ok' : null);

      const g = st.gates;
      const gText = g.closed ? 'geschlossen' : 'offen';
      const gPending = g.open === g.closed;
      setText(gatesV, gText);
      setData(gatesTile, 'pending', gPending || null);
      setData(gatesTile, 'tone', g.closed ? null : 'warn');

      dwell = snap.settings.dwellTime;
      setText(dwellOut, `${dwell} s`);
      if (autoInput.checked !== snap.settings.autoDispatch) autoInput.checked = snap.settings.autoDispatch;
      if (st.dwellRemaining !== null) {
        setText(dwellText, snap.settings.autoDispatch ? 'Abfertigung in' : 'Verweilzeit');
        setText(dwellValue, `${Math.ceil(st.dwellRemaining)} s`);
        dwellBar.style.width = `${(100 * (1 - st.dwellRemaining / dwell)).toFixed(1)}%`;
      } else {
        setText(dwellText, 'Verweilzeit');
        setText(dwellValue, st.phase === 'bereit' ? 'abgelaufen' : '–');
        dwellBar.style.width = st.phase === 'bereit' || st.phase === 'abfahrt' ? '100%' : '0%';
      }

      const reason = snap.can.stations[id]?.dispatch ?? null;
      dispatch.classList.toggle('blink', reason === null);
      dispatch.classList.toggle('lit', st.phase === 'abfahrt');
      const autoNote = snap.settings.autoDispatch && snap.runState === 'running' && snap.mode === 'auto' ? 'Auto-Abfertigung aktiv' : '';
      setText(dispatchHint, reason === null ? 'Abfahrt frei' : autoNote || reason);
      setAttr(dispatchHint, 'title', reason);
    },
  };
}
