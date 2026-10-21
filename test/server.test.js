import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { SimulationIo } from '../src/io/simulation.js';
import { TcpJsonIo } from '../src/io/tcp-json.js';
import { createRideServer } from '../src/server.js';
import { startEmulator } from '../tools/hardware-emulator.js';
import { rawConfig } from './helpers.js';

const config = normalizeConfig(rawConfig());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('HTTP-Schnittstelle', () => {
  let app;
  let base;

  before(async () => {
    app = createRideServer({ config, io: new SimulationIo(config) });
    const addr = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${addr.port}`;
    await wait(150);
  });
  after(() => app.close());

  const post = (body, headers = { 'Content-Type': 'application/json' }) => fetch(`${base}/api/command`, { method: 'POST', headers, body: JSON.stringify(body) });

  test('liefert Oberfläche, Konfiguration und Zustand', async () => {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<title>/);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.config.sections.length, 7);
    assert.equal(cfg.driver, 'simulation');
    assert.ok(cfg.io.inputs.some((s) => s.key === 'drehplattform.lock.engaged'));
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.state.code, 'ready');
    assert.equal(state.io.inputs['io.ok'], true);
  });

  test('nimmt Befehle an und lehnt fremde Formulare ab', async () => {
    const res = await post({ type: 'start' });
    assert.deepEqual(await res.json(), { ok: true });
    const again = await (await post({ type: 'start' })).json();
    assert.equal(again.ok, false);
    const form = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'type=estop' });
    assert.equal(form.status, 415);
    const sim = await (await post({ type: 'sim.speed', factor: 2 })).json();
    assert.equal(sim.ok, true);
  });

  test('sendet Zustand als Server-Sent Events', async () => {
    const res = await fetch(`${base}/api/stream`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const data = JSON.parse(text.split('data: ')[1].split('\n\n')[0]);
    assert.ok(Array.isArray(data.sections));
  });

  test('verhindert Zugriff außerhalb von public/', async () => {
    const res = await fetch(`${base}/%2e%2e/package.json`);
    assert.notEqual(res.status, 200);
  });
});

describe('TCP/JSON-Treiber mit Hardware-Emulator', () => {
  test('Steuerung fährt über das TCP-Protokoll', async () => {
    const emulator = await startEmulator(config, { port: 0 });
    const io = new TcpJsonIo({ host: '127.0.0.1', port: emulator.address.port, layout: config.sections.map((s) => s.id) });
    const app = createRideServer({ config, io });
    try {
      await app.listen(0, '127.0.0.1');
      for (let i = 0; i < 40 && !app.controller.ioOk(); i++) await wait(50);
      await wait(200);
      assert.equal(app.controller.ioOk(), true);
      assert.equal(app.controller.sections.filter((s) => s.boat).length, 3);
      assert.equal(app.handleCommand({ type: 'reset' }).ok, true);
      emulator.sim.setSpeed(8);
      assert.equal(app.handleCommand({ type: 'start' }).ok, true);
      for (let i = 0; i < 60 && app.controller.stats.dispatches === 0; i++) await wait(100);
      assert.ok(app.controller.stats.dispatches >= 1, 'keine Abfahrt über TCP');
      assert.deepEqual(emulator.sim.violations, []);

      // Verbindungsabbruch → E/A-Störung, Emulator schaltet sicher ab
      await emulator.close();
      for (let i = 0; i < 40 && app.controller.ioOk(); i++) await wait(50);
      assert.equal(app.controller.ioOk(), false);
      assert.equal(app.controller.displayState().code, 'fault');
    } finally {
      await app.close();
      await emulator.close().catch(() => {});
    }
  });
});
