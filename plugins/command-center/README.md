# Command Center

The Command Center (CC) is a small phone-first app that queues work for your official T3 Code machines and runs it 24/7. Ask from the phone, pick a project on any machine, and the CC starts the thread in T3 when that machine is online and has a free slot. **Hoy** shows what needs you, what is running and what finished. **Abrir en T3** takes you to the thread in the official T3 app.

The app is in Spanish and has five destinations: **Hoy**, **Trabajo** (Lista, Tablero, Flujos), **Proyectos** (Todos, Artefactos, Memoria), **Dinero** and **Flota** (Máquinas, Agentes, Notificaciones). On the phone the bottom bar has Hoy, Trabajo, a mic button, Proyectos and **Más** (which also holds Dinero and Flota). **Pedir** is not a destination: press `Ctrl/Cmd+K`, or tap the mic on the phone.

The CC talks to T3 only through T3's normal client connection, with a token you issue. It never changes T3 itself.

## Find and continue work

Use **Proyectos > Todos** to search by name or path and narrow the directory by machine or connection status. Pins and groups keep related projects together; manual ordering is available with filters cleared. A project opens with tabs: Resumen, Trabajo, Secciones, Artefactos and Memoria. **Trabajo > Lista** searches across task names, projects and branches. Both directories paginate across machines, with separate branch pages inside each project.

**Hoy** puts what needs you first (approvals, questions, plans, alerts) and never pages it; history is paged. **Trabajo > Lista** filters by machine and status. **Flujos** searches both the library and recent runs. These pages show the activity currently available to the CC, rather than a complete historical archive.

On a keyboard, `Ctrl/Cmd+K` opens Pedir, `/` opens search and `?` shows shortcut help. Press `g` then a key to go to a page: `h` Hoy, `t` or `w` Lista, `b` Tablero, `p` Proyectos, `r` Artefactos, `m` Memoria, `d` Dinero, `f` Flota, `n` Notificaciones, `a` Pedir. Shortcuts leave text fields and open dialogs alone.

## What runs where

- **VPS** (Linux, on your tailnet): official T3 as a background service, and the CC as its own system user `cc`, reachable only on the tailnet at `https://<vps>.<tailnet>.ts.net:8443`.
- **PC**: the official T3 desktop app with Tailscale HTTPS on. Tasks for the PC wait while the app is closed.
- **Phone**: the Tailscale app, the official T3 app, and the CC installed from the browser to the home screen.

## Install on the VPS

You need systemd, Node 24.13.1 or newer at `/usr/bin/node` (for example from NodeSource), `git`, `curl`, and Tailscale with MagicDNS and HTTPS certificates. The machine name appears in public certificate logs, so pick one you are happy to publish.

1. Set up official T3 as your normal user: install the `t3` command, then `t3 service install` and `t3 pair --tailscale`. Pair the official phone app with it.

2. Create the `cc` user and install the CC (replace `<you>` with your GitHub account):

   ```sh
   sudo useradd --system --user-group --create-home --home-dir /var/lib/cc --shell /usr/sbin/nologin cc
   sudo chmod 700 /var/lib/cc
   sudo -u cc git clone --filter=blob:none https://github.com/<you>/t3code.git /var/lib/cc/src
   sudo -u cc mkdir -m 700 /var/lib/cc/data /var/lib/cc/backups /var/lib/cc/releases
   d=/var/lib/cc/src/plugins/command-center/deploy
   sudo -u cc install -m 600 $d/env.example /var/lib/cc/env
   sudo -u cc nano /var/lib/cc/env   # set CC_PUBLIC_URL and CC_PUSH_SUBJECT
   sudo install -m 755 $d/cc-update /usr/local/sbin/
   sudo install -m 755 $d/cc-backup $d/t3-update /usr/local/bin/
   sudo install -m 644 $d/command-center.service $d/cc-update.service $d/cc-update.timer \
     $d/cc-backup.service $d/cc-backup.timer /etc/systemd/system/
   sudo install -m 644 $d/t3-update.service $d/t3-update.timer /etc/systemd/user/
   sudo systemctl daemon-reload
   sudo systemctl enable command-center.service
   sudo systemctl enable --now cc-update.timer cc-backup.timer
   sudo cc-update --force   # first deploy: install, build, test, start
   sudo tailscale serve --bg --https=8443 http://127.0.0.1:3900
   ```

   Never use `tailscale serve reset` (it also removes T3's mapping) and never use Funnel.

3. Turn on daily T3 updates, as your normal user:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now t3-update.timer
   ```

4. Add this helper to your `~/.bashrc`. The commands below use it:

   ```sh
   ccctl() { sudo -u cc bash -c 'set -a; . /var/lib/cc/env; cd /var/lib/cc/current && CC_HOME=/var/lib/cc/data exec node --disable-warning=ExperimentalWarning server/main.ts "$@"' ccctl "$@"; }
   ```

   `ccctl --help` lists every command.

## Pair your phone

1. Keep the Tailscale app on.
2. On the VPS, run `ccctl pair`. Open the printed link on the phone within 5 minutes; it works once.
3. Install it: **Share → Add to Home Screen** on iOS, **Install app** on Android.

Run `ccctl pair` again for each new device.

## Add your machines

Each machine needs a T3 token that can read and run threads, nothing more. Add a machine by its tailnet HTTPS address and paste its token on stdin.

**VPS** (as your normal user):

```sh
t3 auth session issue --scope orchestration:read --scope orchestration:operate --ttl 365d --label command-center --token-only \
  | ccctl machine add https://<vps>.<tailnet>.ts.net --web-url https://nightly.app.t3.codes
```

**PC**: in the desktop app, open **Settings → Connections** and turn on **Tailscale HTTPS** (leave Network access off). Install the `t3` command from **Settings → General → About**, then run in a terminal on the PC:

```sh
t3 auth session issue --scope orchestration:read --scope orchestration:operate --ttl 365d --label command-center --token-only
```

Copy the token, then on the VPS run `ccctl machine add https://<pc>.<tailnet>.ts.net --web-url https://nightly.app.t3.codes`, paste it and press Ctrl-D.

- `--web-url` is where **Open in T3** goes. Use `https://nightly.app.t3.codes` while your machines run T3 Nightly: the stable web app and the App Store and Google Play apps cannot connect to Nightly servers yet. On the phone, use the beta app (TestFlight on iOS, the `android-nightly` APK from T3's GitHub releases on Android).
- `--max <n>` sets how many CC tasks run at once on that machine (default 2). `--label <name>` renames it. Run `machine add` again with the same address to change these or to replace the token.
- `ccctl machine list` shows each machine, its T3 version and token expiry. `ccctl machine rm <id>` removes one.
- Tokens are stored only on the VPS, readable only by `cc`. Revoke one in T3 under **Settings → Connections**. You get an alert 14 days before a token expires.

## Daily use

- **Pedir**: write or dictate the prompt, pick a machine and project, send. The task waits in **Trabajo** until that machine is online and has a free slot. Only one CC task runs per project and machine at a time.
- **Hoy**: what needs you (approvals, questions, plans, alerts), what is running and what finished in the last day. Open a thread to read its last message, approve or decline a command or file change, stop a run, or settle a finished thread. Questions and plans are answered in T3: **Abrir en T3** opens the thread in the official app.
- **Trabajo**: **Lista** and **Tablero** show every task and branch, from the queue to cleanup. Reorder, cancel or retry tasks, and approve tasks that agents submitted. A task that depends on another starts after it finishes, with its result added to the prompt. It refreshes every 30 seconds only while open.
- **Flota > Máquinas**: connection state, T3 version, token expiry and host CPU and memory for each machine (refreshed every 30 seconds only while it is open).

Pedir also has three extras:

- **Dividir en pasos** breaks one request (at commas, semicolons, new lines and "and" / "y") into one task per step. Edit the steps before sending; **Ejecutar en orden** makes each wait for the one before.
- **Perfil** applies one of your Perfiles to the task.
- **Dictar** fills the prompt by voice. The mic appears only in browsers that support SpeechRecognition (Chrome, Edge and Safari, not Firefox).

## Where everything else lives

- **Proyectos > Todos**: your projects across machines, with your own groups, pins and order. Open one to ask for work in it.
- **Proyectos > Memoria**: short notes, todos, decisions, progress and handoffs that you and your agents share. Search, filter by project, mark todos done.
- **Proyecto > Secciones**: per-project workstreams with status, task counts, due date, what is being tried, blocker, what is missing and the pull request. Agents keep them current; deleting one is yours only.
- **Flota > Agentes > Perfiles**: a named role (avatar, role prompt, default model and modes) you pick in Pedir. It prefixes the prompt and fills defaults; it never creates a standing agent.
- **Dinero**: income, recurring monthly costs, and totals per client and project. The hide-amounts eye is remembered per device. Agents cannot see Dinero.
- **Trabajo > Flujos** and **Proyectos > Artefactos**: see their sections below.
- **Flota > Agentes > Acceso API** and **Flota > Notificaciones**: see [Agents](#agents) and [Notifications](#notifications).

## Work

**Trabajo** lists the threads and worktrees your machines are working on, grouped by project, with how far each is: Creada, Trabajando, Commit, Push, PR abierto, Mergeada, Limpieza. It refreshes every 30 seconds while the screen is open, never in the background. Finished or merged work can be tidied from there.

## Workflows

**Trabajo > Flujos** runs a saved sequence of steps (agent, skill, question, parallel and gate steps) on the task queue. Each step starts when the ones before it succeeded; questions and manual gates wait for you under **Hoy > Te necesita**, with a notification. Runs you start begin at once with the permissions you pick. A run an agent starts waits there until you approve it and pick its permissions.

Write workflows as JSON in your repo at `.t3/workflows/<name>.json` and tap **Importar** to pull them from a project, or paste one in the app. Agents can list, save and start workflows through the CC's MCP server; their runs still wait for your approval.

Import reads files through T3, so the machine's token needs the `filesystem:read` scope. Tokens issued with the commands above lack it, and import answers with T3's authorization error. Reissue the token and run `machine add` again with the same address:

```sh
t3 auth session issue --scope orchestration:read --scope orchestration:operate --scope filesystem:read --ttl 365d --label command-center --token-only   | ccctl machine add https://<machine>.<tailnet>.ts.net
```

## Artifacts

**Proyectos > Artefactos** keeps HTML pages and Markdown documents with their version history, which agents save through the `artifact_save` MCP tool. HTML runs in a sandbox with no access to the CC. They are stored in `$CC_HOME/artifacts` and included in the nightly backup.

## Ordenar con IA

**Ordenar con IA** in Pedir sends what you dictated to a coordinator agent (Claude, Codex or Hermes, picked per request) and returns a draft: a clean prompt, project, priority, profile, steps and open questions. Nothing is queued until you edit the draft and send it. The coordinator runs as a short T3 thread on the coordinator machine, in the most restrictive permission mode; if it asks to use a tool, the request fails without approving anything. A draft request gives up after about two minutes.

Set these in `/var/lib/cc/env` (both optional):

- `CC_COORDINATOR_MACHINE`: machine id (from `ccctl machine list`) that runs the coordinator, normally the always-on VPS. Default: the first enabled machine that is online.
- `CC_COORDINATOR_PROJECT`: project id on that machine for the coordinator threads. Default: its first project. The thread uses the project root and never creates a worktree.

A coordinator is available when that machine has the provider enabled and installed in T3. Hermes needs to be added as a Local ACP provider (see [Agents](#agents)).

## Agents

Agents can queue work for you through the CC's MCP server at `https://<vps>.<tailnet>.ts.net:8443/mcp`. **Every task an agent submits waits in Trabajo until you approve it**, and you pick its permissions when you do. An agent sees only its own tasks.

Give each agent its own token: **Flota > Agentes > Acceso API > Crear**, or `ccctl agent-token add <label>` on the VPS. The token is shown once. The app shows ready-to-copy setup for:

- **Claude Code**: `claude mcp add --scope user --transport http cc <url>/mcp --header "Authorization: Bearer <token>"`
- **Codex**: an `[mcp_servers.cc]` entry with `url` and `http_headers` in `~/.codex/config.toml`
- **Hermes**: an `mcp_servers.cc` entry with `url` and `headers` in `~/.hermes/config.yaml`

Agents running on the VPS itself can also use `http://127.0.0.1:3900/mcp`.

The MCP server offers these tools:

- `task_submit`, `task_status`, `task_list`, `task_cancel` and `machines_list`
- `memory_save`, `memory_recall`, `memory_complete`
- `section_list`, `section_create`, `section_update`
- `agent_profile_save`
- `workflow_list`, `workflow_get`, `workflow_save`, `workflow_run`, `workflow_answer`, `workflow_status`
- `artifact_save`, `artifact_list`, `artifact_get`

Everything else, such as Finance and deleting sections, is yours only.

**Hermes in T3** (optional): install Hermes for the user that runs the T3 service (not `cc`), check it, and add it as a provider:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes acp --check
```

Then in the T3 app open **Settings → Providers**, add a **Local ACP** command `hermes` with argument `acp`. Hermes then runs as a T3 provider like Claude or Codex.

**Telegram** (optional): Hermes' gateway turns Telegram messages into CC tasks. Set up its Telegram bot by Hermes' own instructions, then:

1. Create its token: `ccctl agent-token add telegram`.
2. Put the token in the Hermes config the gateway reads: an `mcp_servers.cc` entry with `url: https://<vps>.<tailnet>.ts.net:8443/mcp` and `headers: { Authorization: "Bearer <token>" }`. If the Hermes you use as a T3 provider should not see the CC, run the gateway with its own `HERMES_HOME`.
3. Run `hermes gateway` as a user service that survives logout and reboot. Save this as `~/.config/systemd/user/hermes-gateway.service` (use the path from `command -v hermes`):

   ```ini
   [Service]
   ExecStart=%h/.local/bin/hermes gateway
   Restart=on-failure
   [Install]
   WantedBy=default.target
   ```

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now hermes-gateway
   sudo loginctl enable-linger "$USER"
   ```

Every task it submits waits in Trabajo for your approval; nothing runs on its own.

`ccctl agent-token list` shows each token's last use. Revoke one in **Flota > Agentes** or with `ccctl agent-token rm <label>`; its tasks stay.

## Notifications

The CC notifies you about its own tasks: approvals, questions, plans, finished and failed tasks, and machine alerts. Tapping one opens that item. Other T3 threads notify through T3 Connect in the official T3 app.

Turn them on per device in **Flota > Notificaciones**, then tap **Enviar prueba**.

- **iPhone and iPad** (iOS 16.4 or newer): open the CC from its Home Screen icon first. Safari tabs cannot receive notifications.
- **Android**: Chrome works from the browser or the installed app.
- **Desktop**: Chrome, Edge and Firefox work while the browser is running. Safari on macOS needs the CC added to the Dock.

If a device stops receiving them, turn notifications off and on again there. Set `CC_PUSH_SUBJECT` in `/var/lib/cc/env` to a `mailto:` address or `https:` URL you control; Apple rejects other values.

## Updates

- **T3 on the PC and phone** updates itself. **T3 on the VPS** updates daily at 04:30 with `t3 update --yes`. That run is skipped while CC tasks are running on the VPS and saves a copy of T3's database to `~/t3-backups` first (3 kept). The update button in the desktop sidebar still works at any time.
- **The CC** updates daily at 04:40, and only when `plugins/command-center` changed in your fork. To update now, push and run `sudo cc-update`. It builds and tests the new version, saves a copy of the database, switches over and checks it is healthy. If it is not, it switches back by itself and skips that version until you run `sudo cc-update --force`.
- If `cc-update` says `deploy/cc-update changed` or `deploy/t3-update changed`, read the new script and install it with the command it prints. If a file under `deploy/` ending in `.service` or `.timer` changed, repeat its `install` line from step 2 or 3 and run `daemon-reload`.

## When T3 changes

The CC reconnects after a T3 restart and ignores new fields it does not know, so most T3 updates need nothing. Rarely a release changes something the CC relies on. You see it as:

- a machine shown as `incompatible` or `degraded` in **Flota > Máquinas**;
- a **contract_break** alert in **Hoy**: the CC checks each new T3 version once and names what changed;
- a **version skew** alert: one machine runs an older T3 than another. Update that machine; the CC needs no change.

Meanwhile use the official T3 app directly; nothing already queued is lost. To fix a break:

1. In your fork on the PC, on `main`: `git fetch upstream && git merge upstream/main`. It does not conflict, because the CC lives only in `plugins/`. Never run `gh repo sync --force`: it resets `main` and deletes the CC.
2. `cd plugins/command-center && node scripts/contract-check.ts --local ../..` lists each miss with its file, what it expected and why.
3. In a T3 thread on the fork, give an agent this prompt. Only `server/t3link.ts` knows about T3, so nothing else should change:

   > Fix only server/t3link.ts (plus t3link.test.ts, T3_CONTRACT and the fixtures if re-recorded) for these misses. Keep parsing lenient. Add a protocol to SUPPORTED only when its wire changes are handled. Run npm test, npm run typecheck and `node scripts/contract-check.ts --local ../..`.

4. Only if the wire format itself changed: re-record the fixtures against a throwaway T3 on a temporary home (`t3 serve --base-dir "$(mktemp -d)" --port 13999`), never your real one. The probe launches a real thread, hence the flag. Pass that T3's token on stdin:

   ```sh
   node scripts/contract-check.ts --probe <apiUrl> --project <projectId> --i-know-this-launches --record <file>
   ```

5. Push to `main` of your fork. The VPS deploys it at 04:40, or run `sudo cc-update` now.
6. To check the machines the VPS is connected to (launches nothing), run on the VPS:

   ```sh
   sudo -u cc bash -c 'set -a; . /var/lib/cc/env; cd /var/lib/cc/current && CC_HOME=/var/lib/cc/data node scripts/contract-check.ts --live'
   ```

## Roll back

**The CC**: pick a release from `sudo ls -t /var/lib/cc/releases`, then

```sh
sudo -u cc touch /var/lib/cc/releases/<bad>/.bad
sudo -u cc ln -sfn /var/lib/cc/releases/<good> /var/lib/cc/current
sudo systemctl restart command-center
```

The database copy taken before each update is in `/var/lib/cc/backups/pre-<release>-<time>.sqlite`.

**T3 on the VPS** never downgrades by itself. Find the previous version with `journalctl --user -u t3-update -n 20`, then:

```sh
t3 update <previous-version> --allow-downgrade --yes
```

Only if the new version damaged your data, also restore the copy from before the update. This loses threads changed since then:

```sh
systemctl --user stop t3code.service
cd ~/.t3/userdata && rm -f statev2.sqlite-wal statev2.sqlite-shm && cp ~/t3-backups/statev2-<time>.sqlite statev2.sqlite
systemctl --user start t3code.service
```

## Backups

Every night at 03:30 the CC copies its database (and saved artifacts) to `/var/lib/cc/backups`, keeping 14. Copy that folder off the VPS regularly. Backups contain no tokens, so a leaked backup cannot reach your machines.

To restore:

```sh
sudo systemctl stop command-center
sudo -u cc rm -f /var/lib/cc/data/cc.sqlite-wal /var/lib/cc/data/cc.sqlite-shm
sudo -u cc cp /var/lib/cc/backups/nightly-<date>/cc.sqlite /var/lib/cc/data/cc.sqlite
sudo systemctl start command-center
```

Restoring on a new VPS requires adding each machine again with `ccctl machine add` and turning notifications off and on again on each device, because T3 tokens and notification keys are never in backups.

## Troubleshooting

**Flota > Máquinas** shows each machine's connection:

| State | Meaning and what to do |
| --- | --- |
| connecting | The CC is reaching the machine. If it stays here, check from the VPS: `curl https://<machine>.<tailnet>.ts.net/.well-known/t3/environment`. |
| online | Working. |
| offline | The machine is unreachable: the PC app is closed, the PC is asleep, or Tailscale is off. Its tasks wait; you get an alert after 15 minutes. |
| unauthorized | The token expired or was revoked. Issue a new one and run `machine add` again with the same address. |
| incompatible | That machine's T3 speaks a newer protocol than this CC. Nothing is sent to it and its tasks wait. Update the CC (see [When T3 changes](#when-t3-changes)); until then use T3 directly. |
| degraded | Working, but T3 sent data this CC does not fully understand. Update the CC soon. |

- **contract_break alert** (Hoy): a new T3 version changed something the CC relies on, and the alert names what. Tasks to that machine may fail. Follow [When T3 changes](#when-t3-changes).
- **Version skew alert**: one machine runs an older T3 than another. Update the machine it names.
- **The phone cannot open the CC**: check the Tailscale app is on and `tailscale serve status` on the VPS lists port 8443.
- **The CC is down**: `systemctl status command-center` and `journalctl -u command-center -n 100`.
- **An update failed**: `journalctl -u cc-update -n 100`, or `journalctl --user -u t3-update -n 100` for T3.
