import { readFile } from 'node:fs/promises';

/** Abschnittstypen, die Achsen besitzen und ein Boot transportieren können. */
export const MOVABLE_TYPES = new Set(['turntable', 'rotatingLift', 'catchCarLift']);
export const SECTION_TYPES = new Set(['station', 'block', ...MOVABLE_TYPES]);

export const TYPE_LABELS = {
  station: 'Bahnhof',
  block: 'Block',
  turntable: 'Drehplattform',
  rotatingLift: 'Drehlift',
  catchCarLift: 'Catch-Car-Lift',
};

const DEFAULT_TIMING = {
  tickMs: 50,
  broadcastMs: 100,
  sensorDebounce: 0.6,
  settleTime: 0.3,
  transferTimeoutFactor: 2,
  transferTimeoutMargin: 3,
  lockTimeout: 2.5,
  stationFeedbackTimeout: 4,
  jogWatchdogMs: 400,
};

const DEFAULT_STATION = { dwellTime: 10, autoDispatch: true };

export class ConfigError extends Error {
  constructor(errors) {
    super(`Ungültige Konfiguration:\n - ${errors.join('\n - ')}`);
    this.errors = errors;
  }
}

export async function loadConfig(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  return normalizeConfig(raw);
}

/**
 * Prüft die Layout-Konfiguration und ergänzt Standardwerte.
 * Wirft ConfigError mit allen gefundenen Fehlern.
 */
export function normalizeConfig(raw) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (!raw || typeof raw !== 'object') throw new ConfigError(['Konfiguration ist kein JSON-Objekt']);

  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  if (rawSections.length < 3) fail('Mindestens 3 Streckenabschnitte erforderlich');

  const ids = new Set();
  const sections = rawSections.map((s, i) => {
    const where = `Abschnitt ${i + 1}${s?.id ? ` (${s.id})` : ''}`;
    if (!s || typeof s.id !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(s.id)) fail(`${where}: ungültige id (erlaubt: Buchstaben, Ziffern, _)`);
    else if (ids.has(s.id)) fail(`${where}: id ist doppelt vergeben`);
    else ids.add(s.id);
    if (!SECTION_TYPES.has(s?.type)) fail(`${where}: unbekannter Typ "${s?.type}"`);

    const section = {
      ...s,
      name: s?.name ?? s?.id ?? `Abschnitt ${i + 1}`,
      short: s?.short ?? String(s?.id ?? i + 1).slice(0, 3).toUpperCase(),
      travelTime: Number(s?.travelTime ?? 4),
      display: { ...(s?.display ?? {}) },
    };
    if (!(section.travelTime > 0)) fail(`${where}: travelTime muss größer 0 sein`);
    if (MOVABLE_TYPES.has(s?.type)) normalizeMovable(section, where, fail);
    return section;
  });

  if (rawSections.length && !sections.some((s) => s.type === 'station')) fail('Mindestens ein Bahnhof (type "station") erforderlich');

  const boats = Number(raw.boats ?? 1);
  if (!Number.isInteger(boats) || boats < 1) fail('boats muss eine ganze Zahl ≥ 1 sein');
  else if (sections.length && boats >= sections.length) {
    fail(`Zu viele Boote: ${boats} Boote bei ${sections.length} Abschnitten – mindestens ein Abschnitt muss frei bleiben`);
  }

  const timing = { ...DEFAULT_TIMING, ...(raw.timing ?? {}) };
  for (const [key, value] of Object.entries(timing)) {
    if (!(Number(value) > 0)) fail(`timing.${key} muss größer 0 sein`);
    timing[key] = Number(value);
  }

  const station = { ...DEFAULT_STATION, ...(raw.station ?? {}) };
  station.dwellTime = Number(station.dwellTime);
  station.autoDispatch = Boolean(station.autoDispatch);
  if (!(station.dwellTime >= 1)) fail('station.dwellTime muss mindestens 1 s betragen');

  // Ausrichtung der Boote im Bahnhof relativ zur Fahrtrichtung (180 = Heck voraus), nur für die Darstellung
  const display = { stationHeading: Number(raw.display?.stationHeading ?? 0) };
  if (!Number.isFinite(display.stationHeading)) fail('display.stationHeading muss eine Zahl (Grad) sein');

  const simulation = { ...(raw.simulation ?? {}) };
  if (!errors.length) {
    simulation.initialBoats ??= defaultInitialBoats(sections, boats);
    const initial = simulation.initialBoats;
    if (!Array.isArray(initial) || initial.length !== boats) fail(`simulation.initialBoats muss genau ${boats} Abschnitte enthalten`);
    else {
      if (new Set(initial).size !== initial.length) fail('simulation.initialBoats enthält doppelte Abschnitte');
      for (const id of initial) if (!ids.has(id)) fail(`simulation.initialBoats: unbekannter Abschnitt "${id}"`);
    }
  }

  if (errors.length) throw new ConfigError(errors);

  return {
    name: String(raw.name ?? 'Rocking Boat'),
    subtitle: String(raw.subtitle ?? 'Modellsteuerung'),
    boats,
    io: { driver: 'simulation', ...(raw.io ?? {}) },
    timing,
    station,
    display,
    sections,
    simulation,
  };
}

function normalizeMovable(section, where, fail) {
  const rawAxes = section.axes && typeof section.axes === 'object' ? section.axes : {};
  if (!Object.keys(rawAxes).length) fail(`${where}: keine Achsen definiert`);
  section.lock = Boolean(section.lock);

  section.axes = Object.fromEntries(
    Object.entries(rawAxes).map(([name, a]) => {
      const positions = Object.fromEntries(Object.entries(a?.positions ?? {}).map(([k, v]) => [k, Number(v)]));
      const values = Object.values(positions);
      if (!values.length) fail(`${where}, Achse ${name}: keine Positionen definiert`);
      if (values.some((v) => !Number.isFinite(v))) fail(`${where}, Achse ${name}: Positionen müssen Zahlen sein`);
      const min = Number(a?.min ?? Math.min(...values));
      const max = Number(a?.max ?? Math.max(...values));
      const axis = {
        label: a?.label ?? name,
        unit: a?.unit ?? '',
        display: a?.display ?? (a?.unit === '°' ? 'rotary' : 'vertical'),
        speed: Number(a?.speed ?? 10),
        tolerance: Number(a?.tolerance ?? 0.5),
        min,
        max,
        positions,
      };
      if (!(axis.speed > 0)) fail(`${where}, Achse ${name}: speed muss größer 0 sein`);
      if (!(max > min)) fail(`${where}, Achse ${name}: max muss größer min sein`);
      for (const [pos, v] of Object.entries(positions)) {
        if (v < min || v > max) fail(`${where}, Achse ${name}: Position "${pos}" liegt außerhalb ${min}…${max}`);
      }
      axis.timeout = Number(a?.timeout ?? ((max - min) / axis.speed) * 1.5 + 3);
      return [name, axis];
    }),
  );

  for (const which of ['entry', 'exit']) {
    const conf = section[which];
    if (!conf || typeof conf !== 'object' || !Object.keys(conf).length) {
      fail(`${where}: "${which}" (Achsstellung für ${which === 'entry' ? 'Einfahrt' : 'Ausfahrt'}) fehlt`);
      continue;
    }
    for (const [axis, pos] of Object.entries(conf)) {
      if (!section.axes[axis]) fail(`${where}: ${which} verweist auf unbekannte Achse "${axis}"`);
      else if (!(pos in section.axes[axis].positions)) fail(`${where}: ${which} verweist auf unbekannte Position "${pos}" der Achse "${axis}"`);
    }
  }
}

/** Startbelegung der Simulation: Bahnhof und die Blöcke davor. */
function defaultInitialBoats(sections, boats) {
  const start = sections.findIndex((s) => s.type === 'station');
  const result = [sections[start].id];
  for (let k = 1; result.length < boats && k < sections.length; k++) {
    const s = sections[(start - k + sections.length) % sections.length];
    if (!MOVABLE_TYPES.has(s.type)) result.push(s.id);
  }
  for (let k = 1; result.length < boats && k < sections.length; k++) {
    const s = sections[(start - k + sections.length) % sections.length];
    if (!result.includes(s.id)) result.push(s.id);
  }
  return result;
}

/** Vollständige E/A-Liste (Signalnamen) für die gegebene Konfiguration. */
export function ioList(config) {
  const inputs = [{ key: 'safety.estopOk', type: 'bool', desc: 'Not-Halt-Kreis geschlossen (true = in Ordnung)' }];
  const outputs = [];
  for (const s of config.sections) {
    inputs.push({ key: `${s.id}.present`, type: 'bool', desc: `${s.name}: Boot in Halteposition` });
    outputs.push({ key: `${s.id}.drive`, type: 'bool', desc: `${s.name}: Förderantrieb ein` });
    outputs.push({ key: `${s.id}.brakeOpen`, type: 'bool', desc: `${s.name}: Bremse lüften` });
    if (MOVABLE_TYPES.has(s.type)) {
      for (const [name, a] of Object.entries(s.axes)) {
        const names = Object.keys(a.positions).join(' | ');
        inputs.push({ key: `${s.id}.${name}.pos`, type: 'number', desc: `${s.name}: ${a.label} Istwert [${a.unit}]` });
        inputs.push({ key: `${s.id}.${name}.at`, type: 'string|null', desc: `${s.name}: ${a.label} erreichte Position (${names})` });
        outputs.push({ key: `${s.id}.${name}.cmd`, type: 'string|null', desc: `${s.name}: ${a.label} Zielposition (${names}), null = Halt` });
        outputs.push({ key: `${s.id}.${name}.jog`, type: '-1|0|1', desc: `${s.name}: ${a.label} Tippbetrieb` });
      }
      if (s.lock) {
        inputs.push({ key: `${s.id}.lock.engaged`, type: 'bool', desc: `${s.name}: Verriegelung eingerastet` });
        outputs.push({ key: `${s.id}.lock`, type: 'bool', desc: `${s.name}: Verriegelung einlegen` });
      }
    }
    if (s.type === 'station') {
      inputs.push({ key: `${s.id}.restraints.locked`, type: 'bool', desc: `${s.name}: alle Bügel verriegelt` });
      inputs.push({ key: `${s.id}.gates.closed`, type: 'bool', desc: `${s.name}: Gates geschlossen` });
      outputs.push({ key: `${s.id}.restraints.unlock`, type: 'bool', desc: `${s.name}: Bügel öffnen` });
      outputs.push({ key: `${s.id}.gates.open`, type: 'bool', desc: `${s.name}: Gates öffnen` });
    }
  }
  return { inputs, outputs };
}
