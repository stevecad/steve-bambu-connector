#!/bin/sh
# Runs the STEVE Bambu connector as a systemd user service, restarting it if it stops.
#   ./service/linux/install.sh [config.json] [data] [name]
# "name" tells several printers' services apart (e.g. h2d); the default is one service.
# To keep it running while you're logged out: sudo loginctl enable-linger "$USER"
#   (then "Open in Bambu Studio" can't open a window, since there is no desktop session).
# Remove: systemctl --user disable --now <unit> && rm ~/.config/systemd/user/<unit>.service
# (the unit is printed when you install; by default steve-bambu-connector)
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${1:-config.json}"
DATA="${2:-data}"
NAME="${3:-}"
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
[ -f "$ROOT/$CONFIG" ] || { echo "No $CONFIG in $ROOT. Run 'node setup.js' first."; exit 1; }
[ -f "$ROOT/$DATA/state.json" ] || { echo "Not paired yet. Run 'node connector.js --pair <CODE>' once first."; exit 1; }
UNITNAME="steve-bambu-connector${NAME:+-$NAME}"
UNIT="$HOME/.config/systemd/user/$UNITNAME.service"
# systemd unit quoting: wrap each argument in double quotes, escape \ and ", and double % (systemd specifiers).
q() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"; }
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=STEVE connector for a Bambu Lab printer${NAME:+ ($NAME)}

[Service]
WorkingDirectory=$(q "$ROOT")
Environment=$(q "PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin")
ExecStart=$(q "$NODE") $(q "$ROOT/connector.js") --config $(q "$CONFIG") --data $(q "$DATA")
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$UNITNAME"
echo "Installed and started $UNITNAME. Logs: journalctl --user -u $UNITNAME -f (and $ROOT/$DATA/connector.log)"
