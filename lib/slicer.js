// Slices a 3MF or STL with the Bambu Studio command line, using Bambu's own system profiles.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readZip } = require('./zip');

// Where Bambu Studio usually lives on each platform.
const DEFAULTS = {
  win32: {
    exe: 'C:/Program Files/Bambu Studio/bambu-studio.exe',
    profiles: 'C:/Program Files/Bambu Studio/resources/profiles/BBL',
  },
  darwin: {
    exe: '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
    profiles: '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL',
  },
  linux: { exe: 'bambu-studio', profiles: null },
};

class Slicer {
  constructor({ exe, profilesDir, log }) {
    const d = DEFAULTS[process.platform] || {};
    this.exe = exe || d.exe;
    this.profilesDir = profilesDir || d.profiles;
    this.log = log;
    this.index = null;
  }

  // Whether slicing can work here: the profiles folder exists (and the program, when given as a path).
  available() {
    if (!this.exe || !this.profilesDir || !fs.existsSync(path.join(this.profilesDir, 'machine'))) return false;
    return !path.isAbsolute(this.exe) || fs.existsSync(this.exe);
  }

  // The system machine profile for a printer model, e.g. "Bambu Lab X1 Carbon" + 0.4 -> "Bambu Lab X1 Carbon 0.4 nozzle".
  machineFor(model, nozzleDiameter = 0.4) {
    const names = Object.keys(this.loadIndex().machine);
    const want = `${model} ${Number(nozzleDiameter)} nozzle`.toLowerCase();
    return names.find((n) => n.toLowerCase() === want) || null;
  }

  // Process (quality) profiles for a machine, by short name: "0.20mm Standard" -> "0.20mm Standard @BBL X1C".
  processesFor(machineName) {
    const out = {};
    for (const [name, { profile }] of Object.entries(this.loadIndex().process)) {
      if (profile.instantiation !== 'true' || !(profile.compatible_printers || []).includes(machineName)) continue;
      out[name.replace(/\s*@.*$/, '')] = name;
    }
    return out;
  }

  // name -> file, for every machine, process and filament profile.
  loadIndex() {
    if (this.index) return this.index;
    this.index = {};
    for (const kind of ['machine', 'process', 'filament']) {
      this.index[kind] = {};
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.json')) {
            try {
              const j = JSON.parse(fs.readFileSync(full, 'utf8'));
              if (j.name) this.index[kind][j.name] = { file: full, profile: j };
            } catch {}
          }
        }
      };
      const dir = path.join(this.profilesDir, kind);
      if (fs.existsSync(dir)) walk(dir);
    }
    return this.index;
  }

  // A system profile with its "inherits" chain resolved: the CLI wants every setting present.
  // Order matters: the parent ("inherits"), then the templates the profile pulls in ("include", e.g. the H2D's
  // start/end/filament-change G-code), then the profile's own settings, then overrides. Skipping "include" leaves
  // the parent's G-code in place, which is another printer's start routine.
  resolve(kind, name, overrides = {}) {
    const entry = this.loadIndex()[kind][name];
    if (!entry) throw new Error(`no ${kind} profile named "${name}"`);
    const { inherits, include, ...own } = entry.profile;
    const base = inherits ? this.resolve(kind, inherits) : {};
    const included = {};
    for (const templateName of include || []) {
      const t = this.loadIndex()[kind][templateName];
      if (!t) throw new Error(`${kind} profile "${name}" includes "${templateName}", which isn't installed`);
      const { name: _n, instantiation: _i, inherits: _h, include: _c, ...settings } = t.profile;
      Object.assign(included, settings);
    }
    const merged = { ...base, ...included, ...own, ...overrides };
    merged.from = 'system';
    return merged;
  }

  // Filament profiles that list this machine as compatible, by short name ("Bambu PLA Basic").
  filamentsFor(machineName) {
    const out = {};
    for (const [name, { profile }] of Object.entries(this.loadIndex().filament)) {
      if (profile.instantiation !== 'true') continue;
      if (!(profile.compatible_printers || []).includes(machineName)) continue;
      out[name.replace(/\s*@.*$/, '')] = name;
    }
    return out;
  }

  // filament_id ("GFA00", as the AMS reports a tray) -> profile name, for this machine.
  filamentIdsFor(machineName) {
    if (this.idCache?.[machineName]) return this.idCache[machineName];
    const out = {};
    for (const name of Object.values(this.filamentsFor(machineName))) {
      try {
        const id = this.resolve('filament', name).filament_id;
        if (id && (!out[id] || name.startsWith('Bambu'))) out[id] = name;
      } catch {}
    }
    this.idCache = { ...this.idCache, [machineName]: out };
    return out;
  }

  run(args, cwd, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('cancelled')); return; }
      const p = spawn(this.exe, args, { cwd, windowsHide: true });
      const timer = setTimeout(() => { p.kill(); reject(new Error('slicing timed out')); }, timeoutMs);
      signal?.addEventListener('abort', () => { p.kill(); clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
      p.on('error', (e) => { clearTimeout(timer); reject(new Error(`Bambu Studio not found: ${e.message}`)); });
      p.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });
  }

  // Refuses a sliced file that isn't what the printer expects: the printer model and its start G-code must be the
  // resolved profile's, and on two-nozzle printers the filament must be on the nozzle asked for. A wrong profile would
  // run another printer's start routine on this one.
  // hotend: the hotend the part was sliced for ({id, diameter, flow}); the file must say the same.
  static checkOutput(entries, machineProfile, filamentMap, hotend) {
    const settings = JSON.parse(entries.get('Metadata/project_settings.config')?.toString() || '{}');
    if (settings.printer_model !== machineProfile.printer_model) {
      throw new Error(`sliced for "${settings.printer_model}", not "${machineProfile.printer_model}"; not using it`);
    }
    if ((settings.machine_start_gcode || '') !== (machineProfile.machine_start_gcode || '')) {
      throw new Error("the sliced file's start G-code isn't this printer's; not using it");
    }
    const nozzles = Slicer.slicedNozzles(entries);
    if (filamentMap && nozzles.length && !nozzles.every((n) => n.id === filamentMap - 1)) {
      throw new Error(`sliced for nozzle ${nozzles.map((n) => n.id).join(', ')}, not nozzle ${filamentMap - 1}; not using it`);
    }
    if (hotend) {
      for (const n of nozzles) {
        if (n.flow !== hotend.flow || n.diameter !== hotend.diameter) {
          throw new Error(`sliced for a ${n.diameter} mm ${n.flow} hotend, but nozzle ${hotend.id} is ${hotend.diameter} mm ${hotend.flow}; not using it`);
        }
      }
    }
  }

  // The nozzles a sliced file prints with, from Metadata/slice_info.config: [{id, diameter, flow}].
  static slicedNozzles(entries) {
    const info = entries.get('Metadata/slice_info.config')?.toString() || '';
    return [...info.matchAll(/<nozzle\b([^>]*)>/g)].map((m) => {
      const attr = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]) || [])[1];
      return { id: Number(attr('id')), diameter: Number(attr('nozzle_diameter')) || null, flow: attr('volume_type') || null };
    });
  }

  // Opens a model in Bambu Studio's window, where the person checks placement and prints with Bambu's own Print
  // button (no Developer Mode needed). It opens on the computer running the connector.
  openInGui(filePath) {
    const app = /\.app\//.test(this.exe) ? this.exe.replace(/\.app\/.*$/, '.app') : null;
    const [cmd, args] = process.platform === 'darwin' && app ? ['open', ['-a', app, filePath]] : [this.exe, [filePath]];
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    p.on('error', (e) => this.log(`could not open Bambu Studio: ${e.message}`));
    p.unref();
  }

  // model: Buffer, name: input file name. Returns {file (Buffer of .gcode.3mf), plates, preview (PNG of plate 1)}.
  // filamentMap: on two-nozzle printers, the filament map the part is sliced with (map 1 = nozzle 0, map 2 = nozzle 1).
  // orient: let Bambu Studio turn the part to its best printing orientation (otherwise it prints as modelled).
  // machineOverrides: settings for the hotends actually installed (see Actions.hotendOverrides); hotend: the one this
  // part prints with, which the output is checked against.
  async slice(model, name, { machine, process, filament, processOverrides = {}, filamentOverrides = {}, machineOverrides = {},
    filamentMap, hotend, orient = false, signal, timeoutMs = 15 * 60000 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steve-slice-'));
    try {
      const ext = /\.stl$/i.test(name) ? '.stl' : '.3mf';
      const input = 'model' + ext;
      fs.writeFileSync(path.join(dir, input), model);
      const machineProfile = this.resolve('machine', machine, machineOverrides);
      fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify(machineProfile));
      fs.writeFileSync(path.join(dir, 'process.json'), JSON.stringify(this.resolve('process', process, processOverrides)));
      fs.writeFileSync(path.join(dir, 'filament.json'), JSON.stringify(this.resolve('filament', filament, filamentOverrides)));
      fs.mkdirSync(path.join(dir, 'out'));
      const code = await this.run([
        '--slice', '0', '--arrange', '1', '--orient', orient ? '1' : '0',
        '--load-settings', 'machine.json;process.json',
        '--load-filaments', 'filament.json',
        ...(filamentMap ? ['--filament-map-mode', 'Manual', '--filament-map', String(filamentMap)] : []),
        '--outputdir', 'out', '--export-3mf', 'sliced.gcode.3mf', input,
      ], dir, timeoutMs, signal);
      const resultPath = path.join(dir, 'out', 'result.json');
      const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
      const outPath = path.join(dir, 'out', 'sliced.gcode.3mf');
      if (code !== 0 || !fs.existsSync(outPath)) {
        throw new Error(`slicing failed: ${result?.error_string || `Bambu Studio exit ${code}`}`);
      }
      const plates = (result?.sliced_plates || []).map((p) => ({
        plate: p.id,
        time_min: Math.round((p.total_predication || 0) / 60),
        filament_g: Math.round((p.filaments || []).reduce((s, f) => s + (f.total_used_g || 0), 0) * 10) / 10,
        objects: (p.objects || []).map((o) => o.name),
        warning: p.warning_message || undefined,
      }));
      const file = fs.readFileSync(outPath);
      const entries = readZip(file);
      Slicer.checkOutput(entries, machineProfile, filamentMap, hotend);
      return { file, plates, preview: entries.get('Metadata/plate_1.png') || null };
    } finally {
      // Bambu Studio may still be exiting (Windows holds its files a moment); don't let cleanup hide the real error.
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
  }
}

module.exports = { Slicer, DEFAULTS };
