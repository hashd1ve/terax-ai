#!/bin/sh
# Reference: the per-pane activity hook Terax merges into ~/.claude/settings.json.
# The LIVE command is generated inline by agent.rs (see hook_cmd); this file
# documents the behavior for maintainers. STATE is one of working|blocked|done.
#
# Writes one JSON line to the Terax agent socket when running inside a Terax
# pane. Uses a Python one-liner for an atomic AF_UNIX SOCK_STREAM connect so a
# missing/closed socket is a no-op (never blocks the agent).
STATE="$1"
if [ -n "$TERAX_PANE" ] && [ -n "$TERAX_AGENT_SOCK" ]; then
  python3 - "$TERAX_AGENT_SOCK" "$TERAX_PANE" "$STATE" <<'PY' 2>/dev/null || true
import socket, sys, json
sock, pane, state = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(0.2)
    s.connect(sock)
    s.sendall((json.dumps({"pane": pane, "state": state}) + "\n").encode())
    s.close()
except OSError:
    pass
PY
fi
