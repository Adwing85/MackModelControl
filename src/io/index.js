import { SimulationIo } from './simulation.js';
import { TcpJsonIo } from './tcp-json.js';

/** Wählt den E/A-Treiber aus Konfiguration bzw. Umgebungsvariablen (IO_DRIVER, IO_HOST, IO_PORT). */
export function createIo(config, env = {}) {
  const driver = env.IO_DRIVER ?? config.io.driver ?? 'simulation';
  if (driver === 'simulation') return new SimulationIo(config);
  if (driver === 'tcp') {
    return new TcpJsonIo({
      host: env.IO_HOST ?? config.io.host ?? '127.0.0.1',
      port: Number(env.IO_PORT ?? config.io.port ?? 7000),
      staleMs: config.io.staleMs ?? 1000,
      heartbeatMs: config.io.heartbeatMs ?? 200,
      layout: config.sections.map((s) => ({ id: s.id, type: s.type })),
    });
  }
  throw new Error(`Unbekannter E/A-Treiber „${driver}“ (erlaubt: simulation, tcp)`);
}
