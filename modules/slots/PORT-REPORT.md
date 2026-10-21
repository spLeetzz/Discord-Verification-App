# Area B — Slots: port report

The slot manager is Quotient's "let the members run the slot list
themselves" feature. This area ports the **claim path** — the race the
whole port exists to fix — the cancel, the reminders, the ID-Pass
transfer, the published slot list and its panel, and the setup and the
editor of a slot manager.

Everything lives in `modules/slots/`, plus one thin adapter at
`commands/esports/slots.ts`.

**Status: complete.** `npm run typecheck` passes for these files, the
56 tests in this area pass, and `npm run smoke` is still 106/106.

---

## 1. The command surface

One file, `commands/esports/slots.ts`, one line:

```ts
export { slotManagerCommand as default } from "../../modules/slots/commands/index.js";
```

The definitions live in `modules/slots/commands/index.ts`. The command
is **staff-only** and **public** (D43).

| Subcommand | What it does |
|---|---|
| `/slotmanager setup` | Picks the scrims, confirms, creates the read-only channel, posts the public panel, records the manager. |
| `/slotmanager edit` | Picks a slot manager and opens its editor (the same editor the buttons open). |
| `/slotmanager list` | Lists the server's slot managers. |
| `/slotmanager slotlist show` | Publishes the slot list of a scrim, or refreshes the published one. |
| `/slotmanager slotlist punish` | Bans the teams of the chosen slots, with the four-mode matrix. |
| `/slotmanager slotlist info` | Shows who is in a slot. |

The **public slot message is public by definition**: it is posted into
the channel with `channel.send`, never as a reply to the interaction,
so it is public whatever the dispatcher's ephemeral flag does. The
cancel flow's **confirm prompt is public too** (D43) — that is the one
flow that defers without the ephemeral flag.

### The panel's custom ids

`slots:<action>[:<payload>]` — never an id whose owner is guessed from
its shape (D7). The payload is the **record** the id refers to, so a
panel survives a restart (D18):

| Id | Payload | What it does |
|---|---|---|
| `slots:claim:<managerId>` | the slot manager | The claim flow. |
| `slots:cancel:<managerId>` | the slot manager | The cancel flow. |
| `slots:remind:<managerId>` | the slot manager | The reminder flow. |
| `slots:idp:<managerId>` | the slot manager | The ID-Pass transfer. |
| `slots:slotlist_edit:<scrimId>` | the scrim | The slot list's editor. |
| `slots:slotlist_punish:<scrimId>` | the scrim | The punish flow. |
| `slots:slotlist_info:<scrimId>` | the scrim | The info flow. |
| `slots:slotlist_add:<scrimId>` | the scrim | Add a team. |
| `slots:slotlist_remove:<scrimId>` | the scrim | Remove a team. |
| `slots:slotlist_change:<scrimId>` | the scrim | Change a team. |
| `slots:manager_*:<managerId>` | the slot manager | The editor's buttons. |
| `slots:pick:<token>` | a **token** | A choice in a flow. |
| `slots:modal_*:<token>` | a **token** | A form in a flow. |

Two kinds of payload, and the difference is the point: a **record id**
for anything that refers to a row, a **token** for the state of a flow
that is mid-flight and has no row yet.

### The published slot list's public API

The slot area owns the slot-list panel; the scrims area owns the scrim
lifecycle and publishes the list through this API, so there is one
implementation of what a published slot list looks like.

```ts
// modules/slots/index.ts
export async function publishSlotList(scrimId: string, channelId?: string): Promise<string | null>;
export async function refreshSlotListMessage(messageId: string): Promise<void>;
export function buildSlotListPanel(scrimId: string): ActionRowBuilder<ButtonBuilder>[];
export function buildSlotListEmbed(scrim, slots): EmbedBuilder;
```

- **`publishSlotList`** sends the message, records its id in
  `scrims.slotlist_message_id` (**this area is the only writer**) and
  returns the id. It answers `null` when there is nothing to publish:
  no scrim, no channel, or no team in the scrim. It is idempotent — a
  scrim that already has a published list is re-rendered in place
  rather than sent twice.
- **`refreshSlotListMessage`** re-renders a published message, found
  through the scrim row that holds its id.
- **`buildSlotListPanel`** hands the panel rows to an area that renders
  the message itself; the buttons are still this area's, so they are
  answered here.

The client these need is captured once, when the area is registered
(`registerSlotsListeners(client)`), so a caller does not have to thread
it through.

---

## 2. The claim path

The claim is a race, and the database settles it.

```
public panel ──"Claim Slot"──▶ pick the scrim and the slot number
                                        │
                                        ▼
                              the claim form
                    (team name + teammate mentions)
                                        │
                                        ▼
        UPDATE slots SET state='claimed', team_name=$3,
               owner_user_id=$4, members=$5
         WHERE scrim_id=$1 AND num=$2 AND state='free'
         RETURNING id;
```

- **Zero rows updated ⇒ somebody else won.** There is no lock, no
  `available_slots` array, no join table and no read-modify-write. The
  source protected this with a module-global `asyncio.Lock` that died
  with the process, so two users could own one slot.
- The claim form collects the **teammate mentions**, like the
  registration flow does, and they are written into `slot_members` in the
  same transaction that claims the slot.
- The checks run **before** the statement: the scrim exists, the member
  is not banned, the member does not already hold a slot (unless
  multi-claim is on), and the team name is usable.
- The scrim's role is given to the claimer after the claim.

The claim is asserted in `modules/slots/repo.test.ts` against the live
database: the test reads the statement the database receives
(`buildClaimStatement(...).toSQL()`), checks that it is one
`update "slots"` with the three predicates and no `select` anywhere,
and then proves that the second claim of the same slot updates nothing
while the first owner stays the owner.

### Why the module has its own small select mechanism

`core/select.ts`'s `awaitSelect` **consumes** the select interaction,
and Discord does not allow a modal after a reply (`showModal` throws
"Cannot show modal after deferring or replying to an interaction").
Three flows need a form *after* a choice — the claim, the punish and
the moderator's team forms — so `modules/slots/views/pick.ts` has a
small mechanism of its own: a **persistent** select menu whose custom
id carries a token. The menu's interaction is fresh when the member
picks, so the handler may open the modal from it.

`awaitSelect` is used everywhere a form is **not** needed: the cancel's
slot picker, the reminder's scrim picker, the ID-Pass slot and teammate
pickers, the info picker.

---

## 3. The state machine

A slot is a **row** in `slots` with a `state` column (D14). There is no
`available_slots` array and no join table.

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
| `free` | `claimed` | a member | the conditional `UPDATE` |
| `free` | `claimed` | a moderator | the same statement ("Add Team") |
| `claimed` | `free` | the owner | the conditional `UPDATE` (the cancel) |
| `claimed` | `free` | a moderator | "Remove Team" |
| `claimed` | `claimed` | the owner | the ID-Pass transfer (the ownership moves) |
| `locked` / `banned` | `free` | a moderator | the scrims area's machine |

The cancel statement, verbatim:

```sql
UPDATE slots
   SET state='free', team_name=null, owner_user_id=null, members='{}'
 WHERE id=$1 AND owner_user_id=$2;
```

The `owner_user_id` predicate is what stops one member from cancelling
another member's slot.

### The rules that are load-bearing

1. **The role rule.** Cancelling removes the scrim's role only when it
   was the member's **last** slot in that scrim. The count is read
   *before* the release, excluding the slot being cancelled, because
   that slot is still claimed at that moment. A member with two slots
   keeps the role until the second one goes too.
2. **The reminder is one-shot.** The row is deleted when it fires, so
   nobody is reminded about the same scrim twice. The reminder is a
   durable row — **there is no `setTimeout` anywhere in this module.**
3. **The window.** The panel covers the scrims whose registration has
   closed **today** and whose match has not started. The source used
   this rule in all three places the panel appears (claim, cancel,
   reminder), so it is a deliberate same-day rule and it is ported as it
   is. With D26 the "registration is closed" half is `status='closed'`
   and the "closed today" half is `closed_at > midnight in IST` (the
   zone, not the server's local time — D30).

---

## 4. The premium gates

Every gate goes through `assertEntitled(guildId, feature)` from
`modules/premium/`, and the check happens **before** the state it
guards changes (D15). A refusal shows the one gate presentation —
`buildPremiumGate(gateReason(feature))` with the upgrade button (D29).
Nothing is silently disabled.

| Feature | What it opens | Where |
|---|---|---|
| `slot_reminders` | the **Remind Me** button | `views/public.ts` |
| `idp_transfer` | the **Transfer IDP Role** button | `views/public.ts` |
| `extra_channels` | more slot managers than the free tier allows | `views/manager.ts` |

The free-tier allowance is read from the configuration (`FREE_TIER`),
never hard-coded (D45). The feature values are the schema's own
(`db/schema/common.ts`): `slot_reminders` and `idp_transfer`.

---

## 5. The source bugs this area fixed rather than ported

| # | What it was | What it does now |
|---|---|---|
| **B1** | The claim race, guarded by a process-global `asyncio.Lock` that died with the process (and never protected a second bot process). | The claim is one conditional `UPDATE … WHERE state='free'`. Zero rows updated means somebody else won. No lock, no array, no read-modify-write. |
| **B2** | The "Remind Me" filter removed the matches from the list it was iterating, so **every second match survived**. | The excluded ids go into a `Set` and the candidates are filtered against it. Every match is excluded and none is skipped. Proved by a test that bans three scrims and expects nothing left. |
| **B3** | The claim recorded only the claimer as a member, so the ID-Pass transfer could never find a teammate — **the feature had never worked**. | The claim form collects the teammate mentions and they are written to `slot_members` in the same transaction as the claim. |
| **B4** | "Add Team" offered `range(start_from, 30)` — a hard-coded thirty that ignored `total_slots` and offered numbers the scrim did not have. | The numbers offered are the scrim's own: `start_from … start_from + total_slots - 1`. |
| **B9** | The ID-Pass transfer removed the captain from `slot.members` **in memory only**; the database kept listing the old captain. | The transfer writes the new owner **and** the new member list back. |
| **B10** | `guild.get_member()` may be null; the source crashed on it inside a detached task. | The members that cannot be resolved are dropped, and the member is told when nobody is left. |
| **B5** | The source's error reply did not `return`, so execution continued into a failure. | Every refusal returns. |
| **B6** | `ephermeral=True` — a typo that raised a `TypeError`. | `MessageFlags.Ephemeral`. |
| **B7** | The refusal said "Cancel Reminder" for the remind feature. | "You can't set reminder in any scrim at this time." |
| — | The punish flow asked for a free-text reason with a chat-message collector, and the ban type was a **four-keycap button row with no stable custom id** — the ban type could not be routed at all. | The ban type is a **select menu** and the reason and the duration are asked for in a **modal** (D17). All four modes are kept. |
| — | The claim's teammate list was never persisted at all. | The member rows are written in the same transaction as the claim, so the team is there with the slot or not at all. |
| — | The "Change Team" flow left the previous captain with the ID/Pass role. | The old leader's role is removed when they hold no other slot in that scrim — the same rule the cancel uses. |

### Preserved deliberately

| What | Why |
|---|---|
| The "Main Channel can't be edited. Sorry 🥲" button. | A deliberate stub in the source. Ported with the same message; **no channel-rename flow was invented.** |
| The four ban modes, as four distinct behaviours. | Real behaviour; all four are kept (`planBan`). |
| The same-day window. | The source used it consistently in all three places the panel appears. |
| The `scrims-mod` role-name check. | A guild-wide convention with nowhere to live in the schema. It is additive: the `Moderator` staff role and Administrator also pass. |

---

## 6. The tests

64 tests in four files, all passing.

| File | What it pins down |
|---|---|
| `modules/slots/service.test.ts` | The rules: the claim, the member list, the role rule, the reminder filter, the ID-Pass refusal, the ban matrix, the slot numbers, the window, the start of the day. |
| `modules/slots/repo.test.ts` | The claim and the cancel **against the live database**: the statement the database receives, a free slot claimed, a taken slot refused, the member list persisted, only the owner may release, the last-slot count, and the schema's own "a claimed slot has an owner" constraint. |
| `modules/slots/ids.test.ts` | The custom-id scheme, the panel builders, and the registration. |
| `modules/slots/slotlist.test.ts` | The published slot list's public API: the panel the message carries, the message id on the scrim row, "nothing to publish" answered with `null`, the idempotent publish, and the refresh. |

The brief's five requirements, and where each is proved:

| Requirement | Where |
|---|---|
| A free slot is claimed, a taken slot is refused, and the conditional UPDATE is the mechanism (the query is asserted, not just the outcome). | `repo.test.ts` — "the claim statement", "claims a free slot", "refuses a slot somebody else already took". |
| The member list persists the mentions. | `repo.test.ts` — "persists the member list"; `service.test.ts` — "writes the teammate mentions into the member list". |
| The cancel removes the role only when it was the user's last slot in that scrim. | `service.test.ts` — the three "the cancel" tests. |
| The reminder filter excludes banned, already-reminded and own-slot scrims, and does not skip every second match. | `service.test.ts` — the five "the reminder filter" tests. |
| The ID-Pass transfer refuses when no teammate was mentioned. | `service.test.ts` — "refuses when no teammate was mentioned". |

---

## 7. Decisions I made, and the ones that need the manager

### Decisions I made

1. **`commands/esports/slots.ts`, not `slotmanager.ts`.** `wave3.md`
   says Area B owns `commands/esports/slotmanager.ts`; the brief says
   `commands/esports/slots.ts`. I followed the brief. The file's name
   does not matter to the loader — the command's *name* does, and that
   is `/slotmanager` either way.
2. **The slot list is published and refreshed by this area**, with a
   panel of its own (`slots:slotlist_*`). The scrims area published the
   same message with a panel of its own (`scrims:slotlist:*`).
   **Resolved by the manager: this area's panel is the keeper** — see
   §7.1.
3. **The command's punish flow asks for the ban type and the duration
   from select menus, and has no free-text reason.** A slash command is
   deferred by the dispatcher before the command body runs, and Discord
   does not allow a modal after a defer — so a command has no way to ask
   for a line of free text. The slot list's **Punish** button has the
   full flow, with a modal for the reason and the duration. This is a
   forced consequence of the runtime, not a choice.
4. **A moderator-added team with no leader** is stored with the
   placeholder owner `"0"` (`MODERATOR_OWNER_ID`), because the schema
   forbids a claimed slot without an owner
   (`CHECK (state <> 'claimed' OR owner_user_id IS NOT NULL)`). A
   snowflake is never `"0"`, so the placeholder can never be a real
   member, and the info panel renders it as "added by a moderator",
   exactly as the source did.
5. **The ban expiry** writes `banned_teams.expires` and arms a
   `scrim_ban` job whose payload shape (`{ scrimIds, userIds }`) is the
   one the scrims area's handler reads. The ban itself is a durable
   row; the scheduler is the `jobs` table, never a `setTimeout`.
6. **The match-time editor is not ported here.** The source's slot
   manager had a "Match Time" button that set `scrims.match_time`; that
   column and the match-time lock belong to the scrims area.

### For the manager

1. **Two slot list panels — resolved.** The manager's decision: this
   area's panel is the keeper (it has the four-mode ban matrix, the
   modal for the reason, and the `total_slots` bound for "Add Team"),
   and the scrims area's `scrims:slotlist:*` panel is gone. The
   resolution is **not** "delete the scrims area's code": this area
   owns the panel, the scrims area keeps the lifecycle, and the scrims
   area publishes and refreshes through this area's public API —

   ```ts
   export async function publishSlotList(scrimId: string, channelId?: string): Promise<string | null>;
   export async function refreshSlotListMessage(messageId: string): Promise<void>;
   export function buildSlotListPanel(scrimId: string): ActionRowBuilder<ButtonBuilder>[];
   ```

   — so there is one implementation of what a published slot list looks
   like, and one namespace (`slots:slotlist_*`) for its buttons. The
   import direction is one-way (scrims → slots), so there is no cycle.
   The scrims area's follow-up is listed in the README.
2. **`scrims.slotlist_message_id` is written by this area, and only by
   this area.** `publishSlotList` records the message it sent. The
   scrims area must stop writing the column: two writers means
   whichever re-renders last wins, and a message id that points at a
   message nobody can edit.
3. **D43 is implemented in the dispatcher.** `handlers/interactions.ts`
   honours `command.ephemeral` and runs `command.guards`, so
   `/slotmanager` is declared `ephemeral: false` and `staffOnly: true`
   and the behaviour is what the brief asks for. The public slot panel
   is posted with `channel.send`, so it is public regardless. The
   manager editor's **buttons** check the caller themselves
   (`canManageSlotManager`), because the panel can be seen by anybody
   who can read the channel it is in — the source showed the editor as
   an ephemeral message, so only the moderator could ever press a
   button.
4. **The premium module was in flight when I started.** It has landed:
   `assertEntitled(guildId, feature)` exists with the documented
   signature, and I used it for all three gates. `core/premium.ts`'s
   `FREE_TIER` is the source of the slot-manager allowance.

---

## 8. What is not finished

Nothing in the brief is outstanding. One thing is deliberately out of
scope and is listed above: the match-time editor (the scrims area's
column).

The command's punish flow has no free-text reason, for the reason given
in §7.3 — the panel's Punish button has the full flow. That is a
Discord limitation, not a gap: a command is deferred before its body
runs, and Discord forbids a modal after a defer.

---

## 9. The follow-up: the ban log

The ownership move left a hole. The scrims area's punish flow is now
only reachable from the messages it rendered before the handoff, and
**this area's Punish button writes no ban log at all** — so every ban a
moderator performs through the published slot list stopped leaving a
trace. The `ban_logs` table is shared, so this area can write it
without importing the scrims area, and it does.

### What was built

| File | What it is |
|---|---|
| `ban-log.ts` | The writer: the entry, the embed, and the write. It never throws. |
| `jobs.ts` | The `scrim_ban` handler — the ban whose time is up. |
| `repo.ts` | `getBanLogChannel`, `listBans`, `unbanUser`, and the job payload readers. |
| `service.ts` | `unbanUsers` — the rule of an unban, testable without a database. |
| `views/slotlist.ts` | `punishSlots` writes the log; `unbanSlots` lifts the bans and writes the log. |
| `commands/index.ts` | `/slotmanager slotlist unban`. |

### The semantics, and how they match the scrims area's

- **One entry per ban.** A ban is a (scrim, member) pair, and the log
  has one entry per pair — the count the scrims area's own unban and
  expiry paths leave. A punish that bans a team from every scrim of the
  server therefore leaves one entry per pair.
- **The same embed.** The title (`🔨 Banned` / `🔓 Unbanned`), the
  colour, and the fields — User, Scrim, Until, and Reason and Moderator
  when there is one. The scrims area's writer was read for the content;
  the code here is this area's own, because the dependency runs
  scrims → slots and an import back would be a cycle.
- **The same table.** `ban_logs` is one row per guild, and this area
  only **reads** it. `/scrims banlog` still owns the row.
- **The unban entry carries the ban's reason and expiry**, read from
  the row before it is deleted. The scrims area's `/scrims unban`
  carries the moderator's reason instead; a command cannot ask for free
  text (Discord forbids a modal after a defer), so the reason the ban
  was given is the one that is known.

### The failure behaviour

**The write never fails the ban.** The ban row is in the database before
the log is written, every failure in the log path is swallowed and
logged as a warning, and the moderator's ban stands either way. The same
is true of the unban: the row is already gone by the time the entry is
written. A ban that is applied but not logged is recoverable; a ban that
is refused because a log write failed is not.

### The tests

`ban-log.test.ts`, twelve tests against the live database and a fake
Discord:

| Test | What it pins down |
|---|---|
| "writes a ban log entry" | The punish writes the entry, with the user, the scrim, the reason and the moderator. |
| "writes one entry per ban" | A team ban leaves two entries, and the "Until" field carries the expiry. |
| "does not fail the ban when the log cannot be written" | The channel throws; the ban is still in the database. |
| "does not fail the ban when the guild has no ban log channel" | No row, no entry, and the ban still stands. |
| "writes an unban entry" / "lifts the ban" | The unban writes the entry and the row goes. |
| "says nothing about a member who was not banned" | No ban, no entry. |
| "writes an unban entry and lifts the ban" | The `scrim_ban` job leaves the same trail a manual unban does. |
| "reads the payload the scrims area writes, without doubling the entry" | The scrims area's superset payload is read, and a scrim named twice leaves one entry. |

### For the manager

1. **`handlers/listeners.ts` has to route `scrim_ban` to this area.** The
   handler is `handleSlotsJob(client, event, payload)`, exported from
   `register.ts`; the area entry needs `job: "Slots"` and
   `jobEvents: ["scrim_ban"]`. Until it is wired, the expiry runs
   through the scrims area's handler, which writes the same trail with
   its own writer — the trail does not break, it is just not written by
   this area.
2. **`/slotmanager slotlist unban` overlaps `/scrims unban`.** The
   scrims area's ban panel is only reachable from stale messages, so the
   unban a moderator needs for a slot-list ban lives here. The scrims
   area's command still works and still writes the log. If one surface
   is wanted, `/scrims unban` is the one to drop.
3. **One implementation of the writer, if it is wanted.** This area
   exports `writeBanLog` / `writeBanLogs` from `index.ts`, so the
   scrims area can drop its own copy and import this one — the
   dependency already runs that way.
