# `modules/moderation/` — the moderation area

The port of Quotient's `mod` cog: clear/purge, role add/remove, kick/ban/
unban, lock/unlock, maintenance mode, category operations, and the block
list.

Everything here is additive to the existing bot. The frozen verification
flow is untouched.

---

## The command surface

Twelve top-level commands. Discord allows a hundred per guild and the
whole port will have about thirty, so the groups are aggressive
(D24).

| Command | Subcommand | Options | Permission |
|---|---|---|---|
| `/clear` | `embeds` | `search` (int, 1–2000, default 100) | Manage Messages |
| | `files` | `search` | Manage Messages |
| | `images` | `search` | Manage Messages |
| | `all` | `search` | Manage Messages |
| | `user` | `user` (user, required), `search` | Manage Messages |
| | `contains` | `text` (string, ≥3, required), `search` | Manage Messages |
| | `bot` | `prefix` (string, optional), `search` | Manage Messages |
| | `emoji` | `search` | Manage Messages |
| | `reactions` | `search` | Manage Messages |
| `/clear-amount` | — | `amount` (int, 1–2000, required) | Manage Messages |
| `/clear-user` | — | `user` (user, required), `search` | Manage Messages |
| `/role` | `add` | `role` (role, required), `members` (string, optional), `apply_to_all` (bool, optional) | Manage Roles |
| | `humans` | `role` (role, required) | Manage Roles |
| | `bots` | `role` (role, required) | Manage Roles |
| | `all` | `role` (role, required) | Manage Roles |
| `/rrole` | `remove` | `role` (role, required), `members` (string, optional), `apply_to_all` (bool, optional) | Manage Roles |
| | `humans` | `role` (role, required) | Manage Roles |
| | `bots` | `role` (role, required) | Manage Roles |
| | `all` | `role` (role, required) | Manage Roles |
| `/kick` | — | `target` (string: mention or id, required), `reason` (string, optional) | Kick Members |
| `/ban` | — | `target` (string: mention or id, required), `reason` (string, optional) | Ban Members |
| `/unban` | — | `user_id` (string, required), `reason` (string, optional) | Ban Members |
| `/lock` | `channel` | `channel` (channel, optional — defaults to the current one), `duration` (string, optional) | Manage Channels |
| | `server` | `duration` (string, optional) | Manage Channels + Manage Guild |
| `/unlock` | `channel` | `channel` (channel, optional) | Manage Channels |
| | `server` | — | Manage Channels + Manage Guild |
| `/maintenance` | `on` | `role` (role, optional — defaults to @everyone) | Manage Channels |
| | `off` | `role` (role, optional — defaults to @everyone) | Manage Channels |
| `/category` | `delete` | `category` (category, required) | Manage Channels |
| | `hide` | `category` (category, required) | Manage Channels |
| | `unhide` | `category` (category, required) | Manage Channels |
| | `nuke` | `category` (category, required) | Manage Channels |

Every command is **staff-only** (the `Moderator` role or Administrator) as
well as holding the permission above — D41: "where a privileged capability
genuinely remains, it uses the target's existing role-based `isStaff()`,
never a second parallel auth system".

The role-hierarchy guard (`core/guards.ts`'s `canManageRole`) is applied
on top of the Manage Roles permission for every `/role` and `/rrole`
subcommand, and again when the revert button is pressed.

### Ephemerality

The moderation commands set `ephemeral: false` (D43). The public parts
are:

- the **Confirm / Cancel prompt** — it is a public message, because an
  ephemeral prompt disappears when the moderator navigates away;
- the **role-revert button** — it is a public message, because a second
  moderator may need to undo the action;
- the outcome message of a lock, an unlock, a maintenance change and a
  category nuke — Quotient's were public, and everybody in the channel
  needs to know that the channel is closed.

Everything else answers in the interaction's reply.

> The dispatcher currently defers **every** command ephemerally
> (`handlers/interactions.ts:55`), so the Confirm / Cancel prompt is
> ephemeral until the dispatcher honours `Command.ephemeral`. That is a
> central change; see the area report.

---

## The state machines

### The lockdown

The state is a row in `lockdowns`. There is no flag on the channel, so
there is nothing that can fall out of sync with Discord.

```
                 lock (guarded)
     ┌──────────────────────────────┐
     │            absent            │
     └──────────────────────────────┘
                  │            ▲
                  │            │ unlock (guarded)
                  │            │ expiry (the jobs row fires)
                  ▼            │
     ┌──────────────────────────────┐
     │            locked            │
     └──────────────────────────────┘
```

**The key** of a lockdown is what identifies its subject:

| Type | Key | `channel_id` | `role_id` | `channel_ids` |
|---|---|---|---|---|
| `channel` | guild + channel | the channel | — | the channel |
| `guild` | guild | the channel the command was run in | — | every locked channel |
| `maintenance` | guild + role | the channel the command was run in | the role | every hidden channel |
| `category` | guild + category | the category | — | every hidden channel |

**Transitions**

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

**The guards, in the order they are checked**

1. `evaluateLock` refuses a second lockdown with the same key. The
   refusal says what is already locked and, when the lockdown has an
   expiry, when it lifts.
2. `evaluateUnlock` refuses when there is no lockdown to lift — "That
   channel is not locked, so there is nothing to unlock." — and when the
   channel is covered by a *different* lockdown: a channel of a server
   lockdown says "Use `/unlock server`", a channel under maintenance mode
   says "Use `/maintenance off`", a channel of a hidden category says
   "Use `/category unhide`". Lifting half of a server lockdown is not
   something the moderator asked for.
3. The bot must hold `manage_channels` in every channel it is about to
   change. The channels it cannot edit are left alone and counted.

**The expiry is a row in `jobs`, never a `setTimeout`.** A timer dies
with the process and the channel stays locked forever. The job row says
**when** the lockdown lifts; the dispatcher deletes the row before it
dispatches it, which makes the whole thing idempotent.

**A lockdown with no duration has no job row.** There is nothing to
schedule, and everything the unlock needs is on the lockdown row itself.
A job row that never fires, used as a data store, would read as a design
nobody meant.

### The maintenance mode

Maintenance mode is a lockdown of type `maintenance`. It hides the
channels from a role — `@everyone` unless a role is named — by taking
`view_channel` (Discord's `read_messages`) away from that role, and it
may create a `maintenance-chat` text channel and a `maintenance-vc`
voice channel that the role keeps access to.

```
     ┌──────────────────────────────┐
     │            visible           │
     └──────────────────────────────┘
                  │            ▲
                  │            │ /maintenance off (guarded)
                  ▼            │
     ┌──────────────────────────────┐
     │            hidden            │
     └──────────────────────────────┘
```

The guard is the same one: one maintenance lockdown per role per guild.
A second role may be put under maintenance at the same time.

### The role revert

```
     ┌──────────────────────────────┐
     │            done              │
     └──────────────────────────────┘
                  │            ▲
                  │            │ the revert button
                  ▼            │
     ┌──────────────────────────────┐
     │          reverted            │
     └──────────────────────────────┘
```

The button is one-shot: the token is taken out of the store when it is
pressed, so a second press is refused with "This button has expired."

---

## The public interface

`modules/moderation/service.ts` is the façade. The pieces:

| File | What it holds |
|---|---|
| `types.ts` | the domain types: the closed unions, `MemberTarget`, `LockRecord`, `LockdownJobPayload` |
| `repo.ts` | **all** the SQL of this area |
| `purge.ts` | the pure purge rules: the filters, the fourteen-day cutoff, the batching |
| `purge-service.ts` | the Discord side of the purge |
| `reason.ts` | the audit-log reason format and its 512-character cap |
| `hierarchy.ts` | the member hierarchy: the actor and the bot |
| `permissions.ts` | recording and restoring a channel's permissions |
| `lock-state.ts` | the pure lockdown state machine |
| `lockdown.ts` | lock, unlock, maintenance, category hide/unhide |
| `maintenance.ts` | the maintenance channels |
| `roles.ts` | giving and taking roles, and picking the members |
| `members.ts` | kick, ban, unban, and the member target |
| `category.ts` | delete and nuke |
| `blocklist.ts` | the block list: the model, the check and the cache |
| `jobs.ts` | the lockdown expiry handler |
| `commands/` | the command definitions |
| `views/` | the role-revert button and the router registration |
| `register.ts` | what the manager wires in |

### What the manager has to wire

```ts
// the router
import { registerModerationInteractions } from "./modules/moderation/register.js";
registerModerationInteractions();

// the startup
import { startModeration } from "./modules/moderation/register.js";
await startModeration();
```

`registerModerationInteractions()` registers the `moderation:role_revert`
button prefix with `core/router.ts`. The Confirm / Cancel prompt belongs
to `core/prompt.ts` and is not registered here.

`startModeration()` loads the block list and starts keeping it fresh.

### The block list

D41: the block list ships as a model, a check and a cache — **not** as a
chat command. The dispatcher asks:

```ts
import { isBlocked } from "./modules/moderation/register.js";

if (await isBlocked(interaction.user.id, "1")) return;   // a blocked user
if (interaction.guildId && await isBlocked(interaction.guildId, "2")) return;
```

`"1"` is a user, `"2"` is a guild. The key is the id **and** the kind, so
a user and a guild that share an id do not collide — Quotient's `bl
remove` looked records up by `block_id` alone and did collide.

An ops script would need three things, all of which exist:

| Need | Function |
|---|---|
| block an id | `insertBlocklistEntry({ blockId, blockIdType, blockedBy, reason })` in `repo.ts` |
| unblock an id | `deleteBlocklistEntry(blockId, blockIdType)` in `repo.ts` |
| take effect without a restart | `blocklistCache.refresh()` — the cache is refreshed every five minutes anyway |

### Custom ids

`<area>:<action>[:<payload>]` — the router dispatches on the prefix and
never guesses an id's owner from its shape.

| Id | Owner | Payload |
|---|---|---|
| `moderation:role_revert:<action>:<token>` | this module | the action (`add` / `remove`) and a token into the in-memory store |

The role and the member list have no database row, so the token is the
right mechanism (D18: a record id for a row, a token for ephemeral
state). The token lives for an hour.

---

## The error modes

A refusal is an answer, not a crash. The module raises the `DenialError`
family from `core/errors.ts` and the command adapter turns it into a
reply.

| Error | When | What the user sees |
|---|---|---|
| `InputError` | the input cannot be used | "That is not a member mention or a member id. …" |
| `PermissionDeniedError` | the hierarchy refuses, the bot may not edit the channel, the thing is already locked | the refusal message |
| `RoleHierarchyError` | `canManageRole` refuses | the five rules' own wording, from `core/guards.ts` |
| `NotStaffError` | the caller is not staff | the `Moderator` refusal |
| anything else | a bug | the dispatcher's "Something went wrong" |

The refusals the module raises itself:

| Refusal | When |
|---|---|
| "**#channel** is already locked." | the channel already has a lockdown |
| "The server is already locked." | the guild already has a lockdown |
| "The server is already under maintenance for **role**." | the role is already under maintenance |
| "That channel is not locked, so there is nothing to unlock." | there is no lockdown to lift |
| "That channel is locked as part of a server lockdown. Use `/unlock server` to lift it." | the channel is covered by another lockdown |
| "You cannot do this action on this user due to role hierarchy." | the moderator is not above the target |
| "I cannot do this action on this user due to role hierarchy." | the bot is not above the target |
| "Reason is too long (n/max)" | the audit-log reason does not fit in 512 characters |
| "The substring length must be at least 3 characters." | `/clear contains` |

---

## The bugs that were fixed rather than ported

### 1. The role-revert button never reverted anything

`mod/views/role.py:35`

```python
await _.remove_roles(self.role) if self.take_role else await _.add_roles(self.role)
```

Python parses this as `await (X if cond else Y)`, where `X` is already
the *resolved* result of a call rather than a coroutine — so the outer
`await` raised `TypeError: object list can't be used in 'await'
expression` and the button did nothing at all.

**Now:** the branches are parenthesised. The revert does the opposite of
what the original action did: an "add" is undone with a remove, a
"remove" is undone with an add.

### 2. `unlock server` always raised

`mod/__init__.py:609`

```python
check = await Lockdown.get_or_none(guild_id=ctx.guild.id, type=LockType.guild).first()
```

`.first()` was called on a coroutine.

**Now:** the lookup is a query. `findLockdown(guildId, "guild")` returns
the row or `null`, and the command says "The server is not locked." when
there is none.

### 3. `lock server` without a duration crashed

`mod/__init__.py:568-578` created the row with `expire_time=duration.dt`
*before* the `if duration is None` check, so `None.dt` raised.

**Now:** the row is written with a null expiry, which the column allows.

> **A deliberate difference from D44.** D44 says "create the row only
> when there is a duration". This port **always** creates the row, with
> `expire_time = null` when there is no duration. The reason: the row is
> the state, and the state machine needs it — the double-lock guard
> reads it, and the unlock finds the permission state through it. A
> lockdown with no record cannot be guarded against and cannot be
> unlocked. The crash D44 describes is fixed either way; this way also
> makes an untimed lockdown liftable.

### 4. `maintenance off` never deleted the maintenance channels

`mod/__init__.py:736`

```python
tc = discord.utils.get(ctx.guild.channels, name="maintenance-chat")
```

`discord.utils.get` asks a *list* for an attribute called `name`. Every
channel has a name, so the lookup never matched and the channels stayed.

**Now:** the channels are found by a name **predicate** over the channel
cache (`findChannelsByName`), and — better — by the ids the bot recorded
when it created them. The recorded ids are used when there are any; the
name predicate is the fallback for when the record is missing.

### 5. The unlock opened channels that had been locked on purpose

`mod/__init__.py:598` and `mod/__init__.py:726` set `send_messages = True`
and `read_messages = True` unconditionally. A channel that was
write-locked before the lockdown was silently opened by the unlock.

**Now:** the previous state is **recorded** when the lockdown is applied
and restored exactly when it is lifted. The record holds three things
per channel: whether the channel had an explicit overwrite for the
target at all, and what the permission was — `true`, `false`, or `null`
for "inherit".

- The channel had no overwrite → the unlock **removes** the overwrite the
  lock created, so the channel is exactly what it was.
- The channel had one → the unlock puts the permission back to the value
  it had, `null` included.

The record lives on the lockdown row, in the `prior_state` column. It is
a property of the lockdown and not of the timer, so a lockdown with no
duration — which has no job row at all — still restores exactly after a
restart.

### 6. The clear group was ambiguous

`mod/__init__.py:54` declared a required positional argument *alongside*
its subcommands, which discord.py cannot disambiguate. The `None`
fallbacks in the group body were dead code.

**Now:** the group is split — `/clear-amount` takes a number,
`/clear-user` takes a user, and the filter variants are subcommands of
`/clear`.

### 7. The purge lied about what it deleted

`ctx.channel.purge` passed `filter_old=True`, so the messages Discord
refused to delete (anything older than fourteen days) were silently
skipped and the command reported a smaller number than it had been asked
for.

**Now:** the old messages are filtered out *before* the delete, they are
counted, and the report says so:

> 42 messages were removed.
> ⚠️ 13 matching messages are older than 14 days and could not be deleted.

The same report counts the pinned messages (which bulk delete refuses)
and the ones that failed.

### 8. The category hide replaced the whole overwrite

`utility/__init__.py:518` read the `@everyone` overwrite as a *computed*
permission set and wrote the whole thing back, which dropped every other
`@everyone`-level tweak on the channel.

**Now:** only the one permission that changes is written. discord.js's
`permissionOverwrites.edit()` merges the permission it is given into the
existing overwrite.

### 9. The nuke did not do what it said

`utility/__init__.py:560` is documented as "Delete a category completely
and create a new one", but it only ever replaced the category's
*channels*. The category itself was never touched.

**Now:** the command does what it says — it replaces every channel of the
category with a fresh clone, keeping the name, the topic, the permission
overwrites, the rate limit and the position, and starting with no
messages — **and it says so**, in the channel and in the reply:

> Nuked **Category**: 4 channels replaced with fresh copies. The category
> itself was left in place.

Replacing the category as well would throw away its position, its
permission overwrites and the history of every channel that was ever in
it, which is more than a moderator asking for "a clean slate" expects.

### 10. The block list collided

Quotient's `bl remove` looked records up by `block_id` alone, so a user
and a guild that shared an id collided.

**Now:** the key is the id *and* the kind, which is also what the
database's unique constraint is.

---

## Deliberate differences from Quotient

| Difference | Why |
|---|---|
| The block list has no chat command | D41. The management surface is an ops script. |
| Every command is staff-only *and* needs a Discord permission | D41: one authorisation model, the target's. Quotient only had the permission. |
| The audit-log reason is `"<author> (ID: <id>): <reason>"` for every action | Quotient used two shapes: `"Action done by <author> (ID: <id>)"` when there was no reason, and the one above when there was. The default is kept; the shape with a reason is the same everywhere. |
| `/unlock` on a channel that is not locked refuses | The state machine says there is nothing to lift. Quotient forced `send_messages = True` on any channel, which is the bug this area exists to fix. |
| `/category unhide` opens the channels even without a record | It is a positive action, not the lifting of a lockdown, and there may be channels that were hidden by hand. |
| The members of a bulk role action come from the guild cache | A bulk action over a thousand members must not be a thousand API calls. The bot has the GuildMembers intent. |
| The reason option accepts 400 characters, the real cap is 512 minus the prefix | The prefix depends on the moderator's display name, which is not known when the command is registered. The real cap is enforced by `formatActionReason`, which refuses rather than truncating. |

---

## Tests

```bash
npm test
```

| File | What it proves |
|---|---|
| `purge.test.ts` | which messages each filter selects, the fourteen-day cutoff, the batching, the three-character minimum |
| `reason.test.ts` | the reason format and the 512-character cap |
| `lock-state.test.ts` | the transitions and the guards, including the refusal to double-lock |
| `permissions.test.ts` | the restore-previous-state logic |
| `hierarchy.test.ts` | the actor's and the bot's hierarchy checks |
| `blocklist.test.ts` | the cache, and that a user and a guild with the same id do not collide |
| `roles.test.ts` | the mention parsing, for the role and the member commands |
