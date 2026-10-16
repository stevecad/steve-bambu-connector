// Hands sliced files to Bambu Connect, Bambu's desktop app for printing from other software. It sends the job to
// the printer with Bambu's own authorization, so it works without Developer Mode; the person confirms the print in
// its window. https://wiki.bambulab.com/en/software/bambu-connect
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

class BambuConnect {
  constructor({ outbox, log }) {
    this.outbox = outbox; // where handed-over files stay until Bambu Connect has read them
    this.log = log;
  }

  // Whether Bambu Connect is installed (it registers the bambu-connect:// link handler).
  available() {
    if (process.platform === 'win32') {
      return spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\bambu-connect'], { windowsHide: true }).status === 0 ||
        spawnSync('reg', ['query', 'HKCR\\bambu-connect'], { windowsHide: true }).status === 0;
    }
    if (process.platform === 'darwin') {
      return fs.existsSync('/Applications/Bambu Connect.app') ||
        fs.existsSync(path.join(process.env.HOME || '', 'Applications/Bambu Connect.app'));
    }
    return false;
  }

  // Saves the sliced file and opens it in Bambu Connect. Returns the saved path.
  send(file, fileName) {
    fs.mkdirSync(this.outbox, { recursive: true });
    this.prune();
    const dest = path.join(this.outbox, fileName);
    fs.writeFileSync(dest, file);
    const url = BambuConnect.importUrl(path.resolve(dest), fileName.replace(/\.gcode\.3mf$|\.3mf$/i, ''));
    const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    this.log(`handed ${fileName} to Bambu Connect`);
    return dest;
  }

  // Bambu Connect decodes the whole link once and then parses it as a query string (which decodes again),
  // so each value is encoded twice to survive both.
  static importUrl(filePath, name) {
    const enc = (s) => encodeURIComponent(encodeURIComponent(s));
    return `bambu-connect://import-file?path=${enc(filePath)}&name=${enc(name)}&version=1.1.0`;
  }

  // Files older than a week have long been read.
  prune() {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(this.outbox)) {
      const p = path.join(this.outbox, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
  }
}

module.exports = { BambuConnect };
