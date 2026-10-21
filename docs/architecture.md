# Port architecture — Quotient → Discord Verification App

Decisions made by the manager. Engineers build from this; if a decision is
wrong, argue with the manager, do not silently deviate. Anything marked
**OPEN** will be decided before that wave starts.

Branch: `feature/quotient-port`

---

## 1. The shape of the target

The existing bot stays exactly as it is. The port is additive.

```
main.ts              entry point, client setup, event wiring
deploy.ts            slash-command registration
config/events.ts     per-event config (existing verification flow only)
handlers/            interaction routing + command loader
commands/<group>/    one file per command — thin adapters, thin on purpose
modules/<feature>/   the deep part: domain logic, state machines, DB access
db/                  Postgres: schema, migrations, query layer
core/                shared runtime: guards, scheduler, pagination, cache, errors
web/                 dashboard (server + assets)
repo/                Google Sheets access (EXISTING, unchanged)
utils/               shared helpers (EXISTING, extended only where it makes sense)
types/               shared types + discord.js module augmentation
scripts/             one-off maintenance scripts + smoke test
```

### Why `modules/` and not more `handlers/`

Every Quotient feature is a **module** with a real interface: a state machine
(scrim slot states, tourney group standings), invariants (a slot cannot be
claimed twice; a group has exactly `n` slots), and error modes. That logic
belongs behind one interface per feature, not smeared across command files
and event listeners.

- `commands/` holds a **thin adapter** per command: parse options, call one
  module function, render the result. If a command file needs more than ~40
  lines, the logic is in the wrong place.
- `modules/` holds the deep module: the interface, the state transitions, the
  DB access, and the Discord rendering that belongs to it.
- Tests cross the same interface the commands use. If a test needs to reach
  past it, the module is the wrong shape.

### Naming collision to watch

`repo/cache.ts` already exists and means **the example-image cache**. The new
in-memory TTL cache is `core/ttl-cache.ts`. Never call it `cache.ts` next to
`repo/`.

---

## 2. Decision log

| # | Decision | Rationale |
|---|---|---|
| D1 | **Drizzle ORM** + `node-postgres`, `drizzle-kit` migrations | Type-safe schema in TS so illegal states are unrepresentable; no codegen in the build; ESM-friendly. Tortoise maps ~1:1 onto it. |
| D2 | **Fastify** for the dashboard server | TS-native, schema validation, small, fast. |
| D3 | **socket.io** for realtime | python-socketio's room/event model ports 1:1; no reinvention. |
| D4 | **Slash-first**: every command is a slash command; one generic `!name` prefix bridge resolves to the same definition | Quotient has 109 command/group defs, many declared twice (prefix + slash). One definition, two surfaces — halves the surface and keeps the two from drifting. |
| D5 | Keep the existing **folder-scanning command loader**; extend the `Command` interface with `premium` / `guildOnly` guards | The loader already works and is tested by the smoke test. Don't swap frameworks. |
| D6 | `core/scheduler.ts` for background tasks; `croner` for cron, `chrono-node` for natural-language dates | Replaces discord.py `Task` loops and `dateparser`/`parsedatetime`. |
| D7 | `core/ttl-cache.ts` for in-memory caching | Replaces aiocache. No Redis for a single-process bot. |
| D8 | Per-guild settings live in **Postgres**, not in `config/events.ts` | `config/events.ts` is deploy-time config for the existing verification flow; Quotient's guild settings are runtime state. Different lifecycles — do not unify. |
| D9 | **vitest** + keep `npm run smoke` | A port this size needs real tests. Smoke stays because it needs no DB either. |
| D10 | `sharp` for image work | Replaces Pillow. Perceptual hashing (dHash) implemented over `sharp` raw pixels. |
| D11 | Existing 8 staff commands and the Google Sheet flow are **frozen** | Zero behaviour change to the working bot. New code only. |

### Guarded-by-default

Every new command is guild-only by default and staff-gated where it mutates
state. Discord gives 100 slash commands per guild; the port will not fit if we
are careless. **Register only what exists** — `deploy.ts` must stay truthful.

---

## 3. The `Command` interface after the port

```ts
export interface Command {
  data: CommandData;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  staffOnly?: boolean;
  ephemeral?: boolean;
  /** Premium tier required. Checked by the interaction handler before execute. */
  premium?: PremiumTier;
  /** Defaults to true. Set false only for commands that work in DMs. */
  guildOnly?: boolean;
}
```

Guards run in `handlers/interactions.ts`, before `execute`, in this order:
`guildOnly` → `staffOnly` → `premium`. Each failure replies with a clear
message and stops. Guards never throw past the handler.

---

## 4. Module interface conventions

A module under `modules/<feature>/` exposes:

- **Commands** — `commands.ts` (thin adapters)
- **Logic** — the state machine and rules, pure-ish functions where possible
- **Views** — `views/` — Discord component builders and collectors (the port of
  Quotient's `views/`)
- **Repository** — `repo.ts` — all SQL for that feature, and nothing else
- **Types** — `types.ts` — the feature's domain types

Rules:

- **No SQL outside `modules/<feature>/repo.ts` or `db/`.** If a command needs a
  query, the query belongs to the module.
- **No `client.` calls outside `modules/<feature>/` and `core/`.** Discord is
  behind the module.
- **Discord IDs are strings.** Parse them at the boundary, keep them as
  strings inside.
- **Enums are closed.** A state machine's states are a union type, not
  `string`. Exhaustively switch on them.

---

## 5. Database

Postgres 16 in Docker (`docker-compose.yml` in the repo root, service
`postgres`, host port `5433`).

```
DATABASE_URL=postgres://bssa:bssa@localhost:5433/bssa
```

Schema is owned by the models engineer; every other engineer imports it from
`db/schema.ts` and never writes DDL.

Tables live under `db/schema/*.ts` grouped by area, re-exported from
`db/schema.ts`.

Migrations: `npm run db:generate` (drizzle-kit) and `npm run db:migrate`
(applies them). **Never hand-edit a migration file**; regenerate instead.

Rules:

- Every table gets `id` (uuid or serial — the models engineer decides, once,
  and it applies everywhere), `created_at`, `updated_at`.
- Every foreign key declares `ON DELETE` behaviour explicitly.
- Every uniqueness rule that the code depends on is a database constraint, not
  a read-then-write check.
- `noUncheckedIndexedAccess` is on in tsconfig — array indexing returns
  `T | undefined`. Handle it.

---

## 6. Discord API notes

- **discord.js v14**, `RESTPostAPIChatInputApplicationCommandsJSONBody` is what
  the deploy payload uses. Command names must be unique per guild, and the
  total must stay under 100.
- **Components** carry a `custom_id`. Every custom_id is namespaced:
  `<module>:<action>:<...>` e.g. `scrims:claim_slot:<slot_id>`. The router
  splits on `:` and dispatches to the owning module. Never guess a custom_id's
  owner from its shape.
- **Interaction routing** stays in `handlers/interactions.ts`, but it becomes a
  dispatcher to module routers rather than a growing if/else chain.
- **Component collectors** must expire and must `deferUpdate()` where the
  response is not immediate.
- **Permissions**: `staffOnly` maps to the existing Moderator role check. Keep
  using the same helper so behaviour does not diverge.

---

## 7. What is in each wave

| Wave | Contents | Parallelism |
|---|---|---|
| 1 | Inventory of Quotient (9 areas) | 9 agents, read-only |
| 2 | Foundation: DB schema + `core/` runtime + module contract | 3 agents, disjoint dirs |
| 3 | Feature implementation, one engineer per area | 6-7 agents, disjoint dirs |
| 4 | Dashboard + premium | 2 agents |
| 5 | Integration, review, end-to-end verification | serial, manager-led |

Waves 2 and 3 must not start until wave 1's output is merged into
`docs/porting/`. A feature engineer who cannot find the spec asks the manager.

---

## 8. Definition of done, per feature

An engineer is finished when:

1. `npm run typecheck` passes.
2. `npm run test` passes, including the new tests for that feature.
3. `npm run smoke` still passes.
4. The feature's commands are registered in `deploy.ts`'s payload (if it adds
   commands).
5. The module's interface is documented in `modules/<feature>/README.md` —
   what it exposes, what the invariants are, what the error modes are.
6. No `any`. No `@ts-ignore`. No unhandled promise rejection.

---

## 9. Open decisions

| # | Question | Owner | Needed by |
|---|---|---|---|
| O1 | Dashboard rendering: server-rendered EJS (closest to Jinja) vs a React SPA | manager, after dashboard inventory | wave 4 |
| O2 | Payment provider for premium: does Quotient have a real one, or a stub? | premium engineer reports, manager decides | wave 4 |
| O3 | Primary key strategy for all tables: uuid vs identity | models engineer proposes, manager ratifies | wave 2 |
