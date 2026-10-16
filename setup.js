#!/usr/bin/env node
// Finds Bambu printers on the local network, checks the access code, and writes config.json.
//   node setup.js               interactive setup
//   node setup.js --discover    just list the printers it hears
//   node setup.js --config <file>
'use strict';
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');
const mqtt = require('mqtt');
const { Slicer } = require('./lib/slicer');

const MODELS = {
  'BL-P001': 'X1 Carbon', 'BL-P002': 'X1', C13: 'X1E', C11: 'P1P', C12: 'P1S', N1: 'A1 mini', N2S: 'A1',
  O1D: 'H2D', O1S: 'H2S', O1C: 'H2C', N7: 'P2S',
};

// Bambu printers announce themselves over SSDP on UDP 2021 (and 1990) every few seconds.
function discover(seconds = 8) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [2021, 1990].map((port) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('message', (msg, from) => {
        const text = msg.toString();
        if (!/bambulab|bambu\.com/i.test(text)) return;
        const h = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'im').exec(text) || [])[1]?.trim();
        const serial = h('USN');
        if (!serial || found.has(serial)) return;
        found.set(serial, {
          serial, host: h('Location') || from.address, name: h('DevName.bambu.com') || serial,
          model: MODELS[h('DevModel.bambu.com')] || h('DevModel.bambu.com') || '?',
          mode: h('DevConnect.bambu.com') || '?',
        });
      });
      s.on('error', () => {});
      s.bind(port, () => { try { s.addMembership('239.255.255.250'); } catch {} });
      return s;
    });
    setTimeout(() => { sockets.forEach((s) => s.close()); resolve([...found.values()]); }, seconds * 1000);
  });
}

// Connects over MQTT with the access code and waits for a status report.
function check(host, serial, accessCode) {
  return new Promise((resolve) => {
    const c = mqtt.connect(`mqtts://${host}:8883`, {
      username: 'bblp', password: accessCode, rejectUnauthorized: false,
      connectTimeout: 8000, reconnectPeriod: 0, clientId: `steve-setup-${Date.now()}`,
    });
    const done = (r) => { clearTimeout(t); c.end(true); resolve(r); };
    const t = setTimeout(() => done({ ok: false, error: 'no answer from the printer' }), 12000);
    c.on('connect', () => c.subscribe(`device/${serial}/report`, () => {
      c.publish(`device/${serial}/request`, JSON.stringify({ info: { sequence_id: '1', command: 'get_version' } }));
      c.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: '2', command: 'pushall' } }));
    }));
    c.on('message', (_t, m) => {
      try {
        const j = JSON.parse(m.toString());
        const model = j.info?.module?.find((x) => x.name === 'ota')?.product_name;
        if (model) done({ ok: true, model });
      } catch {}
    });
    c.on('error', (e) => done({ ok: false, error: /auth|not authorized/i.test(e.message) ? 'the access code was refused' : e.message }));
  });
}

async function main() {
  // The same default as connector.js: config.json next to the program, wherever you run this from.
  const configPath = process.argv.includes('--config')
    ? path.resolve(process.argv[process.argv.indexOf('--config') + 1])
    : path.join(__dirname, 'config.json');
  console.log('Listening for Bambu printers on the network…');
  const printers = await discover();
  printers.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} — ${p.model} at ${p.host} (serial ${p.serial}, ${p.mode} mode)`));
  if (!printers.length) console.log('  none heard (a firewall may block UDP 2021; you can type the details in).');
  if (process.argv.includes('--discover')) return;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (fs.existsSync(configPath) && !/^y/i.test(await rl.question(`${configPath} exists. Replace it? [y/N] `))) return;
    let p = null;
    if (printers.length) {
      const pick = await rl.question(`Printer number (or Enter to type its details): `);
      p = printers[Number(pick) - 1] || null;
    }
    if (!p) {
      p = { host: await rl.question('Printer IP address: '), serial: await rl.question('Serial number: ') };
      p.name = (await rl.question('Name for it: ')) || p.serial;
    }
    if (p.mode && p.mode !== 'lan') {
      console.log('\nNote: this printer says it is in cloud mode. Control from third-party software needs LAN Only mode' +
        '\nwith Developer Mode on (printer screen: Settings → Network). Status and camera may still work.\n');
    }
    let accessCode, result;
    for (;;) {
      accessCode = (await rl.question('Access code (printer screen: Settings → Network → Access Code): ')).trim();
      process.stdout.write('Checking… ');
      result = await check(p.host, p.serial, accessCode);
      if (result.ok) { console.log(`connected to ${result.model}.`); break; }
      console.log(result.error + '.');
      if (/^n/i.test(await rl.question('Try again? [Y/n] '))) {
        if (!/^y/i.test(await rl.question('The printer did not accept that code. Save the config anyway? [y/N] '))) return;
        break;
      }
    }

    const config = {
      name: `Bambu ${p.name}`,
      steve_url: 'https://stevecad.studio/connect/v1',
      printer: { name: p.name, host: p.host, serial: p.serial, access_code: accessCode },
      slicer: {},
      ffmpeg: 'ffmpeg',
    };
    const slicer = new Slicer({});
    if (slicer.available()) {
      console.log(`Bambu Studio found: ${slicer.exe}`);
    } else {
      console.log('Bambu Studio not found where it usually is. Slicing STEVE parts needs it.');
      const exe = await rl.question('Path to the Bambu Studio program (Enter to skip slicing): ');
      if (exe) {
        config.slicer.exe = exe;
        config.slicer.profiles = await rl.question('Path to its resources/profiles/BBL folder: ');
      }
    }
    if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).error) {
      console.log('ffmpeg not found on PATH: X1, H2, P2 and X2 cameras need it. Install it, or set "ffmpeg" in the config to its path.');
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    console.log(`\nWrote ${configPath} (it holds the access code: keep it private).`);
    console.log('Next: in STEVE, Settings → Connectors → Pair a connector, then run:\n  node connector.js --pair <CODE>');
  } finally {
    rl.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
