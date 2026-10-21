# Area C — Tournaments: port report

The port of Quotient's `src/cogs/esports/views/tourney/`,
`src/cogs/esports/views/groupm/`, `src/cogs/esports/events/tourneys.py`
and `src/models/esports/tourney.py` into `modules/tourneys/`.

**Status:** complete. `npm run typecheck` passes for every file in this
area, `npm test` passes for every file in this area (102 tests in nine
files), and `npm run smoke` still passes 106/106.

**Files:** 46 files, ~12,500 lines including the tests.

---

## 1. The command surface

One top-level command, `/tourney`, with five subcommands. The file in
`commands/esports/tourneys.ts` is a one-line re-export of
`modules/tourneys/commands/index.ts` — the loader scans
`commands/<folder>/*.ts` one level deep, so the real definitions live
in the module.

| Subcommand | What it does | Ephemeral? |
|---|---|---|
| `/tourney panel` | The management panel: the guild's tournaments and a way into each | **Public** |
| `/tourney create` | Starts the setup wizard | **Public** |
| `/tourney open <tournament> <open\|close>` | Opens or closes the registration | **Public** |
| `/tourney groups <tournament>` | The group manager | **Public** |
| `/tourney slots <tournament> [channel]` | Posts the persistent slot-manager panel | **Public** |

**D43: the panel is public.** The dispatcher honours
`Command.ephemeral`, and the esports commands set it to `false`. The
slot-manager panel in particular is the panel the *teams* use, so it
must be visible.

The module registers itself with the manager's registry
(`handlers/listeners.ts`) under the names it looks for:

```ts
registerTourneysListeners(client);       // the client listeners
registerTourneysInteractions();          // the custom ids
handleTourneysJob(client, event, payload); // the durable jobs
```

`handleTourneysJob` answers for `tourney_open` (this area's own) and
for `msg_delete` (the durable "delete this message in thirty minutes"
row, which the manager's registry assigns to this area).

### The custom ids

```
tourneys:<action>[:<part>[:<part>…]]
```

The record id travels in the custom id, so a panel survives a restart
(D18). The wizard is the exception: it carries a **token**, because the
tournament does not exist yet.

### The `/idp` command — the room credentials

`/idp` is a **second top-level command** of this area, not a `/tourney`
subcommand: it shares a custom room's credentials and is not tournament
management. The file in `commands/esports/idp.ts` is a one-line
re-export of `modules/tourneys/commands/idp.ts`.

| Option | What it is | Required? |
|---|---|---|
| `room_id` | The room id the teams type in | yes |
| `password` | The room's password | yes |
| `map` | The map the room is set to | yes |
| `ping_role` | A role to ping with the details | no |

It posts an embed with the three values and a **"Get in Copy Format"**
button, and the message **deletes itself after thirty minutes** through
the durable `jobs` table and the `msg_delete` event — never a
`setTimeout`.

**The reply is ephemeral (D23).** Quotient deleted the *user's* message
to hide the password, because a slash command has no user message to
delete. The command's own answer is a confirmation, and it never
carries the password.

**The credentials live in a public message for half an hour.** That is
the source's behaviour, and the message deletes itself. The
alternative — holding the credentials in memory and revealing them only
on the button — was rejected: the command would be useless while the
bot was down, and the button would have nothing to show. Instead the
embed's description *is* the copy block, and the button reads the three
values back out of the message it is attached to.

**The job payload is `{ channelId, messageId }` and nothing else.** The
deletion only has to know *which* message to delete, and a job row is a
row in a table that is read, logged and copied around — it is not a
place a credential can go.

**Only the named role may be pinged.** The ping is the only thing in the
message's content, and `allowedMentions` is `{ parse: [], roles: [the
role] }`.

**Who may run it:** the area's staff guard (`canUseTourneyMod`) —
Administrator, **Manage Server**, the `tourney-mod` role or the guild's
`Moderator` role. The source wanted `manage_guild` or the `scrims-mod`
role; this is the same rule with this area's role names.

This is **not** the slots area's "Transfer IDP Role": that is a
different feature with an unfortunately similar name, and it is already
done.

---

## 2. The state machine

```
           ┌──────────────────────────────┐
           ▼                              │
  draft ──open──▶ open ──pause──▶ paused ─┘
    │                │  ▲         │
    │                │  └─open────┘
    │                └──close──▶ closed ──open──▶ open
    └──────────────────────────────┘
```

D26: the lifecycle is an **explicit value** — `draft | open | paused |
closed` — not a pair of nullable timestamps. Quotient derived "open"
and "paused" from `started_at`/`closed_at`, and **both pause and close
set `closed_at`**, so the two states were indistinguishable in the
data: the only way to tell them apart was to read `started_at` in the
view and guess.

| Transition | What it does |
|---|---|
| `draft → open` | Unlocks the channel for the open role, posts the announcement, pings the ping role. |
| `open → paused` | Suspends the registration. **The slots are kept** — a pause is not an end. |
| `paused → open` | Resumes the registration. |
| `* → closed` | Ends the tournament. The slots are kept; the registration stops. |
| `closed → open` | Re-opens a finished tournament, as the source's toggle allowed. |

**The guards on opening** are the source's `toggle_registrations` plus
the environment checks: the registration channel exists and the bot can
`Manage Channels` in it; the success role exists, the bot can
`Manage Roles`, and the role is below the bot's top role; the open
role, if one is set, exists; and the tournament is **not full** —
"Slots are already full, Increase slots to start again."

The pure part lives in `state.ts`; the environment part lives in
`views/lifecycle.ts`, where the guild is available.

### The daily open job

A tournament may open on schedule as well as by hand. The schedule is a
set of weekdays and a time of day, and the next occurrence of it is
what the durable `tourney_open` job is armed for.

**The job is a row in the `jobs` table, never a `setTimeout`.** A timer
that dies with the process means the tournament never opens again.

**The schedule lives in the job row's payload** — `{ tourneyId,
openDays, openTime }`. The `tourneys` table has no schedule column and
the schema is ratified and migrated, so there is nowhere else to put
it. A job row *is* a schedule: it survives a restart, and the
dispatcher deletes it before dispatching it.

The arithmetic is in `schedule.ts` and is pure: the next occurrence of
a wall-clock time on an allowed weekday, in the server's zone (IST by
default, D30), computed with `Intl` so a daylight-saving change is
accounted for.

---

## 3. The group algorithm

**Groups are a flat chunk of the ordered slot list by `group_size`.**

That is the whole of it. Quotient's `Tourney._get_groups` was

```python
return split_list(await self.assigned_slots.all().order_by("num"), self.group_size)
```

and `split_list` (`src/utils/default.py:19-28`) is a flat chunk:

```python
for i in range(0, len(data), per_list):
    new.append(data[i : i + per_list])
```

- the slots are ordered by their number first;
- the last group is short when the count is not a multiple of the group
  size;
- there are no byes, no seeding and no progression.

**Quotient does not implement standings, points, seeding or progression,
and neither does this.** A group here is a bucket of teams, nothing
else. `groups.test.ts` pins the exact grouping down, including the
short last group, and asserts that a group object has exactly two
keys — `number` and `slots` — so nothing sneaks in.

### The published group list

Publishing writes a `tourney_group_lists` row keyed by the message id,
and the **channel is stored on the row** (D16 / B15).

The published message carries a **persistent Refresh button** whose
custom id names the tournament and the group, so it survives a
restart.

**The refresh cooldown** is two minutes, read from a plain timestamp
that **only the refresh path writes** — `repo.touchGroupList` is the
single writer of that column, and the publish path only inserts. (S4
folds the source's `refresh_at` into `tourney_group_lists.updated_at`;
because the refresh path is the only writer, the two are the same
thing — which is exactly the fix B16 asks for.)

### Creating the group channels and roles

"Create Channels & Roles" creates a category, a role and a channel per
group, and then publishes each group's list into the channel it just
created, so the channel ends up on the row.

The source created them in a loop with **no rollback** (B17). Ours
collects what it creates and undoes it when something fails — the
channels, then the roles, then the category, in reverse order. A failed
creation leaves the server exactly as it was.

The category is named `tourney-groups-<tourneyId>`, so two tournaments
never share one and it is found by an **exact** name.

---

## 4. The premium gates

Every gate goes through `assertEntitled(guildId, feature)` from
`modules/premium/`, and the check happens **before** the state it
guards changes (D15).

| Gate | Entitlement | Where |
|---|---|---|
| The custom reaction emojis | `tourney_features` | The editor's **Reactions** field, the wizard's, and the editor's modal |
| The registration "required lines" | `tourney_features` | The editor's **Required Lines** field |
| The duplicate-tag allowance | `tourney_features` | The editor's **Duplicate / Fake Tags** toggle |
| More than one tournament | `tourney_features` | `/tourney create` |

**The free-tier allowance is 1 tournament**, read from
`FREE_TIER.tourneys` in `modules/premium/limits.ts` — never hard-coded
(D45). A guild that holds the entitlement is not limited.

### The decision I had to make, and why

`PremiumFeature` is a closed union, and `guild_entitlements.feature`
has a `CHECK` constraint generated from it. There was **no
tourney-specific feature**, and adding one was a `db/` change (a
migration) that this area could not make.

The scrims area has already settled the pattern: it gates the *same
three fields* — custom emojis, required lines, duplicate tags — behind
`PremiumFeature.scrimSlots`, and uses the same entitlement to lift its
count limit. I first followed that precedent rather than inventing a
parallel one, so the two esports areas behaved identically and there was
exactly one place to change.

**That was the wrong call, and it has been reversed.** Scrims and
tournaments are separate features: a guild that bought extra scrim
slots has not bought extra tournaments, and one purchase of the other
must not unlock these. The manager has since extended the closed set —
`ENTITLEMENT_FEATURES` in `db/schema/common.ts` carries
`"tourney_features"`, the `guild_entitlements` `CHECK` constraint has
been migrated and applied, and `core/constants.ts` has
`PremiumFeature.tourneyFeatures`. Every gate in this area now names
that feature, and the scrims area keeps `scrim_slots` for its own.

**One thing is still missing, and it is not mine:** `FEATURE_LABELS` in
`modules/premium/types.ts` is a `Record<PremiumFeature, string>`, so
it needs a `tourney_features` entry or the premium area does not
typecheck. The label shows up in the refusal a gate throws, so it
should read like the others ("Extra tournament features").

---

## 5. The source bugs this area fixed

Each of these is a defect in Quotient that the port **fixed** rather
than copied. One line each on what it does now.

| # | Where | What it did | What it does now |
|---|---|---|---|
| 1 | `models/esports/tourney.py:437-444` | The fake-tag check was raw SQL quoting schema-qualified identifiers as single names, so it raised `relation does not exist` at runtime — the check had never worked. | A typed query over one table: `tourney_slots.members && ARRAY[$1, $2]::text[]` (`repo.findFakeTagMatches`), proved against the live database. |
| 2 | `events/tourneys.py:180-181` | The cross-reaction cancel was a literal `await ...` on the `Ellipsis` object, which raises `TypeError` — **the feature had never worked**. | The reacting user's slot for that message is deleted, the confirmation message is struck through, and the success role is removed when it was their only slot. |
| 3 | `events/tourneys.py:170-175` | The reaction path **skipped the requirements matrix entirely** and never checked whether the tournament was open, so a tournament that had never opened accepted registrations. | The same eight guards run, and only a tournament whose status is `open` accepts registrations. |
| 4 | `events/tourneys.py:75-77` | The slot number was `max(num) + 1` under a process-global `asyncio.Lock` that died with the process, so two registrations could be handed the same number. | The number comes from a **per-tourney sequence**: the tournament row is locked `FOR UPDATE` inside the transaction that inserts the slot, so the database serialises the allocation and the lock survives a restart. |
| 5 | `views/tourney/slotm.py:302-303` | "Swap Groups" was two independent `UPDATE`s, so the intermediate state had **both** rows on the same number — a violation of `UNIQUE (tourney_id, num)`. | One transaction, three statements, through a temporary number: the second slot takes the first one's number, then the first takes the second's. The order matters and the test proves it. |
| 6 | `views/groupm/_paginator.py:47` | The channel of a published group list was rediscovered by a **substring match** on the channel name, so "Group 1" also matched "Group 10". | The channel is **stored on the `tourney_group_lists` row**, and the publish flow asks for it explicitly. |
| 7 | `views/groupm/main.py:135-147` | The group roles and channels were created in a loop with **no rollback**, so a partial failure left orphans behind. | Everything created is collected and undone — channels, then roles, then the category. |
| 8 | `views/groupm/_refresh.py:104` | The two-minute refresh cooldown read an `auto_now` column, so it depended on the last write of **any** kind. | A plain timestamp that only the refresh path writes; the publish path only inserts. |
| 9 | `views/tourney/_editor.py:54` | The editor rebuilt the whole model from `dict(self.record)` on every interaction, relying on Tortoise internals and writing columns another writer may have changed. | One field, one write: `repo.updateTourney(id, { column: value })`. |
| 10 | `views/tourney/slotm.py:169-193` | "Change Team Name" granted the user temporary `send_messages` in the channel and waited for their next chat message — a chat-message collector, the class of bug D17 bans. | A **modal**, addressed to the person who opened it, shown on the select-menu interaction (which is still unanswered, so Discord accepts it). |
| 11 | `views/tourney/main.py`, `views/tourney/_wiz.py` | Every "type a value" flow was a `bot.wait_for("message")` collector. | Modals for values, select menus for channels and roles. |
| 12 | `events/tourneys.py:117`, `models/esports/tourney.py:103` | "Is it open?" was inferred from `started_at` being non-null, and both pause and close set `closed_at`, so **pause and close were indistinguishable in the data**. | An explicit `status` enum, exhausted over, with `paused` and `closed` as different states. |
| 13 | `views/tourney/_buttons.py:49-67` | The wizard's "set registration channel" wrote the channel id even when another tournament already had it. | The check runs first, and the database has a unique constraint on `tourneys.registration_channel_id`; both are proved by a test. |
| 14 | `views/tourney/main.py:137-146` | "Ban/Unban" asked for the users to ban with a chat-message collector, and deleted its own prompt message *before* it checked whether the user had answered, so a timeout left no explanation behind. | A modal; the mentions are read from it, and the prompt survives until the answer is in. |
| 15 | `views/tourney/main.py:150-198` | "Cancel Slots" asked for a member with a chat-message collector. | A modal with the member and the slot number, and a typed query that finds the slot. |

### The dead code that does **not** ship

`src/cogs/esports/views/tourney/groups.py` — a second
`TourneyGroupManager` that is never reachable and would crash if it
were (D22). The live one was `groupm/main.py`.

---

## 6. The media partners — the one cross-guild feature

A media partner is a channel in **another guild**. When somebody
registers in that channel, the registration is checked against the
partner tournament and then accepted into this guild's tournament.

**This is the only feature in the port that crosses guild boundaries.**
The target bot ignores *interactions* from other guilds
(`ALLOWED_GUILD_ID` in `main.ts`), but this is a **message-driven**
path: the bot is a member of both guilds, it receives the message, and
it decides what to do with it.

**The check is explicit** — `isForeignPartnerChannel(guildId,
channelGuildId)` in `views/partner.ts` — and it is called in **two**
places:

1. when the partner is set up, in the modal handler: the channel has to
   be in another guild, the author has to be a member of that guild, and
   the bot has to be in that guild too or it cannot read the channel;
2. when the message arrives, in the listener: the channel's guild has to
   differ from the tournament's guild.

The source's checks, all reproduced: the partner tournament is in a
different guild, the channel is not already a partner channel (a unique
constraint on `media_partners.channel_id`), and the author is a member
of the partner guild.

### The decision I had to make about the schema

The source had **two** facts per partnership: which tournament owns it
(the `Tourney ↔ MediaPartner` M2M) and which partner tournament it
points at (`MediaPartner.tourney_id`). The M2M is gone — the schema
gives `media_partners` a plain `tourney_id` column.

I store **the owning tournament** in `media_partners.tourney_id`, and
resolve the **partner tournament** at message time from the channel:
it is the tourney in the channel's guild whose registration channel is
that channel. That keeps the row findable from the guild that set the
partnership up, keeps `ON DELETE CASCADE` correct, and makes the
"different guild" check natural.

---

## 7. What is left unfinished

Nothing in the area is unfinished. The daily open job needed a
**shared-file change by the manager** before it worked end to end; that
change has landed and the path is now proved by a test.

### 7.1 The daily open job — done, and proved

`jobs.event` has a `CHECK` constraint generated from `JOB_EVENTS` in
`db/schema/common.ts`, and the manager's registry in
`handlers/listeners.ts` assigns this area's job handler for
`["msg_delete", "tourney_open"]`. Both have landed, and the migration
has been applied.

`modules/tourneys/jobs.test.ts` proves the whole path against the live
database:

1. a `tourney_open` row is accepted, and an event that is not on the
   list is still refused — so the test would notice if the constraint
   had gone away;
2. the row is armed, the **real** dispatcher claims it with the same
   compare-and-delete it uses in production, and `dispatchJob` hands the
   payload to this area's handler, which opens the tournament and
   re-arms itself;
3. the re-arm is the next occurrence of the schedule.

### 7.2 The `tourney_open` event name is a decision, not a fact

`JOB_EVENTS` is a closed set, and "tourney_open" is my choice of name
for it. If the manager prefers a different name, it is one string in
`db/schema/common.ts` and one in `modules/tourneys/repo.ts`
(`TOURNEY_JOB_EVENT`).

### 7.3 The bug the end-to-end test found

**The daily open never opened anything.** The dispatcher deletes the
job row *before* it dispatches it, and the schedule lives in that row's
payload — so the handler, which re-read the row to find the schedule,
found nothing, bailed out, and the tournament stayed shut. There was no
error and no log line: the job fired, did nothing, and vanished.

The handler now reads the schedule out of the **payload it was
handed**, which is the only copy that survives the fire. The old
behaviour is what the test fails on, so the fix cannot silently
regress.

### 7.4 The schedule does not drift

**The next open is the next occurrence of the stored schedule** —
recomputed from the weekdays and the time of day on every arm. It is
never "now plus 24 hours", and never "now plus the length of the last
outage".

The source advanced `open_time` by exactly 24 hours each fire, so a
bot that was down for three days opened the tournament three days late
*and* shifted every later open by three days. Ours re-arms for the
same wall-clock time on the next day the tournament opens, so a
tournament that opens at 6pm opens at 6pm and the first fire after an
outage puts the schedule back where it belongs.

A fire that lands on a day the tournament does not open on **misses**
that open rather than moving it. A moderator can still open it by
hand.

### 7.5 The manager panel's tournament menu was dead

The panel's select menu is `tourneys:select:pick`, so the *action* is
`"select"` and the sub-action is in the parts. The handler compared
the **action** with `"pick"`, so every pick was refused with "That
menu is no longer active" — the panel's tournament picker had never
worked.

The handler now takes the parts as well, and
`views/select-handlers.test.ts` pins it: the test fails on the old
comparison.

---

## 8. Notes for other areas

- **`core/prompt.ts` and `core/select.ts` could only be used once per
  interaction.** `respond()` returned `interaction.reply(...)` (which
  has `awaitMessageComponent`) on a fresh interaction, but
  `interaction.editReply(...)` (a `Message`, which does not) on a
  deferred or replied one. A `prompt` or an `awaitSelect` after another
  response silently timed out, so this area wrote two local workarounds:
  `views/confirm.ts` (a follow-up Confirm/Cancel) and
  `awaitSlotChoice` in `views/select-flow.ts` (a select menu that
  returns the **interaction**, so a modal can be shown on it).
  **The core fix has landed and both are gone.** `core/prompt.ts` and
  `core/select.ts` take an `asFollowUp` option, and `respond()` falls
  back to `followUp` when the interaction has already been replied to.
  The cancel-a-slot confirmation is `prompt(interaction, …, {
  asFollowUp: true })`, and the slot picker is `awaitSelect` from
  `core/select.ts`.
- **`core/select.ts` collects a *string* select menu, so it cannot
  replace a channel or a role menu.** Discord has dedicated component
  types for those, and `views/select-flow.ts` still holds
  `awaitChannelSelect` and `awaitRoleSelect` for them. The scrims area
  has the same two.
- **A modal cannot follow `core/select.ts`'s `awaitSelect`.** Discord
  lets an interaction do exactly one thing — reply, defer, update or
  show a modal — and `awaitSelect` *answers* the select interaction it
  opens, so `showModal` on it is a hard error. A flow that needs a
  modal after a choice has to use a **persistent** menu whose answer
  arrives as an interaction of its own; the slots area does this in
  `views/pick.ts`, and the tournaments area now does it for the
  "Change Team Name" menu (`tourneys:slotm_pick:<tourneyId>:<userId>`,
  handled in `views/select-handlers.ts`).
- **`sql`${[...]}::text[]` is not an array in drizzle.** A drizzle
  template treats a plain array as a *list* of parameters, so the
  expression becomes `($1, $2)::text[]` — a record cast, which
  Postgres refuses. The working form is `ARRAY[$1, $2]::text[]` with
  `sql.join`. The scrims area hit the same thing and fixed it the
  same way.
- **`core/channel-cache.ts` has landed**, so the tournaments area uses
  it (two instances) rather than its own copy.

---

## 9. The tests

| File | What it pins down |
|---|---|
| `state.test.ts` | The transitions, the guards, and that pause and close are different states |
| `groups.test.ts` | The exact grouping for a given slot list and group size, including the short last group |
| `requirements.test.ts` | The matrix as an ordered guard list, the first match winning, and the two source quirks |
| `schedule.test.ts` | The next occurrence of an open schedule, in the server's zone, and that it does not drift |
| `jobs.test.ts` | The daily open, end to end: the database accepts the row, the dispatcher claims it, the handler opens the tournament, and the schedule is re-armed (live database) |
| `views/select-handlers.test.ts` | The two select menus: the manager panel's is routed, and the slot manager's opens the rename modal |
| `slots.test.ts` | The per-tourney sequence and the swap in one transaction (live database) |
| `repo.test.ts` | The registration-channel uniqueness guard, the group-list row, the typed fake-tag query (live database) |
| `idp.test.ts` | The room-credential post: the three values, the `msg_delete` row, the payload that carries no password, the ephemeral replies, the dispatcher that claims the row and deletes the message, and the refusal of a member who is not staff (live database) |

No test in this area talks to Discord. The four database tests talk to
the local Postgres on `:5433`, like every other database test in the
repository, and they clean up after themselves.
