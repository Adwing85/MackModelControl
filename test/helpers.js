import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.js';
import { RideController } from '../src/controller/controller.js';
import { SimulationIo } from '../src/io/simulation.js';

export const rawConfig = () => JSON.parse(readFileSync(fileURLToPath(new URL('../config/rocking-boat.json', import.meta.url)), 'utf8'));

/** Steuerung + Simulation mit simulierter Uhr. */
export function createRig(patch = (raw) => raw) {
  const config = normalizeConfig(patch(rawConfig()));
  const sim = new SimulationIo(config);
  let now = 1_000_000;
  const ctrl = new RideController(config, { now });
  const dt = 0.05;

  const tick = () => {
    now += dt * 1000;
    sim.update(dt);
    sim.write(ctrl.step(sim.read(), now));
  };

  /** Läuft `seconds` simulierte Sekunden; `check` wird nach jedem Zyklus aufgerufen. */
  const run = (seconds, check) => {
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      tick();
      check?.();
    }
  };

  /** Läuft, bis `cond` erfüllt ist (max. `limit` Sekunden). */
  const until = (cond, limit = 120) => {
    const steps = Math.round(limit / dt);
    for (let i = 0; i < steps; i++) {
      tick();
      if (cond()) return true;
    }
    return false;
  };

  const cmd = (type, params = {}) => ctrl.command({ type, ...params });
  const section = (id) => ctrl.byId.get(id);
  const alarmCodes = () => ctrl.alarms.list().map((a) => a.code);

  /** Physikalische Prüfung: nie zwei stehende Boote im selben Abschnitt. */
  const assertNoDoubleOccupancy = () => {
    const stopped = sim.boats.filter((b) => b.to === null).map((b) => b.at);
    if (new Set(stopped).size !== stopped.length) throw new Error(`Doppelbelegung: ${stopped.join(', ')}`);
  };

  tick();
  return { config, sim, ctrl, tick, run, until, cmd, section, alarmCodes, assertNoDoubleOccupancy, get now() { return now; } };
}
