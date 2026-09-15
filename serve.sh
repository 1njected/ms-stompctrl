#!/bin/sh
# Serve the app on 127.0.0.1:8765. Static files only -- there is no backend,
# and the Bluetooth connection is made by the browser, not by this server.
exec python3 -m http.server 8765 --bind 127.0.0.1 --directory "$(dirname "$0")/app"
