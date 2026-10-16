# steve-bambu-connector

A [STEVE](https://stevecad.studio) connector for Bambu Lab printers on your local network. From STEVE (a panel beside
your design, **File → Run an action**, the STEVE assistant, or AI agents over MCP) you can:

- **see the printer**: state, progress, temperatures, fans, lights, AMS filament, errors, camera photos
- **print the part you have open**, the way you prefer (below)
- **control it** (with Developer Mode): pause / resume / stop, speed, light, fans, temperatures, homing and jogging,
  nozzle switching, filament load and unload, raw G-code and MQTT commands, printer files

It runs on a computer on the same network as the printer, connects **out** to STEVE over HTTPS (STEVE never connects
in), and talks to the printer over the LAN.

> Not affiliated with or endorsed by Bambu Lab. Uses the printer's local (LAN) interfaces.

## Three ways to print

| | Open in Bambu Studio | Slice & preview → Print this | Bambu Connect |
| --- | --- | --- | --- |
| How | Opens the part in Bambu Studio on your computer; you check it and press Studio's Print | The connector slices, shows the plate, time, filament and a bed photo; you press Print this | Slice & preview, then **Print with Bambu Connect**: the connector hands the file to Bambu Connect; you confirm there |
| You see placement first | Yes, fully editable | Yes, preview picture | In Bambu Connect |
| Needs Developer Mode | No | **Yes** | No |
| Extra prompts | None beyond Studio | None | Bambu Connect asks every time |
| Setting | when Bambu Studio is installed | default (`print_via: "direct"`) | `print_via: "bambu_connect"` (Windows and macOS) |

Open in Bambu Studio is the safest: you see and can fix everything before printing, and the print goes through
Bambu's own app. Slice & preview is for one-click printing from STEVE once you have turned on Developer Mode.

## Printers

The connector reads the printer's hardware when it starts (one or two nozzles, chamber heater, camera type, model),
offers the actions that fit, and picks Bambu Studio's profiles for the model.

| Printer | Status |
| --- | --- |
| H2D | Tested: status and camera, files, Open in Bambu Studio, Developer Mode detection, slicing for the installed hotends (checked against Bambu Studio's own output), printing from STEVE, and during a print: speed, light, fans, temperatures, raw G-code, pause and resume. Not yet run: home, move, switch nozzle, load/unload filament, stop from STEVE |
| X1 / X1C / X1E, P1P / P1S, A1 / A1 mini, H2S, H2C, P2S, X2 | Should work; untested. Reports welcome |

Commands not yet run on a printer follow Bambu Studio's own source; see [AGENTS.md](AGENTS.md) for exactly what is
verified. This is a preview: reports from other printers are very welcome.

## The printer

On the printer's screen (Settings → Network):

- **LAN Only Mode**: on (the connector talks to the printer on your network).
- **Developer Mode**: on, if you want to control and print from STEVE directly. Firmware from 2025 on refuses
  control commands from anything but Bambu's own apps unless it's on; you then see "printer refused …
  (mqtt message verify failed)". Without it you still get status, the camera, the light, and Open in Bambu Studio.
- **Access Code**: you'll need it during setup.
- X1/H2/P2: **LAN Only Liveview** on, for the camera.

**What Developer Mode means:** anyone on your network who has the access code can control the printer, and Bambu's
cloud (Bambu Handy, cloud printing) is off while LAN Only is on. The printer's own protections (thermal runaway,
door sensors and so on) are unchanged. Use it on a network you trust.

## Install

Needs Node.js 18+, [Bambu Studio](https://bambulab.com/en/download/studio) for slicing and Open in Bambu Studio, and
[ffmpeg](https://ffmpeg.org/download.html) for X1/H2/P2 cameras. [Bambu Connect](https://wiki.bambulab.com/en/software/bambu-connect)
only if you choose that way to print.

```sh
git clone https://github.com/stevecad/steve-bambu-connector
cd steve-bambu-connector
npm install
node setup.js          # finds the printer, checks the access code, writes config.json
```

`node setup.js --discover` (or `npm run discover`) only lists the printers it hears. On **Linux**, set
`slicer.exe` and `slicer.profiles` in the config (Bambu Studio's install location varies), and Bambu Connect isn't
available.

Pair it with STEVE:

1. In STEVE: **Settings → Developers**, turn the API on; then **Settings → Connectors → Pair a connector**.
2. `node connector.js --pair <CODE>`. It connects to the printer first (it gives up after two minutes if the printer
   doesn't answer, so the code isn't wasted), then prints its key fingerprint.
3. In STEVE, paste that fingerprint to confirm the connector.
4. Allow the actions, and let them run at once for the callers you use: you, **Its panel**, the STEVE assistant and
   AI agents. Then "print this part", from a click or from an AI, just happens. (Each action can still be set to
   ask you first, per caller, if you want a gate somewhere.)

The connector publishes its panel itself when it starts (see The panel). With an AI agent that has STEVE's MCP tools
and **Settings → Connectors → Let AI set up my connectors** on, the agent can also make the code, confirm the
fingerprint and allow actions for you.

## Run it as a service

Install it once it's paired, so it starts when you log in and restarts if it stops:

| System | Install | Remove |
| --- | --- | --- |
| Windows | `powershell -ExecutionPolicy Bypass -File service\windows\install.ps1` | `powershell -ExecutionPolicy Bypass -File service\windows\uninstall.ps1` |
| macOS | `./service/macos/install.sh` | see the comment at the top of the script |
| Linux | `./service/linux/install.sh` | see the comment at the top of the script |

Options, for a second printer or other file names:
- Windows: `install.ps1 -Config h2d.config.json -Data data-h2d -Name "STEVE Bambu H2D"` (and `uninstall.ps1 -Name …`).
- macOS and Linux: `install.sh h2d.config.json data-h2d h2d`: config, data folder, and a name that keeps each
  printer's service separate.

They run the connector **in your login session**, on purpose: Open in Bambu Studio and Bambu Connect open windows on your desktop, which a background
system service can't do. On Linux, `sudo loginctl enable-linger $USER` keeps it running while you're logged out
(without the windows). The macOS and Linux services get a PATH that includes Homebrew and `/usr/local/bin`; if
ffmpeg or Bambu Studio live elsewhere, put their full paths in the config (`ffmpeg`, `slicer.exe`).

To run it by hand with automatic restarts instead: `start-connector.cmd` (Windows) or `./start-connector.sh`.

Logs: `data/connector.log` (kept to 5 MB plus one older file).

## The panel

`panel/` is a tab STEVE shows beside your design: progress, camera (refreshing every 10 seconds while a print runs,
with an Auto on/off switch), temperatures with each nozzle's hotend, AMS filament, Pause / Resume /
Stop, speed, light, and a **This part** card: filament slot, quality, plate, supports, lay flat; **Open in Bambu
Studio**; **Slice & preview**, then **Print this** (with Developer Mode) or **Print with Bambu Connect** (with
`print_via: "bambu_connect"`).

The connector publishes it to STEVE when it starts, if the files in `panel/` changed since it last did; STEVE lists it
under the connector in Settings → Connectors, marked "by the connector". Allow the actions its buttons use for
**Its panel**.

**One click, no prompt:** STEVE asks you to confirm before a panel sends a document, unless you allow it. In
Settings → Connectors, allow **Slice and preview** and **Open in Bambu Studio** for **Its panel** with **Runs at once**
and tick **"Its panel may send the document open in STEVE without asking"** (or tick **"Don't ask again"** the first
time you confirm). Then those buttons go straight through when you click them. STEVE still checks that the click was
yours, in that panel, and that only the open document goes. The panel shows a reminder until this is set.

## Configuration

`config.json` (written by `setup.js`; see `config.example.json`):

| Key | Meaning |
| --- | --- |
| `name` | The connector's name in STEVE, sent when pairing (rename it in STEVE afterwards) |
| `printer.name`, `host`, `serial`, `access_code` | The printer. **The access code is a secret: keep this file private.** `printer.name` is optional |
| `print_via` | `"direct"` (default; needs Developer Mode) or `"bambu_connect"` |
| `confirm` | Actions that wait for a person on **every** run, whoever asks. Default `[]` (none); e.g. `["send_gcode", "delete_file"]` to gate those |
| `slicer.exe`, `slicer.profiles` | Bambu Studio's program and its `resources/profiles/BBL` folder, if not in the usual place |
| `machine_profile` | Force a Bambu Studio machine profile, e.g. `"Bambu Lab X1 Carbon 0.4 nozzle"` |
| `ffmpeg` | Path to ffmpeg, if it isn't on your PATH (or the service's) |
| `panel` | `false` to not publish the panel; or `{"title", "placement", "name"}` (defaults: the printer's name, `["right"]`, `"printer"`) |
| `steve_url` | STEVE's connector endpoint (leave as is) |

Who may run what, and whose runs ask you first, is set per action and caller in STEVE (Settings → Connectors).

**More than one printer:** one connector per printer, each with its own config and data folder:
`node connector.js --config h2d.config.json --data data-h2d`, and the service installers' options above.

## Actions

| Action | Does |
| --- | --- |
| `status` | The printer's state (and its raw report, if asked) |
| `snapshot` | A camera photo (`camera.jpg`); `preview: true` for a smaller, lighter one |
| `open_in_studio` | Opens the part in Bambu Studio on the connector's computer |
| `slice_part` | Slices the part; returns the plate picture, time and filament; uploads it for `print_file` |
| `print_file` | Prints a sliced `.gcode.3mf` on the printer (such as the one `slice_part` uploaded), matching filaments to AMS slots |
| `print_part` | Slices and prints in one step, without a preview (direct, or through Bambu Connect) |
| `pause`, `resume`, `stop`, `set_speed` | The current print |
| `set_light`, `set_fan`, `set_temperature` | Chamber light; part, aux and chamber fans; nozzle(s), bed, chamber |
| `home`, `move`, `select_nozzle` | Motion; the active nozzle on two-nozzle printers |
| `load_filament`, `unload_filament` | Load from an AMS slot (`A1`…`D4`) or external spool; unload a nozzle |
| `list_files`, `delete_file` | The printer's storage |
| `send_gcode`, `send_command` | Raw G-code; a raw Bambu MQTT command object |

Events: `status` (when something changes, throttled, and at least once a minute) and `alert` (print started /
resumed / paused / finished / failed, new printer errors).

## Security

- The connector's private key is `data/key.pem`; STEVE knows only its public key. Every request to STEVE's connector
  API is signed, and every run from STEVE is checked (STEVE's signature, expiry, a one-time nonce, and that it's for
  this connector) before anything happens. Each run is carried out once, even if it's delivered twice.
- `config.json` holds the access code. `config*.json` and `data*/` are in `.gitignore`.
- Bambu printers use self-signed certificates on the LAN, so the connector doesn't verify the printer's TLS
  certificate.
- The connector checks what's in the machine instead of assuming: it slices for the hotends the printer reports
  (flow type, diameter, material) and refuses hotends it doesn't recognise. Before any print starts (`print_part`,
  `print_file`, the panel), it checks the file is for this printer, was sliced for the hotends installed now, and that
  each filament comes from a loaded slot with the same material on the right nozzle. Prints start only when the
  printer is idle, one at a time. (`send_gcode` and `send_command` do what they're told.) Safety interlocks belong to the printer.

## Troubleshooting

- **"printer refused … mqtt message verify failed"**: Developer Mode is off. Turn it on, or use Open in Bambu Studio.
- **Waiting for the printer**: check the IP, that it's on and in LAN mode, and the access code (it changes when you
  toggle LAN mode).
- **No camera**: X1/H2/P2 need ffmpeg and LAN Only Liveview.
- **Slicing or Open in Bambu Studio missing**: Bambu Studio wasn't found; set `slicer.exe` and `slicer.profiles`.
- **Revoked in STEVE**: delete `data/state.json` and `data/key.pem`, then pair again.

## Development

`npm test` runs the test suite (no printer needed); `npm run check` syntax-checks everything. See
[AGENTS.md](AGENTS.md) for the design, the verified printer facts and the rules for changes.

## License

MIT
