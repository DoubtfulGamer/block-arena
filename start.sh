#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js first: https://nodejs.org"; exit 1; }
# Usage: ./start.sh        (all game modes take turns; the host can pick one in the game menu)
#        ./start.sh ctf    (or rotate ffa tdm hp ctf kc gg inf lms)
exec node server.js "$@"
