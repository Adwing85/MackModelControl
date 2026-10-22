import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createIo } from './io/index.js';
import { createRuntime } from './runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * HTTP-Server der Steuerung:
 *   GET  /api/config   Layout, E/A-Liste
 *   GET  /api/state    aktuelles Zustandsabbild
 *   GET  /api/stream   Zustandsabbild als Server-Sent Events (10 Hz)
 *   POST /api/command  Bedienbefehl {type, ...}
 * Steuerungszyklus und Simulation laufen im selben Prozess (Standard 50 ms).
 */
export function createRideServer({ config, io, publicDir = PUBLIC_DIR }) {
  const runtime = createRuntime({ config, io });
  const { controller, snapshot, handleCommand } = runtime;
  const clients = new Set();
  let loopTimer = null;
  let broadcastTimer = null;

  function broadcast() {
    if (!clients.size) return;
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 1000\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  async function serveStatic(pathname, res) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, 'Ungültiger Pfad');
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(publicDir, path.normalize(rel));
    if (!file.startsWith(publicDir + path.sep)) return sendText(res, 403, 'Verboten');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      sendText(res, 404, 'Nicht gefunden');
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/stream' && req.method === 'GET') return openStream(req, res);
      if (url.pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, snapshot());
      if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, runtime.configInfo());
      if (url.pathname === '/api/command') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Nur POST erlaubt' });
        // Nur JSON-Anfragen: verhindert Befehle über einfache Formulare fremder Webseiten.
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, message: 'Content-Type application/json erforderlich' });
        }
        let cmd;
        try {
          cmd = JSON.parse(await readBody(req));
        } catch (err) {
          return sendJson(res, 400, { ok: false, message: err.message === 'too large' ? 'Anfrage zu groß' : 'Ungültiges JSON' });
        }
        const result = handleCommand(cmd);
        if (cmd?.type !== 'manual.jog') setImmediate(broadcast);
        return sendJson(res, 200, result);
      }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, message: 'Unbekannter Endpunkt' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Methode nicht erlaubt');
      return serveStatic(url.pathname, res);
    } catch (err) {
      return sendJson(res, 500, { ok: false, message: err.message });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  return {
    controller,
    io,
    server,
    snapshot,
    handleCommand,
    async listen(port = 8080, host = '127.0.0.1') {
      io.start?.();
      runtime.resetClock();
      loopTimer = setInterval(runtime.tick, config.timing.tickMs);
      broadcastTimer = setInterval(broadcast, config.timing.broadcastMs);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      clearInterval(loopTimer);
      clearInterval(broadcastTimer);
      for (const res of clients) res.end();
      clients.clear();
      io.stop?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function main() {
  const configPath = path.resolve(process.env.RIDE_CONFIG ?? path.join(ROOT, 'config', 'rocking-boat.json'));
  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    console.error(`Konfiguration ${configPath} konnte nicht geladen werden:\n${err.message}`);
    process.exit(1);
  }
  const io = createIo(config, process.env);
  const app = createRideServer({ config, io });
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`${config.name} – ${config.subtitle}`);
  console.log(`  Oberfläche: http://${shown}:${port}`);
  console.log(`  E/A:        ${io.info().label}`);
  console.log(`  Layout:     ${configPath}`);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
