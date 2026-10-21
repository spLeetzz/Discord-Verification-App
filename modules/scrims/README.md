# `modules/scrims/` — the scrims area

A scrim is a scheduled practice match between teams: a registration
channel, a list of slots, and a moderator-driven lifecycle.

Quotient modelled this as seventeen view classes that each mutated
`self.record` and re-rendered. discord.js has no views, so **the state
lives in the database and the message is re-rendered from it.** The
`scrims` table is the state.

---

## The interface

### Commands

`commands/esports/scrims.ts` is a one-line re-export. The definitions
live in `modules/scrims/commands/`.

| Command | What it does |
|---|---|
| `/scrims manager` | Opens the management panel: the list of scrims, and from there every panel. |
| `/scrims create` | Creates a scrim: registration channel, slotlist channel, success role, required mentions, total slots, open time, autoclean time. |
| `/scrims reserve` | Reserves a slot in a scrim. **Has the mod guard** — the source had none. |
| `/scrims unban` | Lifts a user's bans from the scrims of this server. |
| `/scrims slotinfo` | Shows the slots a user holds. |
| `/scrims slotlist` | Posts a scrim's slotlist into the current channel. |

Every command is `staffOnly` and passes the scrim mod guard.

### The module's entry points

```ts
import {
  registerScrims,
  registerScrimsInteractions,
  dispatchScrimJob,
} from "./modules/scrims/register.js";
```

- `registerScrims(client)` attaches the `MessageCreate` listener and
  rebuilds the registration-channel cache.
- `registerScrimsInteractions()` wires the custom ids into the core
  router. The manager calls it.
- `dispatchScrimJob(event, payload, client)` is this area's half of the
  durable scheduler.

### Custom ids

```
scrims:<action>[:<part>[:<part>…]]
```

The scrim's id travels in the id (D18), so a panel survives a restart.
Examples:

- `scrims:list` — the list panel;
- `scrims:pick` — the list panel's select menu;
- `scrims:manager:<scrimId>` — the panel of one scrim;
- `scrims:editor:set_role:<scrimId>` — one field of the editor;
- `scrims:wizard:set_role:<token>` — one field of the wizard;
- `scrims:modal:field:set_role:<scrimId>` — the modal behind a field.

The **wizard** carries a token rather than a record id, because the scrim
does not exist yet: that is exactly the case D18 says a token is for.

---

## The state machine

The lifecycle is an explicit value (D26):

```
  draft ──open──▶ open ──close──▶ closed
    ▲                              │
    └─────────────open─────────────┘
```

| From | To | How |
|---|---|---|
| `draft` | `open` | The moderator presses **Start Reg**, or the daily `scrim_open` job fires. |
| `open` | `closed` | The moderator presses **Stop Reg**, the day ends, or the **last slot is taken**. |
| `closed` | `open` | The moderator presses **Start Reg** again. The slots are reset. |

### Opening

1. The old slot rows are deleted and a fresh free row is created for
   every slot number.
2. The reserved slots become ordinary claimed slots.
3. `status` becomes `open`, `opened_at` is set, `closed_at` is cleared
   and `slotlist_message_id` is cleared.
4. The open message is posted in the registration channel, with the
   ping role.
5. The registration channel is opened to the open role.
6. The daily jobs are armed: `scrim_open`, `autoclean` and `scrim_match`.

**Opening resets the slots** — the source did the same.

### Closing

1. `status` becomes `closed`, `closed_at` is set and
   `time_elapsed_seconds` records how long the registration was open.
2. The close message is posted in the registration channel.
3. The registration channel is locked again.
4. If the scrim asked for it, the slotlist is published and its message
   id is stored on the row.

### The daily jobs

Both are rows in the durable `jobs` table, **never a `setTimeout`**. A
timer that dies with the process means the scrim never opens again.

| Job | What it does |
|---|---|
| `scrim_open` | Advances `open_time` by exactly 24 hours, re-arms itself for the new time, and opens the scrim when it is enabled and today is one of its open days. |
| `autoclean` | Advances `autoclean_time` by exactly 24 hours, re-arms itself, and runs the pass when the scrim closed **less than 48 hours ago**. |
| `scrim_ban` | Lifts a ban whose time is up. |
| `scrim_reserve` | Lifts a reservation whose time is up. |
| `scrim_match` | The match-time lock: the claimed slots become `locked`. |

A stale job — one whose time no longer matches the scrim's schedule —
is dropped and a fresh one is armed, so a scrim whose schedule was
edited while the bot was down still opens. The source simply gave up.

---

## Slots (D14)

A slot is a **row** in the `slots` table with a `state` column. There
is no `available_slots` array and no join table.

```
free    → claimed | locked | banned
claimed → free
locked  → free | banned
banned  → free
```

A free slot is a row, not an absence. "How many are free" is
`SELECT count(*) FROM slots WHERE scrim_id = $1 AND state = 'free'`.

### The claim

```sql
UPDATE slots
   SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 RETURNING id;
```

Zero rows returned means somebody else won. **There is no lock.** The
source protected this with a module-global `asyncio.Lock` that died
with the process, so two users could own one slot. The database
enforces the invariant here.

When the claim loses, the service re-reads the slot and tries the next
free number.

### The numbering

The slot numbers run `start_from … start_from + total_slots - 1`.

The source's "Add Team" button offered `range(start_from, 30)` — twenty
numbers that did not exist for a scrim with fewer slots (B4). Ours uses
`total_slots`.

---

## The requirements matrix

A registration message is checked against an **ordered list of guards**.
Each guard returns a deny reason or `null`; the first reason wins.

Quotient's `check_scrim_requirements` is two independent `if`s followed
by an `elif` chain hanging off the second one. Both facts are reproduced
exactly.

| # | Guard | Reason | Notes |
|---|---|---|---|
| 1 | Team name required | `no_team_name` | **Independent.** The source searched for `team.*` anywhere in the message, so "steam" satisfies it. Preserved. |
| 2 | Bot mentions rejected | `mentioned bots` | **Independent.** Only when the scrim asks for at least one mention. |
| 3 | Mention count | `insufficient mentions` | **Chain.** |
| 4 | Banned user | `banned` | **Chain.** |
| 5 | Required lines | `no_lines` | **Chain.** |
| 6 | One registration per person | `multiregister` | **Chain.** |
| 7 | Duplicate team name | `duplicate_name` | **Chain.** The name compared is the one `core/team-name.ts` derives. |
| 8 | Duplicate / fake tags | `fake_tag` | **Chain.** The overlap of the mentioned ids with `slots.members`. |

**The chain only runs when guard 2's condition is false.** Guard 2's
condition is `required_mentions > 0 AND no mentioned user is a bot`, so
a scrim that asks for **no** mentions skips guards 3–8 entirely: the
banned-user check, the line check, the one-registration check, the
duplicate-name check and the fake-tag check all stop firing. That is a
source quirk, and it is preserved rather than "fixed", because a guild
that sets `required_mentions` to `0` gets exactly that behaviour there.

### The fake-tag check

The source ran a raw SQL query with an array-overlap operator against a
schema-qualified join table. Ours is a typed query over one table:

```ts
sql`${slots.members} && ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`
```

Every id is still a bind parameter.

### The message is never mutated

The source lowercased `message.content` in place before checking it.
discord.js messages are frozen, so the port normalises a **copy**
(NFKC, then lowercased) and passes it around (D27). The team name comes
from `core/team-name.ts` — the same derivation the slotlist shows, so
the duplicate check compares like with like.

---

## The configuration surface

### The editor

Twenty fields, laid out in **five rows of five** — exactly Discord's
25-component limit, and the count is checked by
`assertComponentBudget` rather than by eye. Quotient's editor added
exactly 25 and had no headroom either.

| Key | Field | How it is edited | Premium |
|---|---|---|---|
| `set_name` | Name | modal | |
| `set_reg_channel` | Registration channel | select menu | |
| `set_slot_channel` | Slotlist channel | select menu | |
| `set_role` | Success role | select menu | |
| `set_mentions` | Required mentions | modal | |
| `set_slots` | Total slots | modal | |
| `set_open_time` | Open time | modal | |
| `set_emojis` | Reactions | modal | ✅ |
| `set_ping_role` | Ping role | select menu | |
| `set_open_role` | Open role | select menu | |
| `toggle_multireg` | Multi-register | button | |
| `toggle_teamname` | Team compulsion | button | |
| `toggle_dup_name` | Duplicate team name | button | |
| `toggle_del_reject` | Autodelete rejected | button | |
| `toggle_del_late` | Autodelete late messages | button | |
| `set_start_from` | Slotlist start from | modal | |
| `set_autoclean` | Autoclean | sub-panel | |
| `set_days` | Scrim days | select menu | |
| `set_lines` | Required lines | modal | ✅ |
| `toggle_dup_tags` | Duplicate / fake tags | button | ✅ |

**The editor writes only the field the button touched.** The source
rebuilt the whole model from `dict(self.record)` on every interaction,
which relied on Tortoise internals and wrote columns another writer may
have changed.

**Every "type a value" flow is a modal or a select menu** (D17). The
one exception is the match-time editor, which takes several
`#channel time` lines in one message and keeps a message collector,
scoped to the invoking author and the channel, with a timeout.

### The wizard

The creation wizard collects the registration channel, the slotlist
channel, the success role, the required mentions, the total slots, the
open time, the open days and the reactions, and then **Save** creates
the row. The wizard's state is a token, not a row.

### The other panels

| Panel | What it holds |
|---|---|
| The list | The scrims of the guild, a select menu to pick one, and **Create Scrim**. |
| One scrim | Edit, Start/Stop Reg, Reserve Slots, Ban/Unban, Design, Manage Slotlist, Set Match Time, Enable/Disable, Delete, Main Menu. |
| Bans | Ban Users, Unban Users, Unban All, and a list of the bans. |
| Reserved slots | The scrim's slots with their reservations, Reserve Slot, Remove Reserved. |
| Autoclean | The two toggles and the time the pass runs at. |
| Design | The open message, the close message and the slotlist design. |
| Slotlist | Repost, Edit, Punish, Info — and the published message carries the same three buttons. |

### The ban matrix

All four modes are kept, because they are a real user-facing matrix:

| Mode | Who | Where |
|---|---|---|
| 1 | The team leader | This scrim |
| 2 | The whole team | This scrim |
| 3 | The team leader | Every scrim in the server |
| 4 | The whole team | Every scrim in the server |

A ban with a duration creates a `scrim_ban` job row for the unban. A
user who is already banned from a scrim is skipped, and the
`banned_teams` unique constraint on `(scrim_id, user_id)` makes that
idempotent.

### The templates (D32)

The open message, the close message and the slotlist are `jsonb`
columns holding a typed `EmbedTemplate`. There is **no
`ast.literal_eval`** — the source stored a Python literal string and
re-parsed it on every render, which crashed when any other code path
wrote the column.

| Template | Keywords |
|---|---|
| Open | `<<mentions>>` `<<slots>>` `<<reserved>>` `<<slotlist>>` `<<multireg>>` `<<teamname>>` `<<mention_banned>>` `<<mention_reserved>>` |
| Close | `<<slots>>` `<<filled>>` `<<time_taken>>` `<<open_time>>` |
| Slotlist | `<<name>>` `<<time_taken>>` `<<open_time>>` `<<slots>>` |

The substitution runs over the title, the description, every field and
the footer — the source replaced the keywords across the whole
serialised embed, so a keyword in a field name was replaced too.

---

## The premium gates

| Gate | Feature |
|---|---|
| `PremiumFeature.scrimSlots` | The reactions, the required lines, the duplicate-tag toggle, and the free-tier allowance of **3 scrims**. |

The allowance is read from `FREE_TIER` in `core/premium.ts` (D45), never
from a literal. The entitlement check happens **before** the state
mutation (D15).

**`modules/scrims/entitlements.ts` is a local stand-in.** The premium
module is owned by another engineer and had not landed when this area
was built. The file has the documented signature —
`assertEntitled(guildId: string, feature: PremiumFeature): Promise<void>`,
throwing the target's `DenialError` — and is backed by the
`guild_entitlements` table. **When `modules/premium/` lands, delete
that file and re-point the imports.** The call sites do not change.

**`canUseScrimMod` is also a local stand-in.** The brief says the mod
guard is `canUseScrimMod` in `core/guards.ts`; that function is not
there yet. `modules/scrims/guards.ts` has the same shape and the same
behaviour the source had (`manage_guild` or the `scrims-mod` role), and
it also accepts the guild's existing `Moderator` staff role. Swapping
it for the core one is a one-line change.

---

## The source bugs that were fixed rather than ported

| # | Where | What it did | What it does now |
|---|---|---|---|
| 1 | The editor | The "apply to all scrims" question fired **after** the panel had already re-rendered, so the moderator saw the new value and *then* had to confirm a change to every other scrim. | The question comes first, the write second. |
| 2 | The editor | The "Skip to" button was a **dead button** — its callback only deferred. | It opens a modal that takes the scrim's number, and moves the editor there. |
| 3 | `/scrims reserve` | **No permission check at all** — any member could reserve a slot in any scrim. | The mod guard. |
| 4 | The slotlist editor | "Add Team" offered `range(start_from, 30)`, so twenty slot numbers that did not exist were on offer. | The scrim's own slot numbers. |
| 5 | `/scrims create` | The autoclean time was picked at random with `randint(1, 60)` for the minutes, so about one create in sixty crashed. | The autoclean time is asked for. |
| 6 | The slot claim | Protected by a module-global `asyncio.Lock` that died with the process, so two users could own one slot. | One conditional `UPDATE`. The database enforces the invariant. |
| 7 | The templates | Stored as a Python literal string and re-parsed with `ast.literal_eval` on every render. | `jsonb` and one render function. A malformed value is ignored, not fatal. |
| 8 | The "is this template set?" check | `len(template) <= 1`, a proxy for "holds no content" that only worked because discord.py's `to_dict()` always carried a `type: 'rich'` key. | The question is asked directly, so a template with a title and nothing else is not thrown away. |
| 9 | The "unban" and "slot info" commands | Hand-written `FULL OUTER JOIN` over the schema-qualified join tables. | Typed queries over one table. |
| 10 | The message normalisation | `message.content` was lower-cased **in place**. | A normalised copy. The message is never touched. |

### What was ported as-is, quirk and all

- The **team-name rule** accepts any message containing the substring
  `team` — "steam" passes it, because the source searched for
  `team.*` anywhere in the text.
- The **whole `elif` chain is skipped** when the scrim asks for no
  mentions.
- The **one reason** the port reports where the source dispatched up to
  two deny events.
- The **role-name lookup** for the `scrims-mod` role. D16 forbids name
  lookups in general, but this role is a guild-wide convention with
  nowhere in the schema to store its id.
- **`time_elapsed` as a duration.** S4 renamed the column to
  `time_elapsed_seconds`; the sentence is formatted at render time.

---

## The layout

```
modules/scrims/
  types.ts        the domain types (closed unions, no strings)
  template.ts     the embed template and the <<keyword>> substitution
  requirements.ts the ordered guard list
  slots.ts        the numbering and the slot state machine
  bans.ts         the four ban modes
  schedule.ts     the daily re-arm arithmetic
  state.ts        the scrim lifecycle
  render.ts       the three message renders
  repo.ts         ALL the SQL for this area
  service.ts      the state machine and the rules
  guards.ts       the scrim mod guard
  entitlements.ts the premium seam (a local stand-in)
  channel-cache.ts the registration-channel cache
  listeners.ts    the MessageCreate registration intake
  jobs.ts         the durable job handlers
  register.ts     registerScrims / registerScrimsInteractions
  commands/       the slash command definitions
  views/          the panels and their handlers
  README.md       this file
```

**The rule that matters:** no SQL outside `repo.ts`, no `client.` calls
outside `views/` and `listeners.ts`, no Discord ids parsed as numbers.

---

## The error modes

| Situation | What happens |
|---|---|
| The scrim was deleted while a panel was open | "This scrim no longer exists." |
| The bot cannot manage the registration channel | "I do not have `Manage Channels` in …" — and the daily job logs the reason. |
| The success role is above the bot's top role | Registration does not open. |
| The wizard expired | "This wizard has expired. Please run the command again." |
| Every slot was taken while somebody was registering | The registration is refused and the scrim closes itself. |
| A ban is already in place | It is skipped, not stacked. The unique constraint makes it idempotent. |
| The entitlement is missing | `PremiumRequiredError`, which is a `DenialError`, so the dispatcher shows it as a refusal rather than a crash. |
