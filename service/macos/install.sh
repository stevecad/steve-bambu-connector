#!/bin/sh
# Runs the STEVE Bambu connector whenever you log in to macOS (a LaunchAgent), restarting it if it stops.
#   ./service/macos/install.sh [config.json] [data]
# Remove: launchctl bootout gui/$(id -u)/studio.steve.bambu-connector && rm ~/Library/LaunchAgents/studio.steve.bambu-connector.plist
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${1:-config.json}"
DATA="${2:-data}"
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
[ -f "$ROOT/$CONFIG" ] || { echo "No $CONFIG in $ROOT. Run 'node setup.js' first."; exit 1; }
[ -f "$ROOT/$DATA/state.json" ] || { echo "Not paired yet. Run 'node connector.js --pair <CODE>' once first."; exit 1; }
LABEL=studio.steve.bambu-connector
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/connector.js</string>
    <string>--config</string><string>$CONFIG</string>
    <string>--data</string><string>$DATA</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/$DATA/launchd.log</string>
  <key>StandardErrorPath</key><string>$ROOT/$DATA/launchd.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed and started $LABEL. Log: $ROOT/$DATA/connector.log"
