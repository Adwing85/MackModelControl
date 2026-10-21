#!/usr/bin/env node
/**
 * Hardware-Emulator: stellt die Simulation hinter dem TCP/JSON-Protokoll bereit.
 * Dient als Referenz für die Firmware des Modells und zum Testen des TCP-Treibers ohne Hardware.
 *
 *   npm run emulator                       # lauscht auf 127.0.0.1:7000
 *   IO_DRIVER=tcp npm start                # Steuerung verbindet sich mit dem Emulator
 *
 * Wie die echte Hardware schaltet der Emulator alle Ausgänge ab (sicherer Zustand),
 * wenn länger als watchdogMs keine Ausgangsnachricht der Steuerung eintrifft.
 */
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { SimulationIo } from '../src/io/simulation.js';

export async function startEmulator(config, { port = 7000, host = '127.0.0.1', tickMs = 50, watchdogMs = 500, log = () => {} } = {}) {
  const sim = new SimulationIo(config);
  let client = null;
  let lastRx = 0;
  let last = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastRx > watchdogMs) sim.write({});
    sim.update((now - last) / 1000);
    last = now;
    if (client) {
      const { 'io.ok': _ignored, ...inputs } = sim.read();
      client.write(`${JSON.stringify({ type: 'inputs', data: inputs })}\n`);
    }
  }, tickMs);

  const server = net.createServer((socket) => {
    if (client) client.destroy();
    client = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    log(`Steuerung verbunden: ${socket.remoteAddress}:${socket.remotePort}`);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'outputs' && msg.data) {
            sim.write(msg.data);
            lastRx = Date.now();
          } else if (msg.type === 'hello') {
            log(`Hallo von der Steuerung (Protokoll ${msg.protocol}, ${msg.sections?.length ?? 0} Abschnitte)`);
          }
        } catch {
          log('Ungültige Zeile verworfen');
        }
      }
    });
    socket.on('close', () => {
      if (client === socket) client = null;
      sim.write({});
      log('Steuerung getrennt – Ausgänge sicher abgeschaltet');
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    sim,
    server,
    address: server.address(),
    async close() {
      clearInterval(timer);
      client?.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = await loadConfig(path.resolve(process.env.RIDE_CONFIG ?? path.join(root, 'config', 'rocking-boat.json')));
  const port = Number(process.env.IO_PORT ?? config.io.port ?? 7000);
  const host = process.env.IO_HOST ?? '127.0.0.1';
  await startEmulator(config, { port, host, log: (msg) => console.log(`[Emulator] ${msg}`) });
  console.log(`[Emulator] ${config.name}: lausche auf ${host}:${port}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
