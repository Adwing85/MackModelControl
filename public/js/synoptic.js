import { boatColor, s, setAttr, setData, setText, setTransform } from './ui.js';

/**
 * Draufsicht der Strecke als geschlossener Rundkurs. Die Abschnitte werden in Fahrtrichtung
 * (im Uhrzeigersinn) entlang des Kurses verteilt, der Bahnhof liegt unten mittig vor dem Bediener.
 */

const W = 1000;
const H = 430;
const TYPE_WEIGHT = { station: 1.5, block: 1.25, turntable: 0.85, rotatingLift: 0.95, catchCarLift: 1.35 };
const STOP_FRACTION = 0.64;

const isMovable = (type) => type === 'turntable' || type === 'rotatingLift' || type === 'catchCarLift';

export class Synoptic {
  constructor(svg, config, { onSelect } = {}) {
    this.svg = svg;
    this.config = config;
    this.onSelect = onSelect;
    this.boatEls = new Map();
    this.boatAngles = new Map();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();

    const layer = (name) => s('g', { class: `layer-${name}` }, svg);
    this.layers = {
      water: layer('water'),
      center: layer('center'),
      rails: layer('rails'),
      marks: layer('marks'),
      elements: layer('elements'),
      labels: layer('labels'),
      boats: layer('boats'),
      hits: layer('hits'),
    };

    const x0 = 66;
    const x1 = W - 66;
    const y0 = 62;
    const y1 = H - 62;
    const r = 112;
    const cx = W / 2;
    this.path = s('path', {
      d: `M ${cx} ${y1} L ${x0 + r} ${y1} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} L ${x0} ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} ` +
        `L ${x1 - r} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} L ${x1} ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} Z`,
      fill: 'none',
      stroke: 'none',
    }, svg);
    this.L = this.path.getTotalLength();

    s('path', { d: this.path.getAttribute('d'), class: 'trk-bank' }, this.layers.water);
    s('path', { d: this.path.getAttribute('d'), class: 'trk-water' }, this.layers.water);

    this.layoutSections();
    this.buildCenter();
    for (const sec of this.sections) this.buildSection(sec);
  }

  // ------------------------------------------------------------ Geometrie

  pointAt(len) {
    const l = ((len % this.L) + this.L) % this.L;
    const p = this.path.getPointAtLength(l);
    const a = this.path.getPointAtLength((l - 1.5 + this.L) % this.L);
    const b = this.path.getPointAtLength((l + 1.5) % this.L);
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const nx = -(b.y - a.y);
    const ny = b.x - a.x;
    const n = Math.hypot(nx, ny) || 1;
    // Innen liegt bei Fahrt im Uhrzeigersinn rechts der Fahrtrichtung.
    return { x: p.x, y: p.y, angle, inX: nx / n, inY: ny / n };
  }

  subPath(a, b, step = 5) {
    const pts = [];
    for (let l = a; l < b; l += step) pts.push(this.pointAt(l));
    pts.push(this.pointAt(b));
    return `M ${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')}`;
  }

  layoutSections() {
    const cfgs = this.config.sections;
    const weights = cfgs.map((c) => Number(c.display?.weight) || TYPE_WEIGHT[c.type] || 1);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const stationIndex = Math.max(0, cfgs.findIndex((c) => c.type === 'station'));
    let pos = -((weights[stationIndex] / total) * this.L) / 2;
    const order = cfgs.map((_, k) => (stationIndex + k) % cfgs.length);
    const spans = new Array(cfgs.length);
    for (const i of order) {
      const len = (weights[i] / total) * this.L;
      spans[i] = { a: pos, b: pos + len, len };
      pos += len;
    }
    // Ausrichtung der Boote: Drehelemente drehen das Boot mit (z. B. Rückwärtsfahrt nach 180°).
    let heading = Number(this.config.display?.stationHeading) || 0;
    const headingBefore = {};
    for (const i of order) {
      const c = cfgs[i];
      headingBefore[c.id] = heading;
      if (isMovable(c.type)) {
        for (const [name, axis] of Object.entries(c.axes)) {
          if (axis.display !== 'rotary' || !c.entry[name] || !c.exit[name]) continue;
          const delta = axis.positions[c.exit[name]] - axis.positions[c.entry[name]];
          // Nur Wendungen um 180° ändern die Fahrtrichtung des Boots; andere Winkel sind Weichenstellungen.
          if (Math.abs(delta % 180) < 1e-6) heading += delta;
        }
      }
    }
    this.sections = cfgs.map((cfg, i) => ({ cfg, id: cfg.id, type: cfg.type, ...spans[i], mid: spans[i].a + spans[i].len / 2, headingBefore: headingBefore[cfg.id] }));
    this.byId = new Map(this.sections.map((x) => [x.id, x]));
  }

  // ------------------------------------------------------------ Aufbau

  buildCenter() {
    const g = this.layers.center;
    const title = s('text', { x: W / 2, y: H / 2 - 40, 'text-anchor': 'middle', class: 'syn-center-title' }, g);
    title.textContent = (this.config.name || '').toUpperCase();
    const kpis = [
      ['boats', 'Boote auf Strecke'],
      ['dispatches', 'Abfahrten'],
      ['perHour', 'Abfahrten / h'],
    ];
    this.kpiEls = {};
    kpis.forEach(([key, label], i) => {
      const x = W / 2 + (i - 1) * 150;
      const v = s('text', { x, y: H / 2 + 14, 'text-anchor': 'middle', class: 'syn-center-kpi' }, g);
      v.textContent = '–';
      const l = s('text', { x, y: H / 2 + 34, 'text-anchor': 'middle', class: 'syn-center-kpi-l' }, g);
      l.textContent = label;
      this.kpiEls[key] = v;
    });
  }

  buildSection(sec) {
    const d = this.subPath(sec.a, sec.b);
    sec.rail = s('path', { d, class: 'trk-rail', 'data-state': 'free' }, this.layers.rails);
    sec.flow = s('path', { d, class: 'trk-flow' }, this.layers.rails);

    // Blocktrennung am Abschnittsanfang
    const p0 = this.pointAt(sec.a);
    s('line', {
      x1: (p0.x - p0.inX * 20).toFixed(1),
      y1: (p0.y - p0.inY * 20).toFixed(1),
      x2: (p0.x + p0.inX * 20).toFixed(1),
      y2: (p0.y + p0.inY * 20).toFixed(1),
      class: 'trk-sep',
    }, this.layers.marks);

    if (sec.type === 'catchCarLift') this.buildCatchCar(sec);
    else if (sec.type === 'turntable' || sec.type === 'rotatingLift') this.buildRotating(sec);
    else {
      // Haltesensor und Bremse außen neben der Halteposition
      const stop = this.pointAt(sec.a + sec.len * STOP_FRACTION + 16);
      sec.sensor = s('circle', { cx: (stop.x - stop.inX * 25).toFixed(1), cy: (stop.y - stop.inY * 25).toFixed(1), r: 5, class: 'syn-sensor' }, this.layers.marks);
      const brake = this.pointAt(sec.a + sec.len * STOP_FRACTION - 8);
      sec.brake = s('rect', { x: -9, y: -3, width: 18, height: 6, rx: 2, class: 'syn-brake' }, this.layers.marks);
      sec.brake.setAttribute('transform', `translate(${(brake.x - brake.inX * 25).toFixed(1)} ${(brake.y - brake.inY * 25).toFixed(1)}) rotate(${brake.angle.toFixed(1)})`);
    }

    // Beschriftung innen
    const m = this.pointAt(sec.mid);
    const off = sec.type === 'turntable' || sec.type === 'rotatingLift' ? 62 : 40;
    const lx = m.x + m.inX * off;
    const ly = m.y + m.inY * off;
    const anchor = m.inX > 0.55 ? 'start' : m.inX < -0.55 ? 'end' : 'middle';
    const dy = m.inY > 0.55 ? 6 : m.inY < -0.55 ? -18 : -6;
    const label = s('text', { x: lx.toFixed(1), y: (ly + dy).toFixed(1), 'text-anchor': anchor }, this.layers.labels);
    const short = s('tspan', { class: 'syn-short' }, label);
    short.textContent = `${sec.cfg.short}  `;
    const name = s('tspan', { class: 'syn-label' }, label);
    name.textContent = sec.cfg.name;
    sec.sub = s('text', { x: lx.toFixed(1), y: (ly + dy + 18).toFixed(1), 'text-anchor': anchor, class: 'syn-sub' }, this.layers.labels);

    const hit = s('path', { d, class: 'trk-hit', role: 'button', tabindex: '0', 'aria-label': sec.cfg.name }, this.layers.hits);
    const select = () => this.onSelect?.(sec.id);
    hit.addEventListener('click', select);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') select();
    });
  }

  buildRotating(sec) {
    const m = this.pointAt(sec.mid);
    const lift = sec.type === 'rotatingLift';
    const g = s('g', { transform: `translate(${m.x.toFixed(1)} ${m.y.toFixed(1)})` }, this.layers.elements);
    sec.elementGroup = g;
    if (lift) sec.disc = s('rect', { x: -40, y: -40, width: 80, height: 80, rx: 14, class: 'el-disc' }, g);
    else sec.disc = s('circle', { r: 36, class: 'el-disc' }, g);
    sec.deck = s('g', { class: 'deck-rot' }, g);
    s('rect', { x: -34, y: -11, width: 68, height: 22, rx: 6, class: 'el-deck' }, sec.deck);
    s('line', { x1: -30, y1: 0, x2: 30, y2: 0, class: 'el-deck-rail' }, sec.deck);
    sec.baseAngle = m.angle;
    const lockPos = { x: m.inX * 30, y: m.inY * 30 };
    if (sec.cfg.lock) sec.lockDot = s('circle', { cx: (-lockPos.x).toFixed(1), cy: (-lockPos.y).toFixed(1), r: 6, class: 'el-lock' }, g);

    if (lift) {
      const hubAxis = Object.entries(sec.cfg.axes).find(([, a]) => a.display !== 'rotary');
      if (hubAxis) {
        sec.hubAxis = hubAxis[0];
        const gx = -m.inX * 58 - 5;
        const gy = -m.inY * 58 - 30;
        s('rect', { x: gx.toFixed(1), y: gy.toFixed(1), width: 10, height: 60, rx: 4, class: 'el-gauge-bg' }, g);
        sec.hubFill = s('rect', { x: (gx + 2).toFixed(1), y: (gy + 58).toFixed(1), width: 6, height: 0, rx: 2, class: 'el-gauge-fill' }, g);
        sec.hubGauge = { top: gy + 2, height: 56 };
      }
    }
    sec.rotAxis = Object.entries(sec.cfg.axes).find(([, a]) => a.display === 'rotary')?.[0] ?? null;
  }

  buildCatchCar(sec) {
    // Liftkette als Pfeilspitzen in Fahrtrichtung
    const g = s('g', {}, this.layers.marks);
    for (let l = sec.a + 22; l < sec.b - 14; l += 22) {
      const p = this.pointAt(l);
      const chev = s('path', { d: 'M -5 -6 L 2 0 L -5 6', class: 'trk-chev' }, g);
      chev.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${p.angle.toFixed(1)})`);
    }
    sec.car = s('rect', { x: -9, y: -9, width: 12, height: 18, rx: 3, class: 'el-car' }, this.layers.elements);
    sec.carAxis = Object.keys(sec.cfg.axes)[0];
  }

  // ------------------------------------------------------------ Aktualisierung

  axisFrac(sec, snap, name) {
    const axis = sec.cfg.axes[name];
    const pos = snap?.axes?.[name]?.pos;
    if (!axis || pos == null) return 0;
    return Math.min(1, Math.max(0, (pos - axis.min) / (axis.max - axis.min)));
  }

  stopLen(sec, snap) {
    if (sec.type === 'catchCarLift') return sec.a + sec.len * (0.1 + 0.8 * this.axisFrac(sec, snap, sec.carAxis));
    if (sec.type === 'turntable' || sec.type === 'rotatingLift') return sec.mid;
    return sec.a + sec.len * STOP_FRACTION;
  }

  elementAngle(sec, snap) {
    if (!sec.rotAxis) return 0;
    const axis = sec.cfg.axes[sec.rotAxis];
    const entry = axis.positions[sec.cfg.entry[sec.rotAxis]] ?? 0;
    return (snap?.axes?.[sec.rotAxis]?.pos ?? entry) - entry;
  }

  update(snap, selectedId) {
    const snapById = new Map(snap.sections.map((x) => [x.id, x]));
    const boatName = new Map(snap.boats.map((b) => [b.id, b.name]));

    for (const sec of this.sections) {
      const st = snapById.get(sec.id);
      if (!st) continue;
      let state = 'free';
      if (st.alarm === 'fault') state = 'fault';
      else if (st.drive) state = 'move';
      else if (st.alarm === 'warn') state = 'warn';
      else if (st.boat) state = 'occ';
      else if (st.incoming) state = 'res';
      setData(sec.rail, 'state', state);
      sec.flow.classList.toggle('on', st.drive);

      let tone = st.alarm ?? (st.drive || st.incoming ? 'move' : null);
      let sub = st.status;
      if (st.type === 'station' && st.phase) sub = stationSub(st, boatName);
      setText(sec.sub, sub);
      setData(sec.sub, 'tone', tone);

      if (sec.sensor) sec.sensor.classList.toggle('on', st.present);
      if (sec.brake) sec.brake.classList.toggle('open', st.brakeOpen);

      if (sec.deck) {
        const moving = Object.values(st.axes ?? {}).some((a) => a.moving);
        sec.elementGroup.classList.toggle('el-moving', moving);
        sec.disc.classList.toggle('fault', st.alarm === 'fault');
        setTransform(sec.deck, `rotate(${(sec.baseAngle + this.elementAngle(sec, st)).toFixed(1)}deg)`);
        if (sec.lockDot) sec.lockDot.classList.toggle('on', Boolean(st.lock?.engaged));
        if (sec.hubFill) {
          const f = this.axisFrac(sec, st, sec.hubAxis);
          const hgt = sec.hubGauge.height * f;
          setAttr(sec.hubFill, 'y', (sec.hubGauge.top + sec.hubGauge.height - hgt).toFixed(1));
          setAttr(sec.hubFill, 'height', hgt.toFixed(1));
        }
      }
      if (sec.car) {
        const p = this.pointAt(this.stopLen(sec, st));
        const moving = Object.values(st.axes ?? {}).some((a) => a.moving);
        sec.car.classList.toggle('el-moving', moving);
        setTransform(sec.car, `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${p.angle.toFixed(1)}deg)`);
      }
      sec.rail.classList.toggle('selected', selectedId === sec.id);
    }

    // Boote
    const seen = new Set();
    for (const boat of snap.boats) {
      let len;
      let heading;
      let paused = false;
      if (boat.transfer) {
        const from = this.byId.get(boat.transfer.from);
        const to = this.byId.get(boat.transfer.to);
        const a = this.stopLen(from, snapById.get(from.id));
        let b = this.stopLen(to, snapById.get(to.id));
        while (b < a) b += this.L;
        len = a + (b - a) * (boat.transfer.progress ?? 0);
        heading = to.headingBefore;
        paused = boat.transfer.paused;
      } else if (boat.section) {
        const sec = this.byId.get(boat.section);
        const st = snapById.get(sec.id);
        len = this.stopLen(sec, st);
        heading = sec.headingBefore + (sec.deck ? this.elementAngle(sec, st) : 0);
      } else continue;
      seen.add(boat.id);
      const p = this.pointAt(len);
      const el = this.boatElement(boat);
      el.root.classList.toggle('paused', paused);
      setTransform(el.root, `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`);
      setTransform(el.hull, `rotate(${this.continuousAngle(boat.id, p.angle + heading).toFixed(1)}deg)`);
    }
    for (const [id, el] of this.boatEls) el.root.style.display = seen.has(id) ? '' : 'none';

    setText(this.kpiEls.boats, String(snap.stats.boatsOnTrack));
    setText(this.kpiEls.dispatches, String(snap.stats.dispatches));
    setText(this.kpiEls.perHour, snap.stats.perHour == null ? '–' : String(snap.stats.perHour));
  }

  continuousAngle(id, angle) {
    const prev = this.boatAngles.get(id);
    let a = angle;
    if (prev !== undefined) {
      while (a - prev > 180) a -= 360;
      while (a - prev < -180) a += 360;
    }
    this.boatAngles.set(id, a);
    return a;
  }

  boatElement(boat) {
    let el = this.boatEls.get(boat.id);
    if (el) return el;
    const root = s('g', { class: 'boat' }, this.layers.boats);
    root.style.setProperty('--boat', boatColor(boat.id));
    const hull = s('path', { class: 'boat-hull', d: 'M -19 -9 L 9 -9 Q 20 -9 23 0 Q 20 9 9 9 L -19 9 Q -22 9 -22 6 L -22 -6 Q -22 -9 -19 -9 Z' }, root);
    const num = s('text', { class: 'boat-num', x: 0, y: 0 }, root);
    num.textContent = String(boat.id);
    const title = s('title', {}, root);
    title.textContent = boat.name;
    el = { root, hull };
    this.boatEls.set(boat.id, el);
    return el;
  }
}

const PHASE_TEXT = {
  leer: 'leer',
  einfahrt: 'Einfahrt',
  oeffnen: 'Bügel öffnen …',
  beladen: 'Ein-/Aussteigen',
  schliessen: 'Bügel schließen …',
  bereit: 'abfahrbereit',
  abfahrt: 'Abfahrt',
};

function stationSub(st, boatName) {
  const boat = st.boat ?? st.incoming;
  const text = PHASE_TEXT[st.phase] ?? st.phase;
  return boat ? `${boatName.get(boat) ?? `Boot ${boat}`} · ${text}` : text;
}
