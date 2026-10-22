import { capitalize, s, setAttr, setTransform } from './ui.js';

/** Zeigerinstrument je Achse: Drehung (rotary), Hub (vertical) oder Schräglift (incline). */
export function createAxisGauge(axis) {
  if (axis.display === 'rotary') return rotaryGauge(axis);
  if (axis.display === 'incline') return inclineGauge(axis);
  return verticalGauge(axis);
}

const frac = (axis, v) => Math.min(1, Math.max(0, (v - axis.min) / (axis.max - axis.min)));

function rotaryGauge(axis) {
  const svg = s('svg', { class: 'gauge gauge-rotary', viewBox: '-92 -86 184 172', 'aria-hidden': 'true' });
  s('circle', { r: 54, class: 'g-ring' }, svg);
  for (let a = 0; a < 360; a += 15) {
    const inner = a % 45 === 0 ? 46 : 50;
    const t = s('line', { x1: 0, y1: -inner, x2: 0, y2: -54, class: 'g-tick' }, svg);
    t.setAttribute('transform', `rotate(${a})`);
  }
  const marks = {};
  for (const [name, value] of Object.entries(axis.positions)) {
    const g = s('g', { class: 'g-mark' }, svg);
    s('path', { d: 'M 0 -56 L -5 -65 L 5 -65 Z', transform: `rotate(${value})` }, g);
    const rad = (value * Math.PI) / 180;
    const x = Math.sin(rad) * 70;
    const y = -Math.cos(rad) * 68;
    const anchor = Math.sin(rad) > 0.3 ? 'start' : Math.sin(rad) < -0.3 ? 'end' : 'middle';
    const label = s('text', { x: x.toFixed(1), y: (y + (y > 0 ? 12 : -2)).toFixed(1), 'text-anchor': anchor }, g);
    label.textContent = capitalize(name);
    marks[name] = g;
  }
  const target = s('line', { x1: 0, y1: 0, x2: 0, y2: -52, class: 'g-target g-anim' }, svg);
  const deck = s('g', { class: 'g-anim' }, svg);
  s('rect', { x: -10, y: -44, width: 20, height: 88, rx: 6, class: 'g-platform' }, deck);
  s('line', { x1: -4, y1: -40, x2: -4, y2: 40, class: 'g-platform-rail' }, deck);
  s('line', { x1: 4, y1: -40, x2: 4, y2: 40, class: 'g-platform-rail' }, deck);
  s('path', { d: 'M 0 -38 L -6 -28 L 6 -28 Z', class: 'g-target-mark' }, deck);
  s('circle', { r: 6, class: 'g-hub' }, svg);

  return {
    el: svg,
    update({ pos, at, target: tgt }) {
      setTransform(deck, `rotate(${pos ?? 0}deg)`);
      for (const [name, g] of Object.entries(marks)) g.classList.toggle('at', at === name);
      const showTarget = tgt && tgt !== at && axis.positions[tgt] !== undefined;
      setAttr(target, 'visibility', showTarget ? 'visible' : 'hidden');
      if (showTarget) setTransform(target, `rotate(${axis.positions[tgt]}deg)`);
    },
  };
}

function verticalGauge(axis) {
  const svg = s('svg', { class: 'gauge gauge-vertical', viewBox: '0 0 92 112', 'aria-hidden': 'true' });
  const top = 10;
  const bottom = 102;
  const yOf = (v) => bottom - frac(axis, v) * (bottom - top);
  s('rect', { x: 20, y: top - 4, width: 14, height: bottom - top + 8, rx: 4, class: 'g-rail' }, svg);
  const fill = s('rect', { x: 22, y: bottom, width: 10, height: 0, rx: 3, class: 'g-fill' }, svg);
  const marks = {};
  for (const [name, value] of Object.entries(axis.positions)) {
    const y = yOf(value);
    s('line', { x1: 38, x2: 46, y1: y, y2: y, class: 'g-tick' }, svg);
    const label = s('text', { x: 49, y: y + 4, class: 'g-mark-label' }, svg);
    label.textContent = capitalize(name);
    marks[name] = label;
  }
  const targetMark = s('path', { d: 'M 6 -5 L 14 0 L 6 5 Z', class: 'g-target-mark g-anim' }, svg);
  const carriage = s('rect', { x: 12, y: -5, width: 30, height: 10, rx: 3, class: 'g-carriage g-anim' }, svg);

  return {
    el: svg,
    update({ pos, at, target }) {
      const y = yOf(pos ?? axis.min);
      setTransform(carriage, `translateY(${y.toFixed(1)}px)`);
      setAttr(fill, 'y', y.toFixed(1));
      setAttr(fill, 'height', Math.max(0, bottom - y).toFixed(1));
      for (const [name, label] of Object.entries(marks)) label.classList.toggle('at', at === name);
      const show = target && target !== at && axis.positions[target] !== undefined;
      setAttr(targetMark, 'visibility', show ? 'visible' : 'hidden');
      if (show) setTransform(targetMark, `translateY(${yOf(axis.positions[target]).toFixed(1)}px)`);
    },
  };
}

function inclineGauge(axis) {
  const svg = s('svg', { class: 'gauge gauge-incline', viewBox: '0 0 150 112', 'aria-hidden': 'true' });
  const a = { x: 16, y: 96 };
  const b = { x: 128, y: 22 };
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const at = (f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  s('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'g-track' }, svg);
  s('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'g-chain' }, svg);
  const marks = {};
  for (const [name, value] of Object.entries(axis.positions)) {
    const p = at(frac(axis, value));
    const lower = frac(axis, value) < 0.5;
    const label = s('text', { x: p.x + (lower ? 2 : -4), y: p.y + (lower ? 16 : -10), 'text-anchor': lower ? 'start' : 'end', class: 'g-mark-label' }, svg);
    label.textContent = capitalize(name);
    marks[name] = label;
  }
  const car = s('g', { class: 'g-anim' }, svg);
  s('rect', { x: -12, y: -13, width: 24, height: 10, rx: 3, class: 'g-car', transform: `rotate(${angle.toFixed(1)})` }, car);

  return {
    el: svg,
    update({ pos, at: atName }) {
      const p = at(frac(axis, pos ?? axis.min));
      setTransform(car, `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`);
      for (const [name, label] of Object.entries(marks)) label.classList.toggle('at', atName === name);
    },
  };
}
