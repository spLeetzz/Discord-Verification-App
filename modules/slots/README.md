# `modules/slots/` — the slot manager

The slot manager is Quotient's "let the members run the slot list
themselves" feature. A moderator creates a **slot manager**: a read-only
channel with a public panel in it. From that panel a member can

- **claim** a free slot,
- **cancel** a slot they hold,
- **ask to be reminded** when a slot frees up (premium),
- **hand their slot to a teammate** (premium),

and a moderator can, from the scrim's **published slot list**, change a
team, add a team, remove a team, ban a team and look up who is in a
slot.

This module owns the **claim path** — the race the whole port exists to
fix.

---

## The public interface

### The command

`/slotmanager` (in `commands/esports/slots.ts`; the definitions live in
`modules/slots/commands/index.ts`).

| Subcommand | What it does |
|---|---|
| `setup` | Picks the scrims, creates the channel, posts the public panel and records the manager. |
| `edit` | Picks a slot manager and opens its editor. |
| `list` | Lists the slot managers of the server. |
| `slotlist show` | Publishes (or refreshes) the slot list of a scrim. |
| `slotlist punish` | Bans the teams of the chosen slots of a scrim. |
| `slotlist unban` | Lifts the bans of a scrim. |
| `slotlist info` | Shows who is in a slot. |

The command is **staff-only** and **public** (D43). The public slot
message is public by definition; it is posted into the channel with
`channel.send`, not as a reply to the interaction, so it is public
whatever the dispatcher's ephemeral flag does.

### The custom ids

Every id is `slots:<action>[:<payload>]` and the payload is the record
the id refers to, so a panel survives a restart (D18).

| Id | Payload | What it does |
|---|---|---|
| `slots:claim:<managerId>` | the slot manager | Opens the claim flow. |
| `slots:cancel:<managerId>` | the slot manager | Opens the cancel flow. |
| `slots:remind:<managerId>` | the slot manager | Opens the reminder flow. |
| `slots:idp:<managerId>` | the slot manager | Opens the ID-Pass transfer. |
| `slots:slotlist_edit:<scrimId>` | the scrim | Opens the slot list's editor. |
| `slots:slotlist_punish:<scrimId>` | the scrim | Opens the punish flow. |
| `slots:slotlist_info:<scrimId>` | the scrim | Opens the info flow. |
| `slots:slotlist_add:<scrimId>` | the scrim | Adds a team to a slot. |
| `slots:slotlist_remove:<scrimId>` | the scrim | Removes a team from a slot. |
| `slots:slotlist_change:<scrimId>` | the scrim | Changes the team of a slot. |
| `slots:manager_*:<managerId>` | the slot manager | The editor's buttons. |
| `slots:pick:<token>` | a **token** | A choice in a flow. |
| `slots:modal_*:<token>` | a **token** | A form in a flow. |

Two kinds of payload, and the difference matters:

- a **record id** for anything that refers to a database row. It
  survives a restart, a message being moved and a message being edited.
- a **token** for the state of a flow that is mid-flight and has no row
  yet — the slot a member picked, the ban mode, the reason that was
  typed. A token is only meaningful to the process that issued it, and
  it expires.

The router dispatches on the `slots` prefix and **never guesses** an
owner from the shape of an id (D7).

**The slot list's buttons are `slots:slotlist_*`, and that is the only
namespace for them in the bot.** The scrims area used to publish a slot
list of its own with `scrims:slotlist:*` buttons; two panels on one
message is a bug waiting to happen — whichever re-renders last wins — so
that one is going away. After the follow-up below, the scrims area
publishes and refreshes through `modules/slots/`, and its own
`scrims:slotlist:*` buttons are answered by nobody.

### The published slot list's public API

The slot list is a **message in a channel**, and two areas want it: the
slot area (a moderator edits a team from it) and the scrims area (a
scrim closes, and its slot list is published). The rule that keeps the
two from fighting over one message is:

> **The slot area owns the panel. The scrims area owns the lifecycle.**

The slot area owns the buttons, their custom ids (`slots:slotlist_*`)
and the edit, punish and info operations behind them. The scrims area
owns open, close, the daily `scrim_open` job and the autoclean — and
with them the moment a scrim closes with `autoslotlist` on and its slot
list has to be published. It publishes it **through this area**, so
there is one implementation of what a published slot list looks like
and one namespace for its buttons.

The import direction is one-way — the scrims area calls the slot area,
never the other way round — so this creates no cycle.

```ts
import {
  buildSlotListPanel,
  publishSlotList,
  refreshSlotListMessage,
} from "../slots/index.js";
```

| Function | What it does |
|---|---|
| `publishSlotList(scrimId: string, channelId?: string): Promise<string \| null>` | Publishes the scrim's slot list and returns the message id, or `null` when there is nothing to publish. |
| `refreshSlotListMessage(messageId: string): Promise<void>` | Re-renders an already-published slot list message. |
| `buildSlotListPanel(scrimId: string): ActionRowBuilder<ButtonBuilder>[]` | The panel rows for a scrim's slot list, for an area that renders the message itself. |
| `buildSlotListEmbed(scrim, slots): EmbedBuilder` | The body of a published slot list, for an area that renders the list itself. |

**"Nothing to publish"** is one of three things, and all three answer
`null` rather than throwing: the scrim does not exist; the channel
cannot be found; or **no team has claimed a slot** — a slot list with
no teams in it says nothing, so one is not published.

**Publishing is idempotent.** When the scrim already has a published
slot list, that message is re-rendered in place instead of a second one
being sent: a second message would be an orphan, because the row
remembers only one id.

The client these functions need is captured once, when the area is
registered (`registerSlotsListeners(client)`), so a caller does not have
to thread it through. A publish or a refresh before the area is
registered is a no-op, not a crash.

**The body of the published message is this area's too.** The scrims
area renders its own slot list from the scrim's `slotlist_format`
template (D32), and that template still governs the scrims area's own
manager preview. It does **not** govern the published slot list: the
published message is rendered by `buildSlotListEmbed` here, so a slot
list looks the same whoever published it.

**What the scrims area has to change** (a follow-up, on their side):

1. `views/slotlist.ts` — drop `publishSlotlist` and
   `refreshSlotlistMessage`, and the button row of
   `buildSlotlistPanel`. Call `publishSlotList`,
   `refreshSlotListMessage` and `buildSlotListPanel` from
   `modules/slots/index.js` instead.
2. `jobs.ts` (`publishAndStore`) — call `publishSlotList(scrim.id)` and
   **stop writing `scrims.slotlist_message_id`**.
3. `views/lifecycle.ts` — the close flow publishes through
   `publishSlotList`.
4. `views/button-handlers.ts` — the "Repost Slotlist" button publishes
   through `publishSlotList`.

### The exported functions

| Module | What it exposes |
|---|---|
| `index.ts` | The area's public surface: the published slot list's API and the ban log. |
| `SLOTLIST-API.md` | The handoff note for the scrims area: the API, the follow-up, the two rules. |
| `types.ts` | The domain types, the four ban modes and the `SlotStore` port. |
| `repo.ts` | Every SQL statement of this area, and the `slotStore` that implements the port. |
| `service.ts` | The state machine and the rules. |
| `slotlist.ts` | The published slot list's **public API**: publish, refresh, the panel. |
| `ban-log.ts` | The ban log: the entry, the embed and the write. |
| `jobs.ts` | The `scrim_ban` handler: the ban whose time is up. |
| `mentions.ts` | Reading member ids out of free text. |
| `ids.ts` | The custom-id scheme. |
| `client.ts` | The Discord client the area was registered with. |
| `views/panel.ts` | The public panel's body, buttons and refresh. |
| `views/public.ts` | The public panel's handlers. |
| `views/slotlist.ts` | The published slot list, its panel, and the ban operations. |
| `views/manager.ts` | The setup and the editor. |
| `views/modals.ts` | The forms. |
| `views/pick.ts` | The choice-then-form mechanism. |
| `register.ts` | `registerSlotsInteractions()` and `registerSlotsListeners(client)`. |

---

## The ban log

A guild's ban log channel is configured with `/scrims banlog` and stored
in `ban_logs` — one row per guild, holding the channel that receives the
ban and unban entries. **This area reads that row and writes the
entries** (`ban-log.ts`); it never writes the row, so there is one
answer to "where does the log go".

The slot area owns the published slot list, so it owns the **Punish**
button on it — the flow a moderator actually uses to ban a team. A ban
made through that button has to leave the same trail a ban made anywhere
else leaves, or the log stops being an audit trail of anything.

| Path | What it writes |
|---|---|
| The punish flow (`views/slotlist.ts`, `punishSlots`) | One entry per ban. |
| The unban flow (`views/slotlist.ts`, `unbanSlots`) | One entry per unban. |
| The ban that ran out (`jobs.ts`, `scrim_ban`) | One entry per unban. |

**A ban is a (scrim, member) pair, and the log has one entry per pair.**
That is the count the scrims area's own unban and expiry paths leave,
and it is what makes the log say *from what* a member was banned: a
punish that bans a team from every scrim of the server leaves one entry
per pair.

**The write never fails the ban.** The ban row is already in the
database by the time the log is written, and a moderator's ban has to
happen: a log that cannot be written is a nuisance, a ban that does not
happen is a hole. Every failure in the log path is swallowed and logged
as a warning — the channel was deleted, the bot lost the permission, the
database is down. The same is true of the unban: the ban row is already
gone by the time the entry is written.

The scrims area has a writer for the bans it makes. This is a second
implementation of the same content, not an import of theirs: the
dependency runs the other way — the scrims area imports this area for
the published slot list — so importing back would be a cycle. The
writer is exported from `index.ts`, so the manager can point the scrims
area at it if one implementation is wanted.

### The ban expiry

A ban with a duration is a row in `banned_teams` with an `expires`
column, and something has to lift it when the time is up. The scheduler
is the `jobs` table — never a `setTimeout`, because a timer that dies
with the process means the ban lasts forever.

- The event is `scrim_ban` and the payload is
  `{ scrimIds, userIds }` — what `repo.scheduleBanExpiry` writes.
- The scrims area arms the same event for the bans it makes, with a
  superset of that payload (`scrimId` as well as `scrimIds`). This
  area's handler reads both and **deduplicates**: a scrim that is
  named twice is unbanned once and leaves one entry, not two.
- The handler is `handleSlotsJob(client, event, payload)`, exported from
  `register.ts`. **The manager's registry has to route `scrim_ban` to
  this area** (`handlers/listeners.ts` is not this area's file); until
  it does, the expiry runs through the scrims area's handler, which
  writes the same trail with its own writer.

---

## The state machine

A slot is a **row** in the `slots` table with a `state` column. There
is no `available_slots` array and no join table, so a claim is one
conditional `UPDATE` and the database — not a process-global lock —
guarantees that a slot has exactly one owner (D14).

```
                    claim (the conditional UPDATE)
        ┌──────────────────────────────────────────────▶ claimed
        │                                                │  │
   free │                                                │  │ cancel
        │                                                │  ▼
        │                                                │ free
        │  (moderator: add / remove / lock)             │
        └──────────────────────────────────────────────▶ locked
                                                         banned
```

| From | To | Who | How |
|---|---|---|---|
| `free` | `claimed` | a member | the conditional `UPDATE` from S7 |
| `free` | `claimed` | a moderator | the same statement (the "Add Team" button) |
| `claimed` | `free` | the owner | the conditional `UPDATE` from S7 (the cancel) |
| `claimed` | `free` | a moderator | the "Remove Team" button |
| `claimed` | `claimed` | the owner | the ID-Pass transfer (the ownership moves) |
| `locked` / `banned` | `free` | a moderator | the scrims area's state machine |

The claim statement, verbatim:

```sql
UPDATE slots
   SET state = 'claimed', team_name = $3, owner_user_id = $4, members = $5
 WHERE scrim_id = $1 AND num = $2 AND state = 'free'
 RETURNING id;
```

**Zero rows updated means somebody else won.** There is no lock: the
source protected this with a module-global `asyncio.Lock` that died with
the process, so two users could own one slot.

The cancel statement, verbatim:

```sql
UPDATE slots
   SET state = 'free', team_name = null, owner_user_id = null, members = '{}'
 WHERE id = $1 AND owner_user_id = $2;
```

The `owner_user_id` predicate is what stops one member from cancelling
another member's slot.

### The rules that are load-bearing

1. **The role rule.** Cancelling a slot removes the scrim's role only
   when it was the member's **last** slot in that scrim. A member with
   two slots keeps the role until the second one goes too. The count is
   read *before* the release, excluding the slot being cancelled,
   because that slot is still claimed at that moment.
2. **The reminder is one-shot.** The row is deleted when it fires, so
   nobody is reminded about the same scrim twice. The reminder itself is
   a durable row — there is no `setTimeout` anywhere in this module.
3. **The window.** The panel covers the scrims whose registration has
   closed **today** and whose match has not started yet. The source used
   this rule in all three places the panel appears (claim, cancel,
   reminder), so it is a deliberate same-day rule and it is ported as it
   is. With D26 the "registration is closed" half is `status = 'closed'`
   and the "closed today" half is `closed_at > midnight in IST`.

---

## The premium gates

Every gate goes through `assertEntitled(guildId, feature)` from
`modules/premium/`, and the check happens **before** the state it
guards changes (D15).

| Feature | What it opens | Where |
|---|---|---|
| `slot_reminders` | the **Remind Me** button | `views/public.ts` |
| `idp_transfer` | the **Transfer IDP Role** button | `views/public.ts` |
| `extra_channels` | more slot managers than the free tier allows | `views/manager.ts` |

The free-tier allowance is read from the configuration (`FREE_TIER`),
never hard-coded (D45). A refusal shows the one gate presentation:
`buildPremiumGate(gateReason(feature))` with the upgrade button (D29).
A feature a user cannot see the existence of is a support ticket, not a
business model — so nothing is silently disabled.

---

## The source bugs this area fixed rather than ported

| # | What | Where | What it does now |
|---|---|---|---|
| B1 | The slot-claim race, guarded by a process-global lock. | `views/public.ts`, `repo.ts` | The claim is one conditional `UPDATE … WHERE state = 'free'`. Zero rows updated means somebody else won. There is no lock, no read-modify-write and no array. |
| B2 | The "remind" filter mutated the list it was iterating, so every second match survived. | `service.ts` (`filterReminderCandidates`) | The excluded ids are collected into a `Set` and the candidates are filtered against it. Every match is excluded; none is skipped. |
| B3 | The claim recorded only the claimer as a member, so the ID-Pass transfer could never find a teammate. **The feature had never worked.** | `views/modals.ts`, `service.ts` (`claimMembers`) | The claim form collects the teammate mentions, like the registration flow does, and they are written to `slots.members`. |
| B4 | The "Add Team" button hard-coded `range(start_from, 30)`, ignoring `total_slots`. | `service.ts` (`slotNumbersOf`), `views/slotlist.ts` | The numbers offered are the scrim's own: `start_from … start_from + total_slots - 1`. |
| B9 | The IDP transfer removed the captain from `slot.members` **in memory only**; the database still listed the old captain. | `service.ts` (`applyIdpTransfer`) | The transfer writes the new owner **and** the new member list back. |
| B10 | `guild.get_member()` may be null; the source crashed on it inside a detached task. | `views/helpers.ts` (`resolveMembers`) | The members that cannot be resolved are dropped, and the caller is told when nobody is left. |
| B5 | The source's error reply did not `return`, so execution continued into a failure. | everywhere | Every refusal returns. |
| B6 | `ephermeral=True` — a typo that raised a `TypeError`. | everywhere | `MessageFlags.Ephemeral`. |
| B7 | The error said "Cancel Reminder" for the remind feature. | `views/public.ts` | "You can't set reminder in any scrim at this time." |
| — | The punish flow asked for a free-text reason with a chat-message collector, and the ban type was a four-keycap button row with **no stable custom id**. | `views/slotlist.ts`, `views/pick.ts` | The ban type is a **select menu** and the reason and the duration are asked for in a **modal** (D17). All four ban modes are kept. |
| — | The claim's teammate list was never persisted. | `repo.ts` (`claimSlot`) | The member list is part of the claim statement, so it is written atomically with the claim. |

### Preserved deliberately

| What | Where | Why |
|---|---|---|
| The "Main Channel can't be edited. Sorry 🥲" button. | `views/manager.ts` | A deliberate stub in the source. Ported with the same message; there is no channel-rename flow. |
| The four ban modes, as four distinct behaviours. | `service.ts` (`planBan`) | Real behaviour, and all four are kept. |
| The same-day window. | `service.ts` (`isWithinSlotWindow`) | The source used it consistently in all three places the panel appears. |
| The `scrims-mod` role name check. | `views/slotlist.ts` | The role is a guild-wide convention with nowhere to live in the schema. It is *additive*: the `Moderator` staff role and the Administrator permission also pass. |

---

## The errors this area can produce

| Refusal | When |
|---|---|
| "No slot available right now." | The scrim has no free slot, or the panel is out of date. |
| "Somebody claimed this slot before you." | The conditional `UPDATE` matched no row. |
| "You are banned from this scrim." | The member is in `banned_teams` for that scrim. |
| "You already have a slot in this scrim." | Multi-claim is off and the member holds one. |
| "Team name cannot be empty." | The typed name holds nothing usable. |
| "You have no slots that can be cancelled." | The member holds no slot in the manager's scrims. |
| "You don't have any slot that can be transferred." | The member holds no slot. |
| "You cannot transfer the ID-Pass role to your teammates because you didn't mention them when you claimed the slot." | The slot's member list holds nobody but the captain. |
| "All your teammates seems to have left the server." | The mentioned members are gone. |
| "You can't set reminder in any scrim at this time." | No scrim is eligible. |
| The premium gate | The guild does not hold the entitlement. |

---

## Notes for the next engineer

- **The command's punish flow cannot ask for a free-text reason. This
  is a Discord limitation, not an oversight — do not try to add a modal
  to the command path.** A slash command is deferred by the dispatcher
  *before* the command body runs, and Discord does not allow a modal
  after a defer (`showModal` throws "Cannot show modal after deferring
  or replying to an interaction"). So a command flow has no way to ask
  for a line of free text, and a modal in a command handler is a crash
  waiting to happen. The command's punish picks the ban type and the
  duration from select menus; the slot list's **Punish** button has the
  full flow, with a modal for the reason and the duration. **Free text
  is routed through the panel, not through the command.**
- **The pick mechanism.** `core/select.ts`'s `awaitSelect` *consumes* the
  select interaction, and Discord does not allow a modal after a reply.
  Three flows need a form *after* a choice, so this module has its own
  small mechanism in `views/pick.ts`: a persistent select menu whose
  custom id carries a token. The menu's interaction is fresh, so the
  handler may open the modal from it. `awaitSelect` is used everywhere a
  form is **not** needed.
- **The overlap with the scrims area is resolved: the slot area owns
  the panel, the scrims area owns the lifecycle.** The scrims area
  published the slot list with a panel of its own (`scrims:slotlist:…`)
  and wrote the same column; the two panels fought over one message,
  and whichever re-rendered last won. That is gone: the panel is
  **this area's**, its custom ids are `slots:slotlist_*` and there is
  one namespace for these buttons across the bot, and the scrims area
  publishes and refreshes through `publishSlotList` and
  `refreshSlotListMessage` (see "The published slot list's public API"
  above). The scrims area must not build a slot list of its own.
- **`scrims.slotlist_message_id` is written by this area, and only by
  this area.** `publishSlotList` records the message it sent; the
  scrims area does not write the column. One writer, one column: two
  writers means whichever re-renders last wins, and a message id that
  points at a message nobody can edit.
- **The ban expiry.** A ban with a duration writes `banned_teams.expires`
  and arms a `scrim_ban` job. **The payload shape is
  `{ scrimIds: string[], userIds: string[] }`** — that is what
  `repo.scheduleBanExpiry` writes. The scrims area's own ban flow writes
  a superset of it (`scrimId`, `scrimIds`, `userIds`, `reason`), and
  this area's `scrim_ban` handler reads both, so the two agree. The
  handler is `handleSlotsJob` (see "The ban expiry" above) and the
  manager's registry has to route the event to it.
- **The ban log has two writers, and that is deliberate.** The scrims
  area writes the entries for the bans it makes; this area writes the
  entries for the bans the published slot list makes. The content is
  the same and the `ban_logs` row is shared, but the code is not shared:
  the dependency runs scrims → slots, so an import back would be a
  cycle. The writer is exported from `index.ts` for the day the manager
  wants one implementation.
- **`/slotmanager slotlist unban` overlaps `/scrims unban`.** The
  scrims area's ban panel is only reachable from the messages it
  rendered before the handoff, so the unban a moderator needs for a
  ban they made through the published slot list lives here. The
  scrims area's own command still works and still writes the log; the
  manager may prefer to keep only one of the two surfaces.
- **A moderator-added team with no leader** is stored with the
  placeholder owner `"0"` (`MODERATOR_OWNER_ID`), because the schema
  forbids a claimed slot without an owner. A snowflake is never `"0"`,
  so the placeholder can never be a real member, and the info panel
  renders it as "added by a moderator", exactly as the source did.
- **The match-time editor is not ported here.** The source's slot
  manager had a "Match Time" button that set `scrims.match_time`; that
  column and the match-time lock belong to the scrims area.
- **The manager editor's buttons check the caller.** The panel can be
  seen by anybody who can read the channel it is in — the source
  showed the editor as an ephemeral message, so only the moderator could
  press a button. `canManageSlotManager` is the check.
