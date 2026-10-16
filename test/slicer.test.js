'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Slicer } = require('../lib/slicer');
const { readZip, writeZip } = require('../lib/zip');

// A tiny Bambu-style profiles folder: a common base with generic G-code, and a printer that inherits it and pulls
// its own G-code in from template files with "include" (as the H2D does).
function profiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-'));
  const write = (kind, name, body) => {
    fs.mkdirSync(path.join(dir, kind), { recursive: true });
    fs.writeFileSync(path.join(dir, kind, name + '.json'), JSON.stringify({ name, ...body }));
  };
  write('machine', 'common', { instantiation: 'false', machine_start_gcode: ';generic start', machine_end_gcode: ';generic end', retraction_length: ['0.8'] });
  write('machine', 'H2D template start', { instantiation: 'false', machine_start_gcode: ';===== machine: H2D' });
  write('machine', 'H2D template end', { instantiation: 'false', machine_end_gcode: ';H2D end' });
  write('machine', 'Bambu Lab H2D 0.4 nozzle', {
    inherits: 'common', instantiation: 'true', printer_model: 'Bambu Lab H2D',
    include: ['H2D template start', 'H2D template end'], retraction_length: ['0.6'],
  });
  return new Slicer({ exe: 'none', profilesDir: dir, log: () => {} });
}

test('profiles: included templates replace the parent’s G-code; own settings win', () => {
  const m = profiles().resolve('machine', 'Bambu Lab H2D 0.4 nozzle');
  assert.equal(m.machine_start_gcode, ';===== machine: H2D', 'not the parent’s generic start G-code');
  assert.equal(m.machine_end_gcode, ';H2D end');
  assert.deepEqual(m.retraction_length, ['0.6']);
  assert.equal(m.include, undefined);
  assert.equal(m.inherits, undefined);
});

test('profiles: a missing included template is an error, not a silent fallback', () => {
  const s = profiles();
  s.loadIndex().machine['Bambu Lab H2D 0.4 nozzle'].profile.include.push('not installed');
  assert.throws(() => s.resolve('machine', 'Bambu Lab H2D 0.4 nozzle'), /includes "not installed"/);
});

function sliced({ model = 'Bambu Lab H2D', start = ';===== machine: H2D', nozzle = 0 } = {}) {
  return readZip(writeZip(new Map([
    ['Metadata/project_settings.config', Buffer.from(JSON.stringify({ printer_model: model, machine_start_gcode: start }))],
    ['Metadata/slice_info.config', Buffer.from(`<config><plate><nozzle id="${nozzle}" extruder_id="${nozzle + 1}"/></plate></config>`)],
  ])));
}

test('a sliced file is used only if it is for this printer, with its start G-code, on the right nozzle', () => {
  const profile = { printer_model: 'Bambu Lab H2D', machine_start_gcode: ';===== machine: H2D' };
  assert.doesNotThrow(() => Slicer.checkOutput(sliced(), profile, 1));
  assert.throws(() => Slicer.checkOutput(sliced({ start: ';generic start' }), profile, 1), /start G-code/);
  assert.throws(() => Slicer.checkOutput(sliced({ model: 'Bambu Lab X1 Carbon' }), profile, 1), /sliced for "Bambu Lab X1 Carbon"/);
  assert.throws(() => Slicer.checkOutput(sliced({ nozzle: 1 }), profile, 1), /nozzle 1, not nozzle 0/);
  assert.doesNotThrow(() => Slicer.checkOutput(sliced({ nozzle: 1 }), profile, 2));
});
