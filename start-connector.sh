#!/bin/sh
# Starts the STEVE Bambu connector and restarts it if it stops.
# Options are passed on, e.g. ./start-connector.sh --config h2d.config.json --data data-h2d
cd "$(dirname "$0")" || exit 1
while true; do
  node "$(pwd)/connector.js" "$@"
  echo "Connector stopped (exit $?). Restarting in 10 seconds... Ctrl+C to quit."
  sleep 10
done
