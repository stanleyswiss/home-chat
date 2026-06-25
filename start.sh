#!/usr/bin/env bash
# Launch HomeChat. Override the port with: PORT=9000 ./start.sh
cd "$(dirname "$0")" || exit 1
exec node server.js
