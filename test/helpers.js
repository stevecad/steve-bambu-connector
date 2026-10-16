// Shared test helpers: a Printer fed with a real (sanitized) H2D report, and a fake MQTT client that answers commands.
'use strict';
const fs = require('fs');
const path = require('path');
const { Printer } = require('../lib/bambu');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

// reply(payload) -> the printer's answer for a command (or null for no answer).
function fakePrinter({ reply = () => ({ result: 'success' }), report = fixture('h2d-report.json') } = {}) {
  const p = new Printer({ host: '192.0.2.10', serial: 'TESTSERIAL', accessCode: '12345678', name: 'Test H2D', log: () => {} });
  p.sent = [];
  p.connected = true;
  p.client = {
    publish(_topic, text) {
      const payload = JSON.parse(text);
      p.sent.push(payload);
      const [group] = Object.keys(payload);
      const answer = reply(payload);
      if (answer) {
        setImmediate(() => p.handleMessage(Buffer.from(JSON.stringify({
          [group]: { ...payload[group], ...answer },
        }))));
      }
    },
  };
  p.handleMessage(Buffer.from(JSON.stringify(fixture('h2d-version.json'))));
  p.handleMessage(Buffer.from(JSON.stringify(report)));
  return p;
}

const refuse = () => ({ result: 'failed', reason: 'mqtt message verify failed', err_code: 84033543 });

module.exports = { fixture, fakePrinter, refuse };
