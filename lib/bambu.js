// A Bambu Lab printer on the local network: MQTT (8883) for state and commands, FTPS (990) for
// files, RTSPS (322) for the camera. Needs LAN Only mode with Developer Mode on for control.
'use strict';
const EventEmitter = require('events');
const { spawn } = require('child_process');
const { Writable, Readable } = require('stream');
const mqtt = require('mqtt');
const ftp = require('basic-ftp');

const SPEEDS = { 1: 'silent', 2: 'standard', 3: 'sport', 4: 'ludicrous' };

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      merge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

// Newer firmware (H2 series) packs a heater's target in the high 16 bits and its current temperature in the low 16.
function heater(packed) {
  if (typeof packed !== 'number') return null;
  return { current: packed & 0xffff, target: packed >>> 16 };
}

const fanPercent = (v) => (v === undefined ? null : Math.round((Number(v) / 15) * 10) * 10);

function hmsCode(h) {
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  return `HMS_${hex(h.attr >>> 16)}_${hex(h.attr & 0xffff)}_${hex(h.code >>> 16)}_${hex(h.code & 0xffff)}`;
}

class Printer extends EventEmitter {
  constructor({ host, serial, accessCode, name, log }) {
    super();
    this.host = host;
    this.serial = serial;
    this.accessCode = accessCode;
    this.name = name;
    this.log = log;
    this.report = {};
    this.info = null;
    this.connected = false;
    this.lastReportAt = 0;
    this.seq = 1000;
    this.waiters = new Map();
    // Whether the printer takes control commands from us: 'direct', 'read_only' (Developer Mode off) or 'unknown'.
    // Learned from the printer's answers; until then guessed from its report (see controlGuess).
    this.control = 'unknown';
    this.controlLearned = false;
  }

  connect() {
    this.client = mqtt.connect(`mqtts://${this.host}:8883`, {
      username: 'bblp',
      password: this.accessCode,
      rejectUnauthorized: false, // the printer's certificate is self-signed by Bambu
      clientId: `steve-${this.serial}-${process.pid}`,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      keepalive: 30,
    });
    this.client.on('connect', () => {
      this.connected = true;
      this.log(`printer ${this.name}: connected`);
      this.client.subscribe(`device/${this.serial}/report`, () => {
        this.publish({ pushing: { command: 'pushall' } });
        this.publish({ info: { command: 'get_version' } });
      });
      this.emit('change');
    });
    this.client.on('close', () => {
      if (this.connected) this.log(`printer ${this.name}: disconnected`);
      this.connected = false;
      this.emit('change');
    });
    this.client.on('error', (e) => this.log(`printer ${this.name}: ${e.message}`));
    this.client.on('message', (_topic, buf) => this.handleMessage(buf));
  }

  // One MQTT message from the printer: merges status reports and answers waiting commands.
  handleMessage(buf) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (msg.print) {
      const seqId = String(msg.print.sequence_id ?? '');
      if (msg.print.command === 'push_status') {
        merge(this.report, msg.print);
        if (!this.controlLearned) this.control = this.controlGuess();
        this.lastReportAt = Date.now();
        this.emit('change');
      }
      const w = this.waiters.get(seqId);
      if (w && msg.print.command !== 'push_status') {
        this.waiters.delete(seqId);
        w(msg.print);
      }
    }
    if (msg.info && msg.info.command === 'get_version') this.info = msg.info;
    for (const key of ['system', 'pushing', 'info']) {
      const seqId = String(msg[key]?.sequence_id ?? '');
      const w = this.waiters.get(seqId);
      if (w && msg[key].command !== 'get_version') { this.waiters.delete(seqId); w(msg[key]); }
    }
  }

  // Resolves once the printer has sent a report (or after timeoutMs).
  ready(timeoutMs = 8000) {
    if (this.lastReportAt) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off('change', check); resolve(false); }, timeoutMs);
      const check = () => { if (this.lastReportAt) { clearTimeout(t); this.off('change', check); resolve(true); } };
      this.on('change', check);
    });
  }

  publish(payload) {
    const [group] = Object.keys(payload);
    const seqId = String(++this.seq);
    payload[group].sequence_id = seqId;
    this.client.publish(`device/${this.serial}/request`, JSON.stringify(payload));
    return seqId;
  }

  // Sends a command and waits for the printer's echo ("result": "success", or "fail"/"failed" with a reason).
  async command(payload, timeoutMs = 5000) {
    if (!this.connected) throw new Error(`${this.name} is not connected`);
    const seqId = this.publish(payload);
    const reply = await new Promise((resolve) => {
      const t = setTimeout(() => { this.waiters.delete(seqId); resolve(null); }, timeoutMs);
      this.waiters.set(seqId, (m) => { clearTimeout(t); resolve(m); });
    });
    if (reply && /^fail/i.test(String(reply.result || ''))) {
      const reason = reply.reason || (reply.err_code ? `error ${reply.err_code}` : 'failed');
      // Firmware with Bambu's authorization control refuses unsigned commands unless Developer Mode is on.
      const refused = /verify/i.test(reason) || reply.err_code === 84033543;
      if (refused) { this.control = 'read_only'; this.controlLearned = true; this.emit('change'); }
      const hint = refused
        ? ': the printer only takes commands from other software with Developer Mode on (printer screen: Settings → Network → LAN Only Mode, then Developer Mode)'
        : '';
      throw new Error(`printer refused ${reply.command || 'the command'} (${reason})${hint}`);
    }
    if (reply && payload.print && /^success/i.test(String(reply.result || ''))) {
      if (this.control !== 'direct') { this.control = 'direct'; this.controlLearned = true; this.emit('change'); }
    }
    return reply;
  }

  // Unverified guess from the report: bit 29 of "fun" was set on an H2D that refused unsigned commands
  // (Developer Mode off). The printer's actual answers always win over this.
  controlGuess() {
    const fun = this.report.fun;
    if (typeof fun !== 'string' || !/^[0-9a-f]+$/i.test(fun)) return 'unknown';
    return (BigInt('0x' + fun) >> 29n) & 1n ? 'read_only' : 'direct';
  }

  gcode(lines) {
    return this.command({ print: { command: 'gcode_line', param: lines.trim() + '\n' } });
  }

  // The printer's product name from get_version, e.g. "Bambu Lab H2D" or "Bambu Lab X1 Carbon".
  get model() {
    return this.info?.module?.find((m) => m.name === 'ota')?.product_name || null;
  }

  // External spool holders: vir_slot on newer firmware (one per nozzle), vt_tray on older.
  externalSpools() {
    const p = this.report;
    if (Array.isArray(p.vir_slot) && p.vir_slot.length) return p.vir_slot;
    return p.vt_tray ? [p.vt_tray] : [];
  }

  // What this printer has, from its reports. Decides which actions and inputs the connector offers.
  capabilities() {
    const p = this.report;
    const d = p.device || {};
    const model = this.model || '';
    const extruders = d.extruder?.info?.length || 1;
    const rtsp = p.ipcam?.rtsp_url;
    return {
      model,
      dual: extruders === 2,
      chamberHeater: d.ctc !== undefined,
      nozzleDiameter: Number(d.nozzle?.info?.[0]?.diameter || p.nozzle_diameter || 0.4),
      // X1, P1 and A1 take print files from the SD card; newer printers (H2, P2, X2) over FTP.
      sdcardPrinting: /\b(X1|P1|A1)/.test(model),
      // X1, H2, P2 and X2 stream RTSPS on port 322; P1 and A1 send JPEG frames on port 6000.
      camera: rtsp && rtsp !== 'disable' ? 'rtsp' : /\b(P1|A1)/.test(model) ? 'jpeg' : rtsp === 'disable' ? 'disabled' : 'rtsp',
      chamberLights: [...new Set((p.lights_report || []).map((l) => l.node).filter((n) => n.startsWith('chamber_light')))],
    };
  }

  // The hotends installed now, by nozzle id: {id, code, diameter, flow, material}. Newer printers (H2 series) report a
  // code per nozzle, decoded as Bambu Studio does (DevNozzleSystem.cpp): 2nd letter = flow (S standard, H high flow,
  // U TPU high flow, B E3D high flow), digits 3-4 = material (00 stainless, 01 hardened steel, 05 tungsten carbide).
  // flow/material are null when the code isn't one Bambu Studio knows: callers must treat that as "don't print".
  hotends() {
    const FLOW = { S: 'Standard', H: 'High Flow', U: 'TPU High Flow', B: 'E3D High Flow' };
    const MATERIAL = { '00': 'stainless_steel', '01': 'hardened_steel', '05': 'tungsten_carbide' };
    const p = this.report;
    const list = p.device?.nozzle?.info;
    if (Array.isArray(list) && list.length) {
      return list.map((n) => {
        const code = String(n.type || '');
        const known = /^[A-Z][SHUB]\d\d$/.test(code);
        return {
          id: Number(n.id),
          code,
          diameter: Number(n.diameter) || null,
          flow: known ? FLOW[code[1]] : null,
          material: known ? MATERIAL[code.slice(2, 4)] || null : null,
        };
      });
    }
    // Older printers report one nozzle by material name ("hardened_steel") and diameter; they have only standard flow.
    const material = ['stainless_steel', 'hardened_steel', 'tungsten_carbide', 'brass'].includes(p.nozzle_type) ? p.nozzle_type : null;
    return [{ id: 0, code: p.nozzle_type || '', diameter: Number(p.nozzle_diameter) || null, flow: 'Standard', material }];
  }

  // A compact view of the printer, under 8 kB, for events and the panel.
  summary() {
    const p = this.report;
    const d = p.device || {};
    const extruders = (d.extruder?.info || []).map((e) => ({ id: e.id, ...heater(e.temp) }));
    const nozzles = (d.nozzle?.info || []).map((n) => ({ id: n.id, diameter: n.diameter, type: n.type }));
    const lights = Object.fromEntries((p.lights_report || []).map((l) => [l.node, l.mode]));
    const ams = (p.ams?.ams || []).map((unit) => ({
      id: Number(unit.id),
      humidity: unit.humidity_raw !== undefined ? Number(unit.humidity_raw) : null,
      temp: unit.temp !== undefined ? Number(unit.temp) : null,
      trays: (unit.tray || []).map((t) => ({
        slot: Number(t.id),
        type: t.tray_type || null,
        name: t.tray_sub_brands || null,
        color: t.tray_color ? '#' + t.tray_color.slice(0, 6) : null,
        remain: t.remain >= 0 ? t.remain : null,
        filament_id: t.tray_info_idx || null,
      })),
    }));
    const external = this.externalSpools().map((t) => ({
      id: Number(t.id), type: t.tray_type || null, color: t.tray_color ? '#' + t.tray_color.slice(0, 6) : null,
    }));
    return {
      printer: this.name,
      model: this.model,
      connected: this.connected,
      control: this.controlLearned ? this.control : 'unknown',
      state: p.gcode_state || (this.connected ? 'UNKNOWN' : 'OFFLINE'),
      stage: p.mc_print_stage ?? null,
      progress: p.mc_percent ?? null,
      remaining_min: p.mc_remaining_time ?? null,
      layer: p.layer_num ?? null,
      total_layers: p.total_layer_num ?? null,
      job: p.subtask_name || null,
      file: p.gcode_file || null,
      speed: SPEEDS[p.spd_lvl] || null,
      nozzles: extruders.length
        ? extruders.map((e) => {
          const h = this.hotends().find((x) => x.id === e.id) || {};
          return { ...e, ...(nozzles.find((n) => n.id === e.id) || {}), flow: h.flow || null, material: h.material || null };
        })
        : [{ id: 0, current: p.nozzle_temper ?? null, target: p.nozzle_target_temper ?? null }],
      bed: heater(d.bed?.info?.temp) || { current: p.bed_temper ?? null, target: p.bed_target_temper ?? null },
      chamber: heater(d.ctc?.info?.temp) || (p.chamber_temper !== undefined ? { current: p.chamber_temper, target: null } : null),
      fans: {
        part: fanPercent(p.cooling_fan_speed),
        aux: fanPercent(p.big_fan1_speed),
        chamber: fanPercent(p.big_fan2_speed),
        heatbreak: fanPercent(p.heatbreak_fan_speed),
      },
      lights,
      ams,
      external,
      errors: (p.hms || []).map(hmsCode),
      print_error: p.print_error ? p.print_error.toString(16).toUpperCase().padStart(8, '0') : null,
      wifi: p.wifi_signal || null,
      updated_at: this.lastReportAt ? new Date(this.lastReportAt).toISOString() : null,
    };
  }

  async withFtp(fn) {
    const client = new ftp.Client(30000);
    try {
      await client.access({
        host: this.host, port: 990, user: 'bblp', password: this.accessCode,
        secure: 'implicit', secureOptions: { rejectUnauthorized: false },
      });
      return await fn(client);
    } finally {
      client.close();
    }
  }

  listFiles(dir = '/') {
    return this.withFtp(async (c) => (await c.list(dir)).map((f) => ({
      name: f.name, type: f.isDirectory ? 'dir' : 'file', bytes: f.size, modified: f.rawModifiedAt || null,
    })));
  }

  upload(buffer, remotePath) {
    return this.withFtp((c) => c.uploadFrom(Readable.from(buffer), remotePath));
  }

  download(remotePath) {
    return this.withFtp(async (c) => {
      const chunks = [];
      await c.downloadTo(new Writable({ write(chunk, _e, cb) { chunks.push(chunk); cb(); } }), remotePath);
      return Buffer.concat(chunks);
    });
  }

  remove(remotePath) {
    return this.withFtp((c) => c.remove(remotePath));
  }

  // One JPEG from the camera.
  async snapshot(ffmpegPath = 'ffmpeg') {
    const kind = this.capabilities().camera;
    if (kind === 'disabled') throw new Error('LAN liveview is off: turn on LAN Only Liveview on the printer');
    return kind === 'jpeg' ? this.jpegFrame() : this.rtspSnapshot(ffmpegPath);
  }

  // P1/A1 camera: TLS on port 6000, an 80-byte login, then frames of a 16-byte header and a JPEG.
  jpegFrame() {
    const tls = require('tls');
    return new Promise((resolve, reject) => {
      const auth = Buffer.alloc(80);
      auth.writeUInt32LE(0x40, 0);
      auth.writeUInt32LE(0x3000, 4);
      auth.write('bblp', 16, 'ascii');
      auth.write(this.accessCode, 48, 'ascii');
      let buf = Buffer.alloc(0);
      const sock = tls.connect({ host: this.host, port: 6000, rejectUnauthorized: false }, () => sock.write(auth));
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('camera timed out')); }, 15000);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 16) return;
        const size = buf.readUInt32LE(0);
        if (buf.length < 16 + size) return;
        clearTimeout(timer);
        sock.destroy();
        const jpeg = buf.subarray(16, 16 + size);
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) reject(new Error('camera sent something other than a JPEG'));
        else resolve(Buffer.from(jpeg));
      });
      sock.on('error', (e) => { clearTimeout(timer); reject(new Error(`camera: ${e.message}`)); });
    });
  }

  async rtspSnapshot(ffmpegPath) {
    const url = `rtsps://bblp:${encodeURIComponent(this.accessCode)}@${this.host}:322/streaming/live/1`;
    const grab = (extra) => new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-tls_verify', '0',
        '-i', url, '-frames:v', '1', ...extra, '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];
      const ff = spawn(ffmpegPath, args, { windowsHide: true });
      const out = [], err = [];
      const timer = setTimeout(() => { ff.kill(); reject(new Error('camera timed out')); }, 20000);
      ff.stdout.on('data', (c) => out.push(c));
      ff.stderr.on('data', (c) => err.push(c));
      ff.on('error', (e) => { clearTimeout(timer); reject(new Error(`ffmpeg not found (${e.message}): install ffmpeg or set "ffmpeg" in config.json`)); });
      ff.on('close', (code) => {
        clearTimeout(timer);
        const buf = Buffer.concat(out);
        if (code === 0 && buf.length) resolve(buf);
        else reject(new Error('camera: ' + (Buffer.concat(err).toString().replaceAll(this.accessCode, '***').trim() || `ffmpeg exit ${code}`)));
      });
    });
    return grab(['-q:v', '3']);
  }
}

module.exports = { Printer, SPEEDS };
