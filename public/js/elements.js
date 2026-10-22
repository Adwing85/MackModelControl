import { createAxisGauge } from './gauges.js';
import { boatTag, capitalize, cmdButton, fmtNum, h, icon, jogButton, renderIfChanged, setData, setText } from './ui.js';

const JOG_LABELS = { rotary: ['↺', '↻'], vertical: ['▼', '▲'], incline: ['▼', '▲'] };

const fact = (label, dd) => h('div', {}, h('dt', { text: label }), dd);

function ledText(on, text, tone = null) {
  const led = h('span', { class: on ? 'led on' : 'led' });
  if (tone) led.dataset.tone = tone;
  return [led, text];
}

/** Karte für Drehplattform, Drehlift und Catch-Car-Lift. */
export function buildElementCard(cfg, typeLabels) {
  const id = cfg.id;
  const statusChip = h('span', { class: 'chip', text: '–' });
  const axesWrap = h('div', { class: 'axes' });
  const axisViews = Object.entries(cfg.axes).map(([name, axis]) => {
    const gauge = createAxisGauge(axis);
    const value = h('span', { class: 'axis-value mono', text: '–' });
    const at = h('span', { class: 'axis-at', text: '–' });
    axesWrap.append(h('div', { class: 'axis' }, h('span', { class: 'axis-label', text: axis.label }), gauge.el, value, at));
    return { name, axis, gauge, value, at, jogs: [] };
  });

  const boat = h('dd', {}, '–');
  const position = h('dd', {}, '–');
  const lock = cfg.lock ? h('dd', {}) : null;
  const sensor = h('dd', {});
  const drive = h('dd', {});

  const can = `sections.${id}.move`;
  const tools = h(
    'div',
    { class: 'manual-tools' },
    h(
      'div',
      { class: 'tool-row' },
      h('span', { class: 'tool-label', text: 'Anfahren' }),
      cmdButton('→ Einfahrt', 'manual.move', { section: id, position: 'entry' }, can),
      cmdButton('→ Ausfahrt', 'manual.move', { section: id, position: 'exit' }, can),
    ),
    axisViews.map((v) => {
      const labels = JOG_LABELS[v.axis.display] ?? ['−', '+'];
      v.jogs = [jogButton(labels[0], id, v.name, -1, can), jogButton(labels[1], id, v.name, 1, can)];
      return h('div', { class: 'tool-row' }, h('span', { class: 'tool-label', text: `Tippen ${v.axis.label}` }), v.jogs);
    }),
    h('div', { class: 'tool-row' }, cmdButton([icon('forward'), 'Boot weiterfahren'], 'manual.advance', { section: id }, `sections.${id}.advance`)),
  );

  const card = h(
    'article',
    { class: 'card element', 'data-section': id },
    h('header', { class: 'card-head' }, h('h3', { text: cfg.name }), h('span', { class: 'type', text: cfg.name === typeLabels[cfg.type] ? cfg.short : typeLabels[cfg.type] }), statusChip),
    h(
      'div',
      { class: 'element-body' },
      axesWrap,
      h('dl', { class: 'facts' }, fact('Boot', boat), fact('Stellung', position), lock && fact('Verriegelung', lock), fact('Haltesensor', sensor), fact('Antrieb', drive)),
    ),
    tools,
  );

  return {
    id,
    el: card,
    update(st, snap) {
      const moving = Object.values(st.axes).some((a) => a.moving);
      setData(card, 'alarm', st.alarm);
      setText(statusChip, st.status);
      setData(statusChip, 'tone', st.alarm ?? (moving || st.drive ? 'move' : st.boat ? null : st.position === 'entry' ? 'ok' : null));

      for (const v of axisViews) {
        const a = st.axes[v.name];
        v.gauge.update(a);
        setText(v.value, `${fmtNum(a.pos, v.axis.unit === '°' ? 1 : 0)} ${v.axis.unit}`);
        setText(v.at, a.jog ? 'Tippbetrieb' : a.moving ? `→ ${capitalize(a.target ?? '')}` : a.at ? capitalize(a.at) : 'Zwischenstellung');
        setData(v.at, 'tone', a.moving || a.jog ? 'move' : a.at ? 'ok' : null);
        v.jogs[0].classList.toggle('active', a.jog === -1);
        v.jogs[1].classList.toggle('active', a.jog === 1);
      }

      const boatName = (bid) => snap.boats.find((b) => b.id === bid)?.name ?? `Boot ${bid}`;
      const boatKey = `${st.boat}|${st.incoming}|${st.outgoing}`;
      renderIfChanged(boat, boatKey, () => {
        if (st.boat) return [boatTag(st.boat), boatName(st.boat), st.outgoing ? ' →' : ''];
        if (st.incoming) return ['→ ', boatTag(st.incoming), boatName(st.incoming)];
        return '–';
      });
      setText(position, st.position === 'entry' ? 'Einfahrt' : st.position === 'exit' ? 'Ausfahrt' : 'Zwischenstellung');
      if (lock) {
        const l = st.lock;
        const text = l.engaged ? (l.cmd ? 'eingerastet' : 'löst …') : l.cmd ? 'rastet ein …' : 'gelöst';
        renderIfChanged(lock, text, () => [icon(l.engaged ? 'lock' : 'unlock'), text]);
      }
      renderIfChanged(sensor, String(st.present), () => ledText(st.present, st.present ? 'belegt' : 'frei'));
      renderIfChanged(drive, String(st.drive), () => ledText(st.drive, st.drive ? 'ein' : 'aus', 'move'));
    },
  };
}
