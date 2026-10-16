# AGENTS.md

Guidance for AI agents (and people) working on **steve-bambu-connector**: a STEVE connector that lets STEVE see and
control a Bambu Lab printer on the local network, and print the part open in STEVE.

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

1. **Open in Bambu Studio** (`open_in_studio`), the default and safest path. The connector saves the STEVE 3MF and
   opens it in Bambu Studio's window on the connector's computer. The person checks placement, orientation,
   supports and filament mapping, and prints with Studio's own Print button. No Developer Mode, no reverse-engineered
   print command. It opens on the computer that runs the connector, so the connector must run in that person's
   desktop session (see Service).
2. **Slice & preview, then Print this** (`slice_part` then `print_file`): direct printing, needs **Developer Mode**.
   `slice_part` slices with the Bambu Studio CLI, returns the plate picture (`preview_png_base64`), time and
   filament, and uploads the file to the printer. `print_file` prints exactly that file (no re-slice) after the person
   has seen the preview and a fresh camera photo of the bed. `print_part` does both in one step without a preview, for
   API/agent use.
3. **Bambu Connect** (`"print_via": "bambu_connect"`): for people who won't enable Developer Mode but want to start
   prints from STEVE. Bambu Connect asks the person to confirm every print; that's Bambu's design. Never automate
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
| H2D: extruder index 0 is the right nozzle, 1 the left; AMS `info` bits 8-11 give the nozzle an AMS feeds (here A → right, B → left) | Verified |
| Bambu Studio CLI chooses the nozzle only with `--filament-map-mode Manual --filament-map N` (1 = left, 2 = right); `filament_map` in a process JSON is ignored | Verified (Studio 02.08.02.61) |
| CLI `--orient 1` lays the part flat; `--arrange 1` places it; plate preview is `Metadata/plate_1.png` (512 px) | Verified |
| Bambu Connect link: `bambu-connect://import-file?path=…&name=…&version=1.1.0`; it decodes once, then parses as a query string, so values are encoded twice | Verified from Bambu Connect 2.5.0 app code |
| `fun` bit 29 set means the printer requires signed commands | Seen set with Developer Mode off and cleared with it on (H2D); still only a hint, the printer's answer decides |
| `project_file` payload for H2-series (`ftp:///` url, `ams_mapping`/`ams_mapping2`, `nozzle_offset_cali`, …) | Verified on H2D 01.03.00.00 with Developer Mode: a one-filament job from AMS A (right nozzle) started and ran |
| `print_speed` is accepted with Developer Mode on (`result: "SUCCESS"`) | Verified on H2D |
| `set_nozzle_temp`, `set_bed_temp`, `set_ctt`, `select_extruder`, `ams_change_filament` payloads | From BambuStudio source; **unverified on a printer** |
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

`test/helpers.js` builds a `Printer` from the sanitized H2D report with a fake MQTT client whose replies you choose
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
- macOS: `service/macos/install.sh` installs a LaunchAgent with `KeepAlive`.
- Linux: `service/linux/install.sh` installs a systemd **user** unit with `Restart=always`.

Logs: `data/connector.log` (5 MB, one rotated copy).

## Releasing

1. `npm test` and `npm run check` pass; CI passes on Windows, macOS and Linux.
2. Bump `version` in `package.json` (sent to STEVE at enrollment).
3. Note catalog changes (they reset permissions) and newly verified printer facts.
4. Check no secrets: `git ls-files | xargs grep -nE "access_code\": \"[0-9]{8}"` finds nothing; `config.json` and
   `data/` are ignored.
