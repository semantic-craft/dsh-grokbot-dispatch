# dsh-grokbot-dispatch

A DeepSeek Harness (DSH `>=0.2.0-rc.2`) official Cordis plugin for two-way task dispatch between DSH and other agents (Grok Bot, ZCode via [`zcode-dispatch`](https://github.com/semantic-craft/zcode-dispatch), or anything that speaks the small HTTP API below): inbound jobs become visible DSH desktop sessions, outbound `/dispatch-*` commands send tasks out, and finished jobs report back.

## Prerequisites

- DSH `>=0.2.0-rc.2` (desktop app for visible sessions; `dsh` on `PATH` or `dshBin` for the headless runner), Node `>=20`.
- Project folders under `projectsRoot` (default `~/Projects/<project>`); names matching `denyProjects` (default `finance`) are refused.
- A network path from the callers to `host:port` (LAN, VPN, Tailscale, SSH tunnel…). The listener is **plain HTTP**: protected by a source-IP allowlist plus a shared Bearer key, no TLS. Keep it on a trusted network or put a TLS proxy/tunnel in front.
- **Not required**: Yobiru / tailmsg, Tailscale, macOS / launchd. Those are optional (see the table).

## Feature × dependency

| Feature | Default (`transport: "direct"`) | Optional `transport: "yobiru"` |
|---|---|---|
| Inbound: caller → `POST /v1/jobs` → DSH session | key file + `host` + `allowedIps` | same |
| Result pull: `GET /v1/jobs/<id>` | ✅ | ✅ |
| Result push on completion | `callback_peer` / `callback_url` → HTTP `POST` to that peer (`/v1/callbacks`) | `tailmsg request respond` / `send --reply-to` |
| Outbound `/dispatch-grok`, `/dispatch-zcode`, `POST /v1/outbound` | `peers.<name>` `{url, keyFile}` → peer's `POST /v1/jobs` | `grokbotPeer` / `zcodePeer` Yobiru addresses + tailmsg CLI |
| Host / allowlist auto-discovery | optional: `tailscale status --json` if Tailscale is installed | same |
| Auto-start fallback host | optional (e.g. macOS launchd; private deploy config is not in this repo — see your own deploy docs/mesh) | same |

## Minimal working config (direct)

```sh
umask 077; mkdir -p ~/.config/dsh-grokbot-dispatch
openssl rand -hex 32 > ~/.config/dsh-grokbot-dispatch/key     # callers send this as "Authorization: Bearer <key>"
# key of each peer you dispatch to (the peer's own inbound key), e.g. zcode:
cp /path/from/zcode-host/key ~/.config/dsh-grokbot-dispatch/zcode.key; chmod 600 ~/.config/dsh-grokbot-dispatch/*.key
```

`~/.config/dsh-grokbot-dispatch/config.json`:

```json
{
  "host": "192.168.1.20",
  "port": 7790,
  "allowedIps": ["192.168.1.30"],
  "selfName": "dsh",
  "peers": {
    "zcode": { "url": "http://192.168.1.30:7791", "keyFile": "~/.config/dsh-grokbot-dispatch/zcode.key" }
  }
}
```

Then `cd /tmp && dsh plugin --profile desktop add "link:$PWD/plugin"` (from a checkout). On start the plugin logs a **compat check** (key file present and `chmod 600`, `host`/`allowedIps` non-empty, `projectsRoot` exists, `dsh` found, transport prerequisites) and `GET /health` returns the same as `{ok, transport, checks:{errors, warnings}}`; nothing fails silently.

A peer that should push results back to you needs **you** in its `peers` under your `selfName` (or send `callback_url` pointing at one of its configured peers). `callback_url` that does not start with a configured peer `url` is refused (no arbitrary outbound POSTs).

`transport: "yobiru"` is **optional**, for meshes already running Yobiru/tailmsg: add `"transport": "yobiru"` plus `grokbotPeer` / `zcodePeer` (Yobiru addresses) and optionally `"yobiru": {"python", "script", "home", "path"}` (defaults: `python3` from `PATH`, `~/.tailmsg/tailmsg.py`, `~/.tailmsg`, inherited `PATH`). All tailmsg calls live in `plugin/transport.js`.

## Architecture & Official DSH Plugin Surface

- **Official DSH Bundle & Metadata (`plugin/package.json`)**:
  - `dsh.manifestVersion: 1`, `dsh.bundle.patch: "./cordis.patch.yml"`, `dsh.harnessRange: ">=0.2.0-rc.2"`.
  - Exports `.` (`./index.js`), `./package.json`, and `./locale/*.json` (`plugin/locale/en.json`, `plugin/locale/zh-CN.json`) so DSH's `readPluginMeta` (`@deepseek-ai/dsh-app-boot`) displays localized titles and descriptions in the Desktop Plugin Inventory.
- **Primary host = the DSH desktop app**:
  - Linked into `~/.dsh/profiles/desktop/package.json` (`dependencies` + `dsh.profile.bundles`).
  - Opens an HTTP listener inside `ctx.effect` bound only to `host` (config, or this host's tailnet IP if Tailscale is installed; `host`, default port 7790) and writes `~/.local/state/dsh-grokbot-dispatch/primary.pid`.
- **Fallback host (headless runner)**:
  - Optional. Example (macOS launchd; private deploy templates live outside this public repo): a standalone profile `grokbot-dispatch` with `DISPATCH_STANDBY=1 DISPATCH_RUNNER=headless`. While the desktop app holds `7790` it waits quietly; when the app is closed it takes the port and runs jobs with `dsh --profile headless --json`; once the app returns and it is idle it yields the port.
- **Visible sessions (app runner)**:
  - Each inbound job creates a visible session in the DSH desktop app's left panel under its project with `[Job: <16-hex>]` embedded in its title (`[Grok Bot] [Job: <id>] <task…>` or `[Yobiru] [Job: <id>] <task…>`):
    `workspaceController.create({path})` → `sessionController.create({workspaceId})` → `permissionPresets.set(agents.get(id).session, mode)` → `sessionController.rename({sessionId, title})` → `sessionController.follow({address:{kind:'session',sessionId}}, signal)` → `sessionController.prompt({requestId: job.id, sessionId, mode:'queue', content:[{type:'text', text}]}, signal)`.
- **Outbound slash commands (`plugin/commands.js`)**:
  - Registered via DSH's official `ctx.commands.register` (`@deepseek-ai/dsh-commands`):
    - `/dispatch-grok <project> <task…>` — validates `<projectsRoot>/<project>` (`denyProjects` refused), sends `[Project: <project>] <task…>` to peer `grok-bot` (direct: `POST <url>/v1/jobs`; yobiru: `tailmsg.py request send <grokbotPeer> --as dsh --wake now`), and records the `sessionId <-> jobId` mapping.
    - `/dispatch-zcode <project> <task…>` — dispatches to peer `zcode` the same way and records the mapping.
    - `/dispatch-status [job-id]` — inspects active jobs and recent `sessionId <-> jobId` mappings.
- **Persistent `sessionId <-> jobId` mapping & automatic reporting (`plugin/job-map.js`, `plugin/hooks/`)**:
  - `JobMapStore` persists `byJob` and `bySession` mappings in `~/.local/state/dsh-grokbot-dispatch/job-map.json` (mode `0600`, atomic rename).
  - If a session is created or continued with `[Job: <16-hex>]` or `[Yobiru-ID: <16-hex>]` in its title or prompt, `resolveForSession` automatically binds `sessionId <-> jobId`.
  - When a turn finishes (`runAppJob` completion, Cordis `session/event` `turn/end`, `agent/turn-stopping`, or the Claude-Code hook bridge `plugin/hooks/hooks.json` → `plugin/hooks/stop-report.mjs`), `reportJob` idempotently pushes the structured `dsh-job-report-v1` payload through the transport (direct: `POST` JSON to `callback_url` or `<peers[callback_peer].url>/v1/callbacks`; yobiru: `tailmsg.py request respond <id> <payload> --state <completed|failed>` + `ack <id>`, or `tailmsg.py send <callback_peer> <payload> --as dsh --reply-to <jobId> --wake now`), guarded across processes by an exclusive `<jobId>.report.lock` reservation (released on send failure for retry; taken over after 10 min if abandoned) and an in-process `Map`.
  - **Reporting routing policy**: Only tasks dispatched by Grok Bot (`source: "grok-bot"` / `"grok"`) fall back to `grokbotPeer`; `source: "yobiru"` requests are answered only via `request respond` to their requester. Tasks originating from `zcode`, `dsh`, or local/manual sessions never fall back or report to Grok: if an explicit `callback_peer` pointing to their non-Grok origin (e.g. ZCode) is provided, the report is sent to that origin; otherwise no Yobiru callback is sent and the result is only persisted locally on disk.


## Configuration (no hosts, IPs or user paths in code)

Every setting resolves as **env var > `~/.config/dsh-grokbot-dispatch/config.json` > tailscale discovery (if installed) > default** (`plugin/config.js`, `plugin/transport.js`):

| Setting | Env | config.json | Discovery when unset |
|---|---|---|---|
| bind host | `DISPATCH_HOST` | `host` | this node's tailnet IPv4 (`tailscale status --json`); never `0.0.0.0` — if nothing resolves the listener stays down |
| port | `DISPATCH_PORT` | `port` | 7790 |
| Grok Bot peer | `GROKBOT_PEER` | `grokbotPeer` | none — outbound `/dispatch-grok` and Grok reporting stay disabled until set |
| ZCode peer | `ZCODE_PEER` | `zcodePeer` | this node's MagicDNS name + `/zcode` |
| allowed source IPs | `DISPATCH_ALLOWED_IPS` (comma list) | `allowedIps` | tailnet IPs of the `grokbotPeer` node (follows a box re-login IP change) |
| transport | `DISPATCH_TRANSPORT` | `transport` | `direct` |
| direct peers | — | `peers` `{name: {url, keyFile}}` | none |
| our name for callbacks | — | `selfName` | `dsh` |
| explicit callback URL | — | `callbackUrl` | none (send `callback_peer: selfName`) |
| dsh binary | `DSH_BIN` | `dshBin` | `dsh` on `PATH` |
| projects root / denied | `DISPATCH_PROJECTS_ROOT` | `projectsRoot` / `denyProjects` (regex) | `~/Projects` / `finance` |
| Yobiru CLI (yobiru only) | `TAILMSG_PYTHON` / `TAILMSG_SCRIPT` / `TAILMSG_HOME` | `yobiru.python` / `.script` / `.home` / `.path` | `python3` / `~/.tailmsg/tailmsg.py` / `~/.tailmsg` / inherited `PATH` |

Use `DSH_DISPATCH_CONFIG=<file>` to point at another file, `DSH_DISPATCH_DISCOVERY=0` to disable discovery, and `TAILSCALE_BIN` if the CLI is not on PATH.

## Non-public Host Interfaces & Upgrade Notes

- **Official interfaces used**: `package.json` (`dsh.manifestVersion`, `dsh.bundle.patch`, `dsh.harnessRange`, `exports["./locale/*.json"]`), `ctx.effect`, `ctx.commands.register`, and Claude-Code hook format (`plugin/hooks/hooks.json`).
- **Internal Host services used (no public SDK alternative in DSH `0.2.0-rc.2` for in-process visible session creation)**:
  - `ctx.get('workspaceController')`, `ctx.get('sessionController')`, `ctx.get('permissionPresets')`, `ctx.get('agents')`, and Cordis events `session/event` / `agent/turn-stopping`.
  - If a future DSH release changes these service signatures, `pickRunner` / `getServices` degrades or can be forced to the CLI fallback via `DISPATCH_RUNNER=headless`.

## API

| Route | Body / result |
|---|---|
| `GET /health` | `{ok, running, runner, transport, checks:{errors,warnings}, uptime_s}` (IP check only) |
| `POST /v1/jobs` | `{project, text, timeout_seconds?, permission_mode?, source?: "grok-bot"\|"yobiru"\|"zcode"\|"dsh", job_id?, yobiru_id?, callback_peer?, callback_url?, report_via_yobiru?}` → `202 {id, runner:"app"\|"headless", state:"running", ...}` |
| `GET /v1/jobs/<id>` | `{state: running/completed/failed, runner, session_id, title, tools, result, error, reported?, report_method?, ...}` |
| `POST /v1/callbacks` | a peer pushes `dsh-job-report-v1` / `{job_id, state, result, error}` for a job we sent it → stored on the outbound job-map entry (see `/dispatch-status <id>`) |
| `POST /v1/outbound` | `{target: <peer name>, project, task, session_id?}` → `202 {ok, jobId, target, peer, sessionId, ...}` |
| `GET /v1/job-map` | `{entries: [...]}` |

Shell client (any machine with curl): `DSH_DISPATCH_URL=http://host:7790 DSH_DISPATCH_KEY=... client/dsh-dispatch.sh send myproj "[Project: myproj] ..."`, then `client/dsh-dispatch.sh wait <id>`.

## Install / operate

See *Minimal working config* above. Private deployment config (Yobiru transport, launchd fallback host, self-check) is not in this repository — see your own deploy docs/mesh.

## Reliability, logs, self-check

- **Auto-start / restart** (optional launchd example): the agent has `RunAtLoad` and `KeepAlive` (`ThrottleInterval` 30 s).
- **Sleep / tailnet loss**: `supervise` retries bind errors every 30 s and TCP-probes `<host>:<port>` every 30 s. On the primary (desktop) host it never calls `process.exit` and resets `downSince` so it keeps rebinding across prolonged sleep.
- **Logs** (`~/.local/state/dsh-grokbot-dispatch/logs/`): `dispatch.log` (rotated at 2 MB × 5) and `launchd.log`.
- **Self-check**: `GET /health` (compat check); optional local self-check scripts (not shipped in this public repo) can print launchd state, `/health`, recent log events, and recent jobs.
- **Local literal-IP guard**: `bin/check` (no network, no GitHub Actions) fails on hard-coded IPv4 addresses in the tailnet range. Docs, `test/`/`tests/` fixtures, and exact `path|address|reason` entries in `.ip-literals-allow` are exempt.
