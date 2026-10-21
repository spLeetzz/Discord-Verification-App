# Deploy runbook

How the port goes onto `adity.app`. Written for whoever does the next
deploy, including a deploy on a different day.

## The machine

| | |
|---|---|
| Host | `66.116.251.242` ("adity.app"), Ubuntu 22.04, 1 CPU, 2GB RAM |
| Node | `/usr/local/node22/bin/node` — v22.23.3, installed outside the package manager |
| Project | `discord-verification-app` (`proj_fAm22tC3HpzSAeNy`), server `9cb15eaa-cecd-4a90-980b-1ef1bd45a338` |
| Source | `github.com/spLeetzz/Discord-Verification-App`, branch `main` |
| Release | `/opt/openship/releases/<deployment-id>/` — **a new directory per deploy** |
| Service | `openship-dep_Sid3JXE3lOIBhiwL` — runs `npm run start` → `node dist/main.js` |
| Secrets | `/etc/systemd/system/openship-dep_Sid3JXE3lOIBhiwL.service`, mode 600, root-owned |
| Google SA | `/opt/dva-secrets/google-service-account.json` |
| Database | **`/opt/openship/data/app.db`** — outside the release tree, so it survives a deploy |

## The two things that bite

**1. The database file must not live in the release directory.** OpenShip
clones into a *new* release folder and swaps the service. A database file
inside the release tree is deleted on the next deploy. It lives at
`/opt/openship/data/app.db` (mode 700, root-owned), and the path is
configurable with `DB_FILE`.

**2. Only one copy of the bot may run.** The token is one token. A second
copy — a laptop, a second release directory, a stale process — makes *both*
answer every interaction, and users get double replies. Before deploying,
check that nothing else is running the same token:

```bash
ps aux | grep -E "node (dist/main|main)\.js" | grep -v grep
```

## Deploying

### 1. Push

The project tracks `main` and has no auto-deploy, so the merge is the trigger.

```bash
git checkout main && git pull --ff-only
git merge --no-ff feature/quotient-port
git push origin main
```

**`package-lock.json` must be committed and in sync with `package.json`.** The
deploy runs `npm ci`, which fails hard on a mismatch. The port adds
dependencies, so the lock file changes with them.

### 2. Deploy

Hit **Deploy** on the project in the OpenShip app, or via the API:

```
POST /api/projects/proj_fAm22tC3HpzSAeNy/deployments
```

It clones from GitHub, runs `npm ci`, runs
`NODE_OPTIONS=--max-old-space-size=1600 npm run build`, and swaps the service
to the new release. The previous release stays on disk for rollback.

### 3. The environment

The unit holds the environment, and it is a **secret file** — mode 600,
root-owned. The port adds one variable:

```
Environment="DB_FILE=file:/opt/openship/data/app.db"
```

Without it the bot falls back to a path under the project root, which
**will be lost on the next deploy**. If you are deploying by hand rather than
through OpenShip, edit the unit and `systemctl daemon-reload`:

```bash
cp /etc/systemd/system/openship-dep_Sid3JXE3lOIBhiwL.service{,.bak}
# add the Environment= line, then:
systemctl daemon-reload
```

### 4. Migrations

**The bot applies its own migrations at boot**, before it does anything else,
and refuses to start if one cannot be applied. There is no separate migration
step in the deploy pipeline, and that is deliberate — the schema and the code
can never disagree.

To apply them by hand instead:

```bash
cd /opt/openship/releases/<new-release>
DB_FILE=file:/opt/openship/data/app.db npm run db:migrate
```

### 5. Register the commands

The port adds 34 slash commands. They must be registered against the guild —
they are **not** registered by the deploy.

```bash
cd /opt/openship/releases/<new-release>
npm run deploy
```

This needs `BSSA_DISCORD_BOT_TOKEN`, `BSSA_CLIENT_ID` and `GUILD_ID` in the
environment. Run it with the unit's environment sourced, or as root with the
variables exported. The deploy script **validates the payload before sending
it** — a malformed subcommand is named in the error instead of producing a 400
that names an index.

### 6. Verify

```bash
systemctl status openship-dep_Sid3JXE3lOIBhiwL
journalctl -u openship-dep_Sid3JXE3lOIBhiwL -f
```

What a healthy boot looks like:

```
[INFO] Ready! Logged in as <bot name>
[INFO] [Startup] Re-attached view for FF.
[INFO] [Registry] Areas loaded: premium, moderation, community, identity, scrims, slots, tourneys
[INFO] [Jobs] Dispatcher started. Events: ...
```

Two warnings are **expected and correct** until the premium credentials are
set:

```
[WARN] PAYU_KEY and PAYU_SALT are not set. The payment endpoints will refuse to run.
[WARN] PREMIUM_PUBLIC_URL is not set. The premium checkout is disabled.
```

The premium checkout is **off** until those are set. Every other feature
works.

## Rollback

Previous releases stay in `/opt/openship/releases/`. Point the unit at the
older folder, `daemon-reload`, and restart.

**The database is not rolled back with the code.** A migration that added a
column leaves the column; a migration that dropped one leaves the data. Before
rolling back across a schema change, copy the database file aside:

```bash
cp /opt/openship/data/app.db /opt/openship/data/app.db.bak-$(date +%s)
```

## Backups

The database is one file. Back it up with `cp`, on a cron:

```
0 4 * * * cp /opt/openship/data/app.db /opt/openship/data/backup-$(date +\%F).db
```

The bot also prunes its own `command_usage` rows after 30 days, so the file
does not grow without bound.
