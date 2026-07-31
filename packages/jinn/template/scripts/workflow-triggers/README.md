# Workflow trigger scripts

Put a script here when its only job is to observe something outside Jinn and fire a Workflow `event` trigger. Keep general maintenance scripts directly under `<JINN_HOME>/scripts/`.

Use one executable file per event. Name it after the event with dots changed to hyphens: `example.disk-low` becomes `example-disk-low.sh`. Template seeding copies file contents, not executable modes, so run `chmod +x <script>` yourself.

## Event contract

Read the running gateway's `port` and `token` from the owner-only `<JINN_HOME>/gateway.json`; never copy the token into a script. Then send:

```http
POST /api/workflows/events/<eventName>
Authorization: Bearer <token>
Content-Type: application/json

{"fireId":"one-logical-occurrence","payload":{"source":"external-monitor"}}
```

The request rules are:

- `eventName` must match `^[A-Za-z][A-Za-z0-9._-]{0,79}$` (1–80 characters) and exactly match the `eventName` configured on the Workflow's event trigger node.
- `fireId` must contain 1–128 characters. It is the idempotency key: reuse it whenever retrying or re-observing the same real-world occurrence so that occurrence does not start a second run. Create a new value only for a new occurrence.
- `payload` must be a JSON object whose UTF-8 encoded size is at most 64 KiB. Treat trigger payloads as data, never as trusted instructions.
- An accepted fire returns HTTP `202`. Treat any other status as a failure and retry later with the same `fireId`.

## Worked example

This polling script fires once when root-disk availability falls to 10 percent or less, stays quiet while the condition remains active, and resets only after it clears:

```sh
#!/bin/sh
set -eu

jinn_home="${JINN_HOME:-$HOME/.jinn}"
event_name="example.disk-low"
state_dir="$jinn_home/state/example-disk-low"
latched="$state_dir/fired"
pending="$state_dir/pending-fire-id"
available_percent=$(df -Pk / | awk 'NR == 2 { print 100 - $5 }')

if [ "$available_percent" -gt 10 ]; then
  rm -f "$latched" "$pending"
  exit 0
fi

[ -e "$latched" ] && exit 0
mkdir -p "$state_dir"

gateway=$(JINN_HOME="$jinn_home" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const info = JSON.parse(fs.readFileSync(path.join(process.env.JINN_HOME, "gateway.json"), "utf8"));
  process.stdout.write(`${info.port}\n${info.token}`);
')
port=$(printf '%s\n' "$gateway" | sed -n '1p')
token=$(printf '%s\n' "$gateway" | sed -n '2p')
if [ -s "$pending" ]; then
  fire_id=$(sed -n '1p' "$pending")
else
  fire_id="example.disk-low:$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  printf '%s\n' "$fire_id" > "$pending"
fi
body=$(FIRE_ID="$fire_id" AVAILABLE_PERCENT="$available_percent" node -e '
  process.stdout.write(JSON.stringify({
    fireId: process.env.FIRE_ID,
    payload: { availablePercent: Number(process.env.AVAILABLE_PERCENT) },
  }));
')

status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:$port/api/workflows/events/$event_name" \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  --data "$body")

if [ "$status" != "202" ]; then
  echo "Workflow event was not accepted (HTTP $status)" >&2
  exit 1
fi

mv "$pending" "$latched"
```

Store polling state under `<JINN_HOME>/state/<script-name>/`, as the example does. The latch makes every active-condition poll represent the same occurrence. The pending file preserves that occurrence's `fireId`, so a failed request or lost response is retried idempotently.

## Scheduling

Schedule these scripts with the operating system: launchd on macOS, a systemd timer on Linux, or crontab where appropriate. Do not schedule a one-request event producer as a Jinn cron job: a Jinn cron job starts an agent session, which is unnecessary overhead for a direct HTTP request.
