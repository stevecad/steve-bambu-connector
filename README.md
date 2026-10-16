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
| How | Opens the part in Bambu Studio on your computer; you check it and press Studio's Print | The connector slices, shows the plate, time, filament and a bed photo; you press Print this | The connector slices and hands the file to Bambu Connect; you confirm there |
| You see placement first | Yes, fully editable | Yes, preview picture | In Bambu Connect |
| Needs Developer Mode | No | **Yes** | No |
| Extra prompts | None beyond Studio | None | Bambu Connect asks every time |
| Setting | always available | default (`print_via: "direct"`) | `print_via: "bambu_connect"` |

Open in Bambu Studio is the safest: you see and can fix everything before printing, and the print goes through
Bambu's own app. Slice & preview is for one-click printing from STEVE once you have turned on Developer Mode.

## Printers

The connector reads the printer's hardware when it starts (one or two nozzles, chamber heater, camera type, model),
offers the actions that fit, and picks Bambu Studio's profiles for the model.

| Printer | Status |
| --- | --- |
| H2D | Tested: status, camera, light, files, slicing and preview, Open in Bambu Studio, Developer Mode detection |
| X1 / X1C / X1E, P1P / P1S, A1 / A1 mini, H2S, P2S | Should work; untested. Reports welcome |

Direct control commands (temperatures, motion, starting prints) follow Bambu Studio's own source but haven't all been
run on a printer yet; see [AGENTS.md](AGENTS.md) for what is verified.

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

Pair it with STEVE:

1. In STEVE: **Settings → Developers**, turn the API on; then **Settings → Connectors → Pair a connector**.
2. `node connector.js --pair <CODE>`. It prints its key fingerprint.
3. In STEVE, paste that fingerprint to confirm the connector.
4. Allow the actions you want, and for each choose who may run it (you, the panel, the STEVE assistant, AI agents)
   and whose runs ask you first. A sensible start: your own and the panel's runs go at once; AI runs that move,
   heat or print ask you.

The connector publishes its panel itself when it starts (see The panel). With an AI agent that has STEVE's MCP tools
and **Settings → Connectors → Let AI set up my connectors** on, the agent can also make the code, confirm the
fingerprint and allow actions for you.

## Run it as a service

Install it once it's paired, so it starts when you log in and restarts if it stops:

| System | Install | Remove |
| --- | --- | --- |
| Windows | `powershell -ExecutionPolicy Bypass -File service\windows\install.ps1` | `service\windows\uninstall.ps1` |
| macOS | `./service/macos/install.sh` | see the comment at the top of the script |
| Linux | `./service/linux/install.sh` | see the comment at the top of the script |

Each takes the config and data folder as options (for more than one printer). They run the connector **in your
login session**, on purpose: Open in Bambu Studio and Bambu Connect open windows on your desktop, which a background
system service can't do. On Linux, `sudo loginctl enable-linger $USER` keeps it running while you're logged out
(without the windows).

Logs: `data/connector.log` (kept to 5 MB plus one older file).

## The panel

`panel/` is a tab STEVE shows beside your design: progress, camera, temperatures, AMS filament, Pause / Resume /
Stop, speed, light, and a **This part** card: filament slot, quality, plate, supports, lay flat; **Open in Bambu
Studio**; **Slice & preview**, then **Print this** (when Developer Mode is on).

The connector publishes it to STEVE when it starts, and again whenever the files in `panel/` change; STEVE lists it
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
| `name` | The connector's name in STEVE |
| `printer.name`, `host`, `serial`, `access_code` | The printer. **The access code is a secret: keep this file private** |
| `print_via` | `"direct"` (default; needs Developer Mode) or `"bambu_connect"` |
| `confirm` | Actions that wait for a person on **every** run, whoever asks. Default `["send_gcode", "send_command", "delete_file"]`; `[]` for none |
| `slicer.exe`, `slicer.profiles` | Bambu Studio's program and its `resources/profiles/BBL` folder, if not in the usual place |
| `machine_profile` | Force a Bambu Studio machine profile, e.g. `"Bambu Lab X1 Carbon 0.4 nozzle"` |
| `ffmpeg` | Path to ffmpeg, if it isn't on your PATH |
| `panel` | `false` to not publish the panel; or `{"title", "placement", "name"}` (defaults: the printer's name, `["right"]`, `"printer"`) |
| `steve_url` | STEVE's connector endpoint (leave as is) |

Who may run what, and whose runs ask you first, is set per action and caller in STEVE (Settings → Connectors).

**More than one printer:** one connector per printer, each with its own config and data folder:
`node connector.js --config h2d.config.json --data data-h2d` (and the same options for the service installers).

## Actions

| Action | Does |
| --- | --- |
| `status` | The printer's state (and its raw report, if asked) |
| `snapshot` | A camera photo (`camera.jpg`) |
| `open_in_studio` | Opens the part in Bambu Studio on the connector's computer |
| `slice_part` | Slices the part; returns the plate picture, time and filament; uploads it for `print_file` |
| `print_file` | Prints a sliced `.gcode.3mf` on the printer (such as the one `slice_part` uploaded), matching filaments to AMS slots |
| `print_part` | Slices and prints in one step, without a preview |
| `pause`, `resume`, `stop`, `set_speed` | The current print |
| `set_light`, `set_fan`, `set_temperature` | Chamber light; part, aux and chamber fans; nozzle(s), bed, chamber |
| `home`, `move`, `select_nozzle` | Motion; the active nozzle on two-nozzle printers |
| `load_filament`, `unload_filament` | From an AMS slot (`A1`…`D4`) or external spool |
| `list_files`, `delete_file` | The printer's storage |
| `send_gcode`, `send_command` | Raw G-code; a raw Bambu MQTT command object |

Events: `status` (when something changes, throttled) and `alert` (print started / finished / failed / paused, new
printer errors).

## Security

- The connector's private key is `data/key.pem`; STEVE knows only its public key. Every request is signed, and every
  run from STEVE is checked against STEVE's signing keys before anything happens.
- `config.json` holds the access code. `config*.json` and `data*/` are in `.gitignore`.
- Bambu printers use self-signed certificates on the LAN, so the connector doesn't verify the printer's TLS
  certificate.
- Prints start only when the printer is idle. Safety interlocks belong to the printer.

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
