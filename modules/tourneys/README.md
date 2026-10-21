# `modules/tourneys/` — tournaments

A tournament is a bracketed competition between teams. It has a
registration channel, a confirm channel, a success role, a number of
slots and a group size. Teams register by messaging in the registration
channel, and the registered teams are then chunked into **groups**.

This is the port of Quotient's `src/cogs/esports/views/tourney/`,
`src/cogs/esports/views/groupm/` and
`src/cogs/esports/events/tourneys.py`.

---

## The public interface

### The command surface

One top-level command, `/tourney`, with five subcommands. The file in
`commands/esports/tourneys.ts` is a one-line re-export of
`modules/tourneys/commands/index.ts`.

| Subcommand | What it does | Ephemeral? |
|---|---|---|
| `/tourney panel` | The management panel: the guild's tournaments and a way into each | **Public** |
| `/tourney create` | Starts the setup wizard | **Public** |
| `/tourney open <tournament> <open\|close>` | Opens or closes the registration | **Public** |
| `/tourney groups <tournament>` | The group manager | **Public** |
| `/tourney slots <tournament> [channel]` | Posts the persistent slot-manager panel | **Public** |

**The panel is public** (D43): other moderators have to be able to see
it, and the slot-manager panel is the panel the *teams* use.

### The `/idp` command

`/idp` is a **second top-level command** of this area, not a
`/tourney` subcommand: it shares a custom room's credentials, and it is
not tournament management. The file in `commands/esports/idp.ts` is a
one-line re-export of `modules/tourneys/commands/idp.ts`.

| Option | What it is | Required? |
|---|---|---|
| `room_id` | The room id the teams type in | yes |
| `password` | The room's password | yes |
| `map` | The map the room is set to | yes |
| `ping_role` | A role to ping with the details | no |

**The reply is ephemeral (D23).** Quotient deleted the *user's* message
to hide the password, because a slash command has no user message to
delete. The equivalent is an ephemeral reply: the command's own answer
is a confirmation, and it never carries the password.

**The credentials live in a public message, for half an hour.** That is
the source's behaviour, and the message deletes itself — so a room
password does not linger in the channel. The alternative (holding the
credentials in memory and revealing them only on the button) was
rejected: the command would be useless while the bot was down, and the
button would have nothing to show.

**The message is what the button reads.** The embed's description *is*
the copy block, so the "Copy details" button reads the three
values back out of the message it is attached to. Nothing is held in
memory between the command and the click, and the copy survives a
restart.

**Only the named role may be pinged.** The ping is the only thing in the
message's content, and `allowedMentions` is `{ parse: [], roles: [the
role] }` — the embed never pings, and nothing else does either.

#### The message-delete job

The message deletes itself after thirty minutes through the durable
`jobs` table and the `msg_delete` event — **never a `setTimeout`**. A
timer that dies with the process means the message stays in the
channel, and a room password that stays in a channel is the problem the
job exists to solve.

The payload is `{ channelId, messageId }` and **nothing else**: the
deletion only has to know *which* message to delete. A job row is a row
in a table that is read, logged and copied around — it is not a place a
credential can go.

This is the `msg_delete` event the area already handled; what was
missing was the producer, and `modules/tourneys/commands/idp.ts` is it.

### What the module registers

The manager's registry (`handlers/listeners.ts`) looks these up by name:

```ts
// The manager calls this from `handlers/listeners.ts`.
registerTourneysListeners(client);

// The manager calls this too.
registerTourneysInteractions();

// The scheduler calls this for every due job.
handleTourneysJob(client, event, payload); // → Promise<void>
```

`registerTourneys` is an alias of `registerTourneysListeners`.

`handleTourneysJob` answers for two events: `tourney_open` (this
area's own) and `msg_delete` (the durable "delete this message in
thirty minutes" row, which the manager's registry assigns to this
area).

Both events are now **produced** by this area as well: `tourney_open`
by the daily schedule, and `msg_delete` by the room-credential post
(`/idp`).

> **The shared-file changes are done.** `handlers/listeners.ts`
> registers this area's job handler for `["msg_delete", "tourney_open"]`,
> `JOB_EVENTS` in `db/schema/common.ts` carries `"tourney_open"`, and
> the `jobs_event_check` constraint has been migrated and applied — so
> the row the daily open arms is accepted by the database.
> `modules/tourneys/jobs.test.ts` proves it, end to end: it arms the
> job, has the real dispatcher claim and delete the row, and watches the
> handler receive it and open the tournament.

### The listeners

| Event | What it does |
|---|---|
| `messageCreate` | The registration intake, and the media-partner path |
| `messageReactionAdd` | The reaction-based registration path and its cancel |
| `messageDelete` | Removes the slot of a deleted registration message |

`messageReactionAdd` needs `GatewayIntentBits.GuildMessageReactions`
(D33). Without it the reaction path is silently dead — no error, just no
registrations.

### The custom ids

```
tourneys:<action>[:<part>[:<part>…]]
```

| Action | Payload | What it does |
|---|---|---|
| `manager` | — or a tourney id | The manager panel / the panel of one tournament |
| `wizard` | `<field>` + a token | One field of the setup wizard |
| `editor` | `<field>` + a tourney id | One field of the editor |
| `lifecycle` | `toggle`/`close` + a tourney id | Opens, pauses or closes |
| `ban` | a tourney id | The ban form |
| `groups` | a tourney id, a group number | The group manager |
| `group_publish` | a tourney id, a group number | Publishes a group list |
| `group_refresh` | a tourney id, a group number | The persistent **Refresh** button |
| `slotm` | a tourney id | The slot manager |
| `slotm_cancel` | a tourney id, a slot id | Cancels a slot |
| `slotm_rename` | a tourney id, a slot id | Renames a team (a modal) |
| `slotm_pick` | a tourney id, a user id | The "which slot do you want to rename?" menu |
| `slotm_swap` | a tourney id | Swaps two slots' groups |
| `partner` | a tourney id | The media-partner panel |
| `idp_copy` | — | The "Copy details" button of the room-credential post |
| `modal` | the modal kind + the record | Every modal submit |
| `select` | `pick` | The manager panel's tournament menu |

**The record id travels in the custom id** (D18), so a panel survives a
restart. The wizard is the exception: it carries a **token**, because
the tournament does not exist yet. `idp_copy` is the other exception: it
carries nothing at all, because the room credentials are read back out
of the message the button is attached to.

### The menus

**A modal cannot follow a menu that was waited on.** Discord lets an
interaction do exactly one thing — reply, defer, update or show a
modal — and `core/select.ts`'s `awaitSelect` *answers* the select
interaction it opens. A menu that is awaited inline therefore cannot
be followed by a modal: `showModal` on it is a hard error.

So a flow that needs a choice **and then** a modal uses a
**persistent** menu: a real component in a message, whose answer
arrives as an interaction of its own — still unanswered, so the modal
can be shown from it. That is the "which slot do you want to rename?"
menu (`tourneys:slotm_pick:<tourneyId>:<userId>`), handled in
`views/select-handlers.ts`. The slots area does the same thing in
`views/pick.ts`.

Everything else uses the core helpers: `core/prompt.ts`'s `prompt`
(for the "are you sure?" in **Cancel my slot**, with `asFollowUp:
true`, because the button press has already been answered by the menu
before it) and `core/select.ts`'s `awaitSelect` (for the slot picker
in **Cancel my slot**).

`views/select-flow.ts` still holds `awaitChannelSelect` and
`awaitRoleSelect`: Discord has dedicated component types for a channel
and a role, and `core/select.ts` builds a *string* menu, so it cannot
replace them.

---

## The state machine

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
| `draft → open` | Opens the registration: unlocks the channel for the open role, posts the announcement, pings the ping role. |
| `open → paused` | Suspends the registration. **The slots are kept** — a pause is not an end. |
| `paused → open` | Resumes the registration. |
| `* → closed` | Ends the tournament. The slots are kept; the registration stops. |
| `closed → open` | Re-opens a finished tournament, as the source's toggle allowed. |

**The guards on opening** (the source's `toggle_registrations` plus the
environment checks):

- the registration channel exists and the bot can `Manage Channels` in
  it;
- the success role exists, the bot can `Manage Roles`, and the role is
  below the bot's top role;
- the open role, if one is set, exists;
- the tournament is **not full** — "Slots are already full, Increase
  slots to start again."

**The guards on the state machine** live in `state.ts` and are pure.

### The daily open job

A tournament may open on schedule as well as by hand. The schedule is a
set of weekdays and a time of day, and the next occurrence of it is
what the durable `tourney_open` job is armed for.

**The job is a row in the `jobs` table, never a `setTimeout`.** A timer
that dies with the process means the tournament never opens again.

> **The event is in the `CHECK` constraint.** `jobs.event` has a
> `CHECK` constraint generated from `JOB_EVENTS` in
> `db/schema/common.ts`, and `"tourney_open"` is on that list; the
> migration has been applied. The manager's registry assigns this area
> `["msg_delete", "tourney_open"]`.

**The schedule lives in the job row's payload.** The `tourneys` table
has no schedule column, and the schema is ratified and migrated, so
there is nowhere else to put it. A job row *is* a schedule: it survives
a restart, and the dispatcher deletes it before dispatching it.

The payload is `{ tourneyId, openDays, openTime }`.

**The handler reads the schedule out of the payload it was handed**, not
out of the row — the dispatcher deletes the row *before* it dispatches
it, so by the time the handler runs there is no row left to read. The
payload is the only copy that survives the fire.

#### The schedule does not drift

**The next open is the next occurrence of the schedule**, recomputed
from the stored weekdays and time of day on every arm. It is never
"now plus 24 hours", and never "now plus the length of the last
outage".

The source advanced `open_time` by exactly 24 hours each time the job
fired, so a bot that was down for three days opened the tournament
three days late **and** shifted every later open by three days as well.
Ours re-arms for the same wall-clock time on the next day the
tournament opens, so a tournament that opens at 6pm opens at 6pm, and
the first fire after an outage puts the schedule back where it belongs.

A fire that lands on a day the tournament does not open on **misses**
that open rather than moving it — the tournament is not opened three
days late. A moderator can still open it by hand.

`schedule.test.ts` and `jobs.test.ts` pin this down.

---

## The group algorithm

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
else. Anything else would be a new feature, not a port.

The algorithm lives in `groups.ts` and is pure.

### The published group list

Publishing writes a `tourney_group_lists` row keyed by the message id,
and the **channel is stored on the row** (D16 / B15). The source
re-discovered the channel by a **substring match** on the channel name,
so "Group 1" also matched "Group 10" — the list was posted into the
wrong channel half the time.

The published message carries a **persistent Refresh button** whose
custom id names the tournament and the group, so it survives a restart.

**The refresh cooldown** is two minutes. The source read an `auto_now`
column, so the cooldown depended on the last write of *any* kind (B16).
Here the timestamp is a plain one and **only the refresh path writes
it** — `repo.touchGroupList` is the single writer of that column, and
the publish path only inserts.

> S4 folds the source's `refresh_at` into `tourney_group_lists.updated_at`,
> so the cooldown reads `updated_at`. That is the same as "written only
> by the refresh path" as long as nothing else writes the row — and
> nothing does.

### Creating the group channels and roles

"Create channels and roles" creates a category, a role and a channel per
group, and then publishes each group's list into the channel it just
created.

**The source created them in a loop with no rollback** (B17): if
channel 4 of 5 failed, the first three were left behind, and the
category with them. Ours collects what it creates and undoes it when
something fails — the channels, then the roles, then the category, in
reverse order. A failed creation leaves the server exactly as it was.

The category is named `tourney-groups-<tourneyId>`, so two tournaments
never share one and it is found by an **exact** name.

---

## The registration intake

A `MessageCreate` listener in the registration channel, checked against
an **ordered list of guards**. The first reason wins; the rest do not
fire.

The source's `check_tourney_requirements` was two independent `if`s
followed by an `elif` chain hanging off the second one, and the process
stage added two more. The port keeps that order exactly:

| # | Guard | Chain? | Reason |
|---|---|---|---|
| 1 | A team name is required | no | `no_team_name` |
| 2 | No bots mentioned | no | `mentioned bots` |
| 3 | Enough mentions | yes | `insufficient mentions` |
| 4 | The author is not banned | yes | `banned` |
| 5 | Enough lines | yes | `no_lines` |
| 6 | No fake tags | yes | `fake_tag` |
| 7 | No duplicate team name | no | `duplicate_name` |
| 8 | One registration per person | no | `multiregister` |

Two source quirks are **preserved**, because a guild that sets
`required_mentions` to `0` gets exactly this behaviour:

1. **The `elif` chain is skipped entirely when `required_mentions` is
   `0`.** The chain hung off
   `if tourney.required_mentions and not all(mentions are humans)`, so
   with zero required mentions the banned-user, line and fake-tag checks
   stop firing. Guards 7 and 8 were outside the chain in the source, so
   they still run.
2. **The team-name check is independent of everything else.**

The team name comes from `core/team-name.ts` — the same derivation the
group list shows, so the duplicate check compares like with like. The
message content is normalised (NFKC, lowercased) on a **copy**; the
message is never mutated.

### The reaction path

A ✅ reaction on a message registers the **author of that message**,
which is what the source did. The source let only a tournament
moderator trigger it — it was a "moderator approves this registration"
affordance — and that check is kept, because otherwise a stranger could
register somebody else by reacting to their message.

A ❌ reaction cancels: the **reacting user's** slot for that message is
deleted, the confirmation message is struck through, and the success
role is removed when it was their only slot.

---

## The premium gates

Every gate goes through `assertEntitled(guildId, feature)` from
`modules/premium/`, and the check happens **before** the state it
guards changes (D15).

| Gate | Entitlement | Where |
|---|---|---|
| The custom reaction emojis | `tourney_features` | The editor's **Reactions** field and the wizard's |
| The registration "required lines" | `tourney_features` | The editor's **Required lines** field |
| The duplicate-tag allowance | `tourney_features` | The editor's **Duplicate / fake tags** toggle |
| More than one tournament | `tourney_features` | `/tourney create` |

> **Why `tourney_features` and not `scrim_slots`?** Scrims and
> tournaments are separate features, and one must not unlock the other.
> The scrims area keeps `scrim_slots` for its own gates; this area has
> its own entitlement, which is in `ENTITLEMENT_FEATURES` in
> `db/schema/common.ts` and in the `guild_entitlements` `CHECK`
> constraint.

**The free-tier allowance is 1 tournament**, and it is read from
`FREE_TIER.tourneys` in `modules/premium/limits.ts` — never hard-coded
(D45). A guild that holds the entitlement is not limited.

---

## The source bugs this area fixed

Each of these is a defect in Quotient that the port **fixed** rather
than copied.

| # | Where | What it did | What it does now |
|---|---|---|---|
| 1 | `models/esports/tourney.py:437-444` | The fake-tag check was raw SQL that quoted schema-qualified identifiers as single names, so it raised `relation does not exist` at runtime. The check had never worked. | A **join** against the member table (`tourney_slot_members`) — the same question the source's `&&` asked, and a faster one (`repo.findFakeTagMatches`). |
| 2 | `events/tourneys.py:180-181` | The cross-reaction cancel was a literal `await ...` on the `Ellipsis` object, which raises `TypeError`. **The feature had never worked.** | The reacting user's slot for that message is deleted, the confirmation is struck through, and the success role is removed when it was their only slot. |
| 3 | `events/tourneys.py:170-175` | The reaction path **skipped the requirements matrix entirely** and never checked whether the tournament was open, so a tournament that had never opened accepted registrations. | The same guards run, and only a tournament whose status is `open` accepts registrations. |
| 4 | `events/tourneys.py:75-77` | The slot number was `max(num) + 1` under a process-global `asyncio.Lock` that died with the process, so two registrations could be handed the same number. | The number comes from a **per-tourney sequence**: the allocation happens in the transaction that inserts the slot, behind a per-tourney mutex, and the transaction takes the write lock with a conditional `UPDATE` on the tournament row — SQLite has no `SELECT … FOR UPDATE`. |
| 5 | `views/tourney/slotm.py:302-303` | "Swap Groups" was two independent `UPDATE`s, so the intermediate state had **both** rows on the same number — a violation of `UNIQUE (tourney_id, num)`. | One transaction, three statements, with a temporary number: the second slot takes the first one's number, and then the first takes the second's. |
| 6 | `views/groupm/_paginator.py:47` | The channel of a published group list was rediscovered by a **substring match** on the channel name, so "Group 1" also matched "Group 10". | The channel is **stored on the `tourney_group_lists` row**. |
| 7 | `views/groupm/main.py:135-147` | The group roles and channels were created in a loop with **no rollback**, so a partial failure left orphans behind. | Everything created is collected and undone — channels, then roles, then the category. |
| 8 | `views/groupm/_refresh.py:104` | The two-minute refresh cooldown read an `auto_now` column, so it depended on the last write of **any** kind. | A plain timestamp that only the refresh path writes. |
| 9 | `views/tourney/_editor.py:54` | The editor rebuilt the whole model from `dict(self.record)` on every interaction, which relied on Tortoise internals and wrote columns another writer may have changed. | One field, one write: `repo.updateTourney(id, { column: value })`. |
| 10 | `views/tourney/slotm.py:169-193` | "Change Team Name" granted the user temporary `send_messages` in the channel and waited for their next chat message — a chat-message collector, the class of bug D17 bans. | A **modal**, addressed to the person who opened it. |
| 11 | `views/tourney/main.py`, `views/tourney/_wiz.py` | Every "type a value" flow was a `bot.wait_for("message")` collector. | Modals for values, select menus for channels and roles. |
| 12 | `events/tourneys.py:117`, `models/esports/tourney.py:103` | "Is it open?" was inferred from `started_at` being non-null, and both pause and close set `closed_at`, so **pause and close were indistinguishable in the data**. | An explicit `status` enum, exhausted over. |
| 13 | `views/tourney/_buttons.py:49-67` | The wizard's "set registration channel" wrote the channel id even when another tournament already had it. | The check runs first, and the database has a unique constraint on `tourneys.registration_channel_id`. |
| 14 | `views/tourney/main.py:137-146` | "Ban/Unban" asked for the users to ban with a chat-message collector, and then deleted the collector's own message twice. | A modal; the mentions are read from it. |
| 15 | `views/tourney/main.py:150-198` | "Cancel Slots" asked for a member with a chat-message collector. | A modal with the member and the slot number, and a typed query that finds the slot. |

---

## What does **not** ship

- **`views/tourney/groups.py`** — a second `TourneyGroupManager` that is
  never reachable and would crash if it were. It is dead code (D22) and
  is not ported. The live one was `groupm/main.py`.
- **The `tm.tourney_tm.register` join table and the `Tourney ↔ TMSlot`
  M2M** — D25. A tourney slot belongs to exactly one tournament, so
  `UNIQUE (tourney_id, num)` is enough.
- **`Tourney.banned_users` as a `bigint[]`** — D25. It is a
  `tourney_banned_users` table now, so a ban is idempotent instead of a
  read-modify-write.
- **The source's `MediaPartner` ↔ `Tourney` M2M** — the schema has
  `media_partners.tourney_id` as a plain column, so the row belongs to
  the tournament that **owns** the partner registration. The partner
  tournament is resolved from the channel at message time.
- **Standings, points, seeding and progression** — Quotient did not
  implement them.
- **The socket.io dashboard** — D34. The tourney socket handlers were
  provably dead.

---

## The media partners — the one cross-guild feature

A media partner is a channel in **another guild**. When somebody
registers in that channel, the registration is checked against the
partner tournament and then accepted into this guild's tournament.

**This is the only feature in the port that crosses guild boundaries.**
The target bot ignores *interactions* from other guilds, but this is a
**message-driven** path: the bot is a member of both guilds, it
receives the message, and it decides what to do with it. The check is
therefore explicit — `isForeignPartnerChannel(guildId, channelGuildId)`
in `views/partner.ts` — and it is called both when the partner is set
up and when the message arrives.

The source's checks, all reproduced:

1. the partner tournament is in a **different** guild;
2. the channel is **not already** a partner channel (there is a unique
   constraint on `media_partners.channel_id`);
3. the author **is a member** of the partner guild;
4. the bot is in the partner guild too, or it cannot read the channel.

---

## The error modes

| Situation | What happens |
|---|---|
| A registration channel is already in use | The friendly check refuses, and the unique constraint refuses the write. |
| The tournament is full | The registration is refused; the tournament closes itself. |
| The success role is deleted | The bot cannot accept registrations and says so in the log. |
| The bot cannot `Manage Roles` / the role is above the bot's top role | The bot cannot accept registrations. |
| A slot's confirmation message is gone | The slot is still cancelled; the strike is skipped. |
| A published group list's message is gone | The Refresh button says so; the row is left alone. |
| A group list is refreshed within two minutes | The refresh is refused. |
| The wizard's token has expired | The button says the wizard has expired and to run the command again. |
| The room-credential message is gone before its job fires | The deletion is skipped; the job does not throw. |
| The room-credential message has been edited | The button copies whatever the message now holds. |

---

## The tests

| File | What it pins down |
|---|---|
| `state.test.ts` | The transitions, the guards, and that pause and close are different states |
| `groups.test.ts` | The exact grouping for a given slot list and group size, including the short last group |
| `requirements.test.ts` | The matrix as an ordered guard list, the first match winning, and the two source quirks |
| `schedule.test.ts` | The next occurrence of an open schedule, in the server's zone, and that it does not drift |
| `jobs.test.ts` | The daily open, end to end: the database accepts the row, the dispatcher claims it, the handler opens the tournament, and the schedule is re-armed (against the live database) |
| `idp.test.ts` | The room-credential post: the three values, the `msg_delete` row that arms the deletion, the payload that carries no password, the ephemeral replies, the dispatcher that claims the row and deletes the message, and the refusal of a member who is not staff (against the live database) |
| `views/select-handlers.test.ts` | The two select menus: the manager panel's is routed, and the slot manager's opens the rename modal |
| `slots.test.ts` | The per-tourney sequence (against the live database) and the swap in one transaction |
| `repo.test.ts` | The registration-channel uniqueness guard, the group-list row, the join that answers the fake-tag check, and the member list a registration records (against the live database) |

No test in this area talks to Discord. The three database tests talk to
the local SQLite file, like every other database test in the repository.
