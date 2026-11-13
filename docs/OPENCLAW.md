# Connecting to OpenClaw

Mission Control talks to your OpenClaw Gateway over the Gateway's WebSocket protocol,
the same one the Control UI uses. It reads what the Gateway already knows (agents,
sessions, routines, channels, models, health) and keeps no parallel database.
It is built against **OpenClaw 2026.9.x** (Gateway protocol 4).

## Connection

| Setting | Meaning |
|---|---|
| `MC_GATEWAY_URL` | `ws://` or `wss://` address of the Gateway, e.g. `ws://127.0.0.1:18789`. |
| `MC_GATEWAY_TOKEN` or `MC_GATEWAY_TOKEN_FILE` | The Gateway's shared token (`gateway.auth.token` in the OpenClaw configuration). |
| `MC_GATEWAY_ALLOW_PRIVATE_WS=1` | Allows plain `ws://` to Docker service names and `host.docker.internal`. |
| `MC_GATEWAY_DEVICE_FILE` | Optional: an existing device identity instead of the generated one. |

Plain `ws://` is accepted only for loopback, private networks, Tailscale
(`100.64.0.0/10`, `*.ts.net`) and `.local` names; anything else needs `wss://`.
A Gateway with a self-signed certificate needs `NODE_EXTRA_CA_CERTS` pointing to its CA.

The connection is kept open and reused. If the Gateway restarts or the network drops,
the dashboard reconnects on its own and shows the source as unavailable meanwhile.
After a rejected token it waits a minute before trying again.

## Device pairing

On first start the dashboard creates its own Ed25519 device identity in the state
directory (`MC_STATE_DIR/gateway-device.json`, readable only by its owner) and asks the
Gateway to pair it with the scopes `operator.read`, `operator.write` and
`operator.admin`. The admin scope is needed to change an agent's models.

While approval is pending, Home and Settings show the device ID and the exact command
to run where the Gateway runs:

```bash
openclaw devices approve <requestId>
# OpenClaw in Docker:
docker exec <container> node /app/openclaw.mjs devices approve <requestId>
```

Approve only the request whose device ID matches the one the dashboard shows.
The dashboard connects on its next refresh. A direct loopback connection with the
shared token (same machine, or an SSH tunnel) does not need pairing.
Deleting `gateway-device.json` creates a new device, which needs approval again.

The dashboard never reuses the identity of the CLI or the Control UI, and it never
writes OpenClaw's configuration files: every change goes through the Gateway's RPC.

## What it calls

| Method | Parameters sent | Used for |
|---|---|---|
| `agents.list` | none | agents, chat |
| `models.list` | `view: 'default'`, `includeDetails: true` | model catalog, changing models |
| `sessions.list` | `includeDerivedTitles: false`, `includeLastMessage: false`, `configuredAgentsOnly: true`, `archived: 'all'`, `limit`, `offset` | sessions, renewing a session |
| `cron.list` | `includeDisabled: true`, `compact: true`, `includeDeliveryPreviews: false`, `limit`, `offset` | routines |
| `channels.status` | `probe: false` | channels |
| `health` | none | Gateway health |
| `config.get` | none | inherited model fallbacks, changing models |
| `config.patch` | `baseHash`, `raw` (only the targeted model fields), `note` | changing models |
| `cron.get`, `cron.runs`, `cron.update` | `id`, `limit`/`offset`, `patch`, `expectedConfigRevision` | routine details, runs and edits |
| `chat.send` | `agentId`, `sessionKey`, `message`, `idempotencyKey`, `deliver: false`, `suppressCommandInterpretation: true` | chat |
| `agent.wait` | `runId`, `timeoutMs` | waiting for a chat reply |
| `chat.history` | `sessionKey`, `agentId`, `limit`, `offset`, `maxBytes` | conversation history |
| `sessions.reset` | `key`, `agentId`, `reason: 'new'` | renewing a session (after explicit confirmation) |

On another OpenClaw version, check that these methods and parameters still exist and
behave the same before relying on writes, chat or model changes.

## What it shows and what it changes

- **Collected automatically:** agents and their models, sessions (metadata and token
  counts, never message content), routines (schedule and last runs, never their
  prompts or scripts), channels (state and timestamps, never credentials or
  recipients), the model catalog and Gateway health. Lists are paginated, up to 5,000
  records; a truncated list is reported, never shown as complete.
- **Chat:** messages go to the session `agent:<id>:mission-control` by default, with
  delivery to external channels turned off. A reply that takes too long is shown as
  still in progress; the message is never resent automatically.
- **Routines:** only name, schedule and on/off can be edited, with a revision check.
- **Models:** only the agent's primary model and fallbacks are sent, with a hash check
  of the current configuration.
- **Sessions:** renewing asks for confirmation and the reviewed session ID, and refuses
  an active, archived or replaced session.

Writes have no automatic retry: a timeout does not prove the action did not happen.

## Errors

| Status | Meaning |
|---|---|
| `400` | Invalid input |
| `404` | Agent, routine or session not found |
| `409` | The data changed, or the session is active, archived or replaced |
| `501` | Not supported by the installed OpenClaw version |
| `502` | The Gateway's answer was not understood or not confirmed |
| `503` | Gateway unreachable, credentials rejected, or pairing pending |
| `504` | Timeout |

Error messages never include tokens, raw Gateway output or diagnostics.

## Running inside the OpenClaw image

Without `MC_GATEWAY_URL`, the dashboard falls back to importing the Gateway client from
an OpenClaw installation (`MC_GATEWAY_SDK`, default
`/app/dist/plugin-sdk/gateway-runtime.js`). That only works when the dashboard runs
inside the OpenClaw image; the WebSocket connection above is the recommended path.
