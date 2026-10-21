/**
 * Meldeliste nach dem üblichen Quittierprinzip:
 * - Zustandsmeldungen bleiben aktiv, bis die Ursache weg ist, und verschwinden erst nach Quittierung.
 * - Ereignismeldungen (latched) werden durch die Quittierung beendet.
 * Eine Störung (severity "fault") blockiert den Betrieb, solange sie aktiv oder unquittiert ist.
 */
export class AlarmList {
  constructor() {
    this.items = new Map();
    this.seq = 0;
    this.version = 0;
  }

  raise(key, data, now) {
    let alarm = this.items.get(key);
    if (alarm?.active) return { alarm, isNew: false };
    if (alarm) {
      Object.assign(alarm, data, { active: true, acknowledged: false, time: now, clearedAt: null, count: alarm.count + 1 });
    } else {
      alarm = { id: ++this.seq, key, severity: 'fault', latched: false, section: null, ...data, active: true, acknowledged: false, time: now, clearedAt: null, count: 1 };
      this.items.set(key, alarm);
    }
    this.version++;
    return { alarm, isNew: true };
  }

  clear(key, now) {
    const alarm = this.items.get(key);
    if (!alarm?.active) return null;
    alarm.active = false;
    alarm.clearedAt = now;
    if (alarm.acknowledged) this.items.delete(key);
    this.version++;
    return alarm;
  }

  acknowledge(now) {
    let changed = false;
    for (const [key, alarm] of this.items) {
      if (alarm.latched && alarm.active) {
        alarm.active = false;
        alarm.clearedAt = now;
      }
      if (!alarm.acknowledged) {
        alarm.acknowledged = true;
        changed = true;
      }
      if (!alarm.active) {
        this.items.delete(key);
        changed = true;
      }
    }
    if (changed) this.version++;
    return changed;
  }

  clearAll() {
    if (!this.items.size) return;
    this.items.clear();
    this.version++;
  }

  get size() {
    return this.items.size;
  }

  /** Störung aktiv oder noch nicht quittiert. */
  blocking() {
    for (const a of this.items.values()) if (a.severity === 'fault' && (a.active || !a.acknowledged)) return true;
    return false;
  }

  unacknowledgedFault() {
    for (const a of this.items.values()) if (a.severity === 'fault' && !a.acknowledged) return true;
    return false;
  }

  unacknowledged() {
    for (const a of this.items.values()) if (!a.acknowledged) return true;
    return false;
  }

  severityFor(sectionId) {
    let result = null;
    for (const a of this.items.values()) {
      if (a.section !== sectionId || !a.active) continue;
      if (a.severity === 'fault') return 'fault';
      result = 'warn';
    }
    return result;
  }

  list() {
    return [...this.items.values()].sort((a, b) => b.time - a.time || b.id - a.id);
  }
}
