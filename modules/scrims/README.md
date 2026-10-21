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
| `/scrims banlog` | Shows the channel ban entries are written to, or sets it when a channel is given. |
| `/scrims slotinfo` | Shows the slots a user holds. |
| `/scrims slotlist` | Posts a scrim's slotlist into the current channel. |

Every command is guarded by the scrim mod guard (`guards:
[scrimsModGuard]`), **not** by `staffOnly`. The source's `/scrims` asked
for `manage_guild` or the `scrims-mod` role — not the guild's
`Moderator` role — and a `staffOnly` command would be refused by the
dispatcher before the scrim mod guard ever ran.

### The module's entry points

```ts
import {
  registerScrimsListeners,
  registerScrimsInteractions,
  handleScrimsJob,
} from "./modules/scrims/register.js";
```

- `registerScrimsListeners(client)` attaches the `MessageCreate`
  listener and rebuilds the registration-channel cache.
- `registerScrimsInteractions()` wires the custom ids into the core
  router. The manager calls it.
- `handleScrimsJob(client, event, payload)` is this area's half of the
  durable scheduler.

Those are the names the manager's area registry looks for.

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
- `scrims:modal:field:set_role:<scrimId>` — the modal behind a field;
- `scrims:slotm_pick:<scrimId>:<kind>:<userId>` — the "which slot?" menu
  of the slotlist editor, and the member who opened it.

The **wizard** carries a token rather than a record id, because the scrim
does not exist yet: that is exactly the case D18 says a token is for.

### The menus

**A modal cannot follow a menu that was waited on.** Discord lets an
interaction do exactly one thing — reply, defer, update or show a modal
— and `core/select.ts`'s `awaitSelect` *answers* the select interaction
it opens. A menu that is awaited inline therefore cannot be followed by
a modal: `showModal` on it is a hard error
(`InteractionAlreadyReplied`).

So a flow that needs a choice **and then** a modal uses a
**persistent** menu: a real component in a message, whose answer
arrives as an interaction of its own — still unanswered, so the modal
can be shown from it. That is the "which slot?" menu of the slotlist
editor (`scrims:slotm_pick:<scrimId>:<kind>:<userId>`), handled in
`views/slot-pick.ts`. The tournaments area solves the same problem the
same way (`views/select-handlers.ts`), and the slots area does it in
`views/pick.ts`.

The menu goes on the **panel's own message**, so the pick is an
interaction on the panel and the modal that follows is opened from it —
which is what lets the modal submit re-render the panel in place.

**The owner check is the handler's own.** The menu is dispatched by
custom id through the router, and the router has no owner check of its
own, so the member who opened the menu is encoded in the custom id and
checked in the handler. A pick from another moderator is refused and
drives nothing.

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
3. `status` becomes `open`, `opened_at` is set and `closed_at` is
   cleared.
4. The open message is posted in the registration channel, with the
   ping role.
5. The registration channel is opened to the open role.
6. The daily jobs are armed: `scrim_open`, `autoclean` and `scrim_match`.

**Opening resets the slots** — the source did the same.

**Opening does not forget the published slot list.** The message id
stays on the row, so the next close re-renders that message in place
rather than sending a second one. A second message would be an orphan,
with a panel of its own acting on the same slots. See
[the published slot list](#the-published-slot-list).

### Closing

1. `status` becomes `closed`, `closed_at` is set and
   `time_elapsed_seconds` records how long the registration was open.
2. The close message is posted in the registration channel.
3. The registration channel is locked again.
4. If the scrim asked for it, the **slot area** publishes the slot list
   and records its message id on the row.

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

## The published slot list

The **slot area** owns the published slot list: the message, the
buttons (`slots:slotlist_*`) and the operations behind them. This area
owns the lifecycle — open, close, the daily `scrim_open` job, the
autoclean — and publishes the list *through* the slot area's API:

```ts
import { publishSlotList } from "../slots/index.js";

const messageId = await publishSlotList(scrimId);
```

The rules that follow from that:

- **This area never writes `scrims.slotlist_message_id`.** The slot
  area is the only writer. Two writers means whichever re-renders last
  wins, and an id that points at a message nobody can edit. The column
  is not even in this area's `ScrimUpdate` type, so a write would not
  compile.
- **This area renders no `scrims:slotlist:*` button.** The manager's
  slotlist preview carries the slot area's row — Edit, Punish, Info —
  so the manager reaches the same operations the published message
  carries. One namespace for these buttons across the bot.
- **Publishing answers `null` rather than throwing** when there is
  nothing to publish: no scrim, no channel, or no team in a slot. The
  publisher is idempotent, too: a scrim that already has a published
  list has it re-rendered in place.

The import direction is one-way (scrims → slots), so there is no
cycle.

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
by an `elif` chain hanging off the second one. The port is a flat list of
the same eight checks, in the same order.

| # | Guard | Reason | When it runs |
|---|---|---|---|
| 1 | Team name required | `no_team_name` | **Always.** The source searched for `team.*` anywhere in the message, so "steam" satisfies it. Preserved. |
| 2 | Bot mentions rejected | `mentioned bots` | Only when the scrim asks for at least one mention. |
| 3 | Mention count | `insufficient mentions` | Only when the scrim asks for at least one mention. |
| 4 | Banned user | `banned` | **Always.** |
| 5 | Required lines | `no_lines` | **Always.** |
| 6 | One registration per person | `multiregister` | **Always.** |
| 7 | Duplicate team name | `duplicate_name` | **Always.** The name compared is the one `core/team-name.ts` derives. |
| 8 | Duplicate / fake tags | `fake_tag` | **Always.** The overlap of the mentioned ids with `slots.members`. |

**Only the two mention checks depend on `required_mentions`.** Every
other check runs whatever the scrim asks for.

### The `elif` chain, and the bypass it hid

The source's second `if` was
`scrim.required_mentions and not all(mentions are humans)`, and the
whole `elif` chain hung off it:

```python
if scrim.required_mentions and not all(...bot...):
    ...                      # the bot-mention refusal
elif not len(message.mentions) >= scrim.required_mentions:
    ...                      # too few mentions
elif message.author.id in await scrim.banned_user_ids():
    ...                      # banned
elif len(message.content.splitlines()) < scrim.required_lines:
    ...                      # not enough lines
elif not scrim.multiregister and message.author.id in get_slots(...):
    ...                      # already registered
elif scrim.no_duplicate_name:
    ...                      # duplicate name
elif not scrim.allow_duplicate_tags:
    ...                      # fake tag
```

In Python an `elif` chain runs when the `if` is **false**. So the chain
ran whenever the scrim asked for no mentions, and it did *not* run when
somebody mentioned a bot — the bot-mention reason simply won, because it
was the `if`.

The first port of this file misread that shape and made the chain
conditional on the `if` being **true**. On a scrim with
`required_mentions = 0` that skipped guards 3–8 entirely: **a banned
user could register**, a duplicate team name was allowed, and the
one-registration-per-person rule did not apply. That is a bypass, not a
quirk, and it is closed.

The port is now a flat list, and the first match wins. The source's
"the bot-mention reason wins" case is reproduced by the **ordering**
(guard 2 comes before the rest) rather than by a chain, and every other
check is unconditional.

`requirements.test.ts` proves it: a scrim with `required_mentions = 0`
refuses a banned user, and the matrix is compared guard-by-guard so a
guard cannot be wrapped in a condition again.

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

**The editor has no room for a twenty-first field.** It is exactly 25
components, which is Discord's limit for one message, so a field that
is not one of the twenty lives in a sub-panel: the **Auto Slotlist**
switch is in the design panel, not here.

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
| Design | The open message, the close message, the slotlist design, and the **Auto Slotlist** switch. |
| Slotlist | The manager's preview of the list, with the **slot area's** row — Edit, Punish, Info — and the way back to the manager panel. |

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

### The ban log

`/scrims banlog` is the setup surface the `ban_logs` table was missing.
The table is one row per guild (`UNIQUE (guild_id)`), so setting the
channel again replaces the row.

| Invocation | What it does |
|---|---|
| `/scrims banlog` | Shows the channel the ban log goes to, or says that none is set. |
| `/scrims banlog channel:#scrim-logs` | Sets it. The bot must be able to see the channel and send messages in it. |

The channel is written to by `views/ban-log.ts`, on every ban and every
unban: a ban from the ban panel, an unban from the ban panel, an unban
from `/scrims unban`, and a ban whose time was up. **The write never
fails the ban** — the ban is already in the database by the time the log
is written, and every failure in the log path is swallowed.

**A punish is the slot area's.** The published slot list — and with it
the **Punish** button — belongs to the slot area, so the punish flow and
its ban log entries live there (`modules/slots/ban-log.ts`). Both areas
write to the same `ban_logs` channel, so the trail is one trail. This
area used to carry a second, unreachable copy of the punish flow; it is
gone.

The source wrote the same entries to the same kind of channel; what it
did not have is a way to *choose* the channel per guild without a
config file.

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

**The slotlist template does not govern the published list.** The
published list is rendered by the slot area, which has no template of
its own, so a design set here shows in the `/scrims slotlist` post and
nowhere else — not in the published message, and not in the manager's
preview either, whose body is a plain list. One renderer for the
preview and the published list is the next step; the `<<keyword>>`
engine moves into `core/` so the two areas share it.

---

## The premium gates

| Gate | Feature |
|---|---|
| `PremiumFeature.scrimSlots` | The reactions, the required lines, the duplicate-tag toggle, and the free-tier allowance of **3 scrims**. |

The allowance is read from `FREE_TIER` (D45), never from a literal. The
entitlement check happens **before** the state mutation (D15).

**The gate is `modules/premium/`.** The scrims area calls
`assertEntitled(guildId, feature)` and `isEntitled(guildId, feature)`
from `modules/premium/index.js` and nothing else. The expiry is
evaluated **lazily at read time** — `enabled AND (expires_at IS NULL OR
expires_at > now())` — so a lapsed entitlement stops being a gate the
moment it lapses, not when a sweep last ran.

There is **no** local stand-in any more, and nothing in this area reads
the `guild_entitlements` table: `assertEntitled` is the only place a
gate is read. The earlier stand-in (`modules/scrims/entitlements.ts`)
has been deleted.

**`canUseScrimMod` is still a local stand-in.** The brief says the mod
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
- The **one reason** the port reports where the source dispatched up to
  two deny events.
- The **role-name lookup** for the `scrims-mod` role. D16 forbids name
  lookups in general, but this role is a guild-wide convention with
  nowhere in the schema to store its id. It is **kept on purpose**: the
  role name is the constant `SCRIM_MOD_ROLE_NAME` in `guards.ts`, used
  by the lookup, by the refusal message and by the listener that skips a
  scrim moderator's own messages. It is *additive* — the `Moderator`
  staff role and the Administrator permission also pass.
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
  service.ts      the state machine, the rules, and this area's channel cache
  guards.ts       the scrim mod guard
  listeners.ts    the MessageCreate registration intake
  jobs.ts         the durable job handlers
  register.ts     registerScrims / registerScrimsInteractions
  commands/       the slash command definitions
  views/          the panels and their handlers
  README.md       this file
```

**The rule that matters:** no SQL outside `repo.ts`, no `client.` calls
outside `views/` and `listeners.ts`, no Discord ids parsed as numbers.

### The channel cache

The cache itself is `core/channel-cache.ts` (D21) — one implementation,
shared with the tournaments area. `modules/scrims/service.ts` owns the
**scrims instance**, because a scrim registration channel and a tourney
registration channel are different things: a listener that finds no
record for a cached channel removes it from the cache, so a shared set
would let one area evict the other area's channels.

---

## What is not ported

| Thing | Why |
|---|---|
| The source's full visual embed builder | The design editor is a **modal** with three fields (title, description, footer) instead. It writes the same `jsonb` and the same keywords; it just does not have the source's drag-and-drop UI, which lived in a generic embed-builder cog rather than in the scrims area. |
| The registration countdown message (`cdn.msg`) | The column and the template exist and are read back into the record, but **nothing sets them and nothing renders them**: the source's countdown button was commented out of its own design panel, so the source never had a live countdown either. The port's `cdn` is therefore always the column default — `{status: false, countdown: 3, msg: {}}` — and the registration countdown does not exist. |
| `setup_logs` — creating the `quotient-scrims-logs` channel and the `scrims-mod` role | The source created both on the first scrim. Ours stores what it needs by id and the scrim mod role is a guild-wide convention, so there is nothing to create. The ban log channel is configured with **`/scrims banlog`**, which sets the per-guild row in `ban_logs` (or shows the current one). || `show_time_elapsed` | S11: the column was never read. `time_elapsed_seconds` is always stored and always shown. |
| Adding a scrim to a slot manager | That belongs to the slot-manager area, which owns the `slot_manager_scrims` join table. |

### The columns that are honoured but not in the editor

| Column | Where it is set |
|---|---|
| `autoslotlist` | **The design panel** — the "Auto Slotlist: On/Off" switch. The column is honoured when the scrim closes (the slotlist is published), so the switch that sets it had to be somewhere a moderator can reach. It is not one of the editor's twenty fields: the editor is exactly 25 components, which is Discord's limit for one message, and it has no room. |
| `cdn` | **Nowhere.** See the table above — the column is read and written back unchanged, and the countdown does not exist. |
| `autodelete_rejects`, `autodelete_extras` | The editor's "Autodelete rejected" and "Autodelete late messages" toggles. |

---

## The error modes

| Situation | What happens |
|---|---|
| The scrim was deleted while a panel was open | "This scrim no longer exists." |
| Another moderator picked a slot on somebody else's menu | "That menu is not yours." — the pick is refused, and nothing is written. |
| The slot pick expired before the form was submitted | "That form is no longer active." |
| The bot cannot manage the registration channel | "I do not have `Manage Channels` in …" — and the daily job logs the reason. |
| The success role is above the bot's top role | Registration does not open. |
| The wizard expired | "This wizard has expired. Please run the command again." |
| Every slot was taken while somebody was registering | The registration is refused and the scrim closes itself. |
| A ban is already in place | It is skipped, not stacked. The unique constraint makes it idempotent. |
| The entitlement is missing | `PremiumRequiredError`, which is a `DenialError`, so the dispatcher shows it as a refusal rather than a crash. |
