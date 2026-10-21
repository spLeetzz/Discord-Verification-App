# Wave 3 — feature implementation

Six engineers, six disjoint areas, running in parallel. Each area owns its
directories outright. Nobody edits anybody else's files; if you need
something from another area, you ask the manager.

Wave 3 starts when `db/` and `core/` have landed. Until then, read the
specs and plan.

---

## The contract every engineer codes against

Read, in order, before writing anything:

1. `docs/architecture.md` — layout, decisions D1–D24.
2. `docs/porting/common.md` — decisions D12–D45. **This is the spec.**
3. `docs/porting/schema.md` — the ratified schema, S1–S13.
4. The wave-1 inventory for your area. The inventories are in the git history
   of this branch under `docs/porting/` and in the manager's brief to you —
   ask if you cannot find yours.

### Directory ownership

```
modules/<area>/**            yours, entirely
commands/<area>/**           yours, entirely
```

Shared, **manager-owned** — do not edit:

```
db/**            core/**          handlers/**        types/**
config/**        utils/**          repo/**            scripts/**
main.ts          deploy.ts         package.json        docs/**
```

If you need a change in a shared file, say so in your report and it gets
done centrally. That is not a blocker — it is a queue.

### The shape of a feature area

```
modules/<area>/
  types.ts        the domain types for this area (closed unions, no strings)
  repo.ts         ALL SQL for this area, and nothing else
  service.ts      the state machine and the rules
  commands/       the SlashCommandBuilder definitions and handlers
  views/          the Discord component builders and their handlers
  listeners.ts    the client event listeners this area owns
  register.ts     exports register<Area>(client) — called by handlers/listeners.ts
  README.md       the interface: what it exposes, the invariants, the error modes
```

**The rule that matters:** no SQL outside `repo.ts`, no `client.` calls
outside `views/` and `listeners.ts`, no Discord IDs parsed as numbers.

### Commands

The command loader (`handlers/commands.ts`) and the deploy script
(`deploy.ts`) both scan `commands/<folder>/*.ts` — **one level deep**. So:

- Each area gets **one folder**: `commands/esports/`, `commands/community/`,
  `commands/moderation/`, `commands/premium/`.
- Each file in it is **one top-level command or group**.
- The file is a one-line re-export of the command object defined in the
  module:

```ts
// commands/esports/scrims.ts
export { scrimsCommand as default } from "../../modules/scrims/commands/index.js";
```

- **Discord allows 100 slash commands per guild.** We will have ~30. The
  area leads below already group Quotient's prefix groups into Discord
  subcommand groups (`/tagcheck set`, `/tagcheck config`, …) so the count
  stays low.

### Listeners

Each area's `register.ts` exports a function that attaches its listeners.
The manager's `handlers/listeners.ts` calls them all. Do not add
`client.on(...)` calls anywhere else — that is how two engineers end up
fighting over one file.

### Premium gates

One helper, one place: `assertEntitled(guildId, feature)`. It lives in
`modules/premium/` and is **owned by the premium engineer**, but every other
area imports it. If your area needs a gate and the premium module has not
landed yet, code against the documented signature and note it in your report.

The free-tier allowances live in one config object (D45). Read them from
there; never hard-code `3` or `1`.

### Definition of done, per area

1. `npm run typecheck` passes.
2. `npm test` passes, including your tests. Tests that need the database
   use the local Postgres on `:5433`; tests that need Discord use fakes — the
   bot must never talk to Discord in a test.
3. `npm run smoke` still passes — **106/106**. If your area drops a check,
   that is a regression, not a cost.
4. Every premium gate you added goes through `assertEntitled`.
5. Every custom id is namespaced `<area>:<action>[:<payload>]` and carries
   the record id it refers to (D18).
6. `modules/<area>/README.md` written.

---

## Area A — Scrims

**Owns:** `modules/scrims/`, `commands/esports/scrims.ts`

Quotient's scrims are the largest feature: a creation wizard, a 20-field
editor, a design sub-flow, registration intake, autoclean, reserved slots,
bans, the slot list, and a match-time lock.

**Port it as a state machine, not a view tree.** Quotient's 17 view files
mutate `self.record` and re-render. In discord.js there are no views, so
state lives in the database and the message is re-rendered from it. The
`scrims` table is the state.

Key decisions you must honour:

- **D14**: slots are one table with a state column. Claiming is a
  conditional `UPDATE`. You do **not** port `available_slots`.
- **D26**: `scrims.status` is `draft | open | closed`, not two nullable
  timestamps.
- **D32**: the open/close/slotlist message templates are `jsonb`. The
  `<<keyword>>` substitution set is ported as-is. Do **not** port
  `ast.literal_eval`.
- **D17**: every "type a value" flow is a modal or a select menu. The only
  exception is the match-time editor, which needs multiple `#channel time`
  lines in one message — that one keeps a message collector.
- **D18**: custom ids are `scrims:<action>:<scrimId>`. The editor's state is
  the row, not the message.
- **D27**: `find_team` is ported verbatim and unit-tested. It is in
  `core/team-name.ts` — **use it, do not reimplement it.**
- **D30**: one `parseNaturalTime` helper, IST by default.

The registration intake is a `MessageCreate` listener with an ordered list of
guard functions returning a deny reason. Quotient's first two checks are
independent `if`s and the rest are an `elif` chain — reproduce that exactly
as a list of guards.

The requirement matrix, the 20 editor fields, the ban-type matrix (four
modes), the reserved-slot flow, the autoclean toggles, and the match-time
lock are all in your inventory.

**Watch for:** the "apply to all scrims" prompt fires *after* the re-render
in Quotient — fix the order. The `SkipTo` button in the editor is a no-op —
implement it or drop it, do not port a dead button.

## Area B — Slots

**Owns:** `modules/slots/`, `commands/esports/slotmanager.ts`

The slot claim / cancel / remind / IDP-transfer panel, plus the published
slot list and its editor.

This area depends on Area A's `slots` table but owns the **claim path**:
the conditional `UPDATE` from S7, the cancel, the role removal rule ("only
remove the role if this was their last slot"), and the reminder dispatch.

The reminder feature is premium-gated. The IDP transfer is premium-gated.
The IDP transfer currently **can never work** because the claim modal only
records the claimer as a member (BUG-1). **Fix it: the claim modal collects
teammate mentions**, like the registration flow does, and the new member list
is persisted (BUG-9).

The slot list message and its Edit / Punish / Info panel are persistent views
— they must survive a restart. The custom id carries the scrim id.

## Area C — Tournaments

**Owns:** `modules/tourneys/`, `commands/esports/tourney.ts`

The tournament wizard, the editor, registration intake, group management,
the published group list, media partners, and the tournament slot manager.

Key decisions:

- **D25**: `tourney_slots` is one table with `UNIQUE (tourney_id, num)`. The
  `Tourney ↔ TMSlot` M2M and its through table are gone. "Swap Groups" is a
  two-row update in one transaction.
- **D26**: `tourneys.status` is `draft | open | paused | closed`.
- **D29**: the group list publish writes a `tourney_group_lists` row keyed by
  the message id, and the channel is **stored on the row** — not rediscovered
  by a name substring (BUG-15).
- Groups are a **flat chunk of the ordered slot list** by `group_size`.
  Quotient does not implement standings or progression. **Do not invent
  them.**
- The reaction-based registration path needs `GatewayIntentBits.GuildMessageReactions`
  (D33). The manager adds the intent; you write the listener.
- The cross-reaction cancel path in Quotient is a literal `await ...` that
  raises `TypeError` — the feature has never worked. Implement the stated
  intent (delete the user's slot for that message) and say so in your report.
- `views/tourney/groups.py` is **dead code** — a second `TourneyGroupManager`
  that is never reachable and would crash if it were. Do not port it.

## Area D — Identity and verification

**Owns:** `modules/identity/`, `commands/esports/identity.ts` (three groups:
`/tagcheck`, `/easytag`, `/ssverify`)

Tag check, easy tag, screenshot verification, the ssverify config UI, and the
group-management UI.

- The **OCR provider** is `modules/ssverify/ocr/` — **owned by another engineer,
  now delivered**. Import it; do not write your own. Read
  `modules/ssverify/ocr/README.md` before you start.
- **The hash implementation is bit-exact with Python's `imagehash` 4.3.2** —
  verified against a 14-image corpus by the OCR engineer, and independently
  re-verified on the two reference anchor values (a uniform image gives
  dHash `0000000000000000` and pHash `8000000000000000`; a re-encoded JPEG
  gives distance 0 from the original). This matters because the duplicate
  threshold of 7 is calibrated against that library. **All stored hashes must
  come from one implementation** — a database mixing local and remote hashes
  would compare two different conventions.
- Store the hashes as the 16-character lowercase hex strings. `hexToHash`
  **throws** on anything that is not exactly 16 hex characters, so a
  truncated row fails loudly instead of comparing as "a different picture".
- The duplicate check is on the **dHash**. The pHash is stored alongside it,
  as Quotient did, but the threshold was calibrated on the dHash.
- `OcrResult.text` is **already normalised** (lowercased, whitespace
  stripped). Normalise the expected side with the same function. Use
  `OcrResult.rawText` for literal checks like `"SUBSCRIBE "`, which the
  normalisation would otherwise destroy.
- The provider is **serialised per instance** — one screenshot at a time.
  There is **no local engine**: the provider is the remote
  Quotient-compatible service, so there is nothing to warm up.
  `shutdown()` on exit still ends the HTTP client. With no
  `OCR_PROVIDER_URL` configured the provider is the disabled one and every
  submission is refused.
- **The service fetches the image itself**, so it needs the attachment's
  public URL rather than a buffer.
- The OCR takes about two seconds per screenshot — defer the interaction.
- If the OCR cannot start, the text comes back empty and every text rule
  rejects. **It fails closed** — a broken OCR rejects a screenshot rather
  than waving it through.
- **D13**: `ss_submissions.ss_config_id` is a plain FK with `ON DELETE
  CASCADE`. The join table is gone.
- **D15**: one `assertEntitled` helper for every premium gate. The check
  happens **before** the state mutation (BUG-8).
- **D16**: roles and channels are stored **by id**. No name lookups.
- The duplicate-screenshot check is a Hamming distance over the 16-hex
  hashes. The threshold is a parameter, not a constant.
- The rate limits (1 per 7 s per member, 10 per 60 s per guild) use
  `core/ratelimit.ts`.
- The `quotient-tag-ignore` role is created if missing and stored **by id**.
- `TagCheckView` in Quotient is dead — its two buttons do nothing. Port the
  commands and the message listener; skip the view.

## Area E — Community

**Owns:** `modules/community/`, `commands/community/`

Tags, snipe, autorole, autopurge, reminders, and the durable job scheduler's
consumers.

- **The `jobs` table is the durable scheduler.** Every delayed action is a
  row. The dispatcher deletes the row before dispatching it, which makes it
  idempotent under restarts. **Never use `setTimeout` for anything that must
  survive a restart** — the reminder, the autopurge delete, the lockdown
  expiry, the premium expiry.
- The `core/` runtime provides the scheduler plumbing; you provide the
  handlers for your area's job events.
- **D43**: ephemerality is per-command. Community commands are **public** by
  default; the existing verification commands stay ephemeral.
- Tag names are **case-insensitive** (Quotient's converter lowercases for
  validation but returns the original, so lookups are case-*sensitive* — a
  bug). Pick case-insensitive and make the unique constraint match.
- The tag content limit is 99 characters everywhere (Quotient's converter
  says 100, the command says 99).
- Embed tags store **JSON**, not a Python literal (D32).

## Area F — Moderation

**Owns:** `modules/moderation/`, `commands/moderation/`

Clear/purge, role add/remove, kick/ban/unban, lock/unlock, maintenance mode,
and category operations.

- The **role hierarchy guard** (`canManageRole`) is in `core/guards.ts`.
  Use it; do not reimplement the five rules.
- Discord's `bulkDelete` caps at 100 messages and refuses anything older
  than 14 days. Chunk the deletes and filter by timestamp.
- The **role revert button** in Quotient is broken — the ternary binds the
  `await` to the wrong branch (BUG). Implement it correctly.
- The lockdown and maintenance flows are **state machines** over the
  `lockdowns` table, with the expiry as a `jobs` row.
- `maintenance off` never deleted the maintenance channels in Quotient
  (BUG). Fix it.
- `unlock server` always raised `AttributeError` in Quotient (BUG). Fix it.
- **The blocklist ships as a model, a check and a cache — not as a chat
  command** (D41). The global command guard refuses blocked users and
  guilds; the management surface is an ops script.

---

### 8. The room-credential command (`idp`)

**This was missed in the original area split and is assigned here.** Quotient's
`idp` command lets staff post a custom room's ID, password and map; the bot
posts an embed with a "Get in Copy Format" button and **deletes itself after
thirty minutes** so the credentials do not linger.

- The auto-delete is a row in the durable `jobs` table with the `msg_delete`
  event — **never a `setTimeout`**. The manager's dispatcher is already
  registered for `msg_delete` against this area.
- The command's reply must be **ephemeral**. Quotient deletes the *user's*
  message to hide the password, which a slash command cannot do; an ephemeral
  reply is the equivalent. This is D23 and it is a security property, not a
  cosmetic one.
- The password must never appear in a log line.

## Cross-area dependencies

| If you need | From | Note |
|---|---|---|
| `assertEntitled` | F (premium) | documented signature; code against it now |
| `core/team-name.ts` | W2-B | already built — use it |
| `core/guards.ts` (`canManageRole`, `isStaff`) | W2-B | already built — use it |
| `core/ratelimit.ts` | W2-B | already built — use it |
| `core/prompt.ts`, `core/select.ts` | W2-B | already built — use them instead of writing your own confirm/select flows |
| `modules/ssverify/ocr/` | W2-D | in flight — code against the interface |
| `slots` table access | A | A owns the table; B and C ask A for the query helpers |

**When two areas need the same thing, the manager decides who owns it.** Do
not add a second copy.
