import { MOVABLE_TYPES } from '../config.js';
import { AlarmList } from './alarms.js';

/**
 * Ablaufsteuerung des Rocking-Boat-Modells.
 *
 * Die Strecke ist ein Ring aus Abschnitten (Bahnhof, Blöcke, Drehplattform, Catch-Car-Lift, Drehlift).
 * Jeder Abschnitt nimmt höchstens ein Boot auf. Ein Boot fährt nur in den nächsten Abschnitt, wenn dieser
 * frei und – bei beweglichen Elementen – in Einfahrposition verriegelt ist (Blocklogik).
 *
 * step() liest das Eingangsabbild, führt die Logik aus und liefert das Ausgangsabbild. Alle Ausgänge
 * "false"/null entsprechen dem sicheren Zustand (Antriebe aus, Bremsen zu, Achsen stehen).
 */

const ACTIVE_RUN_STATES = new Set(['running', 'stopping', 'ending']);
const MAX_EVENTS = 300;

const PHASE_BLOCKERS = {
  leer: 'Kein Boot im Bahnhof',
  einfahrt: 'Boot fährt gerade ein',
  oeffnen: 'Bügel/Gates öffnen gerade',
  beladen: 'Bügel oder Gates sind offen',
  schliessen: 'Bügel/Gates schließen gerade',
  abfahrt: 'Abfahrt läuft bereits',
};

const ok = (message) => ({ ok: true, message });
const fail = (message) => ({ ok: false, message });
const round = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(digits)) : null);
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export class RideController {
  constructor(config, { now = Date.now() } = {}) {
    this.config = config;
    this.timing = config.timing;
    this.settings = { autoDispatch: config.station.autoDispatch, dwellTime: config.station.dwellTime };
    this.mode = 'auto';
    this.runState = 'stopped';
    this.estopLatched = false;
    this.trackingReady = false;
    this.rescanRequested = true;
    this.inputs = {};
    this.outputs = {};
    this.now = now;
    this.lastNow = null;
    this.lastAllowed = false;
    this.bootTime = now;
    this.events = [];
    this.eventSeq = 0;
    this.transferSeq = 0;
    this.transfers = [];
    this.boats = new Map();
    this.stats = { dispatches: 0, laps: 0, runSeconds: 0, dispatchTimes: [] };
    this.alarms = new AlarmList();

    this.sections = config.sections.map((cfg, index) => createSection(cfg, index));
    this.byId = new Map(this.sections.map((s) => [s.id, s]));
    this.sections.forEach((s, i) => {
      s.next = this.sections[(i + 1) % this.sections.length];
    });
    this.stations = this.sections.filter((s) => s.type === 'station');
    this.log('info', 'Steuerung gestartet');
  }

  // ---------------------------------------------------------------- Zyklus

  step(inputs, now = Date.now()) {
    this.now = now;
    const dt = this.lastNow === null ? 0 : Math.min(0.5, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.inputs = inputs ?? {};

    this.superviseSafety();
    if (this.ioOk()) {
      if (this.rescanRequested) this.rescanTracking();
      this.updateTransfers(dt);
      this.superviseOccupancy(dt);
      this.superviseStations(dt);
    }
    this.expireJogs();
    if (this.mode === 'auto') this.autoLogic();

    const allowed = this.motionAllowed();
    this.outputs = this.computeOutputs(dt, allowed);
    this.lastAllowed = allowed;
    this.updateRunState();
    if (this.runState === 'running') this.stats.runSeconds += dt;
    return this.outputs;
  }

  motionAllowed() {
    if (this.estopLatched || !this.ioOk() || !this.trackingReady) return false;
    if (this.mode === 'auto') return ACTIVE_RUN_STATES.has(this.runState) && !this.alarms.blocking();
    return !this.alarms.unacknowledgedFault();
  }

  // ---------------------------------------------------------------- Überwachung

  superviseSafety() {
    if (!this.ioOk()) {
      this.raise('IO_LOST', { code: 'IO_LOST', text: 'Keine Verbindung zur Anlagen-E/A' });
      return;
    }
    this.clearAlarm('IO_LOST');
    if (this.inputs['safety.estopOk'] !== true) {
      this.raise('ESTOP_HW', { code: 'ESTOP_CIRCUIT', text: 'Not-Halt-Kreis unterbrochen (Not-Halt-Taster an der Anlage)' });
      this.latchEstop();
    } else {
      this.clearAlarm('ESTOP_HW');
    }
  }

  superviseOccupancy(dt) {
    if (!this.trackingReady) return;
    const debounce = this.timing.sensorDebounce;
    for (const s of this.sections) {
      const present = this.present(s);

      const unexpected = present && !s.boat && !s.incoming;
      s.unexpectedTimer = unexpected ? s.unexpectedTimer + dt : 0;
      if (s.unexpectedTimer > debounce) {
        this.raise(`UNEXPECTED:${s.id}`, { code: 'UNEXPECTED_VEHICLE', text: `Unerwartetes Fahrzeug erkannt: ${s.cfg.name}`, section: s.id });
      } else if (!unexpected) this.clearAlarm(`UNEXPECTED:${s.id}`);

      const lost = !present && s.boat !== null && !s.outgoing;
      s.lostTimer = lost ? s.lostTimer + dt : 0;
      if (s.lostTimer > debounce) {
        this.raise(`LOST:${s.id}`, { code: 'VEHICLE_LOST', text: `${this.boatName(s.boat)} nicht mehr erkannt: ${s.cfg.name}`, section: s.id });
      } else if (!lost) this.clearAlarm(`LOST:${s.id}`);
    }
  }

  superviseStations(dt) {
    for (const s of this.stations) {
      const checks = [
        ['restraints', 'Bügel', this.inputs[`${s.id}.restraints.locked`] === true, s.restraintsOpen, 'verriegelt'],
        ['gates', 'Gates', this.inputs[`${s.id}.gates.closed`] === true, s.gatesOpen, 'geschlossen'],
      ];
      for (const [key, label, closedFb, wantOpen, closedWord] of checks) {
        const matches = wantOpen ? !closedFb : closedFb;
        s.feedbackTimers[key] = matches ? 0 : s.feedbackTimers[key] + dt;
        const alarmKey = `STATION_${key.toUpperCase()}:${s.id}`;
        if (s.feedbackTimers[key] > this.timing.stationFeedbackTimeout) {
          this.raise(alarmKey, {
            code: `STATION_${key.toUpperCase()}`,
            severity: 'warn',
            text: `${s.cfg.name}: ${label} ohne Rückmeldung (Soll: ${wantOpen ? 'offen' : closedWord})`,
            section: s.id,
          });
        } else if (matches) this.clearAlarm(alarmKey);
      }
    }
  }

  // ---------------------------------------------------------------- Fahrten (Blockübergänge)

  /** Grund, warum das Boot in s nicht in den nächsten Abschnitt fahren darf – oder null. */
  transferBlocker(s) {
    if (!this.trackingReady) return 'Fahrzeugverfolgung nicht bereit';
    if (!s.boat) return 'Kein Boot in diesem Abschnitt';
    if (s.outgoing) return 'Boot fährt bereits aus';
    // Nach der Ankunft bleibt der Antrieb kurz aus: jede Abfahrt beginnt mit einer steigenden Flanke.
    if (this.now - s.arrivedAt < this.timing.settleTime * 1000) return 'Boot kommt zur Ruhe';
    const to = s.next;
    if (to.boat || to.incoming) return `${to.cfg.name} ist belegt`;
    if (this.present(to)) return `${to.cfg.name}: Sensor meldet Belegung`;
    if (s.movable && !this.atConfig(s, 'exit')) return `${s.cfg.name} nicht in Ausfahrposition`;
    if (to.movable && !this.atConfig(to, 'entry')) return `${to.cfg.name} nicht in Einfahrposition`;
    if (s.type === 'station') {
      if (s.restraintsOpen || this.inputs[`${s.id}.restraints.locked`] !== true) return 'Bügel nicht verriegelt';
      if (s.gatesOpen || this.inputs[`${s.id}.gates.closed`] !== true) return 'Gates nicht geschlossen';
    }
    if (to.type === 'station' && (to.gatesOpen || this.inputs[`${to.id}.gates.closed`] !== true)) return `${to.cfg.name}: Gates nicht geschlossen`;
    return null;
  }

  startTransfer(s) {
    const to = s.next;
    const t = {
      id: ++this.transferSeq,
      boat: s.boat,
      from: s,
      to,
      elapsed: 0,
      supervise: 0,
      progress: 0,
      nominal: to.cfg.travelTime,
      limit: to.cfg.travelTime * this.timing.transferTimeoutFactor + this.timing.transferTimeoutMargin,
      startedAt: this.now,
      timedOut: false,
      paused: false,
      driving: false,
    };
    s.outgoing = t;
    to.incoming = s.boat;
    this.transfers.push(t);
    this.log('info', `${this.boatName(t.boat)}: ${s.cfg.name} → ${to.cfg.name}`, s.id);
    return t;
  }

  updateTransfers(dt) {
    for (const t of [...this.transfers]) {
      if (this.present(t.to)) {
        this.completeTransfer(t);
        continue;
      }
      if (!t.driving) continue;
      t.elapsed += dt;
      t.supervise += dt;
      t.progress = Math.min(0.94, t.elapsed / t.nominal);
      if (t.supervise > t.limit && !t.timedOut) {
        t.timedOut = true;
        this.raise(`TRANSFER:${t.to.id}`, {
          code: 'TRANSFER_TIMEOUT',
          text: `Zeitüberschreitung Fahrt ${this.boatName(t.boat)}: ${t.from.cfg.name} → ${t.to.cfg.name}`,
          section: t.to.id,
          latched: true,
        });
      }
    }
  }

  completeTransfer(t) {
    const { from, to, boat } = t;
    this.transfers.splice(this.transfers.indexOf(t), 1);
    from.boat = null;
    from.outgoing = null;
    from.unexpectedTimer = 0;
    to.boat = boat;
    to.incoming = null;
    to.lostTimer = 0;
    to.arrivedAt = this.now;
    const b = this.ensureBoat(boat);
    if (from.type === 'station') {
      this.stats.dispatches++;
      b.rides++;
      this.stats.dispatchTimes.push(this.now);
      if (this.stats.dispatchTimes.length > 60) this.stats.dispatchTimes.shift();
    }
    if (to.type === 'station') {
      this.stats.laps++;
      this.log('info', `${b.name} ist in ${to.cfg.name} eingefahren`, to.id);
      if (this.mode === 'auto') {
        to.restraintsOpen = true;
        to.gatesOpen = true;
      }
    }
  }

  // ---------------------------------------------------------------- Automatik

  autoLogic() {
    if (!this.trackingReady) return;
    for (const s of this.sections) if (s.movable) this.autoTargets(s);
    const allowed = this.motionAllowed();
    for (const s of this.stations) this.stationAuto(s, allowed);
    if (!allowed || (this.runState !== 'running' && this.runState !== 'ending')) return;
    for (const s of this.sections) {
      if (s.type === 'station' || !s.boat || s.outgoing) continue;
      if (!this.transferBlocker(s)) this.startTransfer(s);
    }
  }

  /** Bewegliche Elemente: leer → Einfahrposition, mit Boot → Ausfahrposition. */
  autoTargets(s) {
    if (s.outgoing || s.incoming) return;
    const conf = s.boat ? s.cfg.exit : s.cfg.entry;
    for (const a of Object.values(s.axes)) {
      a.target = conf[a.name] ?? null;
      a.jog = 0;
    }
  }

  stationAuto(s, allowed) {
    const phase = this.stationPhase(s);
    if (phase === 'beladen') s.dwellStart ??= this.now;
    else s.dwellStart = null;
    if (!allowed || this.runState !== 'running') return;

    if (phase === 'beladen' && this.settings.autoDispatch && this.now - s.dwellStart >= this.settings.dwellTime * 1000) {
      s.restraintsOpen = false;
      s.gatesOpen = false;
      this.log('info', `${s.cfg.name}: Bügel und Gates schließen (Auto-Abfertigung)`, s.id);
    }
    if (phase === 'bereit' && this.settings.autoDispatch && !this.transferBlocker(s)) this.startTransfer(s);
  }

  stationPhase(s) {
    if (s.outgoing) return 'abfahrt';
    if (s.incoming) return 'einfahrt';
    if (!s.boat) return 'leer';
    const locked = this.inputs[`${s.id}.restraints.locked`] === true;
    const closed = this.inputs[`${s.id}.gates.closed`] === true;
    if (s.restraintsOpen || s.gatesOpen) {
      const reached = (s.restraintsOpen ? !locked : locked) && (s.gatesOpen ? !closed : closed);
      return reached ? 'beladen' : 'oeffnen';
    }
    return locked && closed ? 'bereit' : 'schliessen';
  }

  updateRunState() {
    if (this.mode !== 'auto') return;
    if (this.runState === 'stopping' && this.isQuiet(false)) {
      this.runState = 'stopped';
      this.log('info', 'Betriebshalt erreicht – Anlage steht');
    } else if (this.runState === 'ending' && this.isQuiet(true)) {
      this.runState = 'stopped';
      this.log('info', 'Zyklusende erreicht – alle Boote abgestellt');
    }
  }

  isQuiet(includePending) {
    if (this.transfers.length) return false;
    if (this.sections.some((s) => s.movable && !this.elementSettled(s))) return false;
    if (includePending && this.sections.some((s) => s.type !== 'station' && s.boat && !this.transferBlocker(s))) return false;
    return true;
  }

  // ---------------------------------------------------------------- Ausgänge

  computeOutputs(dt, allowed) {
    const out = {};
    for (const s of this.sections) {
      out[`${s.id}.drive`] = false;
      out[`${s.id}.brakeOpen`] = false;
    }
    for (const t of this.transfers) {
      t.driving = allowed && !(this.mode === 'manual' && t.paused);
      if (!t.driving) continue;
      for (const s of [t.from, t.to]) {
        out[`${s.id}.drive`] = true;
        out[`${s.id}.brakeOpen`] = true;
      }
    }
    for (const s of this.sections) {
      if (s.movable) this.driveElement(s, out, dt, allowed);
      if (s.type === 'station') {
        out[`${s.id}.restraints.unlock`] = s.restraintsOpen;
        out[`${s.id}.gates.open`] = s.gatesOpen;
      }
    }
    return out;
  }

  /** Achsen eines beweglichen Elements: entriegeln → verfahren → verriegeln. */
  driveElement(s, out, dt, allowed) {
    const axes = Object.values(s.axes);
    for (const a of axes) {
      out[`${s.id}.${a.name}.cmd`] = null;
      out[`${s.id}.${a.name}.jog`] = 0;
      if (!a.target || this.axisAt(s, a.name) === a.target) {
        a.moveTime = 0;
        a.timedOut = false;
      }
    }
    const busy = Boolean(s.outgoing || s.incoming);
    const pending = axes.filter((a) => this.jogActive(a) || (a.target && this.axisAt(s, a.name) !== a.target));

    if (allowed && !busy) {
      if (pending.length) {
        if (s.cfg.lock) s.lockCmd = false;
        if (!s.cfg.lock || !this.lockEngaged(s)) {
          for (const a of pending) {
            if (this.jogActive(a)) {
              out[`${s.id}.${a.name}.jog`] = a.jog;
              continue;
            }
            out[`${s.id}.${a.name}.cmd`] = a.target;
            a.moveTime += dt;
            if (a.moveTime > a.cfg.timeout && !a.timedOut) {
              a.timedOut = true;
              this.raise(`AXIS:${s.id}.${a.name}`, {
                code: 'AXIS_TIMEOUT',
                text: `${s.cfg.name}: ${a.cfg.label} erreicht Position „${capitalize(a.target)}“ nicht`,
                section: s.id,
                latched: true,
              });
            }
          }
        }
      } else if (s.cfg.lock && axes.every((a) => this.axisAt(s, a.name) !== null)) {
        s.lockCmd = true;
      }
    }

    if (s.cfg.lock) {
      out[`${s.id}.lock`] = s.lockCmd;
      const mismatch = this.lockEngaged(s) !== s.lockCmd;
      s.lockTimer = allowed && mismatch ? s.lockTimer + dt : 0;
      if (!mismatch) s.lockTimedOut = false;
      if (s.lockTimer > this.timing.lockTimeout && !s.lockTimedOut) {
        s.lockTimedOut = true;
        this.raise(`LOCK:${s.id}`, {
          code: 'LOCK_TIMEOUT',
          text: `${s.cfg.name}: Verriegelung ${s.lockCmd ? 'rastet nicht ein' : 'löst nicht'}`,
          section: s.id,
          latched: true,
        });
      }
    }
  }

  // ---------------------------------------------------------------- Befehle

  command(cmd = {}) {
    try {
      return this.execute(cmd);
    } catch (err) {
      return fail(`Interner Fehler: ${err.message}`);
    }
  }

  execute({ type, ...p }) {
    const s = p.section !== undefined ? this.byId.get(p.section) : null;
    if (p.section !== undefined && !s) return fail(`Unbekannter Abschnitt „${p.section}“`);
    const st = p.station !== undefined ? this.byId.get(p.station) : this.stations[0];
    if (!st || st.type !== 'station') return fail('Unbekannter Bahnhof');
    let reason;

    switch (type) {
      case 'estop':
        this.raise('ESTOP_SW', { code: 'ESTOP', text: 'NOT-HALT über Bedienoberfläche ausgelöst', latched: true });
        this.latchEstop();
        return ok('Not-Halt ausgelöst');

      case 'reset':
        return this.reset();

      case 'mode':
        if ((reason = this.whyNotMode(p.mode))) return fail(reason);
        this.mode = p.mode;
        this.runState = 'stopped';
        this.haltMotion();
        for (const station of this.stations) station.dwellStart = null;
        if (p.mode === 'auto') for (const t of this.transfers) t.paused = false;
        this.log('info', `Betriebsart: ${p.mode === 'auto' ? 'Automatik' : 'Handbetrieb'}`);
        return ok();

      case 'start':
        if ((reason = this.whyNotStart())) return fail(reason);
        this.runState = 'running';
        this.log('info', 'Fahrbetrieb gestartet');
        return ok();

      case 'stop':
        if ((reason = this.whyNotStop())) return fail(reason);
        if (this.mode === 'manual') {
          this.haltMotion();
          this.log('info', 'Handbetrieb: alle Bewegungen angehalten');
        } else {
          this.runState = 'stopping';
          this.log('info', 'Betriebshalt eingeleitet – laufende Fahrten werden beendet');
        }
        return ok();

      case 'endCycle':
        if ((reason = this.whyNotEndCycle())) return fail(reason);
        this.runState = 'ending';
        this.log('info', 'Zyklusende eingeleitet – keine neuen Abfahrten');
        return ok();

      case 'station.restraints':
      case 'station.gates': {
        const open = Boolean(p.open);
        const what = type === 'station.restraints' ? 'restraints' : 'gates';
        if ((reason = this.whyNotStationOutput(st, what, open))) return fail(reason);
        if (what === 'restraints') st.restraintsOpen = open;
        else st.gatesOpen = open;
        const label = what === 'restraints' ? 'Bügel' : 'Gates';
        this.log('info', `${st.cfg.name}: ${label} ${open ? 'öffnen' : 'schließen'}`, st.id);
        return ok();
      }

      case 'station.dispatch':
        if ((reason = this.whyNotDispatch(st))) return fail(reason);
        this.startTransfer(st);
        return ok('Abfahrt freigegeben');

      case 'station.settings':
        if (p.autoDispatch !== undefined) {
          this.settings.autoDispatch = Boolean(p.autoDispatch);
          this.log('info', `Auto-Abfertigung ${this.settings.autoDispatch ? 'ein' : 'aus'}`);
        }
        if (p.dwellTime !== undefined) {
          const v = Number(p.dwellTime);
          if (!(v >= 2 && v <= 600)) return fail('Verweilzeit muss zwischen 2 und 600 s liegen');
          this.settings.dwellTime = Math.round(v);
        }
        return ok();

      case 'manual.advance':
        if (!s) return fail('Abschnitt fehlt');
        if ((reason = this.whyNotAdvance(s))) return fail(reason);
        if (s.outgoing) {
          s.outgoing.paused = false;
          this.log('info', `Hand: Fahrt ${this.boatName(s.boat)} fortgesetzt`, s.id);
        } else {
          this.startTransfer(s);
        }
        return ok();

      case 'manual.move': {
        if (!s) return fail('Abschnitt fehlt');
        if ((reason = this.whyNotMove(s))) return fail(reason);
        if (p.axis !== undefined) {
          const a = s.axes[p.axis];
          if (!a) return fail(`Unbekannte Achse „${p.axis}“`);
          if (!(p.position in a.cfg.positions)) return fail(`Unbekannte Position „${p.position}“`);
          a.target = p.position;
          a.jog = 0;
        } else {
          const conf = p.position === 'entry' || p.position === 'exit' ? s.cfg[p.position] : null;
          if (!conf) return fail('Position muss „entry“ oder „exit“ sein');
          for (const [axis, pos] of Object.entries(conf)) {
            s.axes[axis].target = pos;
            s.axes[axis].jog = 0;
          }
        }
        this.log('info', `Hand: ${s.cfg.name} → ${p.position === 'entry' ? 'Einfahrposition' : p.position === 'exit' ? 'Ausfahrposition' : capitalize(p.position)}`, s.id);
        return ok();
      }

      case 'manual.jog': {
        if (!s) return fail('Abschnitt fehlt');
        const a = s.movable ? s.axes[p.axis] : null;
        if (!a) return fail(`Unbekannte Achse „${p.axis}“`);
        const dir = Math.sign(Number(p.dir) || 0);
        if (dir === 0) {
          a.jog = 0;
          return ok();
        }
        if ((reason = this.whyNotMove(s))) return fail(reason);
        a.jog = dir;
        a.jogUntil = this.now + this.timing.jogWatchdogMs;
        a.target = null;
        return ok();
      }

      case 'tracking.add': {
        if (!s) return fail('Abschnitt fehlt');
        if ((reason = this.whyNotTrackAdd(s))) return fail(reason);
        let id = 1;
        const onTrack = new Set(this.sections.map((x) => x.boat).filter(Boolean));
        while (onTrack.has(id)) id++;
        s.boat = id;
        s.unexpectedTimer = 0;
        this.ensureBoat(id);
        this.clearAlarm(`UNEXPECTED:${s.id}`);
        this.log('warn', `Fahrzeugverfolgung: ${this.boatName(id)} in ${s.cfg.name} eingetragen`, s.id);
        return ok();
      }

      case 'tracking.remove': {
        if (!s) return fail('Abschnitt fehlt');
        if ((reason = this.whyNotTrackRemove(s))) return fail(reason);
        const id = s.boat;
        s.boat = null;
        s.lostTimer = 0;
        this.clearAlarm(`LOST:${s.id}`);
        this.log('warn', `Fahrzeugverfolgung: ${this.boatName(id)} aus ${s.cfg.name} ausgetragen`, s.id);
        return ok();
      }

      case 'tracking.rescan':
        if ((reason = this.whyNotRescan())) return fail(reason);
        this.rescanRequested = true;
        return ok('Fahrzeugverfolgung wird neu eingelesen');

      default:
        return fail(`Unbekannter Befehl „${type}“`);
    }
  }

  reset() {
    const hadEstop = this.estopLatched;
    this.alarms.acknowledge(this.now);
    if (this.estopLatched) {
      if (!this.ioOk() || this.inputs['safety.estopOk'] !== true) return fail('Not-Halt-Kreis ist noch unterbrochen – Taster entriegeln');
      this.estopLatched = false;
    }
    for (const t of this.transfers) {
      t.supervise = 0;
      t.timedOut = false;
    }
    for (const s of this.sections) {
      if (!s.movable) continue;
      s.lockTimer = 0;
      s.lockTimedOut = false;
      for (const a of Object.values(s.axes)) {
        a.moveTime = 0;
        a.timedOut = false;
      }
    }
    this.log('info', hadEstop ? 'Not-Halt zurückgesetzt, Meldungen quittiert' : 'Meldungen quittiert');
    return ok();
  }

  /** Setzt Ablauf und Verfolgung zurück (z. B. nach Neustart der Simulation). */
  reinitialize() {
    this.runState = 'stopped';
    this.estopLatched = false;
    this.alarms.clearAll();
    this.haltMotion();
    this.rescanRequested = true;
    this.trackingReady = false;
    this.log('info', 'Steuerung neu initialisiert');
  }

  // ---------------------------------------------------------------- Freigaben (gleiche Prüfungen für UI und Befehle)

  whyNotStart() {
    if (this.mode !== 'auto') return 'Nur in Betriebsart Automatik';
    if (this.estopLatched) return 'Not-Halt aktiv – zuerst quittieren';
    if (!this.ioOk()) return 'Keine Verbindung zur Anlagen-E/A';
    if (this.alarms.blocking()) return 'Störung steht an – Ursache beheben und quittieren';
    if (!this.trackingReady) return 'Fahrzeugverfolgung nicht bereit';
    if (this.runState === 'running') return 'Fahrbetrieb läuft bereits';
    return null;
  }

  whyNotStop() {
    if (this.mode === 'manual') return null;
    if (this.runState === 'running' || this.runState === 'ending') return null;
    return this.runState === 'stopping' ? 'Halt ist bereits eingeleitet' : 'Anlage steht bereits';
  }

  whyNotEndCycle() {
    if (this.mode !== 'auto') return 'Nur in Betriebsart Automatik';
    if (this.runState !== 'running') return 'Nur im laufenden Fahrbetrieb';
    return null;
  }

  whyNotReset() {
    if (!this.estopLatched && this.alarms.size === 0) return 'Keine Meldungen anstehend';
    return null;
  }

  whyNotMode(mode) {
    if (mode !== 'auto' && mode !== 'manual') return 'Unbekannte Betriebsart';
    if (mode === this.mode) return mode === 'auto' ? 'Automatik ist bereits aktiv' : 'Handbetrieb ist bereits aktiv';
    if (this.mode === 'auto' && this.runState !== 'stopped') return 'Wechsel nur bei stehender Anlage';
    if (this.mode === 'manual' && this.motionActive()) return 'Wechsel nur ohne aktive Bewegung';
    return null;
  }

  whyNotStationOutput(st, what, open) {
    if (this.estopLatched) return 'Not-Halt aktiv';
    const current = what === 'restraints' ? st.restraintsOpen : st.gatesOpen;
    const label = what === 'restraints' ? 'Bügel' : 'Gates';
    if (current === open) return `${label} ${open ? 'sind bereits geöffnet' : 'sind bereits geschlossen'}`;
    if (open) {
      if (!st.boat) return 'Kein Boot im Bahnhof';
      if (st.outgoing || st.incoming) return 'Boot ist in Bewegung';
    }
    return null;
  }

  whyNotDispatch(st) {
    if (this.mode !== 'auto') return 'Im Handbetrieb „Boot weiterfahren“ verwenden';
    if (this.runState !== 'running') return this.runState === 'stopped' ? 'Fahrbetrieb ist nicht gestartet' : 'Keine Abfahrt während Halt/Zyklusende';
    if (!this.motionAllowed()) return 'Bewegung nicht freigegeben';
    const phase = this.stationPhase(st);
    if (phase !== 'bereit') return PHASE_BLOCKERS[phase];
    return this.transferBlocker(st);
  }

  whyNotManual() {
    if (this.mode !== 'manual') return 'Nur im Handbetrieb';
    if (this.estopLatched) return 'Not-Halt aktiv';
    if (!this.ioOk()) return 'Keine Verbindung zur Anlagen-E/A';
    if (this.alarms.unacknowledgedFault()) return 'Störung zuerst quittieren';
    if (!this.trackingReady) return 'Fahrzeugverfolgung nicht bereit';
    return null;
  }

  whyNotAdvance(s) {
    const base = this.whyNotManual();
    if (base) return base;
    if (s.outgoing) return s.outgoing.paused ? null : 'Fahrt läuft bereits';
    return this.transferBlocker(s);
  }

  whyNotMove(s) {
    const base = this.whyNotManual();
    if (base) return base;
    if (!s.movable) return 'Kein bewegliches Element';
    if (s.outgoing || s.incoming) return 'Boot fährt gerade über – Element gesperrt';
    return null;
  }

  whyNotTracking() {
    if (this.mode === 'auto' && this.runState !== 'stopped') return 'Nur bei stehender Anlage oder im Handbetrieb';
    if (!this.ioOk()) return 'Keine Verbindung zur Anlagen-E/A';
    if (!this.trackingReady) return 'Fahrzeugverfolgung nicht bereit';
    return null;
  }

  whyNotTrackAdd(s) {
    const base = this.whyNotTracking();
    if (base) return base;
    if (s.boat || s.incoming) return 'Abschnitt ist bereits belegt';
    if (!this.present(s)) return 'Sensor meldet kein Boot';
    return null;
  }

  whyNotTrackRemove(s) {
    const base = this.whyNotTracking();
    if (base) return base;
    if (!s.boat) return 'Kein Boot eingetragen';
    if (s.outgoing || s.incoming) return 'Fahrt aktiv';
    if (this.present(s)) return 'Sensor meldet ein Boot – Austragen nicht möglich';
    return null;
  }

  whyNotRescan() {
    if (this.mode === 'auto' && this.runState !== 'stopped') return 'Nur bei stehender Anlage oder im Handbetrieb';
    if (this.motionActive()) return 'Wechsel nur ohne aktive Bewegung';
    if (!this.ioOk()) return 'Keine Verbindung zur Anlagen-E/A';
    return null;
  }

  availability() {
    const stations = {};
    for (const st of this.stations) {
      stations[st.id] = {
        dispatch: this.whyNotDispatch(st),
        restraintsOpen: this.whyNotStationOutput(st, 'restraints', true),
        restraintsClose: this.whyNotStationOutput(st, 'restraints', false),
        gatesOpen: this.whyNotStationOutput(st, 'gates', true),
        gatesClose: this.whyNotStationOutput(st, 'gates', false),
      };
    }
    const sections = {};
    for (const s of this.sections) {
      sections[s.id] = {
        advance: this.whyNotAdvance(s),
        move: s.movable ? this.whyNotMove(s) : 'Kein bewegliches Element',
        trackAdd: this.whyNotTrackAdd(s),
        trackRemove: this.whyNotTrackRemove(s),
      };
    }
    return {
      start: this.whyNotStart(),
      stop: this.whyNotStop(),
      endCycle: this.whyNotEndCycle(),
      reset: this.whyNotReset(),
      modeAuto: this.whyNotMode('auto'),
      modeManual: this.whyNotMode('manual'),
      rescan: this.whyNotRescan(),
      stations,
      sections,
    };
  }

  // ---------------------------------------------------------------- Zustandsabbild für die Oberfläche

  displayState() {
    if (this.estopLatched) {
      const circuitOk = this.inputs['safety.estopOk'] === true;
      return { code: 'estop', label: 'NOT-HALT', hint: circuitOk ? 'QUITTIEREN drücken, um den Not-Halt zurückzusetzen' : 'Not-Halt-Taster an der Anlage entriegeln, dann quittieren' };
    }
    if (!this.ioOk()) return { code: 'fault', label: 'E/A GESTÖRT', hint: 'Verbindung zur Modell-Hardware prüfen' };
    if (this.alarms.blocking()) {
      return this.alarms.unacknowledgedFault()
        ? { code: 'fault', label: 'STÖRUNG', hint: 'Meldung prüfen, Ursache beheben und QUITTIEREN' }
        : { code: 'fault', label: 'STÖRUNG', hint: 'Ursache steht noch an – im Handbetrieb beheben' };
    }
    if (this.mode === 'manual') return { code: 'manual', label: 'HANDBETRIEB', hint: 'Elemente einzeln verfahren – Verriegelungen bleiben aktiv' };
    switch (this.runState) {
      case 'running':
        return {
          code: 'running',
          label: 'FAHRBETRIEB',
          hint: this.settings.autoDispatch ? 'Automatische Abfertigung aktiv' : 'Bahnhof: Bügel schließen und ABFAHRT drücken',
        };
      case 'stopping':
        return { code: 'stopping', label: 'HALT EINGELEITET', hint: 'Laufende Fahrten werden beendet …' };
      case 'ending':
        return { code: 'ending', label: 'ZYKLUSENDE', hint: 'Keine neuen Abfahrten – Boote fahren in die Abstellpositionen …' };
      default: {
        const blocker = this.whyNotStart();
        return blocker ? { code: 'stopped', label: 'GESTOPPT', hint: blocker } : { code: 'ready', label: 'BEREIT', hint: 'START drücken, um den Fahrbetrieb aufzunehmen' };
      }
    }
  }

  snapshot() {
    const transferByBoat = new Map(this.transfers.map((t) => [t.boat, t]));
    const sectionByBoat = new Map(this.sections.filter((s) => s.boat).map((s) => [s.boat, s.id]));
    return {
      time: this.now,
      uptime: (this.now - this.bootTime) / 1000,
      mode: this.mode,
      runState: this.runState,
      state: this.displayState(),
      estop: { latched: this.estopLatched, circuitOk: this.inputs['safety.estopOk'] === true },
      ioOk: this.ioOk(),
      trackingReady: this.trackingReady,
      motionAllowed: this.lastAllowed,
      settings: { ...this.settings },
      sections: this.sections.map((s) => this.sectionSnapshot(s)),
      boats: [...this.boats.values()]
        .sort((a, b) => a.id - b.id)
        .map((b) => {
          const t = transferByBoat.get(b.id);
          return {
            id: b.id,
            name: b.name,
            rides: b.rides,
            section: sectionByBoat.get(b.id) ?? null,
            transfer: t ? { from: t.from.id, to: t.to.id, progress: round(t.progress, 3), driving: t.driving, paused: this.mode === 'manual' && t.paused } : null,
          };
        }),
      alarms: {
        version: this.alarms.version,
        blocking: this.alarms.blocking(),
        unacknowledged: this.alarms.unacknowledged(),
        items: this.alarms.list().map(({ id, code, severity, text, section, active, acknowledged, time, count }) => ({ id, code, severity, text, section, active, acknowledged, time, count })),
      },
      events: this.events.slice(-40),
      eventSeq: this.eventSeq,
      stats: this.statsSnapshot(),
      can: this.availability(),
    };
  }

  sectionSnapshot(s) {
    const snap = {
      id: s.id,
      type: s.type,
      boat: s.boat,
      incoming: s.incoming,
      outgoing: s.outgoing ? s.outgoing.boat : null,
      present: this.present(s),
      drive: this.outputs[`${s.id}.drive`] === true,
      brakeOpen: this.outputs[`${s.id}.brakeOpen`] === true,
      alarm: this.alarms.severityFor(s.id),
      status: null,
    };
    if (s.movable) {
      snap.axes = {};
      for (const a of Object.values(s.axes)) {
        snap.axes[a.name] = {
          pos: round(this.inputs[`${s.id}.${a.name}.pos`]),
          at: this.axisAt(s, a.name),
          target: a.target,
          jog: this.jogActive(a) ? a.jog : 0,
          moving: this.outputs[`${s.id}.${a.name}.cmd`] != null || (this.outputs[`${s.id}.${a.name}.jog`] ?? 0) !== 0,
        };
      }
      snap.lock = s.cfg.lock ? { cmd: s.lockCmd, engaged: this.lockEngaged(s) } : null;
      snap.position = this.axesAt(s, 'entry') ? 'entry' : this.axesAt(s, 'exit') ? 'exit' : null;
      snap.status = this.elementStatus(s, snap);
    } else if (s.type === 'station') {
      const phase = this.stationPhase(s);
      snap.phase = phase;
      snap.restraints = { open: s.restraintsOpen, locked: this.inputs[`${s.id}.restraints.locked`] === true };
      snap.gates = { open: s.gatesOpen, closed: this.inputs[`${s.id}.gates.closed`] === true };
      snap.dwellRemaining =
        this.mode === 'auto' && phase === 'beladen' && s.dwellStart !== null ? Math.max(0, this.settings.dwellTime - (this.now - s.dwellStart) / 1000) : null;
    }
    snap.status ??= this.transferStatus(s) ?? (s.boat ? `${this.boatName(s.boat)} wartet` : 'frei');
    return snap;
  }

  transferStatus(s) {
    if (s.outgoing) return `${this.boatName(s.boat)} ${s.outgoing.driving ? 'fährt aus' : 'angehalten'}`;
    if (s.incoming) {
      const t = this.transfers.find((x) => x.to === s);
      return t?.driving ? `${this.boatName(s.incoming)} fährt ein` : `reserviert für ${this.boatName(s.incoming)}`;
    }
    return null;
  }

  elementStatus(s, snap) {
    const transfer = this.transferStatus(s);
    if (transfer) return transfer;
    const axes = Object.values(snap.axes);
    if (axes.some((a) => a.jog)) return 'Tippbetrieb';
    if (axes.some((a) => a.moving)) {
      const targetConf = this.targetConfig(s);
      return targetConf === 'exit' ? 'Fährt in Ausfahrposition' : targetConf === 'entry' ? 'Fährt in Einfahrposition' : 'Fährt auf Zielposition';
    }
    if (s.cfg.lock && snap.lock.engaged !== s.lockCmd) return s.lockCmd ? 'Verriegelt …' : 'Entriegelt …';
    if (s.boat) return this.atConfig(s, 'exit') ? `${this.boatName(s.boat)} wartet auf Blockfreigabe` : `${this.boatName(s.boat)} an Bord`;
    if (this.atConfig(s, 'entry')) return 'Bereit zur Einfahrt';
    return 'Nicht in Grundstellung';
  }

  targetConfig(s) {
    for (const which of ['exit', 'entry']) {
      const conf = s.cfg[which];
      if (Object.values(s.axes).every((a) => (conf[a.name] ?? null) === a.target)) return which;
    }
    return null;
  }

  statsSnapshot() {
    const times = this.stats.dispatchTimes;
    const recent = times.filter((t) => this.now - t < 15 * 60e3);
    const span = recent.length >= 2 ? (recent.at(-1) - recent[0]) / 3600e3 : 0;
    return {
      dispatches: this.stats.dispatches,
      laps: this.stats.laps,
      runSeconds: Math.round(this.stats.runSeconds),
      perHour: span > 0 ? Math.round((recent.length - 1) / span) : null,
      lastInterval: times.length >= 2 ? round((times.at(-1) - times.at(-2)) / 1000, 1) : null,
      boatsOnTrack: this.sections.filter((s) => s.boat).length,
    };
  }

  // ---------------------------------------------------------------- Hilfsfunktionen

  ioOk() {
    return this.inputs['io.ok'] === true;
  }

  present(s) {
    return this.inputs[`${s.id}.present`] === true;
  }

  axisAt(s, axis) {
    return this.inputs[`${s.id}.${axis}.at`] ?? null;
  }

  lockEngaged(s) {
    return this.inputs[`${s.id}.lock.engaged`] === true;
  }

  jogActive(a) {
    return a.jog !== 0 && this.now <= a.jogUntil;
  }

  expireJogs() {
    for (const s of this.sections) {
      if (!s.movable) continue;
      for (const a of Object.values(s.axes)) if (a.jog && this.now > a.jogUntil) a.jog = 0;
    }
  }

  axesAt(s, which) {
    return Object.entries(s.cfg[which]).every(([axis, pos]) => this.axisAt(s, axis) === pos);
  }

  /** Element steht in Ein-/Ausfahrposition, ist verriegelt und wird nicht getippt. */
  atConfig(s, which) {
    if (!this.axesAt(s, which)) return false;
    if (Object.values(s.axes).some((a) => this.jogActive(a))) return false;
    return !s.cfg.lock || (s.lockCmd && this.lockEngaged(s));
  }

  elementSettled(s) {
    for (const a of Object.values(s.axes)) {
      if (this.jogActive(a)) return false;
      if (a.target && this.axisAt(s, a.name) !== a.target) return false;
    }
    return !s.cfg.lock || this.lockEngaged(s) === s.lockCmd;
  }

  motionActive() {
    return Object.entries(this.outputs).some(([key, v]) => (key.endsWith('.drive') && v === true) || (key.endsWith('.cmd') && v != null) || (key.endsWith('.jog') && v !== 0));
  }

  haltMotion() {
    for (const t of this.transfers) t.paused = true;
    for (const s of this.sections) {
      if (!s.movable) continue;
      for (const a of Object.values(s.axes)) {
        a.target = null;
        a.jog = 0;
      }
    }
  }

  latchEstop() {
    if (this.estopLatched) return;
    this.estopLatched = true;
    this.runState = 'stopped';
    this.haltMotion();
  }

  raise(key, data) {
    const { isNew } = this.alarms.raise(key, data, this.now);
    if (!isNew) return;
    const severity = data.severity ?? 'fault';
    this.log(severity === 'fault' ? 'fault' : 'warn', data.text, data.section ?? null);
    if (severity !== 'fault') return;
    if (this.mode === 'auto' && this.runState !== 'stopped') {
      this.runState = 'stopped';
      this.log('warn', 'Fahrbetrieb durch Störung gestoppt');
    }
    if (this.mode === 'manual') this.haltMotion();
  }

  clearAlarm(key) {
    const alarm = this.alarms.clear(key, this.now);
    if (alarm) this.log('info', `Behoben: ${alarm.text}`, alarm.section);
  }

  rescanTracking() {
    this.transfers = [];
    for (const s of this.sections) {
      s.boat = null;
      s.incoming = null;
      s.outgoing = null;
      s.unexpectedTimer = 0;
      s.lostTimer = 0;
      this.alarms.clear(`UNEXPECTED:${s.id}`, this.now);
      this.alarms.clear(`LOST:${s.id}`, this.now);
    }
    const n = this.sections.length;
    const start = this.stations[0].index;
    let id = 0;
    // Bahnhof zuerst, dann rückwärts: Boot 1 fährt als nächstes ab.
    for (let k = 0; k < n; k++) {
      const s = this.sections[(start - k + n) % n];
      if (!this.present(s)) continue;
      s.boat = ++id;
      this.ensureBoat(id);
    }
    for (const s of this.stations) {
      s.restraintsOpen = this.inputs[`${s.id}.restraints.locked`] === false;
      s.gatesOpen = this.inputs[`${s.id}.gates.closed`] === false;
      s.dwellStart = null;
    }
    for (const s of this.sections) {
      if (!s.movable) continue;
      s.lockCmd = s.cfg.lock ? this.lockEngaged(s) : true;
      for (const a of Object.values(s.axes)) {
        a.target = null;
        a.jog = 0;
      }
    }
    this.trackingReady = true;
    this.rescanRequested = false;
    this.log('info', `Fahrzeugverfolgung eingelesen: ${id} Boot${id === 1 ? '' : 'e'} erkannt`);
    if (id !== this.config.boats) {
      this.raise('BOAT_COUNT', { code: 'BOAT_COUNT', severity: 'warn', text: `${id} Boot${id === 1 ? '' : 'e'} erkannt, konfiguriert sind ${this.config.boats}`, latched: true });
    }
  }

  ensureBoat(id) {
    if (!this.boats.has(id)) this.boats.set(id, { id, name: `Boot ${id}`, rides: 0 });
    return this.boats.get(id);
  }

  boatName(id) {
    return this.boats.get(id)?.name ?? `Boot ${id}`;
  }

  log(level, text, section = null) {
    this.events.push({ seq: ++this.eventSeq, time: this.now, level, text, section });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }
}

function createSection(cfg, index) {
  const s = {
    id: cfg.id,
    cfg,
    index,
    type: cfg.type,
    movable: MOVABLE_TYPES.has(cfg.type),
    boat: null,
    incoming: null,
    outgoing: null,
    unexpectedTimer: 0,
    lostTimer: 0,
    arrivedAt: -Infinity,
  };
  if (s.movable) {
    s.axes = Object.fromEntries(
      Object.entries(cfg.axes).map(([name, axisCfg]) => [name, { name, cfg: axisCfg, target: null, jog: 0, jogUntil: 0, moveTime: 0, timedOut: false }]),
    );
    s.lockCmd = true;
    s.lockTimer = 0;
    s.lockTimedOut = false;
  }
  if (cfg.type === 'station') {
    s.restraintsOpen = false;
    s.gatesOpen = false;
    s.dwellStart = null;
    s.feedbackTimers = { restraints: 0, gates: 0 };
  }
  return s;
}
