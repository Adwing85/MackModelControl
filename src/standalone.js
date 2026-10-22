import { normalizeConfig } from './config.js';
import { SimulationIo } from './io/simulation.js';
import { createRuntime } from './runtime.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Steuerung und Simulation im Browser für die Einzeldatei-Version (ohne Server).
 * Bietet dieselben Daten wie die HTTP-Schnittstelle; Abbilder werden wie beim Server
 * über JSON übergeben, damit sich die Oberfläche in beiden Fällen gleich verhält.
 */
export function startLocalBackend(rawConfig) {
  const config = normalizeConfig(rawConfig);
  const io = new SimulationIo(config);
  const info = io.info.bind(io);
  io.info = () => ({ ...info(), label: 'Simulation im Browser' });
  const runtime = createRuntime({ config, io });
  const listeners = new Set();

  const broadcast = () => {
    if (!listeners.size) return;
    const data = JSON.stringify(runtime.snapshot());
    for (const listener of listeners) listener(JSON.parse(data));
  };

  // Erster Zyklus sofort, damit schon das erste Abbild ein gültiges Eingangsabbild enthält.
  runtime.tick();
  const timers = [setInterval(runtime.tick, config.timing.tickMs), setInterval(broadcast, config.timing.broadcastMs)];

  return {
    stop: () => timers.forEach(clearInterval),
    configInfo: () => clone(runtime.configInfo()),
    subscribe(listener) {
      listeners.add(listener);
      listener(clone(runtime.snapshot()));
      return () => listeners.delete(listener);
    },
    command(cmd) {
      const result = runtime.handleCommand(clone(cmd));
      if (cmd?.type !== 'manual.jog') setTimeout(broadcast, 0);
      return clone(result);
    },
  };
}
