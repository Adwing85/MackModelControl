import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError, normalizeConfig } from '../src/config.js';
import { createRig, rawConfig } from './helpers.js';

const safeOutputs = (outputs) =>
  Object.entries(outputs).every(([key, v]) => {
    if (key.endsWith('.drive') || key.endsWith('.brakeOpen')) return v === false;
    if (key.endsWith('.cmd')) return v === null;
    if (key.endsWith('.jog')) return v === 0;
    return true;
  });

describe('Konfiguration', () => {
  test('Standardlayout ist gültig', () => {
    const config = normalizeConfig(rawConfig());
    assert.equal(config.sections.length, 7);
    assert.deepEqual(
      config.sections.map((s) => s.type),
      ['station', 'turntable', 'block', 'catchCarLift', 'block', 'rotatingLift', 'block'],
    );
  });

  test('zu viele Boote werden abgelehnt', () => {
    const raw = rawConfig();
    raw.boats = 7;
    raw.simulation.initialBoats = raw.sections.map((s) => s.id);
    assert.throws(() => normalizeConfig(raw), (err) => err instanceof ConfigError && /Zu viele Boote/.test(err.message));
  });

  test('Ein-/Ausfahrposition muss auf vorhandene Achsposition verweisen', () => {
    const raw = rawConfig();
    raw.sections[1].exit = { drehung: 'gibtsnicht' };
    assert.throws(() => normalizeConfig(raw), /unbekannte Position "gibtsnicht"/);
  });
});

describe('Automatikbetrieb', () => {
  test('3 Boote fahren 15 Minuten ohne Störung und ohne Verletzung der Blocklogik', () => {
    const rig = createRig();
    assert.equal(rig.ctrl.trackingReady, true);
    assert.equal(rig.ctrl.sections.filter((s) => s.boat).length, 3);
    assert.equal(rig.cmd('start').ok, true);
    rig.run(15 * 60, rig.assertNoDoubleOccupancy);
    assert.deepEqual(rig.alarmCodes(), []);
    assert.deepEqual(rig.sim.violations, []);
    assert.ok(rig.ctrl.stats.dispatches >= 30, `nur ${rig.ctrl.stats.dispatches} Abfahrten`);
    for (const b of rig.ctrl.boats.values()) assert.ok(b.rides >= 10, `${b.name} hat nur ${b.rides} Fahrten`);
  });

  test('Abfahrt ohne Auto-Abfertigung nur mit geschlossenen Bügeln', () => {
    const rig = createRig((raw) => ({ ...raw, station: { ...raw.station, autoDispatch: false } }));
    rig.cmd('start');
    rig.run(1);
    assert.equal(rig.cmd('station.restraints', { open: true }).ok, true);
    rig.run(3);
    const rejected = rig.cmd('station.dispatch');
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /offen/);
    rig.cmd('station.restraints', { open: false });
    rig.run(3);
    assert.equal(rig.cmd('station.dispatch').ok, true);
    assert.ok(rig.until(() => rig.section('drehplattform').boat === 1, 15));
  });

  test('Betriebshalt beendet laufende Fahrten und bringt die Anlage zum Stehen', () => {
    const rig = createRig();
    rig.cmd('start');
    rig.run(20);
    assert.equal(rig.cmd('stop').ok, true);
    assert.ok(rig.until(() => rig.ctrl.runState === 'stopped', 60));
    assert.equal(rig.ctrl.transfers.length, 0);
    rig.run(5);
    assert.ok(safeOutputs(rig.ctrl.outputs));
  });

  test('Zyklusende: keine neuen Abfahrten, alle Boote stehen am Ende', () => {
    const rig = createRig();
    rig.cmd('start');
    rig.run(45);
    assert.equal(rig.cmd('endCycle').ok, true);
    const dispatchesBefore = rig.ctrl.stats.dispatches;
    assert.ok(rig.until(() => rig.ctrl.runState === 'stopped', 240));
    assert.ok(rig.ctrl.stats.dispatches <= dispatchesBefore + 1);
    assert.ok(rig.section('station').boat !== null, 'Bahnhof muss besetzt sein');
    assert.deepEqual(rig.sim.violations, []);
  });
});

describe('Sicherheit und Störungen', () => {
  test('Not-Halt schaltet sofort alle Bewegungen ab, Wiederanlauf nach Quittierung', () => {
    const rig = createRig();
    rig.cmd('start');
    rig.until(() => rig.ctrl.transfers.length > 0 && rig.ctrl.transfers.every((t) => t.driving), 30);
    assert.equal(rig.cmd('estop').ok, true);
    rig.tick();
    assert.ok(safeOutputs(rig.ctrl.outputs), 'Ausgänge nach Not-Halt nicht sicher');
    const positions = JSON.stringify(rig.sim.boats);
    rig.run(5);
    assert.equal(JSON.stringify(rig.sim.boats), positions, 'Boote bewegen sich trotz Not-Halt');
    assert.equal(rig.cmd('start').ok, false);
    assert.equal(rig.cmd('reset').ok, true);
    assert.equal(rig.cmd('start').ok, true);
    const before = rig.ctrl.stats.dispatches;
    rig.run(120, rig.assertNoDoubleOccupancy);
    assert.ok(rig.ctrl.stats.dispatches > before);
    assert.deepEqual(rig.alarmCodes(), []);
    assert.deepEqual(rig.sim.violations, []);
  });

  test('Not-Halt-Taster am Modell: Quittieren erst nach Entriegeln möglich', () => {
    const rig = createRig();
    rig.cmd('start');
    rig.run(5);
    rig.sim.setEstop(true);
    rig.run(0.2);
    assert.equal(rig.ctrl.displayState().code, 'estop');
    assert.ok(safeOutputs(rig.ctrl.outputs));
    assert.equal(rig.cmd('reset').ok, false);
    rig.sim.setEstop(false);
    rig.run(0.2);
    assert.equal(rig.cmd('reset').ok, true);
    assert.equal(rig.ctrl.displayState().code, 'ready');
  });

  test('blockierte Drehplattform führt zu Positionierfehler statt zu einer Fahrt ohne Anschluss', () => {
    const rig = createRig();
    rig.sim.setFault('jam', 'drehplattform', true);
    rig.cmd('start');
    // Drehplattform kann nicht in Ausfahrposition drehen → Zeitüberschreitung der Achse
    assert.ok(rig.until(() => rig.alarmCodes().includes('AXIS_TIMEOUT'), 60));
    assert.equal(rig.ctrl.runState, 'stopped');
    assert.deepEqual(rig.sim.violations, []);
    rig.sim.setFault('jam', 'drehplattform', false);
    assert.equal(rig.cmd('reset').ok, true);
    assert.equal(rig.cmd('start').ok, true);
    rig.run(120);
    assert.deepEqual(rig.alarmCodes(), []);
  });

  test('klemmende Verriegelung wird gemeldet, die Achse bleibt stehen', () => {
    const rig = createRig();
    rig.sim.setFault('lock', 'drehplattform', true);
    rig.cmd('start');
    assert.ok(rig.until(() => rig.alarmCodes().includes('LOCK_TIMEOUT'), 30));
    assert.equal(rig.sim.read()['drehplattform.drehung.pos'], 0);
    assert.deepEqual(rig.sim.violations, []);
  });

  test('ausgefallener Haltesensor wird als Störung gemeldet', () => {
    const rig = createRig();
    rig.cmd('start');
    rig.run(2);
    rig.sim.setFault('sensor', 'block3', true);
    assert.ok(rig.until(() => rig.alarmCodes().some((c) => c === 'VEHICLE_LOST' || c === 'TRANSFER_TIMEOUT'), 60));
    assert.equal(rig.ctrl.runState, 'stopped');
    assert.deepEqual(rig.sim.violations, []);
  });

  test('klemmendes Boot löst Zeitüberschreitung der Fahrt aus', () => {
    const rig = createRig();
    rig.sim.setFault('stuck', 'block1', true);
    rig.cmd('start');
    assert.ok(rig.until(() => rig.alarmCodes().includes('TRANSFER_TIMEOUT'), 90));
    assert.ok(safeOutputs(rig.ctrl.outputs));
  });

  test('Bügel ohne Rückmeldung: Warnung und keine Abfahrt', () => {
    const rig = createRig();
    rig.sim.setFault('restraints', 'station', true);
    rig.cmd('start');
    rig.run(1);
    // Boot 1 fährt ab, Boot 2 kommt an und kann nicht mehr verriegelt werden
    assert.ok(rig.until(() => rig.alarmCodes().includes('STATION_RESTRAINTS'), 120));
    const dispatches = rig.ctrl.stats.dispatches;
    rig.run(30);
    assert.equal(rig.ctrl.stats.dispatches, dispatches);
    assert.deepEqual(rig.sim.violations, []);
  });
});

describe('Handbetrieb', () => {
  test('Verriegelungen gelten auch im Handbetrieb', () => {
    const rig = createRig();
    assert.equal(rig.cmd('mode', { mode: 'manual' }).ok, true);

    // Block 3 → Bahnhof: Bahnhof ist belegt
    const blocked = rig.cmd('manual.advance', { section: 'block3' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /belegt/);

    // Drehplattform weg von der Einfahrposition → Bahnhof darf nicht abfahren
    assert.equal(rig.cmd('manual.move', { section: 'drehplattform', position: 'exit' }).ok, true);
    assert.ok(rig.until(() => rig.ctrl.atConfig(rig.section('drehplattform'), 'exit'), 20));
    const noTrack = rig.cmd('manual.advance', { section: 'station' });
    assert.equal(noTrack.ok, false);
    assert.match(noTrack.message, /Einfahrposition/);

    // Zurück in Einfahrposition → Abfahrt möglich
    rig.cmd('manual.move', { section: 'drehplattform', position: 'entry' });
    assert.ok(rig.until(() => rig.ctrl.atConfig(rig.section('drehplattform'), 'entry'), 20));
    assert.equal(rig.cmd('manual.advance', { section: 'station' }).ok, true);
    assert.ok(rig.until(() => rig.section('drehplattform').boat === 1, 15));

    // Während der Überfahrt ist das Element gesperrt; danach darf es verfahren werden
    assert.equal(rig.cmd('manual.move', { section: 'drehplattform', position: 'exit' }).ok, true);
    assert.ok(rig.until(() => rig.ctrl.atConfig(rig.section('drehplattform'), 'exit'), 20));
    assert.equal(rig.cmd('manual.advance', { section: 'drehplattform' }).ok, true);
    assert.equal(rig.cmd('manual.move', { section: 'drehplattform', position: 'entry' }).ok, false);
    assert.ok(rig.until(() => rig.section('block1').boat === 1, 20));
    assert.deepEqual(rig.sim.violations, []);
  });

  test('Tippbetrieb stoppt ohne Wiederholung des Befehls (Totmann)', () => {
    const rig = createRig();
    rig.cmd('mode', { mode: 'manual' });
    // Die Oberfläche wiederholt den Tippbefehl alle 150 ms, solange der Taster gedrückt ist.
    for (let i = 0; i < 10; i++) {
      assert.equal(rig.cmd('manual.jog', { section: 'drehplattform', axis: 'drehung', dir: 1 }).ok, true);
      rig.run(0.15);
    }
    assert.equal(rig.ctrl.outputs['drehplattform.drehung.jog'], 1);
    assert.equal(rig.ctrl.outputs['drehplattform.lock'], false, 'Verriegelung muss zum Tippen gelöst sein');
    rig.run(0.5);
    assert.equal(rig.ctrl.outputs['drehplattform.drehung.jog'], 0);
    const pos = rig.sim.read()['drehplattform.drehung.pos'];
    rig.run(1);
    assert.equal(rig.sim.read()['drehplattform.drehung.pos'], pos);
    assert.ok(pos > 0);
  });

  test('Betriebsartwechsel nur bei stehender Anlage', () => {
    const rig = createRig();
    rig.cmd('start');
    rig.run(1);
    assert.equal(rig.cmd('mode', { mode: 'manual' }).ok, false);
    rig.cmd('stop');
    assert.ok(rig.until(() => rig.ctrl.runState === 'stopped', 60));
    assert.equal(rig.cmd('mode', { mode: 'manual' }).ok, true);
  });

  test('Fahrzeugverfolgung: Boot austragen und nach Neueinlesen wiederfinden', () => {
    const rig = createRig();
    rig.cmd('mode', { mode: 'manual' });
    assert.equal(rig.cmd('tracking.remove', { section: 'block2' }).ok, false, 'Sensor meldet Boot – Austragen muss scheitern');
    assert.equal(rig.cmd('tracking.rescan').ok, true);
    rig.tick();
    assert.equal(rig.ctrl.sections.filter((s) => s.boat).length, 3);
  });
});
