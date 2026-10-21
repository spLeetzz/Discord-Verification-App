# `modules/community/` — the community area

The port of Quotient's `utility` cog: tags, snipe, auto-roles, auto-purge
and reminders, plus the consumers of the durable job scheduler.

Everything here is additive to the existing bot. The frozen verification
flow is untouched.

---

## The command surface

Five top-level commands. Community commands are **public** by default
(D43): a tag, a snipe and a reminder are messages the people in the
channel are meant to see.

| Command | Subcommand | Options | Permission |
|---|---|---|---|
| `/tag` | `show` | `name` (string, required) | — |
| | `raw` | `name` (string, required) | — |
| | `list` | `member` (user, optional) | — |
| | `info` | `name` (string, required) | — |
| | `claim` | `name` (string, required) | — |
| | `create` | `name` (string, required), `content` (string, required), `embed` (bool, optional) | — |
| | `delete` | `name` (string, required) | owner, or Manage Server |
| | `transfer` | `name` (string, required), `member` (user, required) | owner |
| | `nsfw` | `name` (string, required) | owner, or Manage Server |
| | `mine` | — | — |
| | `purge` | `member` (user, required) | Manage Server |
| | `edit` | `name` (string, required), `content` (string, required), `embed` (bool, optional) | owner, or Manage Server |
| | `search` | `query` (string, required) | — |
| | `stats` | `member` (user, optional) | — |
| `/snipe` | — | `channel` (channel, optional) | — |
| `/autorole` | `humans` | `role` (role, required) | Manage Server |
| | `bots` | `role` (role, required) | Manage Server |
| | `config` | — | Manage Server |
| | `off` | — | Manage Server |
| `/autopurge` | `set` | `channel` (channel, required), `delete_after` (string, required) | Manage Messages |
| | `list` | — | Manage Messages |
| | `remove` | `channel` (channel, required) | Manage Messages |
| `/reminder` | `set` | `when` (string, required), `text` (string, optional) | — |
| | `list` | — | — |
| | `delete` | `id` (string, optional) | — |

The source's guard on the auto-role commands was `is_mod`, which is "the
caller has `manage_guild`", and it also required the **bot** to have
`manage_roles`. Both are kept. The auto-purge commands need `manage_messages`
from the caller and from the bot, in the channel being configured.

The commands are declared in `modules/community/commands/` and re-exported
by the one-line files under `commands/community/`, which is the shape the
command loader scans.

> **Ephemerality.** The commands do not set `ephemeral`, so they are
> **public** — the default the `Command` interface documents and what D43
> asks for. The dispatcher honours the flag
> (`handlers/interactions.ts`: `command.ephemeral ? MessageFlags.Ephemeral
> : undefined`), so a tag, a snipe and a reminder are messages the channel
> can see.

---

## The bot does not notify anybody

**A reply in this area cannot ping anybody, unless the reply says so
explicitly.**

A tag's body is stored verbatim and posted as message **content**, so
without a rule a member could store `@everyone` in a tag and have the
bot — which holds "Mention Everyone" — ping the whole server. The member
would be using a permission they do not have, and the bot would be
holding it for them.

Two things stop it, and the area uses both:

1. **`allowedMentions: { parse: [] }` on the reply.** Every reply goes
   through `views/reply.ts` (`respondSafe`), so Discord is told not to
   parse a mention out of the content. A reply that *means* to mention
   somebody passes that id explicitly: `/tag transfer` names the new
   owner, and `/autorole` names the role.
2. **The user content is escaped.** `core/escape.ts`'s `escapeMentions`
   is applied to the tag body on the show path (the raw path already did
   it), to the tag's name in the confirmations, and to the reminder's own
   text in the confirmation. The markdown is left alone — a tag is a
   canned message and its formatting is the point of it.

> **The price of the rule.** A tag whose body mentions somebody no longer
> pings them: the mention is escaped, like the raw path has always done
> it. A tag is for saying something to a channel, not for reaching a
> person — `/tag transfer` is the command that tells a member they have
> been given a tag, and it mentions them on purpose.

> **The default belongs in `core/context.ts`.** Every area that posts
> user content has this problem, not this one. `views/reply.ts` is the
> area's own copy of the rule, so the area is safe whether or not the
> core default has landed.

Content that goes into an **embed** cannot notify anybody — Discord's
`allowed_mentions` applies to message content only — so the snipe, the
tag statistics, the reminder list and the auto-purge list are left as
they are.

---

## The member allowances

A tag is a row in the `tags` table and a reminder is a row in the `jobs`
table, and nothing removed either of them by itself. A member could put
on the order of ten thousand rows a day, and every one of them was
scanned past by the dispatcher on every poll.

| Allowance | Number | Counted over |
|---|---|---|
| Tags a member may own | **25** | one guild |
| Reminders a member may have running | **25** | every guild |

**Why twenty-five.** A tag is a canned message: twenty-five of them in
one server is already more than a server uses, and the tag namespace is
per guild, so the allowance is per guild too. A reminder is a row in the
table the dispatcher polls every fifteen seconds; twenty-five running
reminders is more than anybody needs at once, and the allowance empties
itself — the dispatcher deletes a reminder's row when it fires.

These are the area's own limits, in `rules.ts` (`MAX_TAGS_PER_MEMBER`,
`MAX_REMINDERS_PER_MEMBER`). They are **not** free-tier limits: the free
tier is about what a *guild* may configure, and these are about what a
*member* may leave lying around.

The rule itself is a pure function (`checkMemberQuota`), and it is
enforced where the row is written: `service.createTag` and
`service.createReminder`.

**The allowance is never a trap.** A member at the allowance can always
make room: `/tag delete` removes a tag the caller owns, and
`/reminder delete` removes a running reminder (one by id, or all of
them). Without the reminder command the allowance would have been a trap,
because a reminder's row only goes away when it fires.

### The retention

| What | How long it is kept | Who prunes it |
|---|---|---|
| A reminder | until it fires | the dispatcher, which deletes the row *before* it dispatches it (`handlers/jobs.ts`) |
| A tag that has been used | for ever | — the usage counter bumps `updated_at` |
| A tag that has never been used | **180 days** | the daily pass (`community_daily`) |
| A snipe | 10 days | the daily pass |
| A command-usage row | 30 days | `db/retention.ts`, called by the daily pass |

The tag prune is deliberately long: a tag is somebody's text, and the
price of keeping it a little longer is far lower than the price of
deleting a guild's rules by surprise. A tag that has been *edited* also
keeps its row — the edit bumps `updated_at` — so what goes is only the
tag somebody made once and forgot about.

---

## The tag name rules

The rules, in the order they are applied:

1. the name is **trimmed**;
2. the name is **lower-cased** — this is the *canonical* form, and it is
   the only form that is stored;
3. the name is not empty;
4. the name is at most **99 characters**;
5. the **first space-separated word** is not one of the fourteen `/tag`
   subcommands.

The reserved words are `show`, `raw`, `list`, `info`, `claim`, `create`,
`delete`, `transfer`, `nsfw`, `mine`, `purge`, `edit`, `search` and
`stats`. The check is on the first word, exactly as the source did it:
`"raw stuff"` is refused, `"rawstuff"` is allowed.

A tag can also be called by its **id**, as the source's converter allowed
(`TagConverter` tried `int(argument)` first). Our ids are uuids, so that
is what "by its id" looks like now.

### The case-sensitivity decision

**Tag names are case-insensitive, and the canonical (lower-cased) name is
what is stored.**

The source's converter lower-cased the name for the reserved-word check
and returned the **original** casing, and the lookup was an exact match.
So `/tag Rules` and `/tag rules` were two different tags, while the
reserved-word check treated `Raw` and `raw` as the same word. The bug is
in the source (wave-3, Area E).

Storing the canonical name makes the schema's existing constraint do the
work:

```sql
UNIQUE (guild_id, name)
```

becomes the case-insensitive constraint, because both `Rules` and `rules`
are stored as `rules`. The alternative — keeping the display casing and
comparing with `lower(name) = lower($1)` — would have made the
constraint case-*sensitive* while the lookup was case-insensitive, so two
tags that differ only in case could both exist. That is the read-then-
write race the schema decisions exist to remove, and it would be back.

The cost is that the display name is lower-case. A tag called `Rules` is
shown as `rules`.

> **Do not "fix" the display casing.** A `normalized_name` column beside
> the display name is the only way to have both the display casing *and*
> a database-enforced case-insensitive constraint. It was considered and
> **declined**: it is a schema change in a file this area does not own,
> and the trade was made — a lower-cased display name for a constraint
> that cannot race.
>
> If the display casing is ever changed back, the schema's
> `UNIQUE (guild_id, name)` stops *being* the case-insensitive
> constraint, and the read-then-write race comes straight back with it:
> two tags that differ only in case could both exist, and the second one
> would be the one that wins.

**The name limit is 99 characters everywhere.** The source had 99 in the
command and 100 in the converter. The body of a tag keeps the source's
own limit of 1990 characters.

---

## The job events this area owns

Every delayed action is a row in the `jobs` table. **Never a
`setTimeout`, never a `setInterval`**: a timer dies with the process, and
a channel stays locked forever, a reminder never fires, or a message is
never deleted. The dispatcher deletes the row *before* it dispatches it,
which makes the handler idempotent under restarts.

| Event | When it is armed | The payload | What it does |
|---|---|---|---|
| `reminder` | `/reminder set` | `{ channelId, userId, message, reminderId, createdAt, sourceMessageId? }` | posts the reminder in the channel it was created in |
| `autopurge` | every message in an auto-purge channel | `{ channelId, messageId }` | deletes the message, unless it is pinned |
| `community_daily` | at startup, and re-armed by itself every day | `{}` | the daily housekeeping pass: prunes the snipes older than ten days, the tags that have never been used and are older than six months, and the command-usage rows older than thirty, and arms itself again for the next day |

The `user_id` column of the `jobs` row carries the member the reminder is
for, so `/reminder list` is an index lookup instead of the source's
`extra #>> '{args,0}'` scan of the whole table (S6, query 4).

> **Each event means one thing.** The `autopurge` event deletes a
> message, and nothing else; the daily sweep is the `community_daily`
> event. The **event name** says which work a row is — the payload does
> not carry a `kind` to tell two kinds of work apart. A reader of the
> `jobs` table does not have to know that `event='autopurge'` can mean
> two unrelated things.

> **The daily pass is a singleton, and it is a row.** Its row has a
> fixed id (`DAILY_JOB_ID`), so "there is exactly one daily row" is a
> fact about the primary key rather than a convention about deleting
> every row of an event. When the pass fires, it **deletes that row and
> writes a new one**, due in 24 hours. The row is the source of truth,
> so the next run survives a restart; there is no timer in this area.

> **One row to clean up by hand.** A row written by the old code is an
> `autopurge` row whose payload says `kind: "daily"`. It is not a
> message deletion, so the auto-purge handler drops it with a warning
> when it comes due. The `community_daily` row is armed at startup, so
> the sweep keeps running either way.

### The handler

```ts
export async function handleCommunityJob(
  client: Client,
  event: string,
  payload: unknown,
): Promise<void>;
```

The dispatcher calls it for every job; the area ignores the events it does
not own, quietly. `handleCommunityJobEvent` is the same function with a
`Promise<boolean>` answer, for a dispatcher that walks a list of areas and
stops at the first one that owns the event.

> The moderation area's handler answers `Promise<boolean>` and this one
> answers `Promise<void>`, because the brief for this area specifies that
> shape — and because the central registry in `handlers/listeners.ts`
> types the handlers as `Promise<void>`. A dispatcher that types them as
> `Promise<unknown>` (or that ignores the answer) takes both. See the area
> report.

### The daily pass, and the retention

The daily pass calls `pruneCommandUsage()` from `db/retention.ts` itself
(S10: the command-usage log keeps thirty days). `handleRetentionJob()` is
exported as well, so the manager can wire the prune to a cron of its own.
The prune is a delete, so running it twice deletes nothing the second
time.

The pass is armed by `ensureDailyJob()` at startup and re-armed by
`rearmDailyJob()` when it fires. Both write a **row** in the `jobs`
table — never a `setTimeout`, and never a `setInterval`. A daily sweep
that only runs until the next restart is not a daily sweep.

---

## The listeners

| Event | What it does |
|---|---|
| `messageDelete` | remembers the last deleted message of a channel, for `/snipe` |
| `messageCreate` | arms an `autopurge` job for a message in an auto-purge channel |
| `guildMemberAdd` | gives the new member the guild's auto-roles |
| `channelDelete` | takes the deleted channel off the auto-purge list |

The `client.on(...)` calls live in `listeners.ts` and nowhere else.

The auto-purge listener runs on **every** message, so it reads an
in-memory set of channel ids (`cache.ts`) rather than asking the database
about every message. The set is rebuilt from the database at startup and
updated by the commands that add or remove a channel.

---

## The public interface

| File | What it holds |
|---|---|
| `types.ts` | the domain types: `TagRecord`, `SnipeRecord`, `AutoPurgeConfig`, `AutoroleConfig`, `ReminderRecord`, `JobRecord` and the job payloads |
| `repo.ts` | **all** the SQL of this area |
| `rules.ts` | the pure rules: the tag name, the auto-purge admission, the reminder's time-and-text split, the tag body |
| `service.ts` | the state machine and the rules: the tags, the snipe, the auto-roles, the auto-purge, the reminders |
| `cache.ts` | the auto-purge channel cache |
| `jobs.ts` | the job handlers and the daily pass |
| `listeners.ts` | the four listeners |
| `commands/` | the command definitions |
| `views/` | the panels (`views/embeds.ts`), the lists (`views/lists.ts`), the empty states (`views/panels.ts`), the area's own button helper (`views/buttons.ts`), the reminder delivery and the reply helper (`views/reply.ts`) |
| `register.ts` | what the manager wires in |

### What the manager has to wire

**Nothing** — the central registry in `handlers/listeners.ts` finds the
area and wires it, because the names it looks for are the ones this
module exports:

| The registry looks for | This module exports |
|---|---|
| `registerCommunityInteractions()` | `registerCommunityInteractions()` |
| `registerCommunityListeners(client)` | `registerCommunityListeners(client)` |
| `handleCommunityJob(client, event, payload)` | `handleCommunityJob(client, event, payload)` |

The registry routes the `reminder`, `autopurge` and `community_daily`
events to this area, and the community area's `jobEvents` list says so.

`registerCommunityInteractions()` registers nothing: the paginator and the
confirm prompt register their own component ids when they are built. The
function exists so the manager has one stable wiring point for the area.

### The command-usage log

Every command invocation writes a row to `command_usage`. The dispatcher
does that, through the area's helper:

```ts
import { recordCommandUsage } from "./modules/community/register.js";

await recordCommandUsage({
  guildId, channelId, userId,
  cmd: interaction.commandName,   // the top-level name
  prefix: "",
  failed: false,
});
```

`cmd` is the **top-level** command name (`tag`, not `tag show`): the tag
statistics filter on `cmd = 'tag'`, and the qualified name is accepted as
well (`like 'tag %'`), so either convention works.

> **The dispatcher writes the log now.** It calls the area's helper
> after every invocation — on a success, on a guard refusal and on a
> thrown error — and a failure to log never fails the command; it is
> logged as a warning.
>
> The table has a thirty-day retention policy and the two composite
> indexes the statistics need (S10). The prune runs in the daily pass.

---

## The panels

Every panel the area shows is built with `core/ui.ts` — the bot's design
language. A panel has a **title**, a *short* description, the data in
**fields**, and a **footer** that says what to do next, so the
description does not have to shout it.

| Panel | Command | Title | The footer says |
|---|---|---|---|
| the deleted message | `/snipe` | "Deleted message" | "Sniped messages are kept for ten days." |
| the tag's statistics | `/tag info` | "Tag: `<name>`" | "Post it with `/tag show <name>`." |
| the auto-roles | `/autorole config` | "Auto-roles" | "Add a role with `/autorole humans` or `/autorole bots`." |
| the auto-purge channels | `/autopurge list` | "Auto-purge channels" | "Set a channel up with `/autopurge set`." |
| the guild's tag statistics | `/tag stats` | "Tag stats" | "These statistics are for this server only." |
| a member's tag statistics | `/tag stats <member>` | "Tag stats for `<name>`" | "These statistics are for this server only." |
| a reminder | the delivery | "Reminder" | "Delete it early with `/reminder delete`." |
| a list of tags | `/tag list`, `/tag mine`, `/tag search` | the paginator's title | the header above the list |
| a list of reminders | `/reminder list` | "Running reminders (n)" | the header above the list |

**A tag is a short thing, and the panel that shows a tag is a list.**
The list *is* the panel: a numbered row per tag, the name in bold and
the id in a code span, and the hint about what to do with the list above
it, because the paginator's own footer carries the page count.

**The area has no buttons of its own.** Every action here is a slash
command, so the footer is where the action is named. The one button the
area does show is the reminder's "Jump to original message" link, and a
link is grey: it takes the reader somewhere and changes nothing.

> **The link button is the area's own helper.** `core/ui.ts` has the
> button styles, and none of them is the *link* style, because a link
> button is the one button that cannot carry a custom id. The helper
> lives in `views/buttons.ts` until the core grows one.

---

## The error modes

A refusal is an answer, not a crash. The module raises the `DenialError`
family from `core/errors.ts` and the command adapter turns it into a
reply.

| Error | When | What the user sees |
|---|---|---|
| `InputError` | the input cannot be used | the refusal message |
| `OwnershipError` | the caller does not own the tag | "That tag does not belong to you." |
| `PremiumRequiredError` | the guild is past the free-tier allowance | the premium gate's message |
| anything else | a bug | the dispatcher's "Something went wrong" |

The refusals the module raises itself:

| Refusal | When |
|---|---|
| "That tag name is already taken." | the canonical name is taken |
| "That tag name starts with a reserved word." | the first word is a `/tag` subcommand |
| "This tag can only be used in NSFW channels." | an NSFW tag outside an NSFW channel |
| "The snipe is marked NSFW but the current channel isn't." | the same rule for a snipe |
| "**#channel** is already an auto-purge channel." | the channel is already configured |
| "You cannot set auto-purge in more than N channels on the free tier." | the free-tier allowance is used up |
| "You can have at most 25 tags in this server. Delete one with `/tag delete` before you make another." | the member's tag allowance is used up |
| "You can have at most 25 reminders running. Delete one with `/reminder delete` before you set another." | the member's reminder allowance is used up |
| "The owner of that tag is still in the server." | `/tag claim` on a tag whose owner is here |
| "That reminder is not one of yours, or it has already fired." | `/reminder delete` with somebody else's id |

> **An empty list is a panel, not a refusal.** A command that shows a
> list — `/tag list`, `/tag mine`, `/tag search`, `/reminder list`,
> `/autopurge list`, `/autorole config`, `/snipe` — answers with the
> **empty panel** from `core/ui.ts` when there is nothing to show, and
> the panel's footer says what to do next ("Create one with
> `/tag create`."). A new member meets that panel first, so it has to
> say what to do rather than only report the absence. A *refusal* —
> "that channel is not an auto-purge channel" — is not an empty state
> and stays a refusal.

---

## The bugs that were fixed rather than ported

### 1. The tag lookup was case-sensitive and the reserved-word check was not

`utility/functions.py:8-29` — `TagName.convert` lower-cased the name for
the validation and returned the **original** casing, and `TagConverter`
looked the tag up with an exact match.

**Now:** the name is canonical (trimmed, lower-cased) and that is what is
stored and looked up. The database's `UNIQUE (guild_id, name)` is then the
case-insensitive constraint.

### 2. The name limit was 99 in one place and 100 in another

`utility/__init__.py:335` refused a name of more than 99 characters and
`utility/functions.py:20` refused one of more than 100.

**Now:** 99, everywhere, in one constant (`TAG_NAME_MAX_LENGTH`).

### 3. An embed tag was posted twice

`utility/__init__.py:250-256` — the embed branch of the `tag` command did
not return, so the embed *and* the raw content were sent.

**Now:** the embed branch returns. An embed tag is posted once.

### 4. The embed template was a Python literal

`utility/__init__.py:251` re-parsed the stored column with
`ast.literal_eval` on every use, so any other code path that wrote the
column crashed the next render.

**Now:** the stored value is **JSON** (D32), parsed with `JSON.parse`
through `core/embed-builder.ts`. A template that does not parse is a
refusal ("This tag's embed template is broken…"), not a crash.

### 5. The auto-purge free-tier check ran before the "already configured" check

`utility/__init__.py:615-622` — the count of the guild's auto-purge
channels was checked first, so a free guild re-running the command on a
channel it had **already** configured was told it had reached the channel
limit — a message about a limit it had not reached, for a channel that was
already set up.

**Now:** the "already configured" answer comes first (`rules.ts`,
`checkAutoPurgeAdmission`).

### 6. `autorole config` crashed when the guild was not in the cache

`utility/__init__.py:184` — the model property `human_roles` called
`self._guild.get_role(x)` with `self._guild` being `bot.get_guild(...)`,
which is `None` for a guild the bot has not cached. `AttributeError`.

**Now:** the roles are resolved against the guild the command was run in,
and a role that no longer exists is shown as deleted instead of crashing
the command.

### 7. A dead auto-role failed every join

`cogs/events/cmds.py:92-117` — the listener removed the role from the
list when the grant raised `NotFound` or `Forbidden`, but a role that was
deleted while the bot was down was never removed, so the grant failed on
**every** join.

**Now:** the listener drops the role ids that no longer exist before it
grants anything, and drops any role the bot cannot give. The list heals
itself.

### 8. The snipes were pruned once, at startup

`utility/events/autopurge.py:21-25` — `delete_older_snipes` was a
one-shot task in the cog's constructor, not a loop. Old rows accumulated
for weeks.

**Now:** the prune is a **daily job** (`community_daily`), and it is
durable: the row is in the `jobs` table, so the prune happens after a
restart too.

### 9. `reminder all` said "the 10 latest" and showed everything

`utility/__init__.py:79-85` — the query ordered by expiry **ascending**
with **no limit**, so the paginator showed every running reminder, soonest
first, while the docstring promised "the 10 latest currently running
reminders".

**Now:** the reminders are ordered **descending** (the latest first) and
**limited to ten**, and the reply says what it is ("Your running
reminders (12)"). The count is the real number of running reminders, not
the number that fitted on a page.

### 10. The guild's tag statistics counted three tags as three tags

`utility/functions.py:73-79` — the description said
`f"{len(records)} tags, {sum(t.usage for t in records)} tag uses"` where
`records` was the **top three** rows, so a guild with thirty tags was
told it had three.

**Now:** the totals are counted over every tag of the guild, and the top
three are listed underneath them.

---

## Deliberate differences from Quotient

| Difference | Why |
|---|---|
| The tag name is stored lower-cased | the schema's unique constraint has to *be* the case-insensitive constraint. See "the case-sensitivity decision" above. |
| The daily sweep is the `community_daily` event, not a kind of `autopurge` | Quotient had no daily sweep — it pruned the snipes once at startup. A daily maintenance sweep is not an auto-purge, and a reader of the `jobs` table should not have to know that one event name can mean two unrelated things. |
| An embed tag is created with `/tag create … embed:true` and a JSON body | the source could only make one by writing to the database by hand; the `make` command was commented out. The subcommand list did not grow — the option did. |
| The auto-purge delay uses `core/time.ts`'s `parseDuration` | the source's `simple_convert` understood `s\|m\|h\|d`; the port understands the same units and weeks as well. The bounds are the source's: more than five seconds, at most seven days. |
| The auto-role toggle is decided by the database | the source read the row, chose `ARRAY_APPEND` or `ARRAY_REMOVE` and wrote it back — a read-modify-write that races two moderators clicking at once. The roles are a join table now, and the toggle is an insert that conflicts or a delete that does not: no read, so no window. |
| The reminder is posted in the channel it was created in | as in the source. It is not a DM: a DM is a private inbox the user may not be looking at. When the channel is gone, the reminder is dropped and the drop is logged. |
| The snipe names the author instead of mentioning them | the source used the author's name. A mention would ping somebody for a message they deleted. |
| A reply in this area cannot notify anybody | a tag's body is member text posted as message content. Without the rule, a member could store `@everyone` in a tag and have the bot ping the whole server — a permission the member does not have and the bot does. |
| A member may own 25 tags and have 25 reminders running | nothing removed either row by itself, so both tables grew for ever. The numbers are the area's own limits, in `rules.ts`; the free tier is about what a *guild* may configure. |
| An unused tag is pruned after 180 days | the allowance bounds how many tags a member may have *at once*; the prune bounds how many the table keeps over the months. A tag that has been used or edited is never touched. |
| `/reminder delete` exists | without a way to delete a reminder, the allowance would have been a trap: a reminder's row only goes away when it fires. |
| The usage log is written by the dispatcher, not by the commands | the log is a property of the dispatcher. The area provides the helper. |

---

## Tests

```bash
npm test
```

| File | What it proves |
|---|---|
| `rules.test.ts` | the tag name normalisation and the reserved-word check, the auto-purge admission **order**, the member allowance, the reminder's time-and-text split, the NSFW rule, the stale roles |
| `embed-tag.test.ts` | the embed-tag render path, and that a malformed stored template is a refusal and not a crash |
| `mentions.test.ts` | that **no reply in this area can notify anybody**: a tag whose body is `@everyone` is escaped and its reply allows no mentions, a reminder's text is escaped, and the reminder's delivery mentions only the member it is for |
| `quota.test.ts` | the member allowances, against the live database: the tag past the allowance is refused, the reminder past the allowance is refused, and a member at the allowance can still delete their own tag and their own reminder |
| `retention.test.ts` | the retention, against the live database: an unused tag is pruned, a used or recently edited tag is kept, and a fired reminder leaves no row behind |
| `stats.test.ts` | the usage-log statistics, against the live database |
| `tags.test.ts` | the tag storage rules against the live database: the canonical name, the case-insensitive lookup, the unique constraint, the usage counter, the ownership rules |
| `repo.test.ts` | the statements that are not plain reads, against the live database: the atomic auto-role toggle and the races it survives, the case-insensitive tag search, the atomic usage counter, the snipe upsert, the job rows |
| `jobs.test.ts` | the job payloads, that each event means one thing, and that the daily row is **a row in the `jobs` table** — armed at startup, re-armed by itself, and never a timer |

The database-backed tests run against a SQLite database the test runner
creates for them, so they need no server and no setup.
