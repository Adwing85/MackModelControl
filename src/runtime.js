import { ioList, TYPE_LABELS } from './config.js';
import { RideController } from './controller/controller.js';

/**
 * Laufzeit der Steuerung ohne Transportweg: Steuerungszyklus, Zustandsabbild und Befehle.
 * Wird vom HTTP-Server und von der Einzeldatei-Version im Browser gleichermaßen verwendet.
 */
export function createRuntime({ config, io }) {
  const controller = new RideController(config);
  let lastTick = Date.now();

  function tick() {
    const now = Date.now();
    io.update?.((now - lastTick) / 1000);
    lastTick = now;
    io.write(controller.step(io.read(), now));
  }

  function snapshot() {
    return {
      ...controller.snapshot(),
      io: { ...io.info(), inputs: controller.inputs, outputs: controller.outputs },
      sim: io.kind === 'simulation' ? io.snapshot() : null,
    };
  }

  function configInfo() {
    return { config, io: ioList(config), typeLabels: TYPE_LABELS, driver: io.kind };
  }

  function handleCommand(cmd) {
    if (!cmd || typeof cmd.type !== 'string') return { ok: false, message: 'Befehl ohne „type“' };
    if (cmd.type.startsWith('sim.')) return handleSimCommand(cmd);
    return controller.command(cmd);
  }

  function handleSimCommand({ type, ...p }) {
    if (io.kind !== 'simulation') return { ok: false, message: 'Nur im Simulationsbetrieb verfügbar' };
    switch (type) {
      case 'sim.speed':
        return io.setSpeed(p.factor);
      case 'sim.estop':
        return io.setEstop(p.pressed);
      case 'sim.fault':
        return io.setFault(p.kind, p.section, p.active);
      case 'sim.clearFaults':
        io.clearFaults();
        return { ok: true };
      case 'sim.reset':
        io.reset();
        controller.reinitialize();
        return { ok: true, message: 'Simulation zurückgesetzt' };
      default:
        return { ok: false, message: `Unbekannter Simulationsbefehl „${type}“` };
    }
  }

  return {
    controller,
    io,
    tick,
    snapshot,
    configInfo,
    handleCommand,
    resetClock() {
      lastTick = Date.now();
    },
  };
}
