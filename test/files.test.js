'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { readZip, writeZip } = require('../lib/zip');
const { BambuConnect } = require('../lib/bambuconnect');

test('zip: what is written reads back the same', () => {
  const entries = new Map([
    ['Metadata/plate_1.gcode', Buffer.from('G28\n'.repeat(5000))],
    ['3D/3dmodel.model', crypto.randomBytes(20000)],
    ['empty.txt', Buffer.alloc(0)],
    ['Métadonnées/ü.json', Buffer.from('{"ok":true}')],
  ]);
  const back = readZip(writeZip(entries));
  assert.deepEqual([...back.keys()], [...entries.keys()]);
  for (const [k, v] of entries) assert.ok(back.get(k).equals(v), k);
});

test('zip: rejects something that is not a zip', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /not a ZIP/);
});

// What Bambu Connect does with an import-file link (from its app code): decode the whole link once, then parse it
// as a query string.
function bambuConnectParse(url) {
  const t = decodeURIComponent(url.replace('bambu-connect://import-file/', '').replace('bambu-connect://import-file', '').replace(/\/$/, ''));
  return Object.fromEntries(new URLSearchParams(t));
}

test('Bambu Connect links survive its double decoding, even with awkward characters', () => {
  const file = 'C:\\Users\\A & B\\100% done+final\\Part #2.gcode.3mf';
  const parsed = bambuConnectParse(BambuConnect.importUrl(file, 'Part #2 & co'));
  assert.equal(parsed.path, file);
  assert.equal(parsed.name, 'Part #2 & co');
  assert.equal(parsed.version, '1.1.0');
});

const { buildPanel } = require('../lib/panel');
const path = require('path');

test('the panel bundle: all files, text as text, within STEVE limits, stable hash', () => {
  const dir = path.join(__dirname, '..', 'panel');
  const a = buildPanel(dir, { title: 'Printer' });
  const b = buildPanel(dir, { title: 'Printer' });
  assert.deepEqual(Object.keys(a.panel.files).sort(), ['index.html', 'panel.css', 'panel.js']);
  assert.match(a.panel.files['index.html'], /<script src="panel.js">/);
  assert.deepEqual(a.panel.placement, ['right']);
  assert.equal(a.hash, b.hash, 'unchanged files give the same hash, so the panel is not republished');
  assert.notEqual(buildPanel(dir, { title: 'Other' }).hash, a.hash);
});
