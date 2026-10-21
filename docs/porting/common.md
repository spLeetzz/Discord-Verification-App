# Port decisions — ratified after wave 1 inventory

Manager decisions. These are **not** open questions any more. If an engineer
thinks one is wrong, argue in the ticket — do not deviate silently.

Sources: inventory of the slot-manager area and the identity/tagcheck/ssverify/
group-management area. Other areas' inventories may add to this file; it is the
single place to look for "how do we do X".

---

## D12. Table names: clean, no schema prefixes

Quotient's Tortoise models declare table names like `sm.scrims`,
`sm.assigned_slots`, `tm.tourney` — Postgres **schema** prefixes, an artifact
of Tortoise's schema-per-model-group feature. One inventory recommended
keeping them verbatim so the ported raw SQL keeps working.

**Rejected.** We are not running Quotient against its own database, and we are
replacing every raw-SQL statement with typed queries anyway — the "raw SQL
keeps working" argument evaporates on contact with the rewrite. Carrying a
`sm.` prefix into a fresh schema buys nothing and costs a lifetime of
`PUBLIC."sm.scrims"` quoting.

**New names** (singular where the row is one thing):

| Quotient | Ours |
|---|---|
| `sm.scrims` | `scrims` |
| `sm.assigned_slots` | `slots` (see D14) |
| `sm.banned_teams` | `banned_teams` |
| `sm.reserved_slots` | `reserved_slots` |
| `sm.scrims_sm.assigned_slots` (M2M) | gone — see D14 |
| `slot_manager` | `slot_managers` |
| `scrims_slot_reminders` | `slot_reminders` |
| `esports_bans` | `ban_logs` |
| `tm.tourney` | `tourneys` |
| `tm.register` | `tourney_slots` |
| `tourney_groups` | `tourney_group_lists` |
| `ss_info` | `ss_configs` |
| `ss_data` | `ss_submissions` |
| `tagcheck` | `tagcheck_channels` |
| `easytags` | `easytag_channels` |
| `timer` | `jobs` |
| `guild_data` | `guild_settings` |

`jobs` replaces `timer` because "timer" means three different things in this
codebase already (the scheduler, the reminder cog, and the Discord message
timeout). `jobs` is unambiguous.

## D13. One-to-many is a FK, not a join table

`SSVerify.data ↔ SSData` is strictly one-to-many — a submission belongs to
exactly one config. Quotient uses a Tortoise M2M join table, which forces the
duplicate check into a join it does not need.

**Ours:** `ss_submissions.ss_config_id` is a plain FK with
`ON DELETE CASCADE`. Deleting a config deletes its submissions, which is what
`SSVerify.full_delete()` already does by hand.

Where a relation really is many-to-many (scrim ↔ banned team, scrim ↔ slot
reminder), use a real join table with a composite unique constraint.

## D14. Slots are one table with a state column — not an array plus rows

This is the biggest design change in the port, and it is deliberate.

Quotient models a scrim's slots as two things at once: an `available_slots`
`integer[]` array on the scrim, **and** rows in `assigned_slots`. Claiming a
slot is a read-modify-write across both: `ArrayRemove("available_slots", num)`
plus `AssignedSlot.create(...)`. Quotient protects this with a
module-global `asyncio.Lock` (`_claim.py:15`) and a re-read of
`available_slots`.

That lock is a **process-global in-process mutex**. It does not survive a
restart and does not survive a second bot process. Two users claiming the same
slot produces two owners of slot N — a corruption class that is invisible in
development and appears in production. This is the highest-value bug in the
whole port.

**Ours — one table, one state column, one conditional UPDATE:**

```sql
slots(id, scrim_id, num, state, team_name, owner_user_id, members, ...)
  UNIQUE (scrim_id, num)
  CHECK (state IN ('free','claimed','locked','banned'))
```

Claim becomes:

```sql
UPDATE slots
   SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 RETURNING id;
```

Zero rows updated ⇒ somebody else got it first. **The database enforces the
invariant.** No lock, no array, no join table, no read-modify-write. The
whole race class disappears.

Consequences:
- `scrims.available_slots` array: **gone**. "How many slots are free" becomes
  `SELECT count(*) FROM slots WHERE scrim_id = $1 AND state = 'free'`.
- `scrims_sm.assigned_slots` join table: **gone**. A slot belongs to exactly
  one scrim.
- `AssignedSlot` → `slots`. One row per slot, always. A free slot is a row
  with `state='free'`, not an absence.
- Cancel = `UPDATE slots SET state='free', team_name=NULL, owner_user_id=NULL,
  members='{}' WHERE id=$1 AND owner_user_id=$2`.
- The "Add Team" / "Remove Team" moderator buttons become state transitions
  on the same table, not array surgery.

The slot state machine is a closed union in TS:

```ts
type SlotState = "free" | "claimed" | "locked" | "banned";
```

Exhaustively switch on it. No `string`.

## D15. Premium is an entitlement, and expiry never deletes user data

Quotient gates features on `Guild.is_premium`, a single boolean, and on
expiry **deletes the guild's data**: `deactivate_premium` removes every
`SSVerify` row, and every `TagCheck`/`EasyTag` beyond the first
(`src/cogs/premium/expire.py:15-40`).

That is a hostile product decision. A lapsed subscription should stop
*selling*, not destroy what the customer configured.

**Ours:**

```sql
guild_entitlements(guild_id, feature, enabled, expires_at, source)
  PRIMARY KEY (guild_id, feature)
```

- `feature` is a closed union: `"scrim_slots" | "slot_reminders" |
  "idp_transfer" | "extra_channels" | "screenshot_types" | "success_message"`.
- `assertEntitled(guildId, feature)` is the **only** place a gate is
  enforced. Every gated path calls it. Quotient's two live premium leaks
  (the screenshot-type gate assigns before checking, and the success-message
  gate exists in the editor but not the wizard) are impossible with one
  helper.
- The check happens **before** the state mutation, always.
- On expiry: the entitlement row goes inactive. **No data is deleted.** The
  feature's records stay, and reactivate if the guild subscribes again.
- The target bot is single-guild, so gates will read as "always on" for the
  owning guild unless the owner explicitly revokes. That is correct: the
  gating machinery is real, and the owner decides.

## D16. Roles and channels are stored by ID, never by name

Quotient looks up roles by name in a dozen places: `quotient-tag-ignore`,
`tourney-mod`, `scrims-mod`, and a *substring* match
`"tourney-mod" in role.name.lower()`. It even auto-renames the role back if
someone renames it.

**Ours:** every role id a feature needs is a column in that feature's config
row. Channel ids likewise. The only name-based lookup left in the codebase is
the existing `Moderator` staff check in `handlers/interactions.ts`, which is
frozen with the existing flow.

For the group-list publish flow, the channel is **stored on the row** when it
is created, not re-discovered by substring match.

## D17. Inputs: modals and select menus; message collectors only for multi-line

Quotient's `inputs.string_input` / `integer_input` / `channel_input` /
`role_input` are all `bot.wait_for("message")` with a 120 s timeout. That
class of flow is where bugs live: someone else typing in the channel, the
bot's own messages, timeouts, races with the bot's message handler.

**Ours:**
- Single structured value → a **modal** (`ModalBuilder` + `TextInputBuilder`).
  The target already builds modals (`utils/embeds.ts` `buildVerificationModal`).
- Channel or role → a **select menu** (`ChannelSelectMenuBuilder`,
  `RoleSelectMenuBuilder`). No text parsing, no `wait_for`.
- Free text that genuinely needs multiple lines in one message (the match-time
  editor takes `#channel 7 PM` per line) → a **message collector**, scoped to
  the invoking author and channel, with a timeout, and it must not swallow
  the bot's own messages. One helper, used once.

## D18. Custom ids carry their record; ephemeral state carries a token

discord.py's `View` owns its children and dispatches by object identity.
discord.js has no view concept, so we must encode state in the id.

**Ours, two mechanisms:**

1. **Record id in the custom_id** — `slots:claim:<slotId>`. Stateless. It
   survives a bot restart, a message being moved, a message being edited. This
   is the default for anything that references a database row.
2. **Token map for ephemeral/wizard state** — `slots:select_claim:<token>`
   where `<token>` is a random id into an in-memory `Map` with a TTL. Used for
   state that has no database row yet (a wizard mid-flight, a select menu
   whose options are expensive to rebuild).

Never put a token in a custom_id that references a database row. Never put
"which page am I on" in a token — that belongs in the row.

The existing `verify_btn:<eventKey>` custom_id keeps working unchanged.

## D19. Bugs: fix them, do not port them

The inventories surfaced a set of concrete defects. The port **fixes** them
unless a fix changes observable behaviour that a user might depend on. Each
one is listed so a reviewer can check.

| # | Where | Defect | Our fix |
|---|---|---|---|
| B1 | `_claim.py:15,66-78` | Slot claim race, guarded by a process-global lock | Conditional `UPDATE ... WHERE state='free'` (D14) |
| B2 | `_reminder.py:41-55` | Mutating a list while iterating it — every second match survives the filter | Filter with a set comprehension |
| B3 | `_claim.py:77` | `members=[user_id]` only, so the IDP transfer can never find a teammate | The claim modal collects teammate mentions, like the registration flow does. Persist `members` as written (fixes B9 too) |
| B4 | `smslotlist/editor.py:144` | `range(scrim.start_from, 30)` hard-codes 30 slots | Use `scrim.total_slots` |
| B5 | `smslotlist/button.py:56-59` | `except OperationalError` replies but does not `return` | Add the `return` |
| B6 | `smslotlist/button.py:130` | `ephermeral=True` typo → `TypeError` | `ephemeral: true` |
| B7 | `_reminder.py:27` | Error says "Cancel Reminder" for the remind feature | Correct the wording |
| B8 | `ssmod/_buttons.py:90-94` + `_edit.py:33-38` | Premium type assigned **before** the check, then persisted by the next refresh → free guilds get premium types | Check entitlement **before** assigning (D15) |
| B9 | `_idp.py:48` | `members.remove()` mutates in memory only; the DB still lists the old captain | Persist the new member list |
| B10 | `_idp.py:77` | `guild.get_member()` may be null → `AttributeError` in a detached task | Null-check and surface the failure |
| B11 | `ssmod/_buttons.py:226-231` vs `:36` | Cancelling the wizard leaves the channel in the live cache | Only add to the cache on save |
| B12 | `ssmod/_edit.py:101-102` vs `_wiz.py:23-31` | Success-message gate exists in the editor but not in the wizard | One `assertEntitled` call in both paths |
| B13 | `expire.py:56-64` | The warning lists every channel, including the ones that survive | List only what is actually removed — and remove nothing (D15) |
| B14 | `_ssverify.py:97` (regex `\b@\w+`) | Does not match a full tag `@name#1234` despite the message advertising it | Match the full tag |
| B15 | `groupm/_paginator.py:47` | Channel auto-detect by substring: group 1 matches "Group 10" | Store the channel id on the row (D16) |
| B16 | `tourney.py:494` | `refresh_at` is `auto_now`, so the 2-minute cooldown depends on the last write of any kind | Plain nullable timestamp, written only by the refresh path |
| B17 | `groupm/main.py:135-147` | Role/channel creation has no rollback — a partial failure leaves orphans | Collect created ids; clean up on failure |
| B18 | `ssmod/_edit.py:33-38` | `dict(self.record)` update payload includes the M2M field and relies on Tortoise internals | Explicit field list |
| B19 | `esports/__init__.py:103` | `idp` deletes the user's message to hide the password | Slash commands have no user message — **the reply must be ephemeral** or the password sits in the channel |
| B20 | `ssverify.py:48,118` | OCR calls serialised by one global lock | Keep serialised — but per-provider, not global to the bot |

**Preserved deliberately:**

- `slotm/editor.py:66-69` — the "Main Channel can't be edited" button is a
  deliberate stub. Port it with the same message. Do not invent a
  channel-rename flow.
- `idp` deletes the invoking message — kept as behaviour, but as an ephemeral
  reply (B19).

## D20. OCR and image hashing are ours, not a third party's

Quotient calls an external service (`POST {FASTAPI_URL}/ocr`) that returns
`{url, dhash, phash, text}`. The URL and key are in a gitignored config file,
so **the service is not in the repository and cannot be run**. The entire
screenshot-verification feature depends on it. The bot also links to
`imagehash`, a Python-only library, for the duplicate check.

**Ours — an OCR adapter interface with two implementations:**

```ts
interface OcrProvider {
  readonly name: string;
  analyze(image: Buffer | string): Promise<OcrResult>;
}
interface OcrResult {
  text: string;
  dhash: string;   // 16 hex chars, 64 bits
  phash: string;
}
```

- `LocalOcrProvider` — **default**. `tesseract.js` for text, `sharp` for
  dHash/pHash over raw pixels. No API key, no network, works offline.
- `HttpOcrProvider` — the Quotient-compatible remote service. Used only when
  `OCR_PROVIDER_URL` is configured.

Two adapters make this a real seam rather than speculative indirection.

The duplicate check does not need an image library at all: the service hands
us a hex hash, and the comparison is a Hamming distance. Port it as
`hexToHash` (16 hex chars → `bigint`) plus a 64-bit XOR popcount, ~15 lines.
This is the one place `imagehash` leaks in, and it is trivially portable.

**Open for the port:** confirm the exact hash the remote service produces
before trusting a threshold. The `<= 7` Hamming distance on a 64-bit dHash is
only meaningful for a 64-bit dHash. Our local implementation must produce
the same shape, and the threshold is a config value, not a constant.

## D21. In-memory caches: `Set`/`Map`, rebuilt at startup

Quotient keeps `bot.cache.tagcheck`, `eztagchannels`, `ssverify_channels` as
`set()`s of channel ids, filled at startup and pruned when a record vanishes.
The point is to avoid a database round trip on every message.

**Ours:** the same, in `core/channel-cache.ts`, rebuilt from the database at
startup. One place owns the invalidation. Not in `config/events.ts` — that is
deploy-time config for the frozen verification flow.

## D22. Excluded dead code — do not port

Confirmed unreachable in Quotient. Porting it would be waste, and worse, it
would look like live behaviour to the next engineer.

| Dead code | Where | Why |
|---|---|---|
| `PtableTourney`, `PtableTeam`, `PtableMatch` | `src/models/esports/ptable.py` | Never registered with Tortoise — the tables do not even exist |
| `Subscriptions`, `SubPlan`, `SubLog` | `src/models/esports/reserve.py` | Same |
| The whole points-table image renderer | `src/cogs/esports/helpers/image.py` | 235 lines, entirely commented out |
| `IDPMenu` | `src/cogs/esports/menus.py:265-455` | Defined, never instantiated |
| `TagCheckView` | `src/cogs/esports/views/tagcheck/__init__.py` | Not imported; its two buttons do nothing. The tag-check *behaviour* is delivered by the commands and the message listener |
| The second `TourneyGroupManager` | `src/cogs/esports/views/tourney/groups.py` | Exported but unreachable — the live one is `groupm/main.py`. Its `publish_g_hook` webhook flow is therefore dead |
| The legacy `discord.ext.menus` reaction menus | `src/cogs/esports/menus.py` | Legacy; the live equivalents are the discord.js views |

## D23. The `idp` reply must be ephemeral

Quotient's `idp` command deletes the *user's* message so the room password
does not linger. A slash command has no user message to delete.

**Ours:** the `idp` reply is **ephemeral**. This is a security property, not a
cosmetic choice, and it needs a test.

## D24. Deployment scope

The target registers slash commands **guild-scoped** to `GUILD_ID` only.
Discord allows 100 slash commands per guild. The port adds ~60 commands.

**Action:** before wave 3 ships, count the commands and group them under
subcommands where the source had groups. `tagcheck set|config|remove|autodelete`
becomes `/tagcheck set` etc. — one top-level command, four subcommands. That
is how the source's groups map to Discord's own group concept, and it keeps
the count low.

---

## D25. Tourney slots get the same treatment as scrim slots

The tourney inventory independently reached the same conclusion as D14: the
`Tourney.assigned_slots` M2M plus a `TMSlot.num` column is wrong, because
`num` is a *per-tourney* position stored on a globally-unique row, and
"Swap Groups" mutates it in place.

**Ours:** `tourney_slots(id, tourney_id, num, team_name, leader_id, members,
message_id, jump_url, confirm_jump_url)` with `UNIQUE(tourney_id, num)`.

- The `Tourney ↔ TMSlot` M2M and its `tm.tourney_tm.register` join table are
  **gone** — a tourney slot belongs to exactly one tourney.
- Swap Groups becomes a two-row `UPDATE ... SET num = ...` inside one
  transaction, with a deferred unique constraint or a swap-via-temporary to
  avoid the unique collision.
- `num` assignment stops being `max(num)+1` (race-prone outside the global
  lock) and becomes a sequence per tourney.
- `Tourney.banned_users` becomes a `tourney_banned_users(tourney_id, user_id)`
  table, not a `bigint[]`. `ARRAY_APPEND`/`ARRAY_REMOVE` are read-modify-write
  and will race under concurrent bans; a join table with a unique constraint
  is idempotent.
- `TMSlot.members` **stays** a `bigint[]` — the fake-tag check is an array
  overlap (`$2 && SLOTS.MEMBERS`) and the elements have no natural key.

## D26. Tourney status is an explicit enum, not two nullable timestamps

Quotient derives "open / paused / closed" from `started_at` and `closed_at`.
Both pause and close set `closed_at`, so the two states are indistinguishable
in the data, and the UI tells them apart only by reading `started_at`.

**Ours:** `status: "draft" | "open" | "paused" | "closed"` — a closed union,
exhaustively switched on. The timestamps become ordinary columns that
support the state, not the state itself.

Same for scrims: `status: "draft" | "open" | "closed"`.

## D27. `find_team` is ported verbatim and unit-tested

`utils/default.py:30-43` derives a user-visible team name from a free-text
registration message by regex: first `team.*` match, strip mentions and the
words `team`/`name` and non-word characters, title-case, prefix `"Team "`.
Fallback `"{author}'s team"`.

Subtleties that must survive: it matches only to the end of the **first
line** (`.` does not match `\n`), it is applied to the **lowercased** message
(Quotient mutates `message.content` in place — we do not; we pass a
normalised copy), and the result is truncated at the model boundary.

Port it as `core/team-name.ts` with the same regex. Add it to the smoke
test. It decides a name users see on a slotlist.

## D28. Guards are a list, enforced in one place

`types/command.ts` gains:

```ts
export interface Command {
  data: CommandData;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  staffOnly?: boolean;
  ephemeral?: boolean;
  guildOnly?: boolean;        // defaults to true
  guards?: Guard[];           // premium, count limits, ownership
}
```

`Guard` is `(interaction) => Promise<string | null>` — `null` allows, a string
is the denial message. Enforced in `handlers/interactions.ts` in the order
`guildOnly → staffOnly → guards`, before `execute`.

A single `premium?: boolean` cannot express Quotient's gates, because most of
them are **count-limited** (max 3 scrims, 1 tourney, 1 tagcheck, 1 slot
manager, 1 autopurge channel) rather than boolean. `guards` is a predicate
list, so `Guards.maxScrims(3)` is expressible.

Only one authorisation choke point. Guards never throw past the handler.

## D29. Every premium gate has the same presentation

Quotient has four different failure presentations for the same class of
refusal — a rich upsell embed (6 sites), a hard-coded string (12 sites), a
`NotPremiumGuild` exception with an uninterpolated `{ctx.bot.prime_link}`
placeholder (2 sites), and a **silently disabled button** with no explanation
at all (1 site). Only 6 of 25 gates give the user a clickable upgrade button.

**Ours:** one `buildPremiumGateEmbed(reason)` and one `premium:buy` button,
used by every gate. The silently-disabled button is banned — a feature the
user cannot see the existence of is a support ticket, not a business model.

## D30. Timestamps are UTC in the database; IST is a presentation concern

Quotient mixes four time libraries and has two real bugs from it: `day_today()`
uses naive local time while everything else uses IST, and `TimeText` mislabels
a naive-local datetime as IST.

**Ours:** every timestamp column is `timestamptz`. The database stores
instants. `Asia/Kolkata` is a named constant used only when rendering or when
a user gives a wall-clock time with no offset. All date parsing goes through
one `parseNaturalTime(input, tz)` helper — Quotient has six call sites with
three different setting sets.

## D31. New database code lives in `db/`, not `repo/`

`repo/` already means "Google Sheets access" in this codebase and stays that
way. The Postgres layer is `db/`. Two directories, two meanings, no confusion.
Add a one-line comment at the top of each so the next engineer does not have
to guess.

## D32. Message templates are JSON, not Python literal strings

Quotient stores `discord.Embed.to_dict()` as a **Python literal string** and
re-parses it with `ast.literal_eval` on every render. Any template written by
another code path crashes the next render.

**Ours:** `jsonb` columns holding a typed `EmbedTemplate`, rendered by one
function. The `<<keyword>>` substitution set is ported as-is: open message
(`<<mentions>> <<slots>> <<reserved>> <<slotlist>> <<multireg>> <<teamname>>`),
close message (`<<slots>> <<filled>> <<time_taken>> <<open_time>>`), slotlist
(`<<name>> <<time_taken>> <<open_time>> <<slots>>`).

## D33. Add the reactions intent

The tourney ✅-reaction registration path is a core feature. discord.js only
emits `MessageReactionAdd` with `GatewayIntentBits.GuildMessageReactions`, which
the target does not request. Without it, reaction registration is silently
dead — no error, just no registrations.

## D34. No socket.io dashboard in this port

Quotient's bot is a socket.io **client** to an external, closed-source
dashboard service. Porting it means porting a service contract that is not in
the repository, and the tourney socket handlers are provably dead (the cog is
never registered; two of its three handlers are empty functions; the third
emits a payload that fails its own schema validation).

**Ours:** the three dashboard operations Quotient actually implements — create
scrim, edit scrim, delete scrim — are exposed as slash commands. If a
dashboard is built later it talks REST to the same modules. The socket layer
is skipped, and the skip is recorded here so it is auditable.

## D35. `await view.wait()` becomes a promise

discord.py's `View.wait()` blocks a coroutine until a select writes its value
onto the view object. discord.js is event-driven, so every one of those
becomes a promise resolved by a central handler.

**Ours:** one `awaitSelect(options, { maxValues })` helper in `core/select.ts`
returning `Promise<string[]>`, plus a `prompt()` returning `Promise<boolean>`.
This removes the `custom_id` string-packing hack (`"slot_id:tourney_id"`) and
the `hasattr(v, "custom_id")` sniffing.

## D36. Unicode emoji, not Quotient's custom emoji IDs

`<:check:807913701151342592>` and friends belong to Quotient's emote server.
They will not render in the target's guild. **Ours:** Unicode emoji
(✅ ❌ 🔔 ➕ ➖ 📝 🛠️ ℹ️ 🗑️) for everything user-facing. Keep the custom ids in
`core/emotes.ts` only if we later add our own emote server.

## D37. The premium purchase path is ported *and fixed*

The premium inventory's top risk: Quotient's `premium_success` callback
verifies nothing PayU sent. It trusts `form["status"] == "success"` and an
`Origin` header — both attacker-controlled. Anyone who can reach the HTTP
port and click the buy button can grant themselves unlimited premium.

Porting it as-is ships a free-premium button. **Ours:**

- Verify the PayU **response** hash (note: salt and key are swapped relative
  to the request hash) with a constant-time compare.
- Verify the amount matches the plan price, as a decimal string.
- Add a server-to-server webhook endpoint; the browser redirect is treated as
  untrusted until the hash verifies.
- One idempotent `activatePremium(txnId, verifiedPayload)`, called by both.
- Explicit transaction status enum: `pending | paid | failed`. `failed` is
  retryable — Quotient closes the transaction on failure so it can never be
  retried.
- `premium_plans.duration_days integer`, not an `INTERVAL` — Postgres
  `INTERVAL` has no lossless JS mapping, and every plan is a whole number of
  days.
- `premium_transactions.plan_id` is nullable with `ON DELETE SET NULL`, and
  the plan is **snapshotted** into `plan_snapshot jsonb` at purchase time.
  Quotient's plan table is destructively reseeded on every startup; a
  `RESTRICT` FK breaks that and a `CASCADE` destroys paid transactions. The
  snapshot means the payment page still renders after a reseed.
- Write the database rows **before** notifying. Quotient dispatches the
  purchase listener before the guild row is written, so the confirmation DM
  can show a stale expiry or crash on `None`.
- Use the buyer's real email and Discord display name, not
  `"abcd@gmail.com"` and the user id.

## D38. The `Context` class becomes functions; the `Cog` abstraction is dissolved

discord.py's `Context` is ~18 members of helpers. In discord.js the
interaction *is* the context. **Ours:** `core/context.ts` exports functions
that take an `Interaction`. No class, no inheritance.

discord.py's `Cog` bundles a command group, event listeners, a `bot_check`
and `cog_load`/`cog_unload`. discord.js has no equivalent and the target's
flat `commands/` + `handlers/` split is already the idiomatic shape.
**Ours:** commands live in `commands/<group>/`, listeners in `handlers/` or in
the owning module's `listeners.ts`, and the module registry is explicit.

## D39. The global command guard moves into the dispatcher

Quotient's cog-level `bot_check` applies to *every* command: blocklist
check, dev bypass, 2-per-10s rate limit, and the lockdown switch. In the
target, commands are dispatched one-by-one in `handlers/interactions.ts`, so
this guard must be woven into the dispatcher — otherwise there is no rate
limit (an abuse vector) and no lockdown lever (an operational one).

**Ours:** `core/ratelimit.ts` implements the limiter; the dispatcher applies
it; the blocklist and lockdown are read from `guild_settings`.

---

## D40. Quotient's monetisation cluster does not ship

`money`, `claim_prime`, `vote`, `voteremind` and the Quo Coin economy grant
**real premium from a free in-app currency** — 120 coins buys 30 days of paid
entitlement (`src/cogs/quomisc/views.py:68-99`). The coins have no source but
an external vote page.

Porting that is shipping a paywall bypass. The premium system itself ships in
full — entitlements, plans, checkout, verified payment callback, expiry,
gates — but this economy does not.

The `User.money` column may exist for future use; nothing may spend it to
grant entitlement.

## D41. The dev cog's commands do not ship as Discord commands

| Quotient command | Verdict | Why |
|---|---|---|
| `botupdate on/off` | **drop** | Sets a global lockdown and then shells out to `pm2 reload quotient` (`src/core/Bot.py:131-132`). A process-manager-specific restart primitive with a hard-coded service name. |
| `sync` | **drop** | Re-registers the command tree from inside Discord. `deploy.ts` + `npm run deploy` already does this, guild-scoped and correctly. Two registration paths will drift. |
| `history`, `history for/guild/user/cog`, `cmds` | **drop** | An arbitrary-user activity log rendered into a channel. A compromised dev account leaks every command every member has run. Analytics belong in the database, not in chat. |
| `bl add/remove` | **drop the command, keep the feature** | The blocklist itself is load-bearing — the global command gate refuses blocked users and guilds. The blocklist *model*, the *check* and the *cache* ship; the management surface is an ops script, not a chat command. Quotient's version also looks records up by `block_id` alone, ignoring the type, so a user and a guild sharing an id collide. |
| `alr` (alerts) | **drop** | A DEV-only interrupt loop that pings users after every command. A notification primitive, not a feature — and it ships a global listener that fires for every user. |

Where a privileged capability genuinely remains, it uses the target's
existing role-based `isStaff()`, never a second parallel auth system.

## D42. The dashboard is Option C: minimal server-rendered pages, no socket.io

The bot is a socket.io **client** to an external closed-source dashboard. The
front-end, its OAuth flow, its sessions and its DB writes are not in the
repository — there is no OAuth code, no JWT, no cookie handling anywhere in the
source tree. The tourney socket handlers are dead: the cog is never
registered, two of its three handlers are empty functions, and the third
emits a payload that fails its own pydantic schema.

**Ours:** the payment server runs **in-process** with the bot (the purchase
completion needs to reach the bot object; Quotient's handler does
`from core import bot` and dispatches into the bot's event bus). The socket
layer is dropped, and the drop is recorded here so it is auditable.

The three dashboard operations Quotient actually implements — create scrim,
edit scrim, delete scrim — ship as slash commands. The socket wire protocol
is documented in `docs/dashboard-protocol.md` so the option stays open.

**If a dashboard is commissioned later**, it is Option B (static SPA + JSON
API + WebSocket), not Option A: the bot already owns the Postgres
connection, so the bot becomes the server and the dashboard becomes an
ordinary API client. That inverts Quotient's topology and is a smaller
conceptual change than "bot dials out to the dashboard".

**Security note carried from the source:** Quotient's `bot_scrim_delete` socket
handler deletes a scrim by id **without a guild filter** and **without a
permission check**, and a null id wipes every scrim in the guild. Any ported
equivalent must filter by guild and re-check the caller's permission.

## D43. Ephemerality is per-command

The target defers **every** chat-input command ephemerally
(`handlers/interactions.ts:55`). Quotient's replies are public, and several
ported features need a public message to exist: the Confirm/Cancel prompt, the
role-revert affordance, paginated lists, and anything a second moderator must
see.

**Ours:** `Command.ephemeral` becomes meaningful. The **existing** verification
commands keep their current ephemeral behaviour — the shipped UX does not
change. The new utility, moderation and esports commands default to public,
matching Quotient. The existing `ephemeral?: boolean` field on `Command` was
reserved for exactly this.

## D44. Broken source behaviour is fixed, not copied

The inventories surfaced ~20 concrete defects. Each is either fixed (where the
feature is otherwise unusable) or preserved-and-documented (where it is
observable behaviour someone might rely on). The full list is in the wave-1
inventories; the ones fixed outright:

| Bug | Where | Effect | Fix |
|---|---|---|---|
| `unlock server` calls `.first()` on a coroutine | `mod/__init__.py:609` | the command always raises | fix the query |
| `lock server` without a duration | `mod/__init__.py:568-578` | `AttributeError` on `None.dt` | create the row only when there is a duration |
| `RoleRevertButton` ternary binds `await` to the wrong branch | `mod/views/role.py:35` | the revert button never reverts | parenthesise the ternary |
| `maintenance off` uses `discord.utils.get` to find a channel by name | `mod/__init__.py:736` | maintenance channels are never deleted | use a name predicate |
| `tag` on an embed tag also sends the raw content | `utility/__init__.py:250-256` | duplicate output | return after the embed |
| `money` uses `User.get` | `quomisc/__init__.py:270` | crashes for users with no row | `get_or_none` |
| `footer`'s length check calls `ctx.success` | `quomisc/__init__.py:261` | an error is shown as a success | call the error path |
| `reminder all` says "10 latest" but orders ascending with no limit | `utility/__init__.py:79-85` | wrong order, unbounded result | order descending, limit, fix the wording |
| `autorole config` calls `list(None)` | `utility/__init__.py:184` | `TypeError` when the guild is uncached | handle the null |
| `quickembed` reads `attachments[0].content_type` | `utility/__init__.py:213` | `TypeError` on a non-image upload | null-check |
| `/scrims reserve` has no permission check | `slash/scrims.py:380-390` | any member can reserve slots in any scrim | add the mod guard |
| `randint(1, 60)` for a minute value | `slash/scrims.py:328` | ~1/60 of creates crash | use 0–59 |
| The slot-claim race | `slotm/public/_claim.py:15,66-78` | two owners of one slot | conditional UPDATE (D14) |
| The "remind" filter mutates the list it iterates | `slotm/public/_reminder.py:41-55` | every second match survives the filter | filter with a set comprehension |
| `hard-coded 30` slots in "Add Team" | `smslotlist/editor.py:144` | offers slot numbers that do not exist | use `total_slots` |
| `ephermeral` typo | `smslotlist/button.py:130` | `TypeError` | `ephemeral` |
| Missing `return` after an error reply | `smslotlist/button.py:56-59` | execution continues into a failure | return |
| The premium type is assigned before the check, then persisted by the next refresh | `ssmod/_buttons.py:90-94` + `_edit.py:33-38` | free guilds get premium types | check before assigning (D15) |
| The success-message gate exists in the editor but not the wizard | `ssmod/_edit.py:101` vs `_wiz.py:23` | the gate is bypassable | one `assertEntitled` in both |
| Cancelling the ssverify wizard leaves the channel live | `ssmod/_buttons.py:226-231` vs `:36` | a half-configured channel goes live | only activate on save |
| `IDP transfer` never persists the new member list | `slotm/public/_idp.py:48` | the DB still lists the old captain | persist it |
| `get_member` may be null in a detached task | `slotm/public/_idp.py:77` | `AttributeError` | null-check and surface it |
| The `check_fake_tags` raw SQL quotes schema-qualified identifiers as single names | `models/esports/tourney.py:437-444` | `relation does not exist` at runtime | rewrite as a typed query |
| The `await ...` on the cross-reaction cancel path | `events/tourneys.py:180-181` | `TypeError`; the feature has never worked | implement the stated intent |
| `dict(self.record)` update payloads | `ssmod/_edit.py:33`, `tourney/_editor.py:54` | relies on Tortoise internals; writes unrelated columns | explicit field lists |
| The `Origin` header check crashes when the header is absent | `server/app/payment.py:65,103` | unhandled 500 | optional chaining |
| The premium purchase notification races the database write | `server/app/payment.py:87` vs `:90-91` | the confirmation DM shows a stale expiry | write first, then notify |
| `made_premium` appends the user id, not the guild id | `server/app/payment.py:85` | wrong ids recorded | append the guild id |
| The `clear`/`autorole`/`lock` groups declare a required positional alongside subcommands | `mod/__init__.py:54`, `utility/__init__.py:101`, `mod/__init__.py:488` | ambiguous parsing; the `None` fallbacks may be dead | slash commands are either a group or a command — the ambiguity disappears |

**Preserved deliberately:** the "Main Channel can't be edited" stub button
(`slotm/editor.py:66-69`), the `idp` command deleting the invoking message
(behaviour preserved as an ephemeral reply — D23), and the free-tier limits as
the *code* implements them rather than as the perk table advertises them.

---

## D45. Free-tier limits follow the code, not the marketing table

Quotient's `constants.perks` advertises limits the code does not enforce
(autorole: "1 free"; easytags: "1 free"). Only autopurge actually enforces a
free-tier cap. The perk table and the socket perk list have also drifted from
each other.

**Ours:** the free-tier allowance is a **single config object** that the gates
read, so the table and the code cannot disagree:

```
freeTier: { scrims: 3, tourneys: 1, tagcheckChannels: 1, easytagChannels: 1,
            slotManagers: 1, ssverifyConfigs: 1, mediaPartners: 1,
            autopurgeChannels: 1 }
```

The perk list is generated from it. A gate that has no allowance entry is
unlimited.
