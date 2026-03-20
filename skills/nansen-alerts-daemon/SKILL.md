---
name: nansen-alerts-daemon
description: Manage the alerts daemon — run, start, stop, status, logs. Use when setting up real-time alert streaming via WebSocket or managing the background daemon process.
metadata:
  openclaw:
    requires:
      env:
        - NANSEN_API_KEY
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---

# Alerts Daemon

Persistent WebSocket client that connects outbound to Nansen's alert stream.
No public URL or inbound ports needed — works behind any NAT/firewall.

## Quick Reference

```bash
nansen alerts daemon run                       # Foreground, NDJSON on stdout
nansen alerts daemon start --action '<cmd>'    # Background, runs <cmd> per alert
nansen alerts daemon stop                      # Stop background daemon
nansen alerts daemon status                    # Running? Last alert? PID?
nansen alerts daemon logs                      # Tail daemon log
```

## Architecture

```
Nansen WS Server  ←──outbound──  nansen alerts daemon
      │                                  │
      │ push alert JSON                  ├── stdout (NDJSON)
      │                                  └── --action hook (shell cmd)
```

The daemon connects to `wss://api.nansen.ai/v1/smart-alert/stream` using your API key.
On disconnect, it reconnects with exponential backoff (5s → 300s max) and backfills
missed alerts from the `/past-alerts` REST endpoint.

## Options (run / start)

| Flag | Description |
|------|-------------|
| `--action <cmd>` | Shell command per alert. Alert JSON on stdin. Supports `{alertId}`, `{alertName}`, `{alertType}`, `{firedAt}` placeholders. |
| `--action-env` | Pass alert JSON as `NANSEN_ALERT` env var instead of stdin |
| `--no-backfill` | Skip past-alert replay on (re)connect |
| `--ws-url <url>` | Override WebSocket URL (e.g. local mock server) |
| `--state-file <path>` | State JSON path (default: `~/.nansen/alerts-daemon-state.json`) |
| `--pid-file <path>` | PID file path (default: `~/.nansen/alerts-daemon.pid`) |
| `--log-file <path>` | Log file path (default: `~/.nansen/alerts-daemon.log`) |

## Examples

```bash
# Pipe alerts to jq for filtering
nansen alerts daemon run | jq 'select(.alertType == "sm-token-flows")'

# Wake up an agent on every alert
nansen alerts daemon start --action 'openclaw inject --message "Alert: {alertName}"'

# Pass alert data as env var
nansen alerts daemon start --action 'process-alert.sh' --action-env

# Test with local mock server
node src/daemon/mock-server.js &
nansen alerts daemon run --ws-url ws://localhost:9876/v1/smart-alert/stream

# Check status
nansen alerts daemon status --pretty
```

## Output Format

Each alert is emitted as a single JSON line (NDJSON):

```json
{"type":"alert","alertId":"abc123","alertName":"ETH SM Inflow >5M","alertType":"sm-token-flows","firedAt":"2026-03-20T11:46:00Z","data":{...}}
```

## State File

`~/.nansen/alerts-daemon-state.json` tracks `lastAlertAt` for backfill on reconnect.
Written atomically (tmp + rename). Permissions: `0600`.

## Notes

- Requires a valid Nansen API key (`nansen login` or `NANSEN_API_KEY` env var)
- Node 22+ has built-in WebSocket; older versions need `npm install ws`
- The `--action` hook runs each alert as a subprocess — not `eval` — preventing shell injection from alert data
- Log files contain only alert metadata (ID, name, type, timestamp), not data payloads
