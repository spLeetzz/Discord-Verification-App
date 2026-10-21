# Area E — Community: port report

The port of Quotient's `utility` cog, `utility/events/`, `utility/functions.py`
and the `reminder` cog: tags, snipe, auto-roles, auto-purge, reminders, the
durable job scheduler's consumers, and the command-usage log.

**Status: complete.** `npm run typecheck` is clean for my files, `npm test` is
green for my files (9 files, 111 tests), and `npm run smoke` is still 106/106.
The whole repository typechecks. At the time of writing, two tests in
`modules/tourneys/` fail; that area is in flight, and the failures are not
mine and are not in my files.

**Since the first version of this report:** the daily pass moved off the
`autopurge` event onto its own `community_daily` event, the payload
discriminator went with it, and the daily row became a singleton with a
fixed id. See §2.

**Since the security review:** no reply in this area can notify anybody
(`views/reply.ts` and the escaping on the tag and reminder paths), a member
may own 25 tags and have 25 reminders running, an unused tag is pruned after
180 days, and `/reminder delete` exists so the allowance is never a trap. See
`SECURITY-REPORT.md`.

---

## 1. The command surface

Five top-level commands, twenty-three subcommands. **Public** by default (D43) —
none of them sets `ephemeral`, and the dispatcher honours the flag.

| Command | Subcommand | Options | Permission |
|---|---|---|---|
| `/tag` | `show` | `name` | — |
| | `raw` | `name` | — |
| | `list` | `member` (optional) | — |
| | `info` | `name` | — |
| | `claim` | `name` | — |
| | `create` | `name`, `content`, `embed` (bool, optional) | — |
| | `delete` | `name` | owner, or Manage Server |
| | `transfer` | `name`, `member` | owner |
| | `nsfw` | `name` | owner, or Manage Server |
| | `mine` | — | — |
| | `purge` | `member` | Manage Server |
| | `edit` | `name`, `content`, `embed` (bool, optional) | owner, or Manage Server |
| | `search` | `query` | — |
| | `stats` | `member` (optional) | — |
| `/snipe` | — | `channel` (optional) | — |
| `/autorole` | `humans` / `bots` | `role` | Manage Server (+ the bot needs Manage Roles) |
| | `config` / `off` | — | Manage Server |
| `/autopurge` | `set` | `channel`, `delete_after` | Manage Messages (+ the bot needs Manage Messages in the channel) |
| | `list` / `remove` | `channel` (remove only) | Manage Messages |
| `/reminder` | `set` | `when`, `text` (optional) | — |
| | `list` | — | — |
| | `delete` | `id` (optional) | — |

`/reminder delete` is the one subcommand the port did not have: without a way
to delete a reminder, the member's allowance of running reminders would have
been a trap, because a reminder's row only goes away when it fires. With an
id it deletes that one reminder; without one it deletes all of them. See
`SECURITY-REPORT.md`.

**Deviation from the brief, forced by the loader:** the brief said
`commands/community.ts`, one file. `handlers/commands.ts` does
`readdirSync(commands/)` and then `readdirSync()` on **each entry** — a file
there makes it throw `ENOTDIR` and takes down the whole loader, for every
area. `deploy.ts` skips non-directories, so only the loader breaks, but it
breaks everything. The area therefore owns **`commands/community/`** with one
one-line re-export per top-level command (`tag.ts`, `snipe.ts`, `autorole.ts`,
`autopurge.ts`, `reminder.ts`), which is the shape wave-3 §"Commands"
prescribes and the shape the loader and the deploy script both scan. The
manager hardened the loader in `5441939` ("skips anything under commands/ that
is not a directory") — which makes a `commands/community.ts` file *ignored*
rather than fatal, but the folder is still what the rest of the port uses.

Two options were added to `/tag create` and `/tag edit` that the source did
not have, and no subcommand was added: `embed` (boolean) says the body is a
JSON embed template. The source could only make an embed tag by writing to
the database by hand — its `make` command was commented out — so without the
option the embed render path could never be reached. On `/tag edit` the
option is left out to keep the tag's current kind, so editing an embed tag's
JSON does not quietly turn it into a text tag.

---

## 2. The job events I own and their payloads

Everything delayed is a **row in `jobs`**, never a `setTimeout`. The
dispatcher deletes the row before it dispatches it, so a handler that fires
twice cannot do its work twice.

| Event | Armed by | Payload | What it does |
|---|---|---|---|
| `reminder` | `/reminder set` | `{ channelId, userId, message, reminderId, createdAt, sourceMessageId? }` | posts the reminder in the channel it was created in |
| `autopurge` | every message in an auto-purge channel | `{ channelId, messageId }` | deletes the message, unless it is pinned |
| `community_daily` | at startup, re-armed by itself every day | `{}` | the daily pass: prunes the snipes older than 10 days and the command-usage rows older than 30, and arms itself again for the next day |

`jobs.user_id` carries the member the reminder is for, so `/reminder list` is
an index lookup instead of the source's `extra #>> '{args,0}'` scan of the
whole table (S6, query 4). The reminder's own id and creation time travel in
the payload, because the dispatcher hands the handler the payload and nothing
else — that is what lets the embed say "Reminder #\<id\>" and match the id
`/reminder list` shows.

**Each event means one thing.** The `autopurge` event deletes a message and
nothing else; the daily sweep is the `community_daily` event. The event name
says which work a row is, so the payload carries no `kind` to tell two kinds
of work apart. (The payload discriminator existed only because the daily
pass rode on `autopurge`; it is gone.)

**The daily pass is a singleton, and it is a row.** Its row has a fixed id
(`DAILY_JOB_ID`), so "there is exactly one daily row" is a fact about the
primary key rather than a convention about deleting every row of an event.
When the pass fires it **deletes that row and writes a new one**, due in 24
hours — `repo.deleteJob(DAILY_JOB_ID)` then `repo.insertJob({ id:
DAILY_JOB_ID, event: "community_daily" })`. There is no `setTimeout` and no
`setInterval` anywhere in this area: the row in the `jobs` table is the
source of truth, so the next run survives a restart. A daily sweep that only
runs until the next restart is not a daily sweep.

> The fixed id also removed a race between this area's own test files: the
> old "delete every daily row" query was global, so the `jobs` test's re-arm
> could delete the `repo` test's fixture row (or the other way round) and
> fail the run. Scoping the queries by the id made both files independent.

The handler:

```ts
export async function handleCommunityJob(client: Client, event: string, payload: unknown): Promise<void>
```

exactly as the brief specifies, and exactly what the central registry in
`handlers/listeners.ts` looks for (`handle${area.job}Job`). The moderation
area's handler answers `Promise<boolean>` instead; `handleCommunityJobEvent`
is the same function with that answer, for a dispatcher that wants it. The
registry types the handlers as `Promise<void>`, so the brief's shape is the
one that fits.

---

## 3. The tag name rules and the case-sensitivity decision

The rules, in order: **trimmed** → **lower-cased** (the *canonical* form) →
not empty → at most **99** characters → the **first space-separated word** is
not one of the fourteen `/tag` subcommands (`show`, `raw`, `list`, `info`,
`claim`, `create`, `delete`, `transfer`, `nsfw`, `mine`, `purge`, `edit`,
`search`, `stats`). `"raw stuff"` is refused, `"rawstuff"` is allowed — the
source's rule, kept.

### The decision: case-insensitive, and the canonical name is what is stored

**Tag names are case-insensitive, and the lower-cased name is the only form
stored.**

The source's `TagName` converter lower-cased the name for the reserved-word
check and returned the **original** casing, and `TagConverter` looked the tag
up with an exact match. So `/tag Rules` and `/tag rules` were two different
tags while the reserved-word check treated `Raw` and `raw` as the same word.

Storing the canonical name makes the schema's existing constraint *be* the
case-insensitive constraint:

```sql
UNIQUE (guild_id, name)
```

`Rules` and `rules` are both stored as `rules`, so the constraint refuses the
second one. The alternative — keep the display casing and look up with
`lower(name) = lower($1)` — leaves the constraint case-*sensitive* while the
lookup is case-insensitive, so two tags differing only in case could both
exist: the read-then-write race the whole schema programme exists to remove,
back again.

**The cost:** the display name is lower-case. A tag called `Rules` shows as
`rules`. The only way to have both is a `normalized_name` column beside the
display name, which is a schema change in a file this area does not own. It
was requested in §6 and **declined** by the manager: the trade was made —
a lower-cased display name for a constraint that cannot race. The trade-off
is written down in the area README so that nobody "fixes" the display casing
later and silently reintroduces the read-then-write race.

**The name limit is 99 everywhere** (the source had 99 in the command and 100
in the converter). The tag *body* keeps the source's 1990.

A tag can also be called by its **id** (the source's converter tried
`int(argument)` first); our ids are uuids, so that is what "by its id" looks
like now.

---

## 4. The premium gates

One gate, one place: `assertEntitled(guildId, feature)` from
`modules/premium/`. The premium module has landed, so this is coded against
the real thing, not a signature.

**The auto-purge allowance** is the only premium interaction in the area.
Quotient's rule was `count >= 1 and not ctx.is_premium_guild()`: the free
tier allows **one** auto-purge channel and premium lifts the limit. That is a
**count** limit, not a boolean feature (D45), so:

- the entitlement that lifts it is `PremiumFeature.extraChannels` — the
  "more channels" entitlement, the closest one in the closed union;
- the allowance itself is read from `FREE_TIER.autopurgeChannels` in
  `modules/premium/limits.ts` — never hard-coded;
- the check runs through `assertEntitled` (in a `try`/`catch` on
  `PremiumRequiredError`), so the entitlement is read in exactly one place
  and the expiry rule is not re-implemented.

`assertEntitled` throws rather than returning a boolean, and the count gate
needs a boolean ("is the limit lifted?"), so the boolean is taken from the
gate's own refusal. `isEntitled` — the boolean sibling in the same module —
would read more directly if the manager prefers that form; the behaviour is
identical because `assertEntitled` is implemented as `findEntitlement` plus
`isEntitlementActive`.

No other community feature is premium-gated, exactly as in the source: tags,
snipe, auto-roles and reminders are free, and D45 records that the
auto-purge channel count is the **only** free-tier cap the source actually
enforced.

---

## 5. The source bugs I fixed rather than ported

1. **The tag lookup was case-sensitive while the reserved-word check was
   not** — the name is canonical now, and the database's unique constraint
   enforces it.
2. **The name limit was 99 in the command and 100 in the converter** — 99
   everywhere, in one constant.
3. **An embed tag was posted twice** — the embed branch did not return, so
   the embed *and* the raw content were sent; it returns now.
4. **The embed template was a Python literal** re-parsed with
   `ast.literal_eval` on every use — it is JSON now (D32), parsed with
   `JSON.parse`, and a template that does not parse is a **refusal**
   ("This tag's embed template is broken…"), not a crash.
5. **The auto-purge free-tier check ran before the "already configured"
   check** — a free guild re-running the command on a channel it had already
   configured was told it had reached the channel limit; "already
   configured" comes first now.
6. **`autorole config` crashed when the guild was not in the cache** — it
   called `list(None)` on a role list that needed a guild; the roles are
   resolved against the guild the command ran in, and a role that no longer
   exists shows as deleted.
7. **A dead auto-role failed every join** — a role deleted while the bot was
   down was never dropped from the list, so the grant failed on every join;
   the listener drops the ids that no longer exist (and any role the bot
   cannot give) before it grants.
8. **The snipes were pruned once, at startup** — a one-shot task, not a
   loop, so the rows accumulated for weeks; the prune is a **daily job** now.
9. **`reminder all` said "the 10 latest" and showed everything** — it
   ordered by expiry *ascending* with *no limit*; it is descending, limited
   to ten, and says what it is ("Your running reminders (12)").
10. **The guild's tag statistics counted three tags as three tags** — the
    description used the top-three rows for both the count and the sum; the
    totals are counted over every tag now.
11. **The auto-role toggle was a read-modify-write** — the source read the
    row, chose `ARRAY_APPEND` or `ARRAY_REMOVE` and wrote it back; it is one
    `INSERT … ON CONFLICT DO UPDATE` statement now, so two moderators
    clicking at once cannot lose a role.
12. **The tag usage counter was a read-then-write** — it is an atomic
    `UPDATE tags SET usage = usage + 1` (S6, query 6).

**Preserved deliberately:** the NSFW rule for a snipe (an NSFW-channel snipe
is not shown in a non-NSFW channel); the reminder is delivered to the channel
it was created in, not by DM (a dropped reminder is logged, not shown); a
pinned message is never auto-purged; the auto-purge delay bounds (more than
five seconds, at most seven days); the source's `manage_guild` requirement
on the auto-role commands and `manage_messages` on the auto-purge ones.

**One thing I did not change:** a text tag's body is posted as it is stored,
so a tag may contain a mention. The source did the same, and Discord does
not let a bot ping `@everyone` or `@here`, so the abuse vector is small. It
is recorded here rather than silently changed.

---

## 6. What the manager has to do (a queue, not a blocker)

**The queue is empty.** All three items are settled:

1. **Write the command-usage row — done.** The dispatcher calls
   `recordCommandUsage` after every invocation: on a success, on a guard
   refusal and on a thrown error. A failure to log never fails the command.
   `cmd` is the top-level command name, which is what the tag statistics
   count.
2. **A `community_daily` job event — done.** The name is in `JOB_EVENTS` in
   `db/schema/common.ts` (with the migration applied), and the community
   area's `jobEvents` in `handlers/listeners.ts` lists it. The daily pass
   has an event of its own now, and the payload discriminator that used to
   tell it apart from a message deletion is gone.
3. **A `tags.normalized_name` column — declined.** The lower-cased display
   name is the accepted trade: the schema's `UNIQUE (guild_id, name)` *is*
   the case-insensitive constraint, with no read-then-write race. The
   trade-off is written down in the area README so nobody "fixes" the
   display casing later and reintroduces the race.
4. **Nothing else.** The central registry already finds the area: the names
   it looks for (`registerCommunityInteractions`, `registerCommunityListeners`,
   `handleCommunityJob`) are the ones `modules/community/register.ts`
   exports, and the `reminder`, `autopurge` and `community_daily` events
   are routed to it.

---

## 7. The tests

| File | What it pins down |
|---|---|
| `rules.test.ts` | the tag name normalisation and the reserved-word check; the auto-purge admission **order** ("already configured" beats "limit reached"); the member allowance; the reminder's time-and-text split; the NSFW rule; the stale roles |
| `embed-tag.test.ts` | the embed-tag render path, and that a malformed stored template is a refusal and not a crash |
| `mentions.test.ts` | that **no reply in this area can notify anybody**: a tag whose body is `@everyone` is escaped and its reply allows no mentions; the reminder's text is escaped; the reminder's delivery mentions only the member it is for |
| `quota.test.ts` | the member allowances against the live database: the tag past the allowance is refused, the reminder past the allowance is refused, and a member at the allowance can still delete their own tag and their own reminder |
| `retention.test.ts` | the retention against the live database: an unused tag is pruned, a used or recently edited tag is kept, and a fired reminder leaves no row behind |
| `stats.test.ts` | the usage-log statistics, against the live database: the per-member counts, the per-owner counts, the window-function totals, the atomic counter |
| `tags.test.ts` | the tag storage rules against the live database: the canonical name, the case-insensitive lookup, the unique constraint refusing a name that differs only in case, the ownership rules |
| `repo.test.ts` | the hand-written SQL against the live database: the atomic auto-role toggle, the snipe upsert, the job rows |
| `jobs.test.ts` | the job payloads; that each event means one thing; that the daily row is **a row in the `jobs` table**, armed at startup and re-armed by itself, and never a timer |

The database-backed areas use ids no real row can have and clean up after
themselves. `repo.test.ts` **caught a real bug in my own SQL**: the
`ON CONFLICT DO UPDATE` clause needed the column qualified with the table
name, because an unqualified name is ambiguous between the row being updated
and the row being inserted (`column reference "humans" is ambiguous`).

`mentions.test.ts` and `quota.test.ts` need no environment: the service and
the repository are mocked, so the "does not notify" proof runs on a machine
without Postgres.

---

## 8. What is left unfinished

**Nothing in the brief.** Every item is implemented, tested and documented:
the durable job scheduler's consumers, tags (including the embed path, the
raw path and the statistics), snipe, auto-role, auto-purge, reminders, the
command-usage log with its retention, and the five command groups. The
queue in §6 is empty.
