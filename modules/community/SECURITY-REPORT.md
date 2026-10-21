# Security review — Area E (community): what changed

The three findings from the independent review, what I did about each, and
what I need from the manager. Everything here is in `modules/community/` and
`commands/community/`; I touched no file in `core/`, `db/`, `handlers/`,
`types/`, `config/`, `utils/`, `repo/`, `scripts/`, `main.ts` or
`deploy.ts`.

---

## 1. The ping fix (Finding 1 — MEDIUM)

### What was wrong

`/tag show` posted the tag's body as message **content**, and the reply
carried no `allowed_mentions`. Any member could store `@everyone` in a tag
and have the bot — which holds "Mention Everyone" — ping the whole server.

### What I did: **both** halves, not either

The audit said either would do. I did both, because each covers the other's
gap:

**1. The reply allows no mentions.** Every reply in the area now goes
through `modules/community/views/reply.ts`:

```ts
export async function respondSafe(interaction, payload, mentions = {}) {
  const allowedMentions: MessageMentionOptions = {
    parse: [],
    ...(mentions.users?.length ? { users: [...mentions.users] } : {}),
    ...(mentions.roles?.length ? { roles: [...mentions.roles] } : {}),
  };
  return respond(interaction, { ...payload, allowedMentions });
}
```

`parse: []` is Discord's "do not parse any mention out of this content". A
reply that *means* to mention somebody passes that id explicitly:
`/tag transfer` names the new owner (`users: [member.id]`), `/autorole` names
the role (`roles: [role.id]`).

**2. The user content is escaped.** `core/escape.ts`'s `escapeMentions` is
applied to:

| Where | What is escaped |
|---|---|
| `/tag show` | the tag body (the markdown is left alone — a tag is a canned message and its formatting is the point of it) |
| `/tag create`, `/tag delete` | the tag's name in the confirmation |
| `/tag transfer` | the name in the confirmation |
| `/tag purge` | the member's name in the confirmation |
| `/reminder set` | the reminder's own text in the confirmation |

**Why both.** `escapeMentions` follows discord.py and is **case-sensitive**:
`@everyone` becomes `@\u200beveryone`, but `@Everyone` is left alone.
Discord only pings the lower-case forms, so that is not a hole by itself —
but it is exactly the kind of gap that the `parse: []` default closes, and
the two together mean neither has to be perfect.

### Where the default now lives

**In my area: `modules/community/views/reply.ts`.** It is the area's own copy
of the rule, so the area is safe whether or not the core default has landed.

**It belongs in `core/`** — every area that posts user content has this
problem, not this one. The cheapest global fix is one line in `main.ts`:

```ts
new Client({ allowedMentions: { parse: [] } })
```

discord.js uses the client's default for any message that does not say
otherwise (`MessagePayload.js`: `this.options.allowedMentions ?? this.target.client.options.allowedMentions`),
so that covers `interaction.reply`, `channel.send` and the rest in one go.

The alternative is `core/context.ts`: `ReplyPayload` gains an optional
`allowedMentions`, and `respond` defaults it to `{ parse: [] }`. I need
**both** if you want the other areas to be safe: `main.ts` covers the paths
that do not go through `respond` (`channel.send`), and `core/context.ts`
covers the paths that do.

> **What a global default breaks.** A `parse: []` default stops the
> *deliberate* mentions too. These need an explicit allow-list when you
> turn it on — I have already done the two in my area:
>
> | File | The mention |
> |---|---|
> | `modules/identity/commands/easytag.ts:162` | `<@&${ignoreRoleId}>` — the "add this role to be ignored" hint |
> | `modules/identity/commands/tagcheck.ts:177` | the same |
> | `modules/moderation/views/role-revert.ts:205` | `role.toString()` — the role that was reverted |
> | `modules/tourneys/commands/idp.ts:118` | already has its own `allowedMentions` ✓ |
> | `modules/scrims/views/lifecycle.ts:190`, `modules/tourneys/views/lifecycle.ts:187` | already have their own ✓ |

### The other user content in the area

The audit asked me to look for the rest of it. Everything in the area that
posts user content as **message content** is now escaped and covered by
`allowedMentions`:

| Path | Why it is safe |
|---|---|
| `/snipe` | the deleted message goes into an **embed** — embeds cannot notify |
| `/tag show` (embed tag) | `embedTemplateToBuilder` — an embed |
| `/tag list`, `/tag mine`, `/tag search`, `/tag stats`, `/tag info` | embeds (the paginator renders its pages as embeds) |
| `/reminder list` | a paginator — an embed |
| `/autopurge list`, `/autorole config` | embeds |
| the refusals (`replyError`) | an embed — the tag name in "**x** is not a valid tag name" is rendered, not notified |
| `/reminder` **delivery** | the text is in an embed; the one deliberate mention (`<@userId>`) now has `allowedMentions: { parse: [], users: [userId] }` on the `channel.send` |

### Other areas — not mine, but you asked

The same vector exists outside my area. I did not touch these:

| File | What is posted as content | Who supplies it |
|---|---|---|
| `modules/scrims/commands/reserve.ts:114` | `` `Slot ${num} has been reserved for \`${teamName}\`` `` | **a member** — the team name comes from the member's registration message. This is the same hole as the tag was. |
| `handlers/modals.ts:57,70` | `` `**${submission.email}** has already been verified` `` | **a member** — the email. An email's local part may contain `@everyone` (`@everyone@example.com` is a legal address). |
| `modules/tourneys/commands/lifecycle.ts:97,114`, `modules/tourneys/commands/slotm.ts:121` | the tourney's name | a moderator — no escalation, but the bot's "Mention Everyone" is still used on it |
| `modules/moderation/commands/{lock,unlock,category,maintenance}.ts` | channel, category and role names | a moderator; a role name cannot be `@everyone` (Discord reserves it) |

---

## 2. The unbounded rows (Finding 2 — MEDIUM)

### The caps

| Allowance | Number | Counted over | Enforced in |
|---|---|---|---|
| Tags a member may own | **25** | one guild | `service.createTag` |
| Reminders a member may have running | **25** | every guild | `service.createReminder` |

**Where the numbers live.** `modules/community/rules.ts`, next to the area's
own limits (`TAG_NAME_MAX_LENGTH`, `TAG_CONTENT_MAX_LENGTH`):
`MAX_TAGS_PER_MEMBER` and `MAX_REMINDERS_PER_MEMBER`. They are **not**
free-tier limits: `FREE_TIER` is about what a *guild* may configure, and
these are about what a *member* may leave lying behind.

**The rule is a pure function**, the same shape as the auto-purge admission
(`checkAutoPurgeAdmission`): `checkMemberQuota({ subject, currentCount, limit })`
returns `{ allowed, refusal, message }`. The refusal is a
`LimitExceededError` (the area's existing "kind" for a count limit), and it
says how to get out of it:

> You can have at most 25 tags in this server. Delete one with `/tag delete`
> before you make another.

**Why 25.** A tag is a canned message: twenty-five in one server is more
than a server uses, and the tag namespace is per guild, so the allowance is
per guild. A reminder is a row in `jobs`, the table the dispatcher polls
every fifteen seconds; twenty-five running reminders is more than anybody
needs at once, and the allowance empties itself — the dispatcher deletes a
reminder's row when it fires.

**The allowance is never a trap.** `/tag delete` already existed for the
caller's own tags. Reminders had **no** delete path, so a member at the
allowance could do nothing about it — their reminders would have to fire
first. I added **`/reminder delete`** (one subcommand, `id` optional):

- with an `id`: deletes that one reminder, and refuses if it is not the
  caller's (`"That reminder is not one of yours, or it has already fired."`);
- without one: deletes all of the caller's running reminders.

That is the only new command surface in this change. The delete is
conditional on the row being the member's, so nobody can delete somebody
else's reminder by guessing an id.

### The retention

| What | How long it is kept | Who prunes it |
|---|---|---|
| A reminder | until it fires | the dispatcher, which **deletes the row before it dispatches it** (`handlers/jobs.ts:110-113`) |
| A tag that has been used | for ever | — the usage counter bumps `updated_at` |
| A tag that has never been used | **180 days** | the daily pass (`community_daily`) |
| A snipe | 10 days | the daily pass (already there) |
| A command-usage row | 30 days | `db/retention.ts` (already there) |

The tag prune is new: `repo.deleteUnusedTags(cutoff)` deletes the tags with
`usage = 0` whose `updated_at` is older than the cutoff, and
`onCommunityDaily` calls it next to the snipe prune. A tag that has been
*edited* also keeps its row — the edit bumps `updated_at` — so what goes is
only the tag somebody made once and forgot about.

**180 days is deliberately long.** A tag is somebody's text, and the price of
keeping it a little longer is far lower than the price of deleting a guild's
rules by surprise. The number is in `jobs.ts` next to `SNIPE_RETENTION_DAYS`
— say the word and I will change it.

**Reminder rows do not need a prune.** The dispatcher claims a job by
deleting its row and only then hands the payload to the handler, so a
reminder that has fired leaves nothing behind, and a row that is overdue
fires (late) the moment the bot is back. A prune of overdue reminders would
*delete* reminders instead of delivering them, which is worse than the leak
it was meant to fix. `retention.test.ts` pins the invariant down.

### What I need from `db/`

**One index, and it is a recommendation rather than a blocker:**

```sql
-- tags
CREATE INDEX tags_guild_id_owner_id_idx ON tags (guild_id, owner_id);
```

The member's tag count runs on every `/tag create`, and without the index
it is a sequential scan of the whole `tags` table — every guild's tags, not
just this one. The table is bounded now (25 a member), so the scan is short,
but it is on the hot path of a command anybody may run. The `jobs` table
already has `jobs_user_id_idx`, so the reminder count is an index lookup.

**Nothing else.** In particular:

- **I do not need a `pruneExpiredReminders` in `db/retention.ts`.** The
  reminder rows are removed by the dispatcher (see above), and a prune would
  delete reminders that have not fired yet.
- **I do not need a tag prune in `db/`.** The area already prunes its own
  tables — `pruneSnipes` is `repo.deleteSnipesOlderThan` in
  `modules/community/repo.ts` — so the tag prune follows the same shape and
  needs no schema change. `tags.updated_at` and `tags.usage` are already
  there.
- **`premium_transactions` and `ss_submissions` still have no retention**,
  and neither is my table. They are in your list; I am just saying I have
  not touched them.

If you would rather the prunes lived in `db/retention.ts` next to
`pruneCommandUsage`, say so and I will move the call — the function itself
can stay in the community area's `repo.ts`, because the area's own tables
are the area's own SQL.

---

## 3. The button flows (Finding 3 — LOW/MEDIUM)

**The global limiter is enough for my area. No area-specific limit is
needed.**

The limiter you have added — ten per ten seconds per member — covers the
area's three panel flows:

| Flow | What a press does | Why the global limit is enough |
|---|---|---|
| the paginator (the tag list, a member's tags, the tag search, the reminder list) | one database read and one edit of the same message | the paginator is **stateless** — a press is a read and a re-render, and Discord rate-limits edits to one message anyway. Ten reads per ten seconds is nothing. |
| the prompt (`/autorole off`) | turns the auto-roles off | it is **owner-only** (`core/prompt.ts` filters by the user's id) and one press ends the flow. |

A tighter area-specific limit would also have nowhere to live: the paginator
is `core/paginator.ts`, which five areas share, and a limit that is right for
the tag list is not obviously right for a tournament's slot list. If you
want one anyway, the honest place is the **component router**
(`core/router.ts`), not the area.

---

## 4. The tests

| File | What it proves |
|---|---|
| `modules/community/mentions.test.ts` (new, 6 tests) | **a tag containing `@everyone` does not notify when shown** — the reply's `allowed_mentions.parse` is empty *and* the body is escaped (`"Hey @\u200beveryone, welcome to the server!"`, and the content does not contain `@everyone`); the same for a `<@id>` body; the tag's own markdown survives; the tag's *name* does not notify in the confirmation; **a reminder whose text contains `@everyone` does not notify**; and the reminder's delivery mentions only the member it is for. It drives the real commands with a fake interaction and reads the payload that was sent. It needs no database and no environment — the service and the repository are mocked. |
| `modules/community/quota.test.ts` (new, 8 tests) | the (N+1)th **tag** is refused with a clear message; the (N+1)th **reminder** is refused with a clear message; the allowance counts only the member's own rows; **a member at the allowance can still delete their own tag** (and make another afterwards) and **their own reminder** (and set another afterwards); a member cannot delete somebody else's reminder; a mistyped id is a refusal and not a database error. |
| `modules/community/retention.test.ts` (new, 4 tests) | an unused tag that has not been touched is pruned; a tag that has been used is kept; a tag that has been edited lately is kept; a fired reminder leaves no row behind. |
| `modules/community/rules.test.ts` (grown) | `checkMemberQuota`: under the allowance is allowed, at it is refused, the refusal says how to make room, and the two numbers are pinned at 25. |

The database-backed files run against a SQLite database the test runner
creates for them, so they need no server and no setup.

**Status of my files:** `npm run typecheck` is clean for `modules/community/`
and `commands/community/`; `npm test` is green for the area — **9 files, 119
tests** (it was 6 files and 88 tests). The whole repository typechecks and
the whole test suite is green at the time of writing (82 files, 1199 tests).

---

## 5. What is left for the manager

1. **`allowedMentions: { parse: [] }` as a global default** — one line in
   `main.ts` (`new Client({ allowedMentions: { parse: [] } })`), or in
   `core/context.ts`'s `respond` with an optional override on
   `ReplyPayload`. Both, to cover `channel.send` and `respond` alike. The
   deliberate mentions that need an explicit allow-list are listed in §1.
2. **The `tags (guild_id, owner_id)` index** — recommended, not a blocker.
3. **The scrims and identity content mentions** — the same hole as the tag
   was, in `modules/scrims/commands/reserve.ts:114` and
   `handlers/modals.ts:57,70`. Both are member-supplied. They are not my
   files, so I have not touched them.
4. **A re-deploy of the commands** — `/reminder delete` is a new subcommand.
