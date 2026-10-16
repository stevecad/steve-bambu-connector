// The connector's catalog, built from what the printer has, and what each action does on the printer.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readZip } = require('./zip');

const PLATES = {
  textured_pei: 'Textured PEI Plate',
  smooth_pei: 'High Temp Plate',
  cool_plate: 'Cool Plate',
  engineering: 'Engineering Plate',
  supertack: 'Supertack Plate',
};
const MATERIALS = ['from_slot', 'PLA', 'PLA Matte', 'PLA Silk', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'PA', 'PLA-CF', 'PETG-CF'];
const AMS_SLOTS = ['A', 'B', 'C', 'D'].flatMap((u) => [1, 2, 3, 4].map((n) => u + n));
const SPEED_LEVELS = { silent: 1, standard: 2, sport: 3, ludicrous: 4 };
// Two-nozzle printers (H2D): extruder index 0 is the right nozzle, 1 the left.
// The slicer numbers them the other way: 1 = left, 2 = right.
const EXTRUDER = { right: 0, left: 1 };
const SLICER_EXTRUDER = { 1: 1, 0: 2 }; // physical extruder -> slicer filament map
// External spool ids: 255 feeds the right (main) nozzle, 254 the left; a one-nozzle printer's spool is 254.
const EXTERNAL_DUAL = { ext_right: { id: 255, extruder: 0 }, ext_left: { id: 254, extruder: 1 } };
const EXTERNAL_SINGLE = { external: { id: 254, extruder: 0 } };

const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

// Actions that wait for a person on every run, whoever asks, unless the config says otherwise ("confirm": [...]).
// Who else may run what, and whether their runs ask first, is set per caller in STEVE (Settings → Connectors).
const DEFAULT_CONFIRM = ['send_gcode', 'send_command', 'delete_file'];

// caps: Printer.capabilities(). Options: qualities (short name -> process profile, or null when slicing isn't
// available), studio (Bambu Studio's window can be opened here), confirm (actions that always wait for a person).
function buildCatalog(caps, { qualities = null, studio = false, confirm = DEFAULT_CONFIRM } = {}) {
  const externals = Object.keys(caps.dual ? EXTERNAL_DUAL : EXTERNAL_SINGLE);
  const slots = [...AMS_SLOTS, ...externals];
  const heaters = [...(caps.dual ? ['right_nozzle', 'left_nozzle'] : ['nozzle']), 'bed', ...(caps.chamberHeater ? ['chamber'] : [])];
  const nozzle = { type: 'string', enum: ['left', 'right'] };
  const startInputs = {
    bed_leveling: { type: 'boolean', default: true, title: 'Bed leveling' },
    flow_calibration: { type: 'boolean', default: false, title: 'Flow calibration' },
    timelapse: { type: 'boolean', default: false, title: 'Timelapse' },
  };

  const actions = [
    { name: 'status', title: 'Printer status', description: 'State, job progress, temperatures, fans, lights, AMS filament and errors.',
      inputs: obj({ raw: { type: 'boolean', default: false, title: 'Include the raw printer report' } }),
      result: 'The printer status (and the raw report if asked).' },
    { name: 'snapshot', title: 'Camera photo', description: "A photo from the printer's camera.",
      result: 'The photo as camera.jpg.' },
    { name: 'list_files', title: 'List printer files', description: "Lists files on the printer's storage.",
      inputs: obj({ path: { type: 'string', maxLength: 300, default: '/', title: 'Folder' } }), result: 'The files and folders.' },
    { name: 'pause', title: 'Pause print', description: 'Pauses the current print.' },
    { name: 'resume', title: 'Resume print', description: 'Resumes a paused print.' },
    { name: 'stop', title: 'Stop print', description: 'Stops (cancels) the current print. It cannot be resumed.' },
    { name: 'set_speed', title: 'Print speed', description: 'Sets the print speed mode.',
      inputs: obj({ level: { type: 'string', enum: Object.keys(SPEED_LEVELS), title: 'Speed' } }, ['level']) },
    { name: 'set_light', title: 'Chamber light', description: 'Turns the chamber light on or off.',
      inputs: obj({ light: { type: 'string', enum: ['chamber'], default: 'chamber' }, on: { type: 'boolean', title: 'On' } }, ['on']) },
    { name: 'set_fan', title: 'Fan speed', description: 'Sets the part-cooling, auxiliary or chamber fan.',
      inputs: obj({ fan: { type: 'string', enum: ['part', 'aux', 'chamber'], title: 'Fan' },
        percent: { type: 'integer', minimum: 0, maximum: 100, title: 'Speed %' } }, ['fan', 'percent']) },
    { name: 'set_temperature', title: 'Set temperature', description: 'Sets a heater target. 0 turns it off.',
      inputs: obj({ heater: { type: 'string', enum: heaters, title: 'Heater' },
        celsius: { type: 'integer', minimum: 0, maximum: 350, title: 'Target °C' } }, ['heater', 'celsius']) },
    { name: 'home', title: 'Home axes', description: 'Homes all axes (G28).' },
    { name: 'move', title: 'Move axis', description: 'Jogs one axis by a distance, relative to where it is.',
      inputs: obj({ axis: { type: 'string', enum: ['X', 'Y', 'Z'] },
        distance_mm: { type: 'number', minimum: -100, maximum: 100, title: 'Distance (mm)' } }, ['axis', 'distance_mm']) },
    ...(caps.dual ? [{ name: 'select_nozzle', title: 'Switch nozzle', description: 'Makes the left or right nozzle active (idle or paused only).',
      inputs: obj({ nozzle }, ['nozzle']) }] : []),
    { name: 'load_filament', title: 'Load filament', description: 'Loads filament from an AMS slot or external spool.',
      inputs: obj({ slot: { type: 'string', enum: slots, title: 'Slot' } }, ['slot']) },
    { name: 'unload_filament', title: 'Unload filament', description: 'Unloads the filament from the nozzle.',
      ...(caps.dual ? { inputs: obj({ nozzle }, ['nozzle']) } : {}) },
    { name: 'send_gcode', title: 'Send G-code', description: 'Sends G-code lines to the printer as they are.',
      inputs: obj({ gcode: { type: 'string', maxLength: 4000, title: 'G-code' } }, ['gcode']) },
    { name: 'send_command', title: 'Send printer command', description: 'Sends a raw Bambu MQTT command object, e.g. {"print": {"command": "..."}}.',
      inputs: obj({ command: { type: 'object', title: 'Command' } }, ['command']) },
    { name: 'delete_file', title: 'Delete printer file', description: "Deletes a file from the printer's storage.",
      inputs: obj({ path: { type: 'string', maxLength: 300, title: 'File' } }, ['path']) },
    { name: 'print_file', title: 'Print file on printer', description: 'Starts printing a sliced .gcode.3mf already on the printer.',
      inputs: obj({
        path: { type: 'string', maxLength: 300, title: 'File' },
        plate: { type: 'integer', minimum: 1, maximum: 50, default: 1, title: 'Plate' },
        slots: { type: 'string', maxLength: 100, default: 'auto', title: 'Slots',
          description: `auto, or one slot per project filament in order, comma separated (e.g. A1,B2,${externals[0]}).` },
        ...startInputs }, ['path']) },
  ];

  if (qualities && Object.keys(qualities).length) {
    const names = Object.keys(qualities);
    const sliceInputs = {
      model: { 'x-steve': 'file', format: '3mf', title: 'Part' },
      slot: { type: 'string', enum: ['auto', ...slots], default: 'auto', title: 'Filament slot',
        description: 'AMS slot (A1 = AMS A slot 1) or an external spool. auto picks a loaded slot with the material.' },
      material: { type: 'string', enum: MATERIALS, default: 'from_slot', title: 'Material',
        description: 'from_slot uses the profile for the filament loaded in the slot (PLA when slot is auto).' },
      quality: { type: 'string', enum: names, default: names.find((n) => n === '0.20mm Standard') || names[0], title: 'Quality' },
      plate: { type: 'string', enum: Object.keys(PLATES), default: 'textured_pei', title: 'Build plate' },
      supports: { type: 'boolean', default: false, title: 'Supports' },
      infill_percent: { type: 'integer', minimum: 0, maximum: 100, default: 15, title: 'Infill %' },
      walls: { type: 'integer', minimum: 1, maximum: 10, default: 2, title: 'Wall loops' },
      brim: { type: 'boolean', default: false, title: 'Brim' },
      orient: { type: 'boolean', default: false, title: 'Lay flat',
        description: "Let Bambu Studio turn the part to its best printing orientation; otherwise it prints as modelled." },
    };
    actions.push(
      { name: 'slice_part', title: 'Slice and preview', description: 'Slices the part with Bambu Studio and returns a picture of the plate, the time and the filament, ' +
          'and uploads it to the printer so print_file can print exactly what was previewed. Does not start printing.',
        inputs: obj({ ...sliceInputs, upload: { type: 'boolean', default: true, title: 'Upload to printer' } }, ['model']),
        result: 'plate.png (the plate), estimated time and filament, the file name on the printer, and the sliced .gcode.3mf.' },
      { name: 'print_part', title: 'Print part', description: 'Slices the part with Bambu Studio, uploads it and starts printing, without a preview. Needs Developer Mode.',
        inputs: obj({ ...sliceInputs, ...startInputs }, ['model']), result: 'The file printed and the estimate.' },
    );
  }

  if (studio) {
    actions.push({ name: 'open_in_studio', title: 'Open in Bambu Studio',
      description: "Opens the part in Bambu Studio's window on the connector's computer, to check placement and print with Bambu Studio's own Print button. " +
        'Works without Developer Mode.',
      inputs: obj({ model: { 'x-steve': 'file', format: '3mf', title: 'Part' } }, ['model']),
      result: 'The file opened.' });
  }

  for (const a of actions) if (confirm.includes(a.name)) a.confirm = true;
  return {
    actions,
    events: [
      { name: 'status', description: 'Printer state, progress, temperatures and filament (when something changes).' },
      { name: 'alert', description: 'A print started, finished, failed or paused, or a printer error appeared.' },
    ],
  };
}

// A file name made of safe characters from a STEVE document name.
const safeName = (name, fallback) =>
  (name || fallback).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || fallback;

const slotName = (ams, tray) => String.fromCharCode(65 + ams) + (tray + 1);

const hexDist = (a, b) => {
  if (!a || !b) return 999;
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a.toUpperCase()), p(b.toUpperCase())];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

class Actions {
  // machine: the slicer's machine profile name; qualities: short name -> process profile.
  // bambuConnect: a BambuConnect, or null when it isn't installed.
  // filesDir: where parts opened in Bambu Studio are kept.
  constructor({ printer, slicer, config, caps, machine, qualities, bambuConnect, filesDir, log }) {
    this.p = printer;
    this.bc = bambuConnect || null;
    this.filesDir = filesDir;
    // direct: the connector starts prints itself (needs Developer Mode). bambu_connect: prints go through Bambu
    // Connect, which asks the person to confirm each one.
    this.printVia = config.print_via === 'bambu_connect' ? 'bambu_connect' : 'direct';
    this.slicer = slicer;
    this.config = config;
    this.caps = caps;
    this.machine = machine;
    this.qualities = qualities || {};
    this.log = log;
    this.externals = caps.dual ? EXTERNAL_DUAL : EXTERNAL_SINGLE;
    this.handlers = {
      status: this.status, snapshot: this.snapshot, list_files: this.listFiles,
      pause: () => this.simple('pause'), resume: () => this.simple('resume'), stop: () => this.simple('stop'),
      set_speed: this.setSpeed, set_light: this.setLight, set_fan: this.setFan, set_temperature: this.setTemperature,
      home: this.home, move: this.move, select_nozzle: this.selectNozzle, load_filament: this.loadFilament,
      unload_filament: this.unloadFilament, send_gcode: this.sendGcode, send_command: this.sendCommand,
      delete_file: this.deleteFile, slice_part: (i, c) => this.slicePart(i, c, false),
      print_part: (i, c) => this.slicePart(i, c, true), print_file: this.printFile, open_in_studio: this.openInStudio,
    };
  }

  // AMS units with the extruder each feeds (AMS info bits 8-11 on two-nozzle printers).
  amsUnits() {
    return (this.p.report.ams?.ams || []).map((u) => ({
      id: Number(u.id),
      extruder: this.caps.dual ? (parseInt(u.info || '0', 16) >> 8) & 0xf : 0,
      trays: (u.tray || []).map((t) => ({ ...t, slot: Number(t.id) })),
    }));
  }

  tray(slot) {
    const ext = this.externals[slot];
    if (ext) {
      const t = this.p.externalSpools().find((v) => Number(v.id) === ext.id) || {};
      return { external: ext.id, extruder: ext.extruder, info: t, name: slot };
    }
    const m = /^([A-D])([1-4])$/.exec(slot || '');
    if (!m) throw new Error(`unknown slot ${slot}`);
    const ams = m[1].charCodeAt(0) - 65, trayIdx = Number(m[2]) - 1;
    const unit = this.amsUnits().find((u) => u.id === ams);
    if (!unit) throw new Error(`there is no AMS ${m[1]}`);
    const t = unit.trays.find((x) => x.slot === trayIdx);
    if (!t || !t.tray_type) throw new Error(`slot ${slot} is empty`);
    return { ams, tray: trayIdx, extruder: unit.extruder, info: t, name: slot };
  }

  // Picks the slot to print from: the one asked for, or the first loaded one with the material.
  pickSlot(slot, material) {
    if (slot && slot !== 'auto') return this.tray(slot);
    const want = !material || material === 'from_slot' ? 'PLA' : material;
    const [type, variant] = want.toUpperCase().split(' ');
    for (const u of this.amsUnits()) {
      for (const t of u.trays) {
        if ((t.tray_type || '').toUpperCase() === type && (!variant || (t.tray_sub_brands || '').toUpperCase().includes(variant))) {
          return this.tray(slotName(u.id, t.slot));
        }
      }
    }
    throw new Error(`no AMS slot has ${want} loaded; choose a slot`);
  }

  filamentProfile(material, tray) {
    const byId = this.slicer.filamentIdsFor(this.machine);
    if (material === 'from_slot' || !material) {
      const id = tray.info.tray_info_idx;
      if (id && byId[id]) return byId[id];
      material = tray.info.tray_type || 'PLA';
    }
    const names = this.slicer.filamentsFor(this.machine);
    for (const c of [`Bambu ${material} Basic`, `Bambu ${material}`, `Generic ${material}`, `Bambu ${material} HF`]) {
      if (names[c]) return names[c];
    }
    const loose = Object.keys(names).find((n) => n.toUpperCase().includes(material.toUpperCase()));
    if (loose) return names[loose];
    throw new Error(`no ${material} profile for ${this.machine}`);
  }

  idleOnly() {
    const st = this.p.report.gcode_state;
    if (['RUNNING', 'PREPARE', 'SLICING'].includes(st)) throw new Error(`the printer is busy (${st})`);
  }

  // ---- read ----

  status = async (inputs = {}) => {
    const result = { status: this.p.summary() };
    if (inputs.raw) result.raw = this.p.report;
    return { result, message: result.status.state };
  };

  snapshot = async (_inputs, ctx) => {
    const photo = await this.p.snapshot(this.config.ffmpeg || 'ffmpeg');
    await ctx.file('camera.jpg', photo, 'image/jpeg');
    return { result: { photo: 'camera.jpg', taken_at: new Date().toISOString() }, message: 'Photo taken' };
  };

  listFiles = async (inputs = {}) => {
    const files = await this.p.listFiles(inputs.path || '/');
    return { result: { path: inputs.path || '/', files }, message: `${files.length} entries` };
  };

  // ---- control ----

  async simple(command) {
    await this.p.command({ print: { command, param: '' } });
    return { message: `${command} sent`, result: { command } };
  }

  setSpeed = async ({ level }) => {
    await this.p.command({ print: { command: 'print_speed', param: String(SPEED_LEVELS[level]) } });
    return { message: `Speed: ${level}` };
  };

  setLight = async ({ on }) => {
    const nodes = this.p.capabilities().chamberLights;
    for (const node of nodes.length ? nodes : ['chamber_light']) {
      await this.p.command({ system: { command: 'ledctrl', led_node: node, led_mode: on ? 'on' : 'off',
        led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } });
    }
    return { message: `Light ${on ? 'on' : 'off'}` };
  };

  setFan = async ({ fan, percent }) => {
    const index = { part: 1, aux: 2, chamber: 3 }[fan];
    await this.p.gcode(`M106 P${index} S${Math.round((percent / 100) * 255)}`);
    return { message: `${fan} fan ${percent}%` };
  };

  setTemperature = async ({ heater, celsius }) => {
    const limit = heater === 'bed' ? 120 : heater === 'chamber' ? 65 : 350;
    if (celsius > limit) throw new Error(`${heater} goes up to ${limit} °C`);
    if (heater === 'right_nozzle' || heater === 'left_nozzle') {
      await this.p.command({ print: { command: 'set_nozzle_temp', extruder_index: EXTRUDER[heater.split('_')[0]], target_temp: celsius } });
    } else if (heater === 'nozzle') {
      await this.p.gcode(`M104 S${celsius}`);
    } else if (heater === 'bed') {
      const fun = BigInt('0x' + (this.p.report.fun || '0'));
      if ((fun >> 39n) & 1n) await this.p.command({ print: { command: 'set_bed_temp', temp: celsius } });
      else await this.p.gcode(`M140 S${celsius}`);
    } else if (heater === 'chamber') {
      await this.p.command({ print: { command: 'set_ctt', ctt_val: celsius } });
    } else {
      throw new Error(`unknown heater ${heater}`);
    }
    return { message: `${heater.replace('_', ' ')} → ${celsius} °C` };
  };

  home = async () => {
    this.idleOnly();
    await this.p.gcode('G28');
    return { message: 'Homing' };
  };

  move = async ({ axis, distance_mm }) => {
    this.idleOnly();
    const feed = axis === 'Z' ? 600 : 3000;
    await this.p.gcode(`M211 S\nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91\nG1 ${axis}${Number(distance_mm).toFixed(2)} F${feed}\nM1002 pop_ref_mode\nM211 R`);
    return { message: `Moved ${axis} ${distance_mm} mm` };
  };

  selectNozzle = async ({ nozzle }) => {
    const st = this.p.report.gcode_state;
    if (!['IDLE', 'FINISH', 'FAILED', 'PAUSE'].includes(st)) throw new Error(`can't switch nozzles while ${st}`);
    await this.p.command({ print: { command: 'select_extruder', extruder_index: EXTRUDER[nozzle] } });
    return { message: `${nozzle} nozzle selected` };
  };

  loadFilament = async ({ slot }) => {
    this.idleOnly();
    const t = this.tray(slot);
    const temp = Number(t.info.nozzle_temp_max) || 250;
    const cmd = t.external !== undefined
      ? { command: 'ams_change_filament', curr_temp: temp, tar_temp: temp, ams_id: t.external, target: t.external, slot_id: 0, extruder_id: t.extruder }
      : { command: 'ams_change_filament', curr_temp: temp, tar_temp: temp, ams_id: t.ams, target: t.ams * 4 + t.tray, slot_id: t.tray, extruder_id: t.extruder };
    await this.p.command({ print: cmd });
    return { message: `Loading ${slot} (${t.info.tray_type || 'filament'})` };
  };

  unloadFilament = async ({ nozzle } = {}) => {
    this.idleOnly();
    const extruder = this.caps.dual ? EXTRUDER[nozzle] : 0;
    if (extruder === undefined) throw new Error('say which nozzle: left or right');
    await this.p.command({ print: { command: 'ams_change_filament', curr_temp: 250, tar_temp: 250, ams_id: 255, target: 255, slot_id: 255, extruder_id: extruder } });
    return { message: this.caps.dual ? `Unloading the ${nozzle} nozzle` : 'Unloading' };
  };

  sendGcode = async ({ gcode }) => {
    const reply = await this.p.gcode(gcode);
    return { message: 'G-code sent', result: { reply } };
  };

  sendCommand = async ({ command }) => {
    const group = Object.keys(command || {})[0];
    if (!group || typeof command[group] !== 'object') throw new Error('command must look like {"print": {"command": "..."}}');
    const reply = await this.p.command(JSON.parse(JSON.stringify(command)));
    return { message: 'Command sent', result: { reply } };
  };

  deleteFile = async ({ path }) => {
    await this.p.remove(path);
    return { message: `Deleted ${path}` };
  };

  // ---- printing ----

  // Print starts need an idle printer: not printing, preparing or paused on another job.
  readyToPrint() {
    const st = this.p.report.gcode_state;
    if (['RUNNING', 'PREPARE', 'SLICING', 'PAUSE'].includes(st)) throw new Error(`the printer is busy (${st}); finish or stop that job first`);
  }

  // Direct printing needs the printer to take our commands; say so plainly before trying.
  directPrintCheck() {
    // Only the printer's own refusal counts here; the guess from its report could be wrong.
    if (this.printVia === 'direct' && this.p.controlLearned && this.p.control === 'read_only') {
      throw new Error('this printer only takes print commands from Bambu apps right now. Turn on Developer Mode on the printer ' +
        '(Settings → Network), or use "Open in Bambu Studio" to print from there');
    }
  }

  // Saves the part and opens it in Bambu Studio's window on this computer.
  openInStudio = async (inputs, ctx) => {
    ctx.progress(0.2, 'Downloading the part');
    const model = await ctx.input(inputs.model);
    fs.mkdirSync(this.filesDir, { recursive: true });
    const dest = path.join(this.filesDir, `${safeName(inputs.model.name, 'part')}.3mf`);
    fs.writeFileSync(dest, model);
    this.slicer.openInGui(dest);
    return { result: { file: dest, computer: os.hostname() }, message: `Opened in Bambu Studio on ${os.hostname()}` };
  };

  slicePart = async (inputs, ctx, start) => {
    if (start) {
      this.readyToPrint();
      this.directPrintCheck();
    }
    const tray = this.pickSlot(inputs.slot, inputs.material);
    const filament = this.filamentProfile(inputs.material, tray);
    const quality = inputs.quality && this.qualities[inputs.quality] ? inputs.quality : Object.keys(this.qualities)[0];
    const process = this.qualities[quality];
    ctx.progress(0.05, `Downloading the part (${tray.name}, ${filament})`);
    const model = await ctx.input(inputs.model);
    ctx.progress(0.15, `Slicing with ${quality}`);
    const overrides = {
      curr_bed_type: PLATES[inputs.plate || 'textured_pei'],
      sparse_infill_density: `${inputs.infill_percent ?? 15}%`,
      wall_loops: String(inputs.walls ?? 2),
      enable_support: inputs.supports ? '1' : '0',
      brim_type: inputs.brim ? 'outer_only' : 'no_brim',
    };
    // Tint the part with the slot's filament colour, so the preview shows what will print.
    const colour = tray.info.tray_color ? '#' + tray.info.tray_color.slice(0, 6) : null;
    const sliced = await this.slicer.slice(model, inputs.model.name || 'part.3mf', {
      machine: this.machine, process, filament, processOverrides: overrides,
      filamentOverrides: colour ? { filament_colour: [colour] } : {},
      filamentMap: this.caps.dual ? SLICER_EXTRUDER[tray.extruder] : undefined,
      orient: Boolean(inputs.orient), signal: ctx.signal,
    });
    const fileName = `${safeName(inputs.model.name, 'part')}.gcode.3mf`;
    const plate = sliced.plates[0] || {};
    const estimate = {
      time_min: plate.time_min, filament_g: plate.filament_g, slot: tray.name, filament_profile: filament,
      quality: process, plate: overrides.curr_bed_type, laid_flat: Boolean(inputs.orient),
      ...(plate.warning ? { warning: plate.warning } : {}),
    };
    await ctx.file(fileName, sliced.file, 'model/3mf');
    if (sliced.preview) await ctx.file('plate.png', sliced.preview, 'image/png');
    const preview = sliced.preview ? { preview: 'plate.png' } : {};
    const summary = `${plate.time_min} min, ${plate.filament_g} g`;

    if (!start) {
      if (inputs.upload === false || this.printVia === 'bambu_connect') {
        return { result: { ...estimate, ...preview }, message: `Sliced: ${summary}` };
      }
      ctx.progress(0.75, 'Uploading to the printer');
      await this.p.upload(sliced.file, '/' + fileName);
      return { result: { ...estimate, ...preview, printer_file: '/' + fileName }, message: `Sliced: ${summary}. Ready to print.` };
    }
    if (this.printVia === 'bambu_connect') return this.viaConnect(sliced.file, fileName, estimate, ctx);
    ctx.progress(0.75, 'Uploading to the printer');
    await this.p.upload(sliced.file, '/' + fileName);
    ctx.progress(0.9, 'Starting the print');
    const job = await this.startPrint('/' + fileName, sliced.file, 1, [tray], inputs);
    return { result: { ...estimate, printer_file: '/' + fileName, ...job }, message: `Printing ${fileName}: about ${summary}` };
  };

  printFile = async (inputs, ctx) => {
    this.readyToPrint();
    this.directPrintCheck();
    const filePath = inputs.path.startsWith('/') ? inputs.path : '/' + inputs.path;
    ctx.progress(0.2, 'Reading the file from the printer');
    const file = await this.p.download(filePath);
    const name = filePath.split('/').pop();
    if (this.printVia === 'bambu_connect') return this.viaConnect(file, name, { file: filePath }, ctx); // it maps slots itself
    const plate = inputs.plate || 1;
    const meta = this.projectFilaments(file, plate);
    let trays;
    if (!inputs.slots || inputs.slots === 'auto') {
      trays = meta.map((f) => (f.used ? this.matchTray(f) : null));
    } else {
      const list = inputs.slots.split(',').map((s) => s.trim()).filter(Boolean);
      trays = meta.map((f, i) => (f.used ? this.tray(list[i] || list[list.length - 1]) : null));
    }
    ctx.progress(0.6, 'Starting the print');
    const job = await this.startPrint(filePath, file, plate, trays, inputs);
    return { result: job, message: `Printing ${name}` };
  };

  // Opens the file in Bambu Connect, then watches the printer until the job starts (the person confirms it there).
  async viaConnect(file, fileName, extra, ctx, waitMinutes = 10) {
    if (!this.bc) throw new Error('print_via is "bambu_connect" but Bambu Connect is not installed');
    const beforeJob = this.p.report.subtask_name;
    this.bc.send(file, fileName);
    const base = fileName.replace(/\.gcode\.3mf$|\.3mf$/i, '');
    const deadline = Date.now() + waitMinutes * 60000;
    ctx.progress(0.92, 'Opened in Bambu Connect: confirm the print there');
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw new Error('cancelled');
      await new Promise((r) => setTimeout(r, 3000));
      const r = this.p.report;
      if (['PREPARE', 'RUNNING'].includes(r.gcode_state) && (r.subtask_name === base || r.subtask_name !== beforeJob)) {
        return { result: { ...extra, via: 'bambu_connect', started: true, job: r.subtask_name, printer_state: r.gcode_state },
          message: `Printing ${r.subtask_name || base} (sent through Bambu Connect)` };
      }
    }
    return { result: { ...extra, via: 'bambu_connect', started: false },
      message: "Sent to Bambu Connect; the print hasn't started yet (confirm it there)" };
  }

  // The project's filaments for a plate: type, color, used, and (two-nozzle printers) which nozzle each is on.
  projectFilaments(file, plate) {
    const z = readZip(file);
    const info = z.get('Metadata/slice_info.config')?.toString() || '';
    const settings = JSON.parse(z.get('Metadata/project_settings.config')?.toString() || '{}');
    const plateXml = (info.match(/<plate>[\s\S]*?<\/plate>/g) || []).find((p) => p.includes(`key="index" value="${plate}"`)) || '';
    if (!z.has(`Metadata/plate_${plate}.gcode`)) throw new Error(`the file has no sliced plate ${plate}`);
    const maps = (/key="filament_maps" value="([^"]*)"/.exec(plateXml)?.[1] || '').split(' ').map(Number);
    const types = settings.filament_type || [];
    const colors = settings.filament_colour || [];
    const ids = settings.filament_ids || [];
    const used = new Set([...plateXml.matchAll(/<filament id="(\d+)"/g)].map((m) => Number(m[1]) - 1));
    return types.map((type, i) => ({
      index: i, type, color: colors[i], filament_id: ids[i], used: used.has(i),
      extruder: this.caps.dual ? ((maps[i] || 1) === 2 ? 0 : 1) : 0,
    }));
  }

  matchTray(f) {
    let best = null;
    for (const u of this.amsUnits().filter((x) => x.extruder === f.extruder)) {
      for (const t of u.trays) {
        if (!t.tray_type || t.tray_type !== f.type) continue;
        const score = (t.tray_info_idx === f.filament_id ? 0 : 1000) + hexDist('#' + (t.tray_color || '').slice(0, 6), f.color);
        if (!best || score < best.score) best = { score, slot: slotName(u.id, t.slot) };
      }
    }
    if (!best) {
      const where = this.caps.dual ? ` on the ${f.extruder === 0 ? 'right' : 'left'} nozzle` : '';
      throw new Error(`no ${f.type} loaded in an AMS${where} for filament ${f.index + 1}; give slots`);
    }
    return this.tray(best.slot);
  }

  async startPrint(path, file, plate, trays, opts) {
    const z = readZip(file);
    const md5 = (z.get(`Metadata/plate_${plate}.gcode.md5`)?.toString().trim()) ||
      crypto.createHash('md5').update(z.get(`Metadata/plate_${plate}.gcode`) || Buffer.alloc(0)).digest('hex').toUpperCase();
    const plateJson = JSON.parse(z.get(`Metadata/plate_${plate}.json`)?.toString() || '{}');
    const ams = [], ams2 = [];
    for (const t of trays) {
      if (!t) { ams.push(-1); ams2.push({ ams_id: 255, slot_id: 255 }); }
      else if (t.external !== undefined) { ams.push(t.external); ams2.push({ ams_id: t.external, slot_id: 0 }); }
      else { ams.push(t.ams * 4 + t.tray); ams2.push({ ams_id: t.ams, slot_id: t.tray }); }
    }
    const name = path.split('/').pop();
    const sdcard = this.caps.sdcardPrinting;
    const payload = {
      print: {
        command: 'project_file',
        param: `Metadata/plate_${plate}.gcode`,
        url: sdcard ? `file:///sdcard${path}` : `ftp://${path}`,
        file: name,
        md5,
        bed_type: plateJson.bed_type || 'auto',
        timelapse: Boolean(opts.timelapse),
        bed_leveling: opts.bed_leveling !== false,
        flow_cali: Boolean(opts.flow_calibration),
        vibration_cali: true,
        layer_inspect: true,
        use_ams: trays.some((t) => t && t.external === undefined),
        subtask_name: name.replace(/\.gcode\.3mf$|\.3mf$/i, ''),
        profile_id: '0', project_id: '0', subtask_id: '0', task_id: '0',
        ams_mapping: ams,
        // Fields newer (H2-series) firmware expects.
        ...(sdcard ? {} : {
          auto_bed_leveling: opts.bed_leveling !== false ? 1 : 0,
          cfg: '0', extrude_cali_flag: 0, extrude_cali_manual_mode: 0, nozzle_offset_cali: 2,
          ams_mapping2: ams2,
        }),
      },
    };
    await this.p.command(payload, 8000);
    // The printer takes a moment to pick the job up; report what it says.
    await new Promise((r) => setTimeout(r, this.startWaitMs ?? 6000));
    const s = this.p.summary();
    if (s.print_error && s.state === 'FAILED') throw new Error(`the printer refused the job (error ${s.print_error})`);
    return { file: path, plate, slots: trays.map((t) => (t ? t.name : null)), printer_state: s.state };
  }
}

module.exports = { Actions, buildCatalog };
