# AGENTS.md

Guidance for AI agents (and people) working on **steve-bambu-connector**: a STEVE connector that lets STEVE see and
control a Bambu Lab printer on the local network, and print the part open in STEVE.

**This is experimental software** (see the warning at the top of the README). Whoever runs it is responsible for
making sure it works correctly with their printer. Keep that warning in the README, and never weaken it.

## What it is

A small Node.js program (CommonJS, Node 18+, two dependencies: `mqtt`, `basic-ftp`) that runs on a computer next to
the printer. It talks to:

- **STEVE** over HTTPS, outbound only (`https://stevecad.studio/connect/v1`): signed requests, long-polled runs,
  run reports, events. Protocol: https://stevecad.studio/docs/developers/connectors/
- **The printer** over the LAN: MQTT on 8883 (status and commands), FTPS on 990 (files), the camera (RTSPS on 322
  via ffmpeg; JPEG frames on 6000 for P1/A1).
- **Bambu Studio** on the same computer: its command line slices; its window opens parts for the person to print.
- **Bambu Connect** (optional): Bambu's app that sends a sliced file to the printer after the person confirms.

## Layout

| Path | What |
| --- | --- |
| `connector.js` | Entry point: config, pairing, reading the printer's hardware, the run loop, events, log rotation |
| `setup.js` | Interactive setup: SSDP discovery, access code check, writes `config.json` |
| `lib/steve.js` | STEVE protocol: Ed25519 key, RFC 9421 signing, enroll, token, messages, run reports, files, events, run signature checks |
| `lib/bambu.js` | `Printer`: MQTT state and commands, refusal detection, capabilities, FTPS, camera |
| `lib/actions.js` | `buildCatalog` (actions offered, from the printer's capabilities) and `Actions` (what each does) |
| `lib/slicer.js` | Bambu Studio CLI slicing with resolved system profiles; opening a file in Studio's window |
| `lib/bambuconnect.js` | Handing a sliced file to Bambu Connect |
| `lib/zip.js` | Minimal ZIP read/write for 3MF |
| `lib/panel.js` | Builds the panel bundle the connector publishes (`PUT /connect/v1/panels/{name}`) |
| `panel/` | The STEVE panel (sandboxed page; talks to STEVE through `postMessage`) |
| `service/` | Run-at-login service installers: Windows scheduled task, macOS LaunchAgent, Linux systemd user unit |
| `test/` | `node:test` suite; fixtures are a sanitized real H2D report and STEVE's real signed key list |

## How printing works: three paths

People choose how they print. Keep all three working and keep them distinct.

1. **Open in Bambu Studio** (`open_in_studio`), the safest path and the one that works without Developer Mode. The connector saves the STEVE 3MF and
   opens it in Bambu Studio's window on the connector's computer. The person checks placement, orientation,
   supports and filament mapping, and prints with Studio's own Print button. No Developer Mode, no reverse-engineered
   print command. It opens on the computer that runs the connector, so the connector must run in that person's
   desktop session (see Service).
2. **Slice & preview, then Print this** (`slice_part` then `print_file`): direct printing, needs **Developer Mode**.
   `slice_part` slices with the Bambu Studio CLI, returns the plate picture (run file `plate.png`), time and
   filament, and uploads the file to the printer. `print_file` prints exactly that file (no re-slice) after the person
   has seen the preview and a fresh camera photo of the bed. `print_part` does both in one step without a preview, for
   API/agent use.
3. **Bambu Connect** (`"print_via": "bambu_connect"`, Windows and macOS): for people who won't enable Developer Mode
   but want to start prints from STEVE. The panel's preview then offers **Print with Bambu Connect** (`print_part`). Bambu Connect asks the person to confirm every print; that's Bambu's design. Never automate
   clicking through it.

`print_via` is `"direct"` (default) or `"bambu_connect"`. Direct printing is refused up front only after the printer
itself has refused a command (`Printer.controlLearned`); the guess from the report (`controlGuess`) is used for the
startup message only.

## Facts about Bambu printers (and how sure we are)

| Fact | Status |
| --- | --- |
| Firmware with Bambu's authorization control refuses unsigned `print` commands with `result: "failed"`, `reason: "mqtt message verify failed"`, `err_code: 84033543`, and shows HMS `0500-0500-0001-0007` | Verified on H2D 01.03.00.00 |
| `system` commands (`ledctrl`) are accepted without Developer Mode; status, FTPS and camera work without it | Verified on H2D |
| H2D packs heaters as `target << 16 \| current` in `device.extruder.info[].temp`, `device.bed.info.temp`, `device.ctc.info.temp` | Verified |
| H2D: AMS `info` bits 8-11 give the nozzle (extruder index 0 or 1) an AMS feeds; on the test printer AMS A feeds 0, AMS B feeds 1 | Verified |
| H2D: extruder index 0 is the right nozzle ("main"), 1 the left | From BambuStudio source; **unverified** (only affects labels and `set_nozzle_temp`) |
| Bambu Studio CLI chooses the nozzle only with `--filament-map-mode Manual --filament-map N`, where **map 1 = nozzle 0, map 2 = nozzle 1**; `filament_map` in a process JSON is ignored | Verified against a Bambu Studio-sliced job that printed on the H2D (AMS B filament, map 2, `<nozzle id="1">`). An earlier version assumed 1 = left / 2 = right and sliced onto the wrong nozzle |
| System profiles pull G-code from template files with `"include"` (the H2D's start, end, filament-change, layer-change and timelapse G-code). They must be resolved, between the parent's settings and the profile's own | Verified: skipping `include` produced another printer's start G-code and a failed print; `Slicer.checkOutput` now refuses such a file |
| Hotend codes per nozzle (`device.nozzle.info[].type`, e.g. `HH05`): 2nd letter = flow (S Standard, H High Flow, U TPU High Flow, B E3D High Flow), digits 3-4 = material (00 stainless, 01 hardened steel, 05 tungsten carbide) | From BambuStudio `DevNozzleSystem.cpp` (`s_parse_nozzle_type`) |
| The H2D checks the sliced hotend against the installed one at start and pauses with `05FF8053` ("nozzle not matched") if they differ (e.g. sliced Standard, installed High Flow) | Verified on H2D |
| The CLI slices for a hotend type when the machine profile's `default_nozzle_volume_type` is set per extruder (`["High Flow","High Flow"]`); `slice_info` then says `volume_type="High Flow"` | Verified (Studio 02.08.02.61) |
| CLI output matches Bambu Studio's own for the H2D machine settings, apart from differences between Studio versions (newer template dates, more nozzle variants) | Verified by comparing `project_settings.config` |
| CLI `--orient 1` lays the part flat; `--arrange 1` places it; plate preview is `Metadata/plate_1.png` (512 px) | Verified |
| Bambu Connect link: `bambu-connect://import-file?path=…&name=…&version=1.1.0`; it decodes once, then parses as a query string, so values are encoded twice | Verified from Bambu Connect 2.5.0 app code |
| `fun` bit 29 set means the printer requires signed commands | Seen set with Developer Mode off and cleared with it on (H2D); still only a hint, the printer's answer decides |
| `project_file` payload for H2-series (`ftp:///` url, `ams_mapping`/`ams_mapping2`, `nozzle_offset_cali`, …) | Verified on H2D 01.03.00.00 with Developer Mode (early tests failed only because of the slicer bugs above, since fixed) |
| During a print on the H2D, through STEVE: `print_speed` (silent/standard), `ledctrl` on both chamber lights, `M106 P2` aux fan, `set_nozzle_temp` (index 0), `set_bed_temp`, `gcode_line`, `pause` and `resume` are accepted and take effect (checked in the printer's report) | Verified on H2D |
| A full print started by `project_file` (sliced for the installed High Flow hotend, AMS A → nozzle 0) runs, with the printer's own hotend check passing | Verified on H2D |
| Idle H2D, through STEVE: `G28` homes; `select_extruder` 1 then 0 switches the active nozzle; `ams_change_filament` loads A3 into nozzle 0 and unloads it (it purged on the right nozzle: **index 0 is the right nozzle**); `set_ctt` is accepted; jog Z `+` lowers the bed and X `+` moves the head right | Verified on H2D (motion directions confirmed by the person watching) |
| `stop` during a print's preparation, through STEVE: the job ends as `FAILED` with `print_error` `0300400C` (also what a stop on the printer's screen shows), and the printer turns its heaters off by itself within seconds | Verified on H2D |
| X1/P1/A1 use `file:///sdcard/…` for `project_file`; P1/A1 camera on port 6000 | From ha-bambulab / OpenBambuAPI; **untested here** |

When you verify something on a real printer, update this table and add a test with the captured reply.

## Rules for changes

- **It should just work.** No approvals by default: `DEFAULT_CONFIRM` is empty and the README tells owners to let
  runs go at once. Gates are opt-in (`confirm` in the config, or "asks first" per caller in STEVE).
- **Safety without friction.** Anything that starts a print checks the printer is idle (`readyToPrint`); a run is
  acted on once. Interlocks belong to the printer.
- **Never bypass Bambu's authorization**: no signing with extracted keys, no driving `bambu_networking.dll`, no
  auto-clicking Bambu Connect. Direct control is for printers whose owner turned on Developer Mode.
- **Act on each run once.** STEVE can deliver the same run in more than one message, each freshly signed, so the
  nonce check alone doesn't catch it; the connector keeps the ids of runs it has accepted (`Steve.hasRun`). Never
  remove that: a repeated print run would start a second print.
- **Never print a sliced file that fails `Slicer.checkOutput`** (wrong printer model, start G-code that isn't the
  resolved profile's, or filament on a nozzle its AMS can't feed). When you change slicing, compare the output's
  `Metadata/project_settings.config` with a file Bambu Studio sliced for the same printer before printing it.
- **Check what's in the machine, never assume.** Slice for the hotends the printer reports (`Printer.hotends`,
  `Actions.hotendOverrides`), refuse unknown hotend codes, and run `Actions.verifyPrint` before every print: printer
  model, each nozzle's hotend (flow and diameter), and each filament's slot (loaded, same material, feeds that nozzle).
- **Action descriptions are the AI's operating manual.** Agents using STEVE's MCP tools read each action's description
  (`list_actions`) before running it. Every action that moves or heats the machine says what physically happens, what
  to check first (a fresh snapshot: empty bed, no hands inside) and to tell the person what will move and what to watch
  before sending it (`WATCH` in `lib/actions.js`). Keep that guidance when you change an action; a test checks it.
  The printer doesn't report the toolhead position: after homing the head parks at the back by the purge chute and
  wiper, so it must come forward into the open print area before any X move.
- **One print start at a time, and cancel means cancel.** `Actions.exclusive` serializes print starts;
  `stopIfCancelled` runs before each step and right before `project_file`. A restart mid-run reports the run
  failed (`runState` "accepted") instead of repeating it.
- **Report the printer's answer honestly.** A refused command is a failed run with the reason, never "succeeded".
- **Secrets**: the access code lives only in `config*.json`; the private key only in `data*/key.pem`. Never log,
  return or put them in an event. Redact them from error text (see `rtspSnapshot`).
- **Catalog changes and permissions**: STEVE keeps the owner's permission through changes that grant nothing new (a
  new optional value input, a removed input, tighter limits, new titles and descriptions). It ends it for changes
  that let an action do more: a new STEVE document input, an existing one sending another format or kinds, an input
  becoming required, or `confirm` going from true to false. Call those out in release notes.
- Actions, events and input names: lowercase, digits, `_` (actions/events also `.` `-`), start with a letter, ≤ 40
  chars; ≤ 100 actions, ≤ 30 inputs each. `test/actions.test.js` checks this.
- Events ≤ 8 kB; run results ≤ 64 kB. Images (camera photo, plate preview) are run files; the panel shows them with
  the bridge's `run.file`.
- **The panel**: published by the connector at start when `panel/` changed (hash kept in `data/state.json`). A panel
  run that sends the open document goes without a prompt only if it starts inside the click handler and the owner
  allowed it (`sends_open_document_on_click`); keep `run(...)` calls for Open in Bambu Studio and Slice & preview
  directly in their click handlers.
- **Protocol details**: `GET /messages` answers `{messages, cursor}` (continue from `cursor`); a cancel names its run
  in `envelope.run`; enrollment's `steve_keys` is a signed key list like `GET /keys`.
- Keep dependencies at two. Prefer Node built-ins.

## Testing

```sh
npm test        # node:test, no printer or network needed
npm run check   # syntax check of every file
```

`test/slicer.test.js` covers profile resolution (`include`) and `checkOutput` without Bambu Studio. `test/helpers.js`
builds a `Printer` from the sanitized H2D report with a fake MQTT client whose replies you choose
(`refuse` gives the real refusal). Add tests for every behaviour change.

Live checklist on a real printer (Developer Mode on, bed clear): status; snapshot; light; fan; each heater (then 0);
home; move Z +5; select nozzle; slice_part; print_file of the sliced file with set_speed, pause, resume during the
print; stop; delete_file; load/unload filament. With Developer Mode off: status, snapshot, light, open_in_studio,
slice_part work, and print_file fails with the Developer Mode message.

## Service

The connector must run in the person's **desktop session** (not as a session-0 Windows service or a headless
daemon), because `open_in_studio` and Bambu Connect open windows.

- Windows: `service\windows\install.ps1` registers a scheduled task at logon (hidden through `conhost --headless`,
  restarted by `start-connector.cmd`'s loop and the task's restart policy). `uninstall.ps1` removes it.
- macOS: `service/macos/install.sh [config] [data] [name]` installs a LaunchAgent with `KeepAlive` and a PATH that
  includes Homebrew (stdout goes to /dev/null; the connector keeps its own rotated log).
- Linux: `service/linux/install.sh [config] [data] [name]` installs a systemd **user** unit with `Restart=always`
  (arguments quoted for systemd). Bambu Connect has no Linux version.
- The optional name keeps several printers' services apart (Windows: `-Name`).

Logs: `data/connector.log` (5 MB, one rotated copy).

## Releasing

1. `npm test` and `npm run check` pass; CI passes on Windows, macOS and Linux.
2. Bump `version` in `package.json` (sent to STEVE at enrollment).
3. Note catalog changes (they reset permissions) and newly verified printer facts.
4. Check no secrets: `git ls-files | xargs grep -nE "access_code\": \"[0-9]{8}"` finds nothing; `config.json` and
   `data/` are ignored.
