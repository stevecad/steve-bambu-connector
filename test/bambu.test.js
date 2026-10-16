'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrinter, refuse, fixture } = require('./helpers');

test('reads an H2D report: model, two nozzles, temperatures, AMS, lights', () => {
  const p = fakePrinter();
  const s = p.summary();
  assert.equal(s.model, 'Bambu Lab H2D');
  assert.equal(s.state, 'FINISH');
  assert.equal(s.nozzles.length, 2);
  assert.deepEqual(s.nozzles.map((n) => [n.id, n.current, n.target]), [[0, 24, 0], [1, 25, 0]]);
  assert.deepEqual(s.bed, { current: 24, target: 0 });
  assert.equal(s.ams.length, 2);
  assert.equal(s.ams[0].trays[2].type, 'PLA');
  assert.equal(s.lights.chamber_light, 'off');
  assert.ok(JSON.stringify(s).length < 8000, 'a status event fits in 8 kB');
});

test('decodes packed heater values (target in the high 16 bits)', () => {
  const report = fixture('h2d-report.json');
  report.print.device.extruder.info[0].temp = (220 << 16) | 180;
  const p = fakePrinter({ report });
  assert.deepEqual(p.summary().nozzles[0].current, 180);
  assert.deepEqual(p.summary().nozzles[0].target, 220);
});

test('capabilities of an H2D', () => {
  const caps = fakePrinter().capabilities();
  assert.equal(caps.dual, true);
  assert.equal(caps.chamberHeater, true);
  assert.equal(caps.camera, 'rtsp');
  assert.equal(caps.sdcardPrinting, false);
  assert.equal(caps.nozzleDiameter, 0.4);
  assert.deepEqual(caps.chamberLights.sort(), ['chamber_light', 'chamber_light2']);
});

test('a refused command throws with the Developer Mode hint and marks the printer read-only', async () => {
  const p = fakePrinter({ reply: refuse });
  await assert.rejects(p.gcode('M106 P2 S100'), /mqtt message verify failed.*Developer Mode/);
  assert.equal(p.control, 'read_only');
  assert.equal(p.summary().control, 'read_only');
});

test('an accepted print command marks the printer as directly controllable', async () => {
  const p = fakePrinter();
  await p.command({ print: { command: 'print_speed', param: '2' } });
  assert.equal(p.control, 'direct');
});

test('the printer’s answer wins over the guess from its report', async () => {
  const p = fakePrinter();
  assert.equal(p.control, 'read_only', 'this fixture has fun bit 29 set');
  assert.equal(p.summary().control, 'unknown', 'a guess is not reported as fact');
  await p.command({ print: { command: 'print_speed', param: '2' } });
  p.handleMessage(Buffer.from(JSON.stringify(fixture('h2d-report.json'))));
  assert.equal(p.control, 'direct', 'a later report does not undo what was learned');
});

test('commands carry increasing sequence ids and match their answers', async () => {
  const p = fakePrinter();
  const a = await p.command({ print: { command: 'pause', param: '' } });
  const b = await p.command({ print: { command: 'resume', param: '' } });
  assert.equal(a.command, 'pause');
  assert.equal(b.command, 'resume');
  assert.ok(Number(p.sent[1].print.sequence_id) > Number(p.sent[0].print.sequence_id));
});

test('no answer is not an error (some firmware does not echo)', async () => {
  const p = fakePrinter({ reply: () => null });
  assert.equal(await p.command({ print: { command: 'pause' } }, 50), null);
});

test('refuses to send while disconnected', async () => {
  const p = fakePrinter();
  p.connected = false;
  await assert.rejects(p.command({ print: { command: 'pause' } }), /not connected/);
});

test('status shows the active nozzle and which slot is loaded in each', () => {
  const report = fixture('h2d-report.json');
  report.print.device.extruder.state = 2; // two nozzles, nozzle 0 active (as reported while printing)
  report.print.device.extruder.info[0].snow = 2; // AMS A, slot index 2 -> A3
  report.print.device.extruder.info[1].snow = 65279; // nothing
  const s = fakePrinter({ report }).summary();
  assert.deepEqual(s.nozzles.map((n) => [n.id, n.active, n.loaded]), [[0, true, 'A3'], [1, false, null]]);
});
