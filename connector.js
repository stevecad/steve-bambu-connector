#!/usr/bin/env node
// STEVE connector for a Bambu Lab printer on the local network.
//   Set up:     node setup.js                         (finds the printer, writes config.json)
//   First run:  node connector.js --pair <CODE>       (code from STEVE, Settings → Connectors)
//   After that: node connector.js
// Options: --config <file> (default ./config.json), --data <folder> (default ./data). Run one connector per printer.
'use strict';
const fs = require('fs');
const path = require('path');
const { Steve } = require('./lib/steve');
const { Printer } = require('./lib/bambu');
const { Slicer } = require('./lib/slicer');
const { Actions, buildCatalog } = require('./lib/actions');
const { BambuConnect } = require('./lib/bambuconnect');
const { buildPanel } = require('./lib/panel');
const { version } = require('./package.json');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = __dirname;
const configPath = path.resolve(arg('--config') || path.join(ROOT, 'config.json'));
const DATA = path.resolve(arg('--data') || path.join(ROOT, 'data'));
fs.mkdirSync(DATA, { recursive: true });
// The log keeps the current file and one older one, each up to 5 MB.
const LOG = path.join(DATA, 'connector.log');
const LOG_MAX = 5 * 1024 * 1024;
let logFile = null, logBytes = 0;
function openLog() {
  try { logBytes = fs.statSync(LOG).size; } catch { logBytes = 0; }
  if (logBytes > LOG_MAX) {
    fs.renameSync(LOG, LOG + '.1');
    logBytes = 0;
  }
  logFile = fs.createWriteStream(LOG, { flags: 'a' });
}
openLog();
function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}\n`;
  process.stdout.write(line);
  logFile.write(line);
  logBytes += Buffer.byteLength(line);
  if (logBytes > LOG_MAX) {
    logFile.end();
    openLog();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(configPath)) {
  console.error(`${configPath} is missing: run "node setup.js", or copy config.example.json to config.json and fill it in.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
for (const key of ['host', 'serial', 'access_code']) {
  if (!config.printer?.[key]) { console.error(`config: printer.${key} is missing`); process.exit(1); }
}
config.printer.name = config.printer.name || `Bambu ${config.printer.serial.slice(-4)}`;

const steve = new Steve({ baseUrl: config.steve_url || 'https://stevecad.studio/connect/v1', dataDir: DATA, log });
const printer = new Printer({
  host: config.printer.host, serial: config.printer.serial, accessCode: config.printer.access_code,
  name: config.printer.name, log,
});
const slicer = new Slicer({ exe: config.slicer?.exe, profilesDir: config.slicer?.profiles, log });
let catalog = null, actions = null, actionNames = [];
const active = new Map(); // run id -> AbortController

// Reads the printer's hardware and builds the catalog and actions for it.
async function prepare() {
  printer.connect();
  for (let i = 0; !(printer.lastReportAt && printer.info); i++) {
    if (i === 6) log(`waiting for ${config.printer.name} at ${config.printer.host} (is it on, in LAN mode, and is the access code right?)…`);
    // A pairing code lasts 10 minutes: don't sit on it while the printer can't be reached.
    if (!steve.enrolled && i === 48) {
      log('pairing needs the printer to answer first; check it and pair again with a new code');
      process.exit(1);
    }
    await sleep(2500);
  }
  const caps = printer.capabilities();
  let machine = config.machine_profile || null, qualities = null;
  if (slicer.available()) {
    machine = machine || slicer.machineFor(caps.model, caps.nozzleDiameter);
    if (machine) qualities = slicer.processesFor(machine);
    else log(`no Bambu Studio machine profile for "${caps.model}" with a ${caps.nozzleDiameter} mm nozzle; set "machine_profile" in the config to slice`);
  } else {
    log('Bambu Studio not found: slicing actions are off (set "slicer.exe" and "slicer.profiles" in the config)');
  }
  log(`printer: ${caps.model || 'unknown model'}${caps.dual ? ', two nozzles' : ''}, camera ${caps.camera}` +
    (machine ? `, slicing as "${machine}"` : ''));

  // How prints start: direct (Developer Mode), or through Bambu Connect if the config asks for it.
  let bambuConnect = null;
  if (config.print_via === 'bambu_connect') {
    const bc = new BambuConnect({ outbox: path.join(DATA, 'outbox'), log });
    if (bc.available()) bambuConnect = bc;
    else log('print_via is "bambu_connect" but Bambu Connect is not installed; printing from STEVE is off');
  }
  if (printer.control === 'read_only' && !bambuConnect) {
    log('the printer looks like it refuses control commands (Developer Mode off): status, camera, light and ' +
      '"Open in Bambu Studio" work; turn on Developer Mode to control and print from STEVE');
  }
  catalog = buildCatalog(caps, {
    qualities, studio: slicer.available(), confirm: Array.isArray(config.confirm) ? config.confirm : undefined,
  });
  actionNames = catalog.actions.map((a) => a.name);
  actions = new Actions({ printer, slicer, config, caps, machine, qualities, bambuConnect,
    filesDir: path.join(DATA, 'files'), log });
}

// ---- events: status when it changes, alerts for job transitions and errors ----

let lastSent = null, lastSentAt = 0, lastState = null, lastErrors = '', pending = null;
const KEY_FIELDS = ['connected', 'state', 'stage', 'progress', 'layer', 'job', 'speed', 'lights', 'errors', 'print_error', 'ams'];

function statusChanged(s) {
  if (!lastSent) return 'first';
  for (const k of KEY_FIELDS) if (JSON.stringify(s[k]) !== JSON.stringify(lastSent[k])) return 'key';
  const temps = (x) => JSON.stringify([x.nozzles, x.bed, x.chamber, x.fans, x.remaining_min]);
  if (temps(s) !== temps(lastSent)) return 'minor';
  return null;
}

async function sendEvent(name, data) {
  try {
    await steve.event(name, data);
  } catch (e) {
    log(`event ${name} not sent: ${e.message}`);
  }
}

function onPrinterChange() {
  if (!steve.token) return;
  const s = printer.summary();
  const change = statusChanged(s);
  const now = Date.now();
  // Key changes go out at once (at most one every 2 s); temperatures every 15 s; a heartbeat each minute.
  const due = change === 'key' || change === 'first' ? 2000 : change === 'minor' ? 15000 : 60000;
  if (now - lastSentAt < due) {
    if (!pending) pending = setTimeout(() => { pending = null; onPrinterChange(); }, due - (now - lastSentAt));
    return;
  }
  lastSent = s;
  lastSentAt = now;
  sendEvent('status', s);

  if (!printer.lastReportAt || !s.connected) return;
  if (lastState && !['UNKNOWN', 'OFFLINE'].includes(lastState) && s.state !== lastState) {
    const what = { RUNNING: lastState === 'PAUSE' ? 'resumed' : 'started', FINISH: 'finished', FAILED: 'failed', PAUSE: 'paused' }[s.state];
    if (what) sendEvent('alert', { kind: `print_${what}`, job: s.job, state: s.state, progress: s.progress, print_error: s.print_error });
  }
  lastState = s.state;
  const errs = s.errors.join(',');
  if (errs && errs !== lastErrors) sendEvent('alert', { kind: 'printer_error', errors: s.errors, job: s.job, state: s.state });
  lastErrors = errs;
}
printer.on('change', onPrinterChange);
setInterval(onPrinterChange, 60000);

// ---- runs ----

async function handleRun(message) {
  const env = message.envelope;
  const runId = env.id;
  const problem = await steve.check(message, actionNames);
  if (problem) {
    log(`run ${runId} rejected: ${problem}`);
    if (problem !== 'replayed') await steve.report(runId, { state: 'rejected', error: problem }).catch(() => {});
    return;
  }
  steve.rememberNonce(env.nonce);
  const prior = steve.runState(runId);
  if (active.has(runId) || prior === 'done') {
    log(`run ${runId}: delivered again; already handled, ignoring the repeat`);
    return;
  }
  if (prior === 'accepted') {
    // We had started this run when the connector stopped. Never repeat it (it could be a print); say what happened.
    log(`run ${runId}: delivered again after a restart; reporting it failed instead of repeating it`);
    await steve.report(runId, { state: 'failed', error: 'the connector restarted during this run; it was not repeated' })
      .catch((e) => log('report:', e.message));
    steve.rememberRun(runId, 'done');
    return;
  }
  steve.rememberRun(runId, 'accepted');
  const who = env.requested_by?.kind || 'someone';
  // Name the STEVE documents a run carries, so the log shows what was sliced or printed.
  const docs = Object.values(env.inputs || {}).filter((v) => v && v.kind === 'file')
    .map((v) => `"${v.name}" (${v.document} r${v.revision})`);
  log(`run ${runId}: ${env.action} by ${who}${docs.length ? ` of ${docs.join(', ')}` : ''}${env.note ? ` (${env.note})` : ''}`);
  await steve.report(runId, { state: 'received' });

  const controller = new AbortController();
  active.set(runId, controller);
  const ctx = {
    signal: controller.signal,
    progress: (progress, msg) => steve.report(runId, { state: 'running', progress, message: msg }).catch((e) => log('progress:', e.message)),
    input: (input) => steve.fetchInput(input),
    file: (name, buf, type) => steve.uploadFile(runId, name, buf, type),
  };
  (async () => {
    try {
      await steve.report(runId, { state: 'running', progress: 0 });
      await printer.ready();
      // If a cancel arrives after the action did its work (a print already started), the honest answer is that it
      // succeeded: the actions check for cancellation before each step that can't be undone.
      const out = (await actions.handlers[env.action](env.inputs || {}, ctx)) || {};
      await steve.report(runId, { state: 'succeeded', result: out.result || {}, message: out.message || 'Done' });
      log(`run ${runId}: ${env.action} succeeded${out.message ? ` (${out.message})` : ''}`);
      onPrinterChange();
    } catch (e) {
      const cancelled = controller.signal.aborted;
      log(`run ${runId}: ${env.action} ${cancelled ? 'cancelled' : 'failed'}: ${e.message}`);
      await steve.report(runId, cancelled ? { state: 'cancelled', message: 'Cancelled' } : { state: 'failed', error: e.message })
        .catch((err) => log('report:', err.message));
    } finally {
      active.delete(runId);
      steve.rememberRun(runId, 'done');
    }
  })();
}

async function handleCancel(message) {
  const problem = await steve.check(message, actionNames);
  if (problem) return log(`cancel ignored: ${problem}`);
  steve.rememberNonce(message.envelope.nonce);
  const env = message.envelope;
  const runId = env.run; // envelope.id is the cancel's own id
  const c = active.get(runId);
  if (c) {
    log(`run ${runId}: cancelling`);
    c.abort();
  } else {
    // Not running here (already finished, or never received): say it's cancelled; STEVE ignores it if it ended.
    await steve.report(runId, { state: 'cancelled', message: 'Cancelled' }).catch(() => {});
  }
}

// Publishes the panel in panel/ when it changed ("panel": false in the config turns this off).
async function publishPanel() {
  if (config.panel === false) return;
  try {
    const { panel, hash } = buildPanel(path.join(ROOT, 'panel'), {
      title: config.panel?.title || config.printer.name,
      placement: config.panel?.placement || ['right'],
    });
    const name = config.panel?.name || 'printer';
    if (steve.state.panel_hash === `${name}:${hash}`) return;
    const r = await steve.publishPanel(name, panel);
    steve.state.panel_hash = `${name}:${hash}`;
    steve.saveState();
    log(`published the panel "${r.name || 'printer'}" (version ${r.version ?? '?'})`);
  } catch (e) {
    log(`panel not published: ${e.message}`);
  }
}

// ---- main ----

async function main() {
  const code = arg('--pair');
  if (!steve.enrolled && !code) {
    console.error('Not paired yet. Get a code in STEVE (Settings → Connectors → Pair a connector), then run:\n  node connector.js --pair <CODE>');
    process.exit(1);
  }
  await prepare();
  if (!steve.enrolled) {
    const name = config.name || (/^bambu/i.test(config.printer.name) ? config.printer.name : `Bambu ${config.printer.name}`);
    const r = await steve.enroll(code.trim(), name, version, catalog);
    log(`enrolled as ${r.connector}`);
  }
  console.log('\n  Connector fingerprint (confirm this exact value in STEVE):\n');
  console.log(`  ${steve.fingerprint}\n`);
  logFile.write(`${new Date().toISOString()} fingerprint ${steve.fingerprint}\n`);

  // Wait until the owner confirms the fingerprint.
  for (;;) {
    try {
      await steve.ensureToken();
      break;
    } catch (e) {
      if (e.code === 'pending_confirmation') {
        log('waiting for the connector to be confirmed in STEVE…');
        await sleep(60000);
      } else if (e.status === 403) {
        log(`STEVE refused this connector: ${e.message}. Revoked? Delete ${path.join(DATA, 'state.json')} and ${path.join(DATA, 'key.pem')}, then pair again.`);
        process.exit(1);
      } else {
        log(`token: ${e.message}; retrying`);
        await sleep(15000);
      }
    }
  }
  log('confirmed by STEVE');
  for (let attempt = 1; ; attempt++) {
    try {
      await steve.putCatalog(catalog);
      break;
    } catch (e) {
      if (e.status === 403 || attempt >= 10) throw e;
      log(`catalog not sent (${e.message}); retrying`);
      await sleep(Math.min(60000, 2000 * attempt));
    }
  }
  await publishPanel();

  let backoff = 1000;
  for (;;) {
    try {
      const { messages, cursor } = await steve.messages(30);
      backoff = 1000;
      for (const m of messages) {
        try {
          if (m.kind === 'run') await handleRun(m);
          else if (m.kind === 'cancel') await handleCancel(m);
        } catch (e) {
          log(`message ${m.id}: ${e.message}`);
          if (m.kind === 'run' && m.envelope?.id && !active.has(m.envelope.id)) {
            await steve.report(m.envelope.id, { state: 'rejected', error: `connector error: ${e.message}` }).catch(() => {});
          }
        }
        steve.advance(m.id);
      }
      if (cursor !== null) steve.advance(cursor);
    } catch (e) {
      if (e.status === 403 && e.code !== 'token_invalid' && e.code !== 'signature_invalid') {
        log(`STEVE refused this connector: ${e.message}`);
        process.exit(1);
      }
      log(`poll: ${e.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

process.on('SIGINT', () => { log('stopping'); process.exit(0); });
main().catch((e) => { log('fatal:', e.stack || e.message); process.exit(1); });
