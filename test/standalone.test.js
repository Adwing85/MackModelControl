import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, test } from 'node:test';
import { startLocalBackend } from '../src/standalone.js';
import { buildStandalone } from '../tools/build-standalone.js';
import { rawConfig } from './helpers.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Einzeldatei-Version', () => {
  test('HTML enthält Stylesheet und alle Module eingebettet', async () => {
    const html = await buildStandalone();
    assert.doesNotMatch(html, /<link rel="stylesheet"/);
    assert.doesNotMatch(html, /src="js\/app\.js"/);
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml;base64,/);
    const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 1);
    const [script] = scripts;
    assert.doesNotMatch(script, /^\s*(import|export)\s/m, 'import/export im Bündel übrig');
    for (const mod of ['src/controller/controller.js', 'src/io/simulation.js', 'public/js/app.js', 'public/js/synoptic.js']) {
      assert.ok(script.includes(`__modules[${JSON.stringify(mod)}]`), `${mod} fehlt im Bündel`);
    }
    assert.doesNotThrow(() => new vm.Script(script), 'Bündel ist kein gültiges JavaScript');
  });

  test('Laufzeit im Browser liefert Konfiguration, Zustand und nimmt Befehle an', async () => {
    const backend = startLocalBackend(rawConfig());
    try {
      const info = backend.configInfo();
      assert.equal(info.driver, 'simulation');
      assert.equal(info.config.sections.length, 8);
      let last = null;
      backend.subscribe((snap) => {
        last = snap;
      });
      assert.equal(last.state.code, 'ready');
      assert.equal(last.io.label, 'Simulation im Browser');
      assert.deepEqual(backend.command({ type: 'start' }), { ok: true });
      await wait(250);
      assert.equal(last.runState, 'running');
      assert.equal(backend.command({ type: 'gibtsnicht' }).ok, false);
    } finally {
      backend.stop();
    }
  });
});
