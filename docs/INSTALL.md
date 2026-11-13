# Installing with your own data

Mission Control runs anywhere Node.js or Docker runs. It needs only the address of
your OpenClaw Gateway and its token; a Markdown/Git workspace is optional. It does
not install or change OpenClaw.

## 1. Choose how to run it

**Docker Compose** (recommended):
```bash
cp .env.example .env        # then fill in MC_ACCESS_TOKEN and MC_GATEWAY_TOKEN
openssl rand -hex 32        # a good MC_ACCESS_TOKEN
docker compose up -d --build
docker compose logs -f      # "Mission Control ready at http://127.0.0.1:4318"
```
Open http://127.0.0.1:4318 and sign in with `MC_ACCESS_TOKEN`. The port is
published on the host loopback only. State (sessions, audit records, the Gateway
device identity) lives in the `state` volume.

**Node.js 24.19 or later**, on the machine you browse from:
```bash
npm ci --omit=dev --ignore-scripts
MC_GATEWAY_URL=ws://127.0.0.1:18789 MC_GATEWAY_TOKEN=... MC_WORKSPACE=/path/to/workspace npm start
```
Without other settings it listens on 127.0.0.1:4318 with no login, and keeps its
state in `./state`. Run `npm test` first if you changed anything.

## 2. Connect the OpenClaw Gateway

| Where the Gateway runs | `MC_GATEWAY_URL` |
|---|---|
| Same machine, dashboard with `npm start` | `ws://127.0.0.1:18789` |
| Same machine, dashboard in Docker Desktop (macOS, Windows) | `ws://host.docker.internal:18789` (the compose default) |
| Same Linux machine, Gateway listening only on 127.0.0.1 | Run the dashboard with `network_mode: host` and `MC_HOST=127.0.0.1` (see below), then `ws://127.0.0.1:18789`; or make the Gateway also listen on the Docker bridge |
| Another compose project | Join its network and use the service name, e.g. `ws://openclaw-gateway:18789` |
| Another machine | `wss://...`, or `ws://` to a Tailscale (`*.ts.net`, 100.64.0.0/10) or private address |

`ws://` is accepted only for loopback, private and Tailscale addresses.
`host.docker.internal` and Docker service names also need
`MC_GATEWAY_ALLOW_PRIVATE_WS=1`, which the compose file sets by default; set it to
`0` when the Gateway is elsewhere.

Host-network variant for Linux, in a `docker-compose.override.yml`:
```yaml
services:
  mission-control:
    network_mode: host
    ports: !reset []
    extra_hosts: !reset []
    environment:
      MC_HOST: 127.0.0.1
      MC_GATEWAY_URL: ws://127.0.0.1:18789
```

On first connection the Gateway asks to pair the dashboard's own device. Home and
Settings then show the exact command to run on the Gateway host
(`openclaw devices approve <requestId>`, or
`docker exec <container> node /app/openclaw.mjs devices approve <requestId>`).
Approve only the request whose device ID matches the one shown. The dashboard asks
for the `operator.read`, `operator.write` and `operator.admin` scopes: it can change
models, routines, documents and tasks, and chat with your agents.

It is built against OpenClaw 2026.9.x; [OPENCLAW.md](OPENCLAW.md) lists what it calls,
so you can check another version before relying on writes.

## 3. Sign-in

| `MC_AUTH` | When to use it | What it needs |
|---|---|---|
| `none` | Only you, on this computer. Default for `npm start` on 127.0.0.1. | The dashboard must be opened at 127.0.0.1/localhost. In Docker, also `MC_ALLOW_UNAUTHENTICATED_BIND=1` (the compose port stays on 127.0.0.1). |
| `token` | Default in Docker; any time the dashboard is reachable by others. | `MC_ACCESS_TOKEN` (32+ characters: `openssl rand -hex 32`) or `MC_ACCESS_TOKEN_FILE`. Optional `MC_ACCESS_NAME`, the name recorded in audits (default `token`). |
| `proxy` | A reverse proxy already signs people in (Tailscale Serve, oauth2-proxy, Cloudflare Access, Authelia...). | `MC_PROXY_AUTH_HEADER`, e.g. `Tailscale-User-Login`, `X-Forwarded-Email`, `Cf-Access-Authenticated-User-Email`. Optional `MC_PROXY_ALLOWED_USERS` (comma-separated) and `MC_PROXY_LOGOUT_URL`. |
| `cloudflare-access` | Cloudflare Access in front, with the JWT checked again here. | `MC_ACCESS_TEAM`, `MC_ACCESS_AUD`, `MC_ACCESS_EMAILS`, and an `https://` `MC_ORIGIN`. |

In token mode the browser gets an HttpOnly, SameSite=Strict session cookie that
lasts 7 days; changing the token signs everyone out. Scripts can send
`Authorization: Bearer <token>`. Failed attempts are rate-limited.

In proxy mode the dashboard trusts the header on every request: its port must be
reachable **only** through the proxy, and the proxy must overwrite that header.

To reach the dashboard from other devices, put an HTTPS reverse proxy in front
(Caddy, Tailscale Serve, Cloudflare Tunnel...), set `MC_ORIGIN` to its public
address and make the proxy send `X-Forwarded-Proto: https`. Token mode refuses a
plain-HTTP origin outside 127.0.0.1. The server refuses to start whenever a setting
is unsafe or incomplete, and says which one.

## 4. Settings

| Variable | Default | Meaning |
|---|---|---|
| `MC_GATEWAY_URL` | (compose: `ws://host.docker.internal:18789`) | Gateway WebSocket address. |
| `MC_GATEWAY_TOKEN`, `MC_GATEWAY_TOKEN_FILE` | | Gateway shared token (`gateway.auth.token`). |
| `MC_GATEWAY_ALLOW_PRIVATE_WS` | compose: `1` | Allow `ws://` to host names such as `host.docker.internal`. |
| `MC_GATEWAY_DEVICE_FILE` | `MC_STATE_DIR/gateway-device.json` | An existing device identity, instead of the generated one. |
| `MC_GATEWAY_WORKSPACE` | `/workspace` | Path of the same workspace as your agents see it, so chat attachments reach them. |
| `MC_AUTH` | `none` on loopback; compose: `token` | Sign-in mode (section 3). |
| `MC_ACCESS_TOKEN`, `MC_ACCESS_TOKEN_FILE`, `MC_ACCESS_NAME` | | Token mode. |
| `MC_PROXY_AUTH_HEADER`, `MC_PROXY_ALLOWED_USERS`, `MC_PROXY_LOGOUT_URL` | | Proxy mode. |
| `MC_ACCESS_TEAM`, `MC_ACCESS_AUD`, `MC_ACCESS_EMAILS` | | Cloudflare Access mode. |
| `MC_ALLOW_UNAUTHENTICATED_BIND` | | `1` lets `MC_AUTH=none` listen beyond loopback (containers only). |
| `MC_WORKSPACE` (compose: `MC_WORKSPACE_DIR`) | none | Your Markdown/Git workspace ([WORKSPACE.md](WORKSPACE.md)). Without it, tasks, projects and documents stay empty. |
| `MC_WORKSPACE_LAYOUT` | `auto` | `auto`, `en` or `pt` folder names. |
| `MC_STATE_DIR` | `./state`; compose: `/state` | Dashboard state, outside the workspace. |
| `MC_HOST`, `MC_PORT` | `127.0.0.1`, `4318` | Listening address and port. |
| `MC_ORIGIN` | `http://127.0.0.1:MC_PORT` | The address people open, when a proxy serves another one. |
| `TZ` | system; compose: `UTC` | Decides "today" for due dates and the times shown. |

In Docker the container runs as the `node` user (UID 1000): the workspace folder
must be writable by that user for the dashboard's edits and commits.

## 5. Server metrics

The Server page samples the machine the dashboard runs on, once a minute: CPU,
memory, load, uptime, disk of the workspace (or state) folder, and the dashboard's
own memory and event-loop delay. History is kept in memory for 24 hours. In Docker,
CPU, memory and load are those of the host kernel; disk is the mounted folder.
The Git/GitHub card counts commits not pushed yet when the workspace branch tracks a
remote; the push itself is your own job.

## Optional health checks

Any job of yours (a cron script, a timer, another monitoring tool) can feed the
dashboard's alerts and incidents by writing `checks.json` to the state directory
(`MC_STATE_DIR`; in Docker, the `state` volume, e.g.
`docker compose cp checks.json mission-control:/state/checks.json`):

```json
{
  "checked_at": "2026-01-01T12:00:00Z",
  "checks": {
    "disk": { "status": "ok", "message": "Disk below 80%" },
    "backup": { "status": "warn", "message": "Last backup is 30 hours old", "notify": true },
    "memory:assistant": { "status": "fail", "message": "Memory index unavailable" }
  }
}
```

- `checked_at` is an ISO-8601 time. Results more than two hours old are stale: they
  open, resolve and raise nothing, and the source shows as out of date.
- `status` is `ok`, `warn`, `unknown`, `skipped`, `fail`, `error` or `critical`.
  `fail`, `error` and `critical` open an incident, which a later `ok` for the same
  check resolves. The other values show as warnings until someone acknowledges them.
- `notify: true` raises a warning to high severity.
- Use check IDs without spaces. A check whose ID ends in `:<agent id>` (such as
  `memory:assistant`) also shows on that agent's card while it is not `ok`.
- Write the file atomically: write a temporary file in the same folder, then rename it.

Without this file the source is shown as not connected, and nothing else changes.


## Backup and updates

Back up the workspace and the state directory (or the `state` volume). To update,
pull the new version and run `docker compose up -d --build` (or `npm ci` and
restart). Follow OpenClaw releases before updating the Gateway.

## Recovery

**An action reports `auditWarning`.** The change was committed, but the extra audit
record failed. The action happened: **do not repeat it**.

**A write failed in the middle of a transaction.** The dashboard leaves the marker
`.git/mission-control-pending.json` in the workspace repository, and that marker blocks
every new write from the dashboard until someone recovers it. It records the starting commit (`head`), the action,
the IDs and the paths involved; for a document, also the name of its backup.

To recover an interrupted transaction:

1. Stop new writes: do not use the dashboard's write controls in the meantime.
2. Keep the backup (the `document-backups/` folder in the dashboard's state
   directory, `MC_STATE_DIR`) and keep the marker.
3. In the workspace, check the commit and the diffs of the paths involved:
   `git log -1`, `git status` and `git diff -- <paths from the marker>`. The
   dashboard's commits start with `mission-control:`.
4. Decide the specific fix for those paths. Typical cases:
   - The dashboard's commit exists after `head`, but Git still lists those paths
     as changed: the commit was made and only the index was not updated;
     `git reset -q -- <paths>` updates the index for those paths only.
   - There is no such commit: the files were written but not committed. Review
     them, then commit them yourself, or restore them with `git checkout -- <paths>`
     (delete a file the action created) or from the document backup.
5. Only then remove the marker.

Do not remove `.git/index.lock` while another Git process may be running.
Do not use `git reset --hard`, and do not repeat the click as a recovery attempt.
