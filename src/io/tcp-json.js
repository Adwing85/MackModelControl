import net from 'node:net';

/**
 * E/A-Treiber für die reale Modell-Hardware (z. B. ESP32/Arduino mit Ethernet/WLAN oder ein SPS-Gateway).
 *
 * Protokoll: zeilenweise JSON über TCP (siehe docs/e-a-protokoll.md).
 *   Steuerung → Hardware: {"type":"outputs","seq":1,"data":{...Ausgangsabbild...}}   (bei Änderung, sonst alle heartbeatMs)
 *   Hardware → Steuerung: {"type":"inputs","data":{...Eingangsabbild...}}            (bei Änderung, mindestens alle 500 ms)
 * Bleiben Eingänge länger als staleMs aus, gilt die E/A als gestört (io.ok = false).
 */
export class TcpJsonIo {
  constructor({ host = '127.0.0.1', port = 7000, staleMs = 1000, heartbeatMs = 200, reconnectMs = 1000, layout = [] } = {}) {
    this.kind = 'tcp';
    this.host = host;
    this.port = port;
    this.staleMs = staleMs;
    this.heartbeatMs = heartbeatMs;
    this.reconnectMs = reconnectMs;
    this.layout = layout;
    this.inputs = {};
    this.socket = null;
    this.connected = false;
    this.lastRx = 0;
    this.lastSent = '';
    this.lastSentAt = 0;
    this.seq = 0;
    this.lastError = null;
    this.stopped = false;
    this.timer = null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }

  connect() {
    if (this.stopped) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      this.lastSent = '';
      socket.write(`${JSON.stringify({ type: 'hello', protocol: 1, sections: this.layout })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) this.handleLine(line);
      }
      if (buffer.length > 1_000_000) buffer = '';
    });
    socket.on('error', (err) => {
      this.lastError = err.message;
    });
    socket.on('close', () => {
      this.connected = false;
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), this.reconnectMs);
    });
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.lastError = 'Ungültige JSON-Zeile empfangen';
      return;
    }
    if (msg?.type === 'inputs' && msg.data && typeof msg.data === 'object') {
      Object.assign(this.inputs, msg.data);
      this.lastRx = Date.now();
    }
  }

  read() {
    const fresh = this.connected && Date.now() - this.lastRx < this.staleMs;
    return { ...this.inputs, 'io.ok': fresh };
  }

  write(outputs) {
    if (!this.connected || !this.socket) return;
    const data = JSON.stringify(outputs);
    const now = Date.now();
    if (data === this.lastSent && now - this.lastSentAt < this.heartbeatMs) return;
    this.lastSent = data;
    this.lastSentAt = now;
    this.socket.write(`{"type":"outputs","seq":${++this.seq},"data":${data}}\n`);
  }

  info() {
    return {
      kind: this.kind,
      connected: this.connected,
      label: `TCP ${this.host}:${this.port}`,
      lastError: this.lastError,
      lastRxAge: this.lastRx ? Date.now() - this.lastRx : null,
    };
  }
}
