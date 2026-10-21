# Moderation area — port report

The port of Quotient's `mod` cog (plus the category half of `utility`).
Everything lives in `modules/moderation/` and `commands/moderation/`.

- `npm run typecheck` — clean for this area.
- `npm test` — 88 tests in this area, 480 in the repository, all passing.
- `npm run smoke` — 106/106, unchanged.
- `modules/moderation/README.md` — the interface, the state machines, the
  error modes, the bugs.

---

## 1. The command surface

Twelve top-level commands. `commands/moderation/<name>.ts` is a one-line
re-export of the command object in `modules/moderation/commands/`.

Every command is **staff-only** (the `Moderator` role or Administrator)
*and* needs the Discord permission below. D41: "where a privileged
capability genuinely remains, it uses the target's existing role-based
`isStaff()`, never a second parallel auth system." The role commands also
run `core/guards.ts`'s `canManageRole` — the five rules, in order, are not
reimplemented.

| Command | Subcommand | Options | Permission |
|---|---|---|---|
| `/clear` | `embeds` | `search` (int 1–2000, default 100) | Manage Messages |
| | `files` | `search` | Manage Messages |
| | `images` | `search` | Manage Messages |
| | `all` | `search` | Manage Messages |
| | `user` | `user` (user, **required**), `search` | Manage Messages |
| | `contains` | `text` (string, min 3, **required**), `search` | Manage Messages |
| | `bot` | `prefix` (string, optional), `search` | Manage Messages |
| | `emoji` | `search` | Manage Messages |
| | `reactions` | `search` | Manage Messages |
| `/clear-amount` | — | `amount` (int 1–2000, **required**) | Manage Messages |
| `/clear-user` | — | `user` (user, **required**), `search` | Manage Messages |
| `/role` | `add` | `role` (role, **required**), `members` (string, optional), `apply_to_all` (bool, optional) | Manage Roles |
| | `humans` | `role` (role, **required**) | Manage Roles |
| | `bots` | `role` (role, **required**) | Manage Roles |
| | `all` | `role` (role, **required**) | Manage Roles |
| `/rrole` | `remove` | `role` (role, **required**), `members` (string, optional), `apply_to_all` (bool, optional) | Manage Roles |
| | `humans` | `role` (role, **required**) | Manage Roles |
| | `bots` | `role` (role, **required**) | Manage Roles |
| | `all` | `role` (role, **required**) | Manage Roles |
| `/kick` | — | `target` (string: mention or id, **required**), `reason` (string, optional) | Kick Members |
| `/ban` | — | `target` (string: mention or id, **required**), `reason` (string, optional) | Ban Members |
| `/unban` | — | `user_id` (string, **required**), `reason` (string, optional) | Ban Members |
| `/lock` | `channel` | `channel` (channel, optional — the current one by default), `duration` (string, optional) | Manage Channels |
| | `server` | `duration` (string, optional) | Manage Channels **and** Manage Guild |
| `/unlock` | `channel` | `channel` (channel, optional) | Manage Channels |
| | `server` | — | Manage Channels **and** Manage Guild |
| `/maintenance` | `on` | `role` (role, optional — @everyone by default) | Manage Channels |
| | `off` | `role` (role, optional — @everyone by default) | Manage Channels |
| `/category` | `delete` | `category` (category, **required**) | Manage Channels |
| | `hide` | `category` (category, **required**) | Manage Channels |
| | `unhide` | `category` (category, **required**) | Manage Channels |
| | `nuke` | `category` (category, **required**) | Manage Channels |

`duration` is natural language — `2 hours`, `1 day`, `tomorrow at 7pm` —
parsed by `core/time.ts`'s `parseNaturalTime` (D30).

**Ephemerality (D43).** The commands set `ephemeral: false`. The public
messages are the Confirm / Cancel prompt, the role-revert button, and the
outcome of a lock, an unlock, a maintenance change and a category nuke.
The rest answers in the interaction's reply.

> The dispatcher defers **every** command ephemerally
> (`handlers/interactions.ts:55`), so the Confirm / Cancel prompt is
> ephemeral until the dispatcher honours `Command.ephemeral`. **Central
> change — see §6.**

### The split of Quotient's `clear` group

Quotient's `clear` declared a required positional argument *alongside* its
subcommands, which discord.py cannot disambiguate; the `None` fallbacks in
the group body were dead code (D44). Slash commands have no such
ambiguity, so the group is split: **`/clear-amount`** takes a number,
**`/clear-user`** takes a user, and the filter variants are subcommands of
**`/clear`**. The `user` filter exists in both places because the brief
lists "by user" as one of the filters; `/clear-user` is the one the brief
names, `/clear user` is the one the source had.

### The split of Quotient's `role` / `rrole` groups

`/role` gives a role, `/rrole` takes it away. The greedy member list
became a string of mentions that is parsed, plus an explicit
`apply_to_all` flag — the flag exists because the "everybody" path is a
*confirm* in the source, and a confirm needs a deliberate choice rather
than an empty argument list. The bulk subcommands (`humans`, `bots`,
`all`) are Quotient's.

---

## 2. The state machines

### The lockdown

The state is a row in `lockdowns`. There is no flag on the channel, so
nothing can fall out of sync with Discord.

```
                 lock (guarded)
     ┌──────────────────────────────┐
     │            absent            │
     └──────────────────────────────┘
                  │            ▲
                  │            │ unlock (guarded)
                  ▼            │ expiry (the jobs row fires)
     ┌──────────────────────────────┐
     │            locked            │
     └──────────────────────────────┘
```

**The key** of a lockdown:

| Type | Key | `channel_id` | `role_id` | `channel_ids` |
|---|---|---|---|---|
| `channel` | guild + channel | the channel | — | the channel |
| `guild` | guild | the channel the command was run in | — | every locked channel |
| `maintenance` | guild + role | the channel the command was run in | the role | every hidden channel |
| `category` | guild + category | the category | — | every hidden channel |

**Transitions and guards**

| From | Event | To | Guard |
|---|---|---|---|
| absent | `/lock channel` | locked | no `channel` lockdown for that channel; the bot may edit it |
| absent | `/lock server` | locked | no `guild` lockdown for the guild; at least one channel may be edited |
| absent | `/maintenance on` | locked | no `maintenance` lockdown for that role; at least one channel may be edited |
| absent | `/category hide` | locked | no `category` lockdown for that category |
| locked | `/unlock channel` | absent | the channel has its own `channel` lockdown |
| locked | `/unlock server` | absent | the guild has a `guild` lockdown |
| locked | `/maintenance off` | absent | the guild has a `maintenance` lockdown for that role |
| locked | `/category unhide` | absent | — (a category can be unhidden without a record) |
| locked | the expiry job fires | absent | the lockdown row still exists |

**The guards**

1. `evaluateLock` refuses a second lockdown with the same key, and says
   what is already locked and, when the lockdown has an expiry, when it
   lifts.
2. `evaluateUnlock` refuses when there is no lockdown to lift ("That
   channel is not locked, so there is nothing to unlock."), and refuses
   when the channel is covered by a *different* lockdown — it points at
   `/unlock server`, `/maintenance off` or `/category unhide` instead.
   Lifting half of a server lockdown is not what the moderator asked for.
3. The bot must hold `manage_channels` in every channel it is about to
   change. The ones it cannot edit are left alone and counted.

**The expiry is a row in `jobs`, never a `setTimeout`.** A timer dies
with the process and the channel stays locked forever. The dispatcher
deletes the row before dispatching it, which makes the whole thing
idempotent: a job that fires twice cannot unlock twice, because the
second time there is no row to fire.

### The maintenance mode

A lockdown of type `maintenance`. It hides the channels from a role —
`@everyone` unless a role is named — by taking `view_channel` (Discord's
`read_messages`) away from that role, and it may create a
`maintenance-chat` text channel and a `maintenance-vc` voice channel that
the role keeps access to.

```
     ┌──────────────────────────────┐
     │            visible           │
     └──────────────────────────────┘
                  │            ▲
                  ▼            │ /maintenance off (guarded)
     ┌──────────────────────────────┐
     │            hidden            │
     └──────────────────────────────┘
```

The guard is the same one: one maintenance lockdown per role per guild. A
second role may be under maintenance at the same time.

### The role revert

The button is one-shot — the token is taken out of the store when it is
pressed, so a second press is refused with "This button has expired." The
custom id is `moderation:role_revert:<action>:<token>`, registered with
`core/router.ts` under the prefix `moderation:role_revert`. The action
(`add` / `remove`) says what the button undoes, and the token resolves to
the stored role and member list (D18: a token for state that has no
database row).

### Where the "restore the previous state" data lives

This is the one design decision the decision log did not cover, and it
needed a call. The call was made twice: first for the port, then again
when the schema owner added the column the first answer asked for.

The undo data lives on the `lockdowns` row itself, in the
`prior_state jsonb` column:

```jsonc
{
  "123": { "existed": false, "value": null }   // channel id → what it looked like before
}
```

`prior_state` holds, per channel: whether the channel had an explicit
overwrite for the target at all, and what the permission was — `true`,
`false`, or `null` for "inherit".

- The channel had **no** overwrite → the unlock **removes** the overwrite
  the lock created, so the channel is exactly what it was.
- The channel had one → the unlock puts the permission back to the value
  it had, `null` included.

It is written with the row, in the same statement, so the undo data is as
durable as the lock itself.

**The `jobs` row is the timer and nothing else.** It says when the
lockdown lifts by itself, and its payload says only which lockdown to
lift and where to say so:

```jsonc
{
  "lockdownId": "…",          // the lockdown row
  "type": "channel",
  "guildId": "…",
  "channelIds": ["…"],
  "roleId": null,
  "sourceChannelId": "…",
  "maintenanceChannelIds": []
}
```

**A lockdown without a duration has no `jobs` row at all.** There is
nothing to schedule, and everything the unlock needs is on the lockdown
row. The first cut of this port gave every lockdown a job row, with an
expiry in the year 9999, purely so the undo data had somewhere durable to
live — a job row that never fires, used as a data store, reads as a
design nobody meant.

---

## 3. The bugs that were fixed rather than ported

Ten of them. Six were named in the brief, four more came out of the
source while porting it.

| # | Where | What it did | What it does now |
|---|---|---|---|
| 1 | `mod/views/role.py:35` | `await _.remove_roles(...) if self.take_role else await _.add_roles(...)` parses as `await (X if cond else Y)`, where `X` is already resolved — so the outer `await` raised `TypeError` and **the revert button never reverted anything**. | The branches are parenthesised. The revert does the opposite of the original action: an "add" is undone with a remove, a "remove" with an add. |
| 2 | `mod/__init__.py:609` | `await Lockdown.get_or_none(...).first()` — `.first()` on a coroutine. **`unlock server` always raised** `AttributeError`. | The lookup is a query. `findLockdown(guildId, "guild")` returns the row or `null`, and the command says "The server is not locked." |
| 3 | `mod/__init__.py:568-578` | `Lockdown.create(expire_time=duration.dt)` ran **before** the `if duration is None` check, so `lock server` without a duration crashed on `None.dt`. | The row is written with a null expiry, which the column allows. (See §4 for why the row is written at all.) |
| 4 | `mod/__init__.py:736` | `discord.utils.get(ctx.guild.channels, name="maintenance-chat")` asks a **list** for an attribute — every channel has a name, so it never matched and **the maintenance channels were never deleted**. | The channels are found by a name **predicate** over the channel cache, and — better — by the ids the bot recorded when it created them. The recorded ids are used when there are any; the name predicate is the fallback for when the record is missing. |
| 5 | `mod/__init__.py:598`, `:726` | The unlock set `send_messages = True` / `read_messages = True` **unconditionally**, so a channel that had been write-locked before the lockdown was silently opened by the unlock. | The previous state is **recorded** when the lockdown is applied and restored **exactly** when it is lifted. The record distinguishes "no overwrite at all" from "an explicit allow", "an explicit deny" and "inherit". |
| 6 | `mod/__init__.py:54` | The `clear` group declared a required positional argument alongside its subcommands — ambiguous, and the `None` fallbacks were dead code. | The group is split: `/clear-amount`, `/clear-user`, and the filter subcommands of `/clear`. |
| 7 | `mod/utils.py:38` | `ctx.channel.purge(..., filter_old=True)` **swallowed the messages Discord refused to delete** (anything older than fourteen days) and reported a smaller number than it had been asked for. | The old messages are filtered out *before* the delete, counted, and reported: "42 messages were removed. ⚠️ 13 matching messages are older than 14 days and could not be deleted." The same report counts the pinned messages and the ones that failed. |
| 8 | `utility/__init__.py:518`, `:546` | `hide` / `unhide` read the `@everyone` overwrite as a **computed** permission set and wrote the whole thing back, which **dropped every other `@everyone`-level tweak** on the channel. | Only the one permission that changes is written. discord.js's `permissionOverwrites.edit()` merges the permission it is given into the existing overwrite. |
| 9 | `utility/__init__.py:560` | `nuke` is documented as "Delete a category completely and create a new one", but it **only replaced the category's channels**. The category was never touched. | The command does what it says — it replaces every channel of the category with a fresh clone, keeping the name, the topic, the permission overwrites, the rate limit and the position, and starting with no messages — **and it says so**, in the channel and in the reply: "The category itself was left in place." Replacing the category as well would throw away its position, its permission overwrites and the history of every channel that was ever in it. |
| 10 | `dev.py` (`bl remove`) | The block list was looked up by `block_id` alone, so a user and a guild that shared an id **collided** — and unblocking one unblocked the other. | The key is the id **and** the kind, which is also what the database's unique constraint is. There is no `bl` command at all (D41). |

### The 512-character reason

The action reason is `"<author> (ID: <id>): <reason>"` and the **whole
thing** is capped at 512 characters — Discord's audit-log limit.
Quotient's converter refused the action rather than truncating, and so
does this one: "Reason is too long (500/467)". The default reason, when
the moderator gives none, is Quotient's "Action done by `<author> (ID:
<id>)`".

---

## 4. Deliberate differences from the source, and why

| # | Difference | Why |
|---|---|---|
| 1 | **The `lockdowns` row is always created**, with `expire_time = null` when there is no duration. | **A deliberate deviation from D44**, which says "create the row only when there is a duration". The row is the *state*: the double-lock guard reads it, and the unlock finds the permission state through it. A lockdown with no record cannot be guarded against and cannot be unlocked. The crash D44 describes is fixed either way; this way also makes an untimed lockdown liftable. The column is nullable, so the schema already allows it. **Ratified by the schema owner** — the decision log (D44) now says the same. |
| 2 | The prior permission state lives on the `lockdowns` row, in the `prior_state jsonb` column. | It is a property of the lockdown, not of the timer. The column was added for this port, so the state is as durable as the lock itself and a lockdown with no duration needs nothing else to restore it. |
| 3 | A lockdown without a duration gets **no** `jobs` row. | A job is a schedule, and there is nothing to schedule. The first cut of this port gave every lockdown a job row with a sentinel expiry in the year 9999, purely so the undo data had somewhere durable to live — a job row that never fires, used as a data store, reads as a design nobody meant. |
| 4 | The block list has **no chat command**. | D41. It ships as a model, a check and a cache. The management surface is an ops script — see §5. |
| 5 | Every command is staff-only **and** needs a Discord permission. | D41: one authorisation model, the target's. Quotient only had the permission. |
| 6 | `/unlock` on a channel that is not locked **refuses**. | The state machine says there is nothing to lift. Quotient forced `send_messages = True` on any channel, which is the bug this area exists to fix. |
| 7 | `/category unhide` opens the channels even when there is no record. | It is a positive action, not the lifting of a lockdown, and there may be channels that were hidden by hand. When there **is** a record, the previous state is restored exactly, like every other lockdown. |
| 8 | A category hide is recorded as a `category` lockdown. | So that `/category unhide` restores the previous permissions exactly, the same as the other lockdowns, instead of forcing `read_messages = True`. |
| 9 | The bulk role actions read the members from the guild cache. | A bulk action over a thousand members must not be a thousand API calls. The bot has the GuildMembers intent. |
| 10 | The reason option accepts 400 characters; the real cap is 512 minus the prefix. | The prefix depends on the moderator's display name, which is not known when the command is registered. `formatActionReason` refuses rather than truncating, and says the real number. |
| 11 | The confirm prompt uses `core/prompt.ts`; the brief's `moderation:lock_confirm` example was generalised into it. | `core/prompt.ts` exists and owns the Confirm / Cancel buttons under the `core:prompt` prefix. A second implementation in this area would be the "second copy" the wave-3 brief warns against. This module owns exactly one custom id: `moderation:role_revert`. |
| 12 | The role-revert custom id is `moderation:role_revert:<action>:<token>`. | The area prefix (D7) plus the action and the token the brief asked for. The router dispatches on the prefix and never guesses an id's owner from its shape. |
| 13 | The `contains` minimum is enforced twice: by the option (`setMinLength(3)`) and by `validateContains`. | Discord's own limit gives a better error than a runtime check; the runtime check is the one under test. |

---

## 5. The block list

It ships as a model, a check and a cache — **not** as a chat command
(D41).

**The read side**, which the manager's dispatcher calls:

```ts
import { isBlocked } from "./modules/moderation/register.js";

if (await isBlocked(interaction.user.id, "1")) return;    // a blocked user
if (interaction.guildId && await isBlocked(interaction.guildId, "2")) return;
```

`"1"` is a user, `"2"` is a guild. The key is the id **and** the kind, so
a user and a guild that share an id do not collide.

**What an ops script would need** — all three already exist:

| Need | Function |
|---|---|
| block an id | `insertBlocklistEntry({ blockId, blockIdType, blockedBy, reason })` — `modules/moderation/repo.ts` |
| unblock an id | `deleteBlocklistEntry(blockId, blockIdType)` — `modules/moderation/repo.ts` |
| take effect without a restart | `blocklistCache.refresh()` — the cache is refreshed every five minutes anyway, and the script can call it directly |

The cache is loaded at startup by `startModeration()` and refreshed on a
timer. A database blip leaves the previous contents in place: a failed
refresh must not unblock everybody.

The `ops script` itself would live in `scripts/`, which is not mine.

---

## 6. Central changes needed

None of these block the area; the code is written against them.

| # | Where | What |
|---|---|---|
| 1 | `types/command.ts` | Add `guards?: Guard[]` (D28). The moderation commands carry their guards on `ModerationCommand` (`modules/moderation/types.ts`) because the interface does not declare the field yet. The dispatcher must run them, in the order `guildOnly → staffOnly → guards`. |
| 2 | `handlers/interactions.ts` | Honour `Command.ephemeral` (D43). The dispatcher currently defers **every** command ephemerally, which makes the Confirm / Cancel prompt ephemeral — the thing D43 and this area's brief both say must be public. |
| 3 | `handlers/buttons.ts` (or wherever) | Route button interactions through `core/router.ts`'s `dispatch`, so `moderation:role_revert:*` reaches this area. `handlers/buttons.ts` currently handles only `verify_btn` and returns for everything else. |
| 4 | The startup | Call `registerModerationInteractions()` and `startModeration()`. Both are exported from `modules/moderation/register.ts`. |
| 5 | The job dispatcher | Call `handleModerationJob(client, event, payload)` for the `lockdown` event. Exported from `modules/moderation/register.ts`. |
| 6 | The global command guard | Call `isBlocked(userId, "1")` and `isBlocked(guildId, "2")` (D39/D41). |
| 7 | ~~`db/schema/system.ts`~~ | **Done.** The `prior_state jsonb` column on `lockdowns` was added for this port, and the permission state moved onto it. The `jobs` payload carries no permission state any more. |
| 8 | `core/guards.ts` *(optional)* | Two helpers live in this area and would fit better in core: the **member** hierarchy check (`modules/moderation/hierarchy.ts` — `core/guards.ts` has the *role* version, `canManageRole`, and this area uses it as it is) and a `permissionGuard` factory (`modules/moderation/commands/shared.ts`). |

---

## 7. The tests

| File | What it proves |
|---|---|
| `purge.test.ts` | which messages each filter selects, the fourteen-day cutoff (including the exact boundary), the batching into hundreds, the three-character minimum |
| `reason.test.ts` | the reason format, the 512-character cap, that the prefix counts against it, that a longer name means a shorter budget |
| `lock-state.test.ts` | the transitions and the guards, including the refusal to double-lock, the refusal to unlock a channel of a server lockdown, and the "how long is left" message |
| `lockdown.test.ts` | the lockdown against the live database: the prior state round-trips through `lockdowns.prior_state`, a lockdown with no duration writes no `jobs` row, one with a duration writes exactly one, that row's payload carries no permission state, the unlock puts an existing overwrite back to exactly what it was and removes one that did not exist, and the double-lock guard refuses a second lock with and without a duration |
| `permissions.test.ts` | the restore-previous-state logic: no overwrite → remove, explicit allow → allow, explicit deny → deny, inherit → inherit |
| `hierarchy.test.ts` | the actor's and the bot's checks, the guild-owner exemption, that the bot has none |
| `blocklist.test.ts` | that a user and a guild with the same id do not collide, and that a failed refresh does not unblock anybody |
| `roles.test.ts` | the mention parsing for the role and member commands |

88 tests in this area; 480 in the repository; all passing.
