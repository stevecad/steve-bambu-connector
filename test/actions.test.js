'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Actions, buildCatalog } = require('../lib/actions');
const { writeZip } = require('../lib/zip');
const { fakePrinter, refuse } = require('./helpers');

const NAME = /^[a-z][a-z0-9_.-]{0,39}$/;
const INPUT = /^[a-z][a-z0-9_]{0,39}$/;
const single = { model: 'Bambu Lab X1 Carbon', dual: false, chamberHeater: false, nozzleDiameter: 0.4, sdcardPrinting: true, camera: 'rtsp', chamberLights: ['chamber_light'] };

// A minimal sliced project: two filaments, filament 1 used on plate 1, on filament map 1 (nozzle 0, fed by AMS A).
function slicedProject() {
  const plate = `<config><plate><metadata key="index" value="1"/><metadata key="filament_maps" value="1 2"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#8E9089"/></plate></config>`;
  return writeZip(new Map([
    ['Metadata/slice_info.config', Buffer.from(plate)],
    ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
      filament_type: ['PLA', 'PETG'], filament_colour: ['#8E9089', '#F98C36'], filament_ids: ['GFA00', 'GFG99'] }))],
    ['Metadata/plate_1.gcode', Buffer.from('G28\n')],
    ['Metadata/plate_1.gcode.md5', Buffer.from('ABC123')],
    ['Metadata/plate_1.json', Buffer.from(JSON.stringify({ bed_type: 'textured_plate' }))],
  ]));
}

// A slicer stand-in: knows a few filament profiles, and records what it was asked to slice.
const fakeSlicer = () => ({
  calls: [],
  filamentIdsFor: () => ({ GFA00: 'Bambu PLA Basic @BBL H2D', GFG99: 'Generic PETG @BBL H2D' }),
  filamentsFor: () => ({ 'Bambu PLA Basic': 'Bambu PLA Basic @BBL H2D', 'Generic PETG': 'Generic PETG @BBL H2D' }),
  async slice(model, name, opts) {
    this.calls.push(opts);
    return { file: slicedProject(), plates: [{ plate: 1, time_min: 9, filament_g: 3.7 }], preview: Buffer.from('png') };
  },
  openInGui(file) { this.opened = file; },
});

function actionsFor(printer, extra = {}) {
  const a = new Actions({
    printer, slicer: fakeSlicer(), config: {}, caps: printer.capabilities(), machine: 'Bambu Lab H2D 0.4 nozzle',
    qualities: { '0.20mm Standard': '0.20mm Standard @BBL H2D' }, filesDir: require('os').tmpdir(), log: () => {}, ...extra,
  });
  a.startWaitMs = 0;
  return a;
}

const ctx = () => ({
  files: [], progress: () => {}, input: async () => Buffer.from('3mf'),
  async file(name, buf) { this.files.push(name); }, signal: new AbortController().signal,
});

test('catalog names and inputs follow STEVE’s rules', () => {
  for (const caps of [fakePrinter().capabilities(), single]) {
    const c = buildCatalog(caps, { qualities: { '0.20mm Standard': 'x' }, studio: true });
    assert.ok(c.actions.length <= 100);
    for (const a of c.actions) {
      assert.match(a.name, NAME);
      const inputs = Object.keys(a.inputs?.properties || {});
      assert.ok(inputs.length <= 30, a.name);
      for (const i of inputs) assert.match(i, INPUT, `${a.name}.${i}`);
    }
  }
});

test('two-nozzle printers get left/right inputs; one-nozzle printers do not', () => {
  const dual = buildCatalog(fakePrinter().capabilities());
  const one = buildCatalog(single);
  const heaters = (c) => c.actions.find((a) => a.name === 'set_temperature').inputs.properties.heater.enum;
  assert.deepEqual(heaters(dual), ['right_nozzle', 'left_nozzle', 'bed', 'chamber']);
  assert.deepEqual(heaters(one), ['nozzle', 'bed']);
  assert.ok(dual.actions.some((a) => a.name === 'select_nozzle'));
  assert.ok(!one.actions.some((a) => a.name === 'select_nozzle'));
});

test('slicing and Bambu Studio actions appear only when available', () => {
  const caps = fakePrinter().capabilities();
  const none = buildCatalog(caps).actions.map((a) => a.name);
  assert.ok(!none.includes('slice_part') && !none.includes('open_in_studio'));
  const all = buildCatalog(caps, { qualities: { '0.20mm Standard': 'x' }, studio: true }).actions.map((a) => a.name);
  assert.ok(all.includes('slice_part') && all.includes('print_part') && all.includes('open_in_studio'));
});

test('confirm marks exactly the configured actions', () => {
  const c = buildCatalog(single, { confirm: ['home'] });
  assert.deepEqual(c.actions.filter((a) => a.confirm).map((a) => a.name), ['home']);
  const d = buildCatalog(single);
  assert.deepEqual(d.actions.filter((a) => a.confirm), [], 'nothing waits for a person by default');
});

test('AMS units map to nozzles (H2D: A feeds right, B feeds left)', () => {
  const a = actionsFor(fakePrinter());
  assert.deepEqual(a.amsUnits().map((u) => [u.id, u.extruder]), [[0, 0], [1, 1]]);
  assert.equal(a.tray('B2').extruder, 1);
  assert.throws(() => a.tray('A1'), /empty/);
  assert.throws(() => a.tray('C1'), /no AMS C/);
  assert.throws(() => a.tray('Z9'), /unknown slot/);
});

test('auto slot picks the first loaded slot with the material', () => {
  const a = actionsFor(fakePrinter());
  assert.equal(a.pickSlot('auto', 'PLA').name, 'A3');
  assert.equal(a.pickSlot('auto', 'PETG').name, 'A2');
  assert.throws(() => a.pickSlot('auto', 'TPU'), /no AMS slot has TPU/);
});

test('from_slot uses the profile for the loaded filament', () => {
  const a = actionsFor(fakePrinter());
  assert.equal(a.filamentProfile('from_slot', a.tray('A3')), 'Bambu PLA Basic @BBL H2D');
  assert.equal(a.filamentProfile('from_slot', a.tray('A2')), 'Generic PETG @BBL H2D');
});

test('slicing puts the filament on the nozzle its slot feeds, tinted with the slot colour', async () => {
  const a = actionsFor(fakePrinter());
  await a.slicePart({ model: { name: 'Part.3mf' }, slot: 'B2', upload: false }, ctx(), false);
  await a.slicePart({ model: { name: 'Part.3mf' }, slot: 'A3', upload: false, orient: true }, ctx(), false);
  // Bambu Studio's filament map 1 is nozzle 0 and map 2 is nozzle 1 (checked against a Studio-sliced H2D job).
  assert.equal(a.slicer.calls[0].filamentMap, 2, 'AMS B feeds nozzle 1: filament map 2');
  assert.equal(a.slicer.calls[1].filamentMap, 1, 'AMS A feeds nozzle 0: filament map 1');
  assert.deepEqual(a.slicer.calls[1].filamentOverrides, { filament_colour: ['#8E9089'] });
  assert.equal(a.slicer.calls[1].orient, true);
});

test('slice_part returns the preview and the file it uploaded', async () => {
  const p = fakePrinter();
  p.upload = async (buf, path) => { p.uploaded = path; };
  const a = actionsFor(p);
  const c = ctx();
  const out = await a.slicePart({ model: { name: 'My Part!.3mf' }, slot: 'A3' }, c, false);
  assert.equal(out.result.printer_file, '/My_Part.gcode.3mf');
  assert.equal(p.uploaded, '/My_Part.gcode.3mf');
  assert.equal(out.result.preview, 'plate.png');
  assert.deepEqual(c.files, ['My_Part.gcode.3mf', 'plate.png']);
});

test('a guess alone does not block printing; the printer gets to answer', async () => {
  const p = fakePrinter();
  p.upload = async () => {};
  assert.equal(p.control, 'read_only', 'fixture guess');
  const out = await actionsFor(p).slicePart({ model: { name: 'x.3mf' }, slot: 'A3' }, ctx(), true);
  assert.equal(out.result.printer_state, 'FINISH');
  assert.ok(p.sent.some((s) => s.print?.command === 'project_file'));
});

test('printing is refused up front when the printer only takes commands from Bambu apps', async () => {
  const p = fakePrinter({ reply: refuse });
  await assert.rejects(p.gcode('M400'));
  const a = actionsFor(p);
  await assert.rejects(a.slicePart({ model: { name: 'x.3mf' }, slot: 'A3' }, ctx(), true), /Developer Mode.*Open in Bambu Studio/);
  await assert.rejects(a.printFile({ path: '/x.gcode.3mf' }, ctx()), /Developer Mode/);
});

test('printing is refused while the printer is busy or paused', async () => {
  for (const state of ['RUNNING', 'PREPARE', 'PAUSE']) {
    const p = fakePrinter();
    p.report.gcode_state = state;
    await assert.rejects(actionsFor(p).printFile({ path: '/x.gcode.3mf' }, ctx()), /busy/);
  }
});

test('print_file matches project filaments to AMS slots on the nozzle they were sliced for, and sends project_file', async () => {
  const p = fakePrinter();
  p.download = async () => slicedProject();
  const a = actionsFor(p);
  const out = await a.printFile({ path: 'job.gcode.3mf' }, ctx());
  const cmd = p.sent.find((s) => s.print?.command === 'project_file').print;
  assert.equal(cmd.url, 'ftp:///job.gcode.3mf');
  assert.equal(cmd.param, 'Metadata/plate_1.gcode');
  assert.equal(cmd.md5, 'ABC123');
  assert.equal(cmd.bed_type, 'textured_plate');
  assert.deepEqual(cmd.ams_mapping, [2, -1], 'filament 1 -> A3 (global tray 2); filament 2 unused');
  assert.deepEqual(cmd.ams_mapping2, [{ ams_id: 0, slot_id: 2 }, { ams_id: 255, slot_id: 255 }]);
  assert.deepEqual(out.result.slots, ['A3', null]);
});

test('older printers print from the SD card and get the older payload', async () => {
  const p = fakePrinter();
  p.download = async () => slicedProject();
  const a = actionsFor(p);
  a.caps = { ...a.caps, sdcardPrinting: true, dual: false };
  await a.printFile({ path: '/job.gcode.3mf', slots: 'A3' }, ctx());
  const cmd = p.sent.find((s) => s.print?.command === 'project_file').print;
  assert.equal(cmd.url, 'file:///sdcard/job.gcode.3mf');
  assert.equal(cmd.ams_mapping2, undefined);
});

test('temperature commands: per-nozzle on two-nozzle printers, G-code on one-nozzle printers', async () => {
  const p = fakePrinter();
  const a = actionsFor(p);
  await a.setTemperature({ heater: 'left_nozzle', celsius: 210 });
  assert.deepEqual(p.sent.at(-1).print, { command: 'set_nozzle_temp', extruder_index: 1, target_temp: 210, sequence_id: p.sent.at(-1).print.sequence_id });
  await a.setTemperature({ heater: 'nozzle', celsius: 200 });
  assert.equal(p.sent.at(-1).print.param, 'M104 S200\n');
  await assert.rejects(a.setTemperature({ heater: 'bed', celsius: 150 }), /up to 120/);
});

test('open_in_studio saves the part and opens it in Bambu Studio', async () => {
  const a = actionsFor(fakePrinter());
  const out = await a.openInStudio({ model: { name: 'Bracket v2.3mf' } }, ctx());
  assert.match(out.result.file, /Bracket_v2\.3mf$/);
  assert.equal(a.slicer.opened, out.result.file);
});

test('a print command the printer never answers, with no job started, is not reported as success', async () => {
  const p = fakePrinter({ reply: (cmd) => (cmd.print?.command === 'project_file' ? null : { result: 'success' }) });
  p.download = async () => slicedProject();
  const a = actionsFor(p);
  p.command = ((orig) => (payload, ms) => orig.call(p, payload, payload.print?.command === 'project_file' ? 20 : ms))(p.command);
  await assert.rejects(a.printFile({ path: '/job.gcode.3mf' }, ctx()), /didn't answer/);
});

test('a cancel before the print command stops the print from starting', async () => {
  const p = fakePrinter();
  p.download = async () => slicedProject();
  const a = actionsFor(p);
  const c = ctx();
  const controller = new AbortController();
  c.signal = controller.signal;
  controller.abort();
  await assert.rejects(a.printFile({ path: '/job.gcode.3mf' }, c), /cancelled/);
  assert.ok(!p.sent.some((m) => m.print?.command === 'project_file'), 'project_file was never sent');
});

test('two print starts at once: the second is refused instead of starting a second job', async () => {
  const p = fakePrinter();
  let release;
  p.download = () => new Promise((r) => { release = () => r(slicedProject()); });
  const a = actionsFor(p);
  const first = a.printFile({ path: '/job.gcode.3mf' }, ctx());
  await assert.rejects(a.printFile({ path: '/job.gcode.3mf' }, ctx()), /another print is being started/);
  release();
  await first;
  assert.equal(p.sent.filter((m) => m.print?.command === 'project_file').length, 1);
});
