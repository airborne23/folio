#!/usr/bin/env bash
# runtime-tunnel.sh — robust reverse-SSH tunnel so a folio daemon on a
# remote host can reach this box's local server at localhost:8080.
#
# Architecture:
#
#   remote ($REMOTE_HOST)                  this box
#   ┌────────────────────┐                 ┌──────────────────────┐
#   │ folio daemon     │  →→→ tcp →→→    │ folio server :8080 │
#   │ (talks to          │  ssh -R 18080:127.0.0.1:8080
#   │  localhost:18080)  │                 │ supervisor loop      │
#   └────────────────────┘                 └──────────────────────┘
#
# Usage:
#   scripts/runtime-tunnel.sh start [--background]
#   scripts/runtime-tunnel.sh stop
#   scripts/runtime-tunnel.sh status
#   scripts/runtime-tunnel.sh logs [-f]
#   scripts/runtime-tunnel.sh install-service       # systemd --user
#   scripts/runtime-tunnel.sh uninstall-service
#
# Robustness:
#   - SSH keepalives every 15s; 3 missed → connection considered dead.
#   - Supervisor wraps `ssh` in an until-loop; reconnects with exponential
#     backoff (2s → 60s, capped). Backoff resets after 2min of stable run.
#   - ExitOnForwardFailure=yes catches "remote port already bound" so we
#     don't wedge in a half-broken state.
#   - PID file holds the supervisor pid; killing it tears down its SSH child.

set -euo pipefail

# --- Config (override via env) ---
REMOTE_HOST="${REMOTE_HOST:-10.26.20.3}"
REMOTE_PORT="${REMOTE_PORT:-18080}"
LOCAL_PORT="${LOCAL_PORT:-8080}"
SSH_OPTS_EXTRA="${SSH_OPTS_EXTRA:-}"
STATE_DIR="${STATE_DIR:-/tmp/folio-runtime-tunnel}"
PID_FILE="$STATE_DIR/supervisor.pid"
LOG_FILE="$STATE_DIR/tunnel.log"

mkdir -p "$STATE_DIR"

ssh_cmd() {
  # Note: NO `exec` — we need ssh to stay a child of the supervisor so the
  # while-loop survives and can reconnect when ssh exits. Earlier draft used
  # `exec` and the whole supervisor got replaced on first connect.
  ssh \
    -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    -o ControlMaster=no \
    $SSH_OPTS_EXTRA \
    -R "${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" \
    "$REMOTE_HOST"
}

supervisor() {
  local backoff=2
  local started_at
  echo "$(date -Iseconds) supervisor pid=$$ -> ${REMOTE_HOST}:${REMOTE_PORT} from local:${LOCAL_PORT}"
  trap 'echo "$(date -Iseconds) supervisor stopping"; exit 0' TERM INT
  while :; do
    started_at=$(date +%s)
    echo "$(date -Iseconds) ssh: connecting (backoff next on failure: ${backoff}s)"
    if ssh_cmd; then
      echo "$(date -Iseconds) ssh: clean exit"
    else
      echo "$(date -Iseconds) ssh: exited with $?"
    fi
    # Reset backoff if the previous run lasted ≥120s (steady state); ramp
    # otherwise so a hard-down remote doesn't hot-loop the network.
    local now elapsed
    now=$(date +%s)
    elapsed=$((now - started_at))
    if [[ $elapsed -ge 120 ]]; then
      backoff=2
    else
      backoff=$(( backoff * 2 ))
      [[ $backoff -gt 60 ]] && backoff=60
    fi
    echo "$(date -Iseconds) sleeping ${backoff}s before reconnect"
    sleep "$backoff"
  done
}

cmd_start() {
  if is_running; then
    echo "tunnel supervisor is already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  if [[ "${1:-}" == "--background" ]]; then
    nohup "$0" __supervise >>"$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    sleep 0.5
    if is_running; then
      echo "started supervisor pid=$pid (logs: $LOG_FILE)"
    else
      echo "failed to start supervisor; check $LOG_FILE"
      return 1
    fi
  else
    echo "$$" > "$PID_FILE"
    trap 'rm -f "$PID_FILE"' EXIT
    supervisor 2>&1 | tee -a "$LOG_FILE"
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "no tunnel supervisor running"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  echo "stopping supervisor pid=$pid"
  # Kill the supervisor and its descendants. The supervisor's own SIGTERM
  # handler exits cleanly; the SSH child receives SIGHUP from its parent
  # exiting (since we never daemonized SSH).
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "supervisor didn't exit, sending SIGKILL"
    pkill -KILL -P "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "stopped"
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "supervisor: RUNNING pid=$pid"
    echo "remote:     ${REMOTE_HOST}:${REMOTE_PORT}"
    echo "local:      127.0.0.1:${LOCAL_PORT}"
    # Show SSH child(ren) for diagnostics.
    pgrep -aP "$pid" | head -5 || true
    return 0
  fi
  echo "supervisor: NOT running"
  return 1
}

cmd_logs() {
  if [[ "${1:-}" == "-f" ]]; then
    tail -f "$LOG_FILE"
  else
    tail -100 "$LOG_FILE"
  fi
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null) || return 1
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

cmd_install_service() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit_file="$unit_dir/folio-runtime-tunnel.service"
  mkdir -p "$unit_dir"
  cat > "$unit_file" <<EOF
[Unit]
Description=Folio runtime reverse SSH tunnel ($REMOTE_HOST:$REMOTE_PORT -> :$LOCAL_PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=REMOTE_HOST=$REMOTE_HOST
Environment=REMOTE_PORT=$REMOTE_PORT
Environment=LOCAL_PORT=$LOCAL_PORT
ExecStart=$(realpath "$0") __supervise
Restart=always
RestartSec=2
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now folio-runtime-tunnel.service
  echo "installed and started: $unit_file"
  echo "view logs: journalctl --user -u folio-runtime-tunnel -f"
}

cmd_uninstall_service() {
  systemctl --user disable --now folio-runtime-tunnel.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/folio-runtime-tunnel.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "uninstalled"
}

case "${1:-}" in
  start)               shift; cmd_start "$@" ;;
  stop)                cmd_stop ;;
  status)              cmd_status ;;
  logs)                shift; cmd_logs "$@" ;;
  install-service)     cmd_install_service ;;
  uninstall-service)   cmd_uninstall_service ;;
  __supervise)         supervisor ;;
  *)
    echo "usage: $0 {start [--background] | stop | status | logs [-f] | install-service | uninstall-service}"
    echo "env vars: REMOTE_HOST=$REMOTE_HOST REMOTE_PORT=$REMOTE_PORT LOCAL_PORT=$LOCAL_PORT"
    exit 2
    ;;
esac
