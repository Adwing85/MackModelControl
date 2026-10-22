import { MOVABLE_TYPES } from '../config.js';

/**
 * Physikalische Simulation des Modells. Bildet dieselben E/A-Signale ab wie die reale Hardware,
 * damit die Steuerung ohne Modell getestet und vorgeführt werden kann.
 *
 * Ein Boot steht entweder in der Halteposition eines Abschnitts (to === null) oder fährt
 * in den nächsten Abschnitt (to gesetzt, p = Fortschritt 0…1).
 */

const LEAVE = 0.35; // Fortschritt, ab dem der Haltesensor des Startabschnitts frei wird
const LOCK_TIME = 0.35;
const RESTRAINT_TIME = 1.2;
const GATE_TIME = 0.8;
const JOG_FACTOR = 0.4;

export const SIM_FAULTS = {
  sensor: 'Haltesensor defekt',
  stuck: 'Boot klemmt bei Einfahrt',
  jam: 'Achse blockiert',
  lock: 'Verriegelung klemmt',
  restraints: 'Bügel verriegeln nicht',
};

export class SimulationIo {
  constructor(config) {
    this.kind = 'simulation';
    this.config = config;
    this.sections = config.sections;
    this.byId = new Map(this.sections.map((s) => [s.id, s]));
    this.indexOf = new Map(this.sections.map((s, i) => [s.id, i]));
    this.speed = 1;
    this.reset();
  }

  reset() {
    this.outputs = {};
    this.estopPressed = false;
    this.faults = Object.fromEntries(Object.keys(SIM_FAULTS).map((k) => [k, new Set()]));
    this.violations = [];
    this.time = 0;
    this.boats = this.config.simulation.initialBoats.map((at, i) => ({ id: i + 1, at, to: null, p: 0, settled: true }));
    this.axes = new Map();
    this.locks = new Map();
    this.stations = new Map();
    for (const s of this.sections) {
      if (MOVABLE_TYPES.has(s.type)) {
        for (const [name, a] of Object.entries(s.axes)) {
          const startName = s.entry[name] ?? Object.keys(a.positions)[0];
          this.axes.set(`${s.id}.${name}`, { section: s, name, cfg: a, pos: a.positions[startName], moving: false });
        }
        if (s.lock) this.locks.set(s.id, { engaged: true, timer: 0 });
      }
      if (s.type === 'station') this.stations.set(s.id, { locked: true, closed: true, rTimer: 0, gTimer: 0 });
    }
  }

  // ------------------------------------------------------------ E/A-Schnittstelle

  start() {}
  stop() {}

  write(outputs) {
    this.outputs = { ...outputs };
  }

  read() {
    const inputs = { 'io.ok': true, 'safety.estopOk': !this.estopPressed };
    for (const s of this.sections) {
      let present = this.boats.some((b) => b.at === s.id && (b.to === null || b.p < LEAVE));
      if (this.faults.sensor.has(s.id)) present = false;
      inputs[`${s.id}.present`] = present;
    }
    for (const [key, ax] of this.axes) {
      inputs[`${key}.pos`] = Number(ax.pos.toFixed(2));
      inputs[`${key}.at`] = this.axisAt(ax);
    }
    for (const [id, lock] of this.locks) inputs[`${id}.lock.engaged`] = lock.engaged;
    for (const [id, st] of this.stations) {
      inputs[`${id}.restraints.locked`] = st.locked;
      inputs[`${id}.gates.closed`] = st.closed;
    }
    return inputs;
  }

  info() {
    return { kind: this.kind, connected: true, label: 'Simulation' };
  }

  update(dtReal) {
    const dt = Math.max(0, dtReal) * this.speed;
    if (!dt) return;
    this.time += dt;
    this.updateLocks(dt);
    this.updateAxes(dt);
    this.updateStations(dt);
    this.updateBoats(dt);
  }

  // ------------------------------------------------------------ Bedienung der Simulation

  setSpeed(factor) {
    const f = Number(factor);
    if (!(f >= 0.25 && f <= 10)) return { ok: false, message: 'Faktor muss zwischen 0,25 und 10 liegen' };
    this.speed = f;
    return { ok: true };
  }

  setEstop(pressed) {
    this.estopPressed = Boolean(pressed);
    return { ok: true };
  }

  setFault(kind, sectionId, active) {
    if (!this.faults[kind]) return { ok: false, message: `Unbekannte Störung „${kind}“` };
    const s = this.byId.get(sectionId);
    if (!s) return { ok: false, message: `Unbekannter Abschnitt „${sectionId}“` };
    if ((kind === 'jam' || kind === 'lock') && !MOVABLE_TYPES.has(s.type)) return { ok: false, message: 'Nur für bewegliche Elemente' };
    if (kind === 'lock' && !s.lock) return { ok: false, message: 'Element hat keine Verriegelung' };
    if (kind === 'restraints' && s.type !== 'station') return { ok: false, message: 'Nur für Bahnhöfe' };
    if (active) this.faults[kind].add(sectionId);
    else this.faults[kind].delete(sectionId);
    return { ok: true };
  }

  clearFaults() {
    for (const set of Object.values(this.faults)) set.clear();
  }

  snapshot() {
    return {
      speed: this.speed,
      estopPressed: this.estopPressed,
      time: Number(this.time.toFixed(1)),
      faults: Object.fromEntries(Object.entries(this.faults).map(([k, set]) => [k, [...set]])),
      faultLabels: SIM_FAULTS,
      violations: this.violations.slice(-10),
      boats: this.boats.map((b) => ({ ...b, p: Number(b.p.toFixed(3)) })),
    };
  }

  // ------------------------------------------------------------ Physik

  out(key) {
    return this.outputs[key];
  }

  axisAt(ax) {
    for (const [name, value] of Object.entries(ax.cfg.positions)) if (Math.abs(ax.pos - value) <= ax.cfg.tolerance) return name;
    return null;
  }

  sectionAxes(sectionId) {
    return [...this.axes.values()].filter((ax) => ax.section.id === sectionId);
  }

  /** Steht das Element in der Achsstellung für Ein- bzw. Ausfahrt (Gleisanschluss vorhanden)? */
  connected(s, which) {
    const conf = s[which];
    for (const ax of this.sectionAxes(s.id)) {
      if (conf[ax.name] !== undefined && this.axisAt(ax) !== conf[ax.name]) return false;
      if (ax.moving) return false;
    }
    return !s.lock || this.locks.get(s.id).engaged;
  }

  updateLocks(dt) {
    for (const [id, lock] of this.locks) {
      const cmd = this.out(`${id}.lock`) === true;
      if (cmd === lock.engaged) {
        lock.timer = 0;
        continue;
      }
      // Der Verriegelungsbolzen rastet nur in einer definierten Position ein.
      const aligned = this.sectionAxes(id).every((ax) => this.axisAt(ax) !== null);
      if (cmd && (!aligned || this.faults.lock.has(id))) {
        lock.timer = 0;
        continue;
      }
      if (!cmd && this.faults.lock.has(id)) continue;
      lock.timer += dt;
      if (lock.timer >= LOCK_TIME) {
        lock.engaged = cmd;
        lock.timer = 0;
      }
    }
  }

  updateAxes(dt) {
    for (const [key, ax] of this.axes) {
      ax.moving = false;
      const s = ax.section;
      const locked = s.lock && this.locks.get(s.id).engaged;
      const cmd = this.out(`${key}.cmd`);
      const jog = Number(this.out(`${key}.jog`) ?? 0);
      if (locked || this.faults.jam.has(s.id)) continue;
      const before = ax.pos;
      if (jog) {
        ax.pos = clamp(ax.pos + Math.sign(jog) * ax.cfg.speed * JOG_FACTOR * dt, ax.cfg.min, ax.cfg.max);
      } else if (cmd != null && ax.cfg.positions[cmd] !== undefined) {
        const target = ax.cfg.positions[cmd];
        const step = ax.cfg.speed * dt;
        ax.pos = Math.abs(target - ax.pos) <= step ? target : ax.pos + Math.sign(target - ax.pos) * step;
      }
      ax.moving = ax.pos !== before;
      if (ax.moving && this.boats.some((b) => b.to !== null && (b.to === s.id || b.at === s.id))) {
        this.violation(`${s.name}: Achse bewegt sich während einer Überfahrt`);
      }
    }
  }

  updateStations(dt) {
    for (const [id, st] of this.stations) {
      const wantLocked = this.out(`${id}.restraints.unlock`) !== true;
      if (st.locked !== wantLocked) {
        st.rTimer += dt;
        if (st.rTimer >= RESTRAINT_TIME && !(wantLocked && this.faults.restraints.has(id))) {
          st.locked = wantLocked;
          st.rTimer = 0;
        }
      } else st.rTimer = 0;

      const wantClosed = this.out(`${id}.gates.open`) !== true;
      if (st.closed !== wantClosed) {
        st.gTimer += dt;
        if (st.gTimer >= GATE_TIME) {
          st.closed = wantClosed;
          st.gTimer = 0;
        }
      } else st.gTimer = 0;
    }
  }

  updateBoats(dt) {
    const powered = (id) => this.out(`${id}.drive`) === true && this.out(`${id}.brakeOpen`) === true;
    for (const b of this.boats) {
      const from = this.byId.get(b.at);
      if (b.to === null) {
        // Halt am Haltesensor: erst nach Wegnahme des Antriebs ist eine neue Abfahrt möglich.
        if (!powered(from.id)) {
          b.settled = true;
          continue;
        }
        if (!b.settled) continue;
        const next = this.sections[(this.indexOf.get(from.id) + 1) % this.sections.length];
        const problem = this.departureProblem(from, next);
        if (problem) {
          this.violation(problem);
          continue;
        }
        b.to = next.id;
        b.p = 0;
        continue;
      }
      const to = this.byId.get(b.to);
      const moving = (b.p >= LEAVE || powered(from.id)) && powered(to.id);
      if (!moving || this.faults.stuck.has(to.id)) continue;
      b.p += dt / to.travelTime;
      if (b.p < 1) continue;
      if (this.boats.some((o) => o !== b && o.to === null && o.at === to.id)) {
        b.p = 0.97;
        this.violation(`Kollision: ${to.name} ist belegt`);
        continue;
      }
      b.at = to.id;
      b.to = null;
      b.p = 0;
      b.settled = false;
    }
  }

  departureProblem(from, next) {
    if (MOVABLE_TYPES.has(from.type) && !this.connected(from, 'exit')) return `${from.name}: Ausfahrt ohne Gleisanschluss`;
    if (MOVABLE_TYPES.has(next.type) && !this.connected(next, 'entry')) return `${next.name}: Einfahrt ohne Gleisanschluss`;
    if (from.type === 'station') {
      const st = this.stations.get(from.id);
      if (!st.locked || !st.closed) return `${from.name}: Abfahrt mit offenen Bügeln/Gates`;
    }
    if (next.type === 'station' && !this.stations.get(next.id).closed) return `${next.name}: Einfahrt bei offenen Gates`;
    return null;
  }

  violation(text) {
    const last = this.violations.at(-1);
    if (last && last.text === text && this.time - last.time < 1) return;
    this.violations.push({ time: Number(this.time.toFixed(2)), text });
    if (this.violations.length > 50) this.violations.shift();
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
