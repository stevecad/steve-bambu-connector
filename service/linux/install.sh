#!/bin/sh
# Runs the STEVE Bambu connector as a systemd user service, restarting it if it stops.
#   ./service/linux/install.sh [config.json] [data]
# To keep it running while you're logged out: sudo loginctl enable-linger "$USER"
#   (then "Open in Bambu Studio" can't open a window, since there is no desktop session).
# Remove: systemctl --user disable --now steve-bambu-connector && rm ~/.config/systemd/user/steve-bambu-connector.service
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${1:-config.json}"
DATA="${2:-data}"
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
[ -f "$ROOT/$CONFIG" ] || { echo "No $CONFIG in $ROOT. Run 'node setup.js' first."; exit 1; }
[ -f "$ROOT/$DATA/state.json" ] || { echo "Not paired yet. Run 'node connector.js --pair <CODE>' once first."; exit 1; }
UNIT="$HOME/.config/systemd/user/steve-bambu-connector.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=STEVE connector for a Bambu Lab printer
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/connector.js --config $CONFIG --data $DATA
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now steve-bambu-connector
echo "Installed and started steve-bambu-connector. Logs: journalctl --user -u steve-bambu-connector -f (and $ROOT/$DATA/connector.log)"
