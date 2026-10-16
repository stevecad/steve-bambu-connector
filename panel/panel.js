'use strict';
// Bambu printer panel: draws the connector's "status" event and runs its actions through STEVE's bridge.

let next = 0;
const waiting = new Map();
const busy = new Map();       // action name -> run id while a run is open
const runActions = new Map(); // run id -> action name, for every run this panel started
const finished = new Set();   // run ids whose end was already handled
const allowed = new Set();
const defs = new Map();       // action name -> its definition (inputs)
let doc = null;               // the STEVE document open now, when the panel may send it
let sliced = null;            // the last slice_part result for this document: what "Print this" prints
const ENDED = ['succeeded', 'failed', 'rejected', 'cancelled', 'expired'];
const PRINT_CARD = ['slice_part', 'open_in_studio', 'print_file'];
const $ = (id) => document.getElementById(id);

function call(method, params = {}) {
  const id = ++next;
  window.parent.postMessage({ steve: 1, id, method, params }, '*');
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.steve !== 1) return;
  if (message.id !== undefined && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    message.error ? reject(message.error) : resolve(message.result);
  } else if (message.event === 'event') {
    if (message.name === 'status') draw(message.data);
  } else if (message.event === 'run') {
    guarded(() => showRun(message.run));
  } else if (message.event === 'context') {
    applyTheme(message.context.theme);
    setDocument(message.context.document);
  }
});

// Shows a file from one of this panel's runs (camera photo, plate preview) in an <img>.
const objectUrls = new Map();
async function showRunFile(runId, name, img) {
  try {
    const f = await call('run.file', { id: runId, name });
    if (objectUrls.has(img)) URL.revokeObjectURL(objectUrls.get(img));
    const url = URL.createObjectURL(f.blob);
    objectUrls.set(img, url);
    img.src = url;
    return true;
  } catch (e) {
    say(`Couldn't show ${name}: ${e.message || e}`);
    return false;
  }
}

// Runs a UI update and shows any error in the footer instead of failing silently.
function guarded(fn) {
  try { fn(); } catch (e) { say(`Panel error: ${e.message || e}`); }
}

// Follows a run until it ends, in case a pushed update is missed.
function watchRun(id, action) {
  const timer = setInterval(async () => {
    if (finished.has(id) || busy.get(action) !== id) { clearInterval(timer); return; }
    try {
      const r = await call('run.get', { id });
      guarded(() => showRun({ ...r, id }));
    } catch {}
  }, 2000);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

let status = null;

function fmtMin(m) {
  if (m == null) return '';
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h} h ${mm} min` : `${mm} min`;
}

function temp(label, h) {
  if (!h || h.current == null) return '';
  const tg = h.target ? `→ ${h.target}°` : 'off';
  return `<div class="temp"><div class="label">${label}</div><div class="t">${Math.round(h.current)}°</div><div class="tg">${tg}</div></div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function draw(s) {
  status = s;
  $('name').textContent = s.printer || 'Printer';
  $('sub').textContent = s.connected ? `${s.model || 'Bambu Lab'} · Wi-Fi ${s.wifi || '—'}` : 'Printer not reachable';
  const state = s.connected ? s.state : 'OFFLINE';
  $('state').textContent = state;
  $('state').className = 'pill ' + state;

  const active = ['RUNNING', 'PAUSE', 'PREPARE'].includes(state);
  $('jobName').textContent = s.job || 'No job';
  $('pct').textContent = s.progress != null && (active || state === 'FINISH') ? `${s.progress}%` : '';
  $('barFill').style.width = `${active || state === 'FINISH' ? s.progress || 0 : 0}%`;
  $('layer').textContent = s.total_layers ? `Layer ${s.layer} / ${s.total_layers}` : '';
  $('remain').textContent = active && s.remaining_min != null ? `${fmtMin(s.remaining_min)} left` : '';

  const nozzles = s.nozzles || [];
  const names = nozzles.length === 2 ? ['Right nozzle', 'Left nozzle'] : ['Nozzle'];
  $('temps').innerHTML = nozzles.map((n, i) => temp(names[i] || `Nozzle ${n.id}`, n)).join('') +
    temp('Bed', s.bed) + temp('Chamber', s.chamber);

  for (const b of $('speed').querySelectorAll('button')) b.classList.toggle('on', b.dataset.level === s.speed);
  const lightOn = Object.entries(s.lights || {}).some(([k, v]) => k.startsWith('chamber_light') && v === 'on');
  for (const b of $('light').querySelectorAll('button')) b.classList.toggle('on', (b.dataset.on === 'on') === lightOn);

  $('ams').innerHTML = (s.ams || []).map((u) => `<div class="ams-unit"><span class="ams-id">${String.fromCharCode(65 + u.id)}</span>` +
    u.trays.map((t) => `<div class="tray" title="${esc(t.name || t.type || 'Empty')}">` +
      `<div class="sw ${t.type ? '' : 'empty'}" style="${t.color ? `background:${esc(t.color)}` : ''}"></div>` +
      `<span>${esc(t.type || '—')}${t.remain != null ? ` ${t.remain}%` : ''}</span></div>`).join('') + '</div>').join('');
  $('amsCard').hidden = !(s.ams || []).length;

  const errs = [...(s.errors || []), ...(s.print_error ? [`Print error ${s.print_error}`] : [])];
  $('errors').hidden = !errs.length;
  $('errors').innerHTML = errs.map(esc).join('<br>');
  fillSlots();
  refreshButtons();
}

// ---- the open part: open in Bambu Studio, or slice, preview and print ----

function setDocument(d) {
  const nextDoc = d && ['part', 'design'].includes(d.kind) ? d : null;
  if (!nextDoc || !doc || nextDoc.id !== doc.id || nextDoc.revision !== doc.revision) clearPreview();
  doc = nextDoc;
  $('docInfo').textContent = doc ? `the open ${doc.kind}, revision ${doc.revision}` : '';
  $('printCard').hidden = !(doc && (allowed.has('slice_part') || allowed.has('open_in_studio')));
  const asks = ['slice_part', 'open_in_studio'].filter((a) => allowed.has(a) && defs.get(a)?.sends_open_document_on_click === false);
  $('askHint').hidden = !asks.length;
  refreshButtons();
}

function clearPreview() {
  sliced = null;
  $('preview').hidden = true;
  $('printMsg').textContent = '';
}

function options(select, values, chosen, label = (v) => v) {
  const keep = select.value;
  select.innerHTML = values.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
  select.value = values.includes(keep) ? keep : chosen ?? values[0];
}

function fillSlots() {
  const def = defs.get('slice_part');
  if (!def || !status) return;
  const all = def.inputs?.properties?.slot?.enum || ['auto'];
  const loaded = new Map([['auto', 'Auto (first PLA)']]);
  for (const u of status.ams || []) {
    for (const t of u.trays) {
      if (t.type) loaded.set(String.fromCharCode(65 + u.id) + (t.slot + 1), `${String.fromCharCode(65 + u.id)}${t.slot + 1} · ${t.name || t.type}`);
    }
  }
  for (const v of all) if (v.startsWith('ext')) loaded.set(v, v === 'external' ? 'External spool' : `External ${v.slice(4)}`);
  const values = [...loaded.keys()].filter((v) => all.includes(v));
  options($('pSlot'), values, 'auto', (v) => loaded.get(v));
}

function fillPrintForm() {
  const def = defs.get('slice_part');
  const sliceable = Boolean(def);
  for (const id of ['pSlot', 'pQuality', 'pPlate', 'pSupports', 'pOrient']) $(id).closest('label').hidden = !sliceable;
  $('btnSlice').hidden = !sliceable;
  $('btnStudio').hidden = !defs.has('open_in_studio');
  if (!def) return;
  const p = def.inputs?.properties || {};
  options($('pQuality'), p.quality?.enum || [], p.quality?.default);
  const plates = { textured_pei: 'Textured PEI', smooth_pei: 'Smooth PEI', cool_plate: 'Cool Plate', engineering: 'Engineering', supertack: 'SuperTack' };
  options($('pPlate'), p.plate?.enum || [], p.plate?.default, (v) => plates[v] || v);
  fillSlots();
}

function sliceInputs() {
  return {
    model: { document_id: doc.id, revision: doc.revision },
    slot: $('pSlot').value || 'auto',
    quality: $('pQuality').value,
    plate: $('pPlate').value,
    supports: $('pSupports').checked,
    orient: $('pOrient').checked,
    upload: true,
  };
}

// Direct printing is off when the printer refuses commands from other software (Developer Mode off).
function canPrintHere() {
  return allowed.has('print_file') && status?.control !== 'read_only';
}

function showPreview(result, runId) {
  sliced = result;
  $('preview').hidden = false;
  $('plateImg').hidden = !result.preview;
  if (result.preview) showRunFile(runId, result.preview, $('plateImg'));
  $('estimate').textContent = `${fmtMin(result.time_min)} · ${result.filament_g} g`;
  $('estimateDetail').textContent = [result.slot, (result.quality || '').replace(/\s*@.*$/, ''), result.plate,
    result.laid_flat ? 'laid flat' : null].filter(Boolean).join(' · ') + (result.warning ? ` — ${result.warning}` : '');
  const printable = Boolean(result.printer_file) && canPrintHere();
  $('btnPrintThis').hidden = !printable;
  $('bedNote').hidden = !printable;
  $('printNote').hidden = printable;
  $('printNote').textContent = status?.control === 'read_only'
    ? 'Printing from STEVE needs Developer Mode on the printer. Or use Open in Bambu Studio.'
    : !allowed.has('print_file') ? 'Allow "Print file on printer" for this panel to print from here.' : '';
  // A fresh photo, so the person can see the bed is clear before printing.
  if (printable && allowed.has('snapshot')) run('snapshot');
  refreshButtons();
}

function enabled(action) {
  return allowed.has(action) && !busy.has(action) && status?.connected;
}

function refreshButtons() {
  const st = status?.state;
  const idle = !['RUNNING', 'PREPARE', 'PAUSE'].includes(st);
  const can = (id, action, when) => { $(id).disabled = !(enabled(action) && when); };
  can('btnPause', 'pause', ['RUNNING', 'PREPARE'].includes(st));
  can('btnResume', 'resume', st === 'PAUSE');
  can('btnStop', 'stop', ['RUNNING', 'PAUSE', 'PREPARE'].includes(st));
  can('btnSnap', 'snapshot', true);
  for (const b of $('speed').querySelectorAll('button')) b.disabled = !enabled('set_speed');
  for (const b of $('light').querySelectorAll('button')) b.disabled = !enabled('set_light');
  const working = PRINT_CARD.some((a) => busy.has(a));
  $('btnStudio').disabled = !doc || working || !allowed.has('open_in_studio');
  $('btnSlice').disabled = !doc || working || !allowed.has('slice_part');
  $('btnPrintThis').disabled = !sliced?.printer_file || working || !canPrintHere() || !idle || !status?.connected;
}

function say(text) {
  $('msg').textContent = text || '';
}

async function run(action, inputs = {}) {
  if (busy.has(action)) return;
  busy.set(action, null);
  refreshButtons();
  try {
    const r = await call('run', { action, inputs });
    busy.set(action, r.id);
    runActions.set(r.id, action);
    guarded(() => showRun({ ...r, action }));
    if (!ENDED.includes(r.state)) watchRun(r.id, action);
  } catch (e) {
    busy.delete(action);
    const text = e.code === 'caller_not_allowed' ? `"${action}" isn't allowed for this panel yet.` : e.message || String(e);
    if (PRINT_CARD.includes(action)) $('printMsg').textContent = text;
    else say(text);
    refreshButtons();
  }
}

function actionOf(r) {
  if (runActions.has(r.id)) return runActions.get(r.id);
  if (r.action && busy.has(r.action)) return r.action;
  for (const [a, id] of busy) if (id === r.id) return a;
  return r.action;
}

function showRun(r) {
  if (finished.has(r.id)) return; // its end was already shown (a push and a poll can both report it)
  const action = actionOf(r);
  if (ENDED.includes(r.state)) finished.add(r.id);
  if (PRINT_CARD.includes(action)) return showPrintRun(action, r);
  if (r.state === 'awaiting_confirmation') say('Waiting for you to confirm in STEVE');
  else if (r.state === 'failed' || r.state === 'rejected') say(r.error || r.message || `${action} failed`);
  else if (r.message) say(r.message);
  if (r.state === 'succeeded' && action === 'snapshot' && r.result?.photo) {
    showRunFile(r.id, r.result.photo, $('cam')).then((ok) => {
      if (!ok) return;
      $('cam').classList.add('shown');
      $('camEmpty').hidden = true;
    });
  }
  if (r.state === 'succeeded' && r.result?.status) draw(r.result.status);
  if (ENDED.includes(r.state)) {
    busy.delete(action);
    if (r.state === 'succeeded' && !r.message) say('');
    refreshButtons();
  }
}

function showPrintRun(action, r) {
  const m = $('printMsg');
  if (r.state === 'awaiting_confirmation') m.textContent = 'Confirm in STEVE: it asks before a panel sends one of your documents.';
  else if (r.state === 'failed' || r.state === 'rejected') m.textContent = r.error || r.message || `${action} failed`;
  else if (r.state === 'succeeded') m.textContent = r.message || 'Done';
  else if (r.message) m.textContent = r.message;
  else if (r.state === 'queued') m.textContent = 'Sent to the connector…';
  if (action === 'slice_part' && r.state === 'succeeded' && r.result) showPreview(r.result, r.id);
  if (ENDED.includes(r.state)) { busy.delete(action); refreshButtons(); }
}

$('btnStudio').addEventListener('click', () => {
  clearPreview();
  run('open_in_studio', { model: { document_id: doc.id, revision: doc.revision } });
});
$('btnSlice').addEventListener('click', () => { clearPreview(); run('slice_part', sliceInputs()); });
$('btnPrintThis').addEventListener('click', () => {
  if (!sliced?.printer_file) return;
  run('print_file', { path: sliced.printer_file, slots: sliced.slot, plate: 1 });
});

// Stop asks twice: the first click arms it for 4 seconds.
let stopTimer = null;
$('btnStop').addEventListener('click', () => {
  const b = $('btnStop');
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = 'Stop print?';
    stopTimer = setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Stop'; }, 4000);
    return;
  }
  clearTimeout(stopTimer);
  b.classList.remove('armed');
  b.textContent = 'Stop';
  run('stop');
});
$('btnPause').addEventListener('click', () => run('pause'));
$('btnResume').addEventListener('click', () => run('resume'));
$('btnSnap').addEventListener('click', () => run('snapshot'));
$('speed').addEventListener('click', (e) => { const l = e.target.dataset?.level; if (l) run('set_speed', { level: l }); });
$('light').addEventListener('click', (e) => { const o = e.target.dataset?.on; if (o) run('set_light', { light: 'chamber', on: o === 'on' }); });

(async function init() {
  try {
    const ctx = await call('context');
    applyTheme(ctx.theme);
    const events = await call('events');
    const st = (events || []).find((e) => e.name === 'status');
    if (st) draw(st.data);
    const actions = await call('actions');
    for (const a of actions || []) {
      defs.set(a.name, a);
      if (a.allowed) allowed.add(a.name);
    }
    fillPrintForm();
    setDocument(ctx.document);
    if (allowed.has('snapshot')) run('snapshot');
  } catch (e) {
    say(e.message || String(e));
  }
})();
