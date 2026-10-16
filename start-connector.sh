#!/bin/sh
# Starts the STEVE Bambu connector and restarts it if it stops.
cd "$(dirname "$0")" || exit 1
while true; do
  node connector.js "$@"
  echo "Connector stopped (exit $?). Restarting in 10 seconds... Ctrl+C to quit."
  sleep 10
done
