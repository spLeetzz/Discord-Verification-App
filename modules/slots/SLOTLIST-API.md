# The published slot list — the API the scrims area calls

**The rule:** the slot area owns the **panel** (the buttons, their
custom ids, the edit / punish / info operations). The scrims area owns
the **lifecycle** (open, close, `scrim_open`, the autoclean) and
publishes the slot list *through the slot area*, so there is one
implementation of what a published slot list looks like and one
namespace for its buttons.

The import direction is one-way — scrims → slots — so there is no
cycle.

---

## The three functions

```ts
// modules/slots/index.ts  (the area's public surface)

export async function publishSlotList(
  scrimId: string,
  channelId?: string,
): Promise<string | null>;

export async function refreshSlotListMessage(
  messageId: string,
): Promise<void>;

export function buildSlotListPanel(
  scrimId: string,
): ActionRowBuilder<ButtonBuilder>[];
```

Two more are exported, for an area that renders the message itself:

```ts
export function buildSlotListEmbed(
  scrim: { readonly name: string },
  slots: readonly SlotListSlot[],
): EmbedBuilder;
```

### `publishSlotList(scrimId, channelId?)`

Sends the message and returns its id.

- The channel is the scrim's own `slotlist_channel_id`, unless the
  caller names one.
- The message carries the slot area's Edit / Punish / Info panel.
- **Nothing to publish** → `null` (never a throw). That is: the scrim
  does not exist; the channel cannot be found; or **no team has claimed
  a slot** — a list with no teams in it says nothing.
- **It is idempotent.** A scrim that already has a published slot list
  is re-rendered in place, not sent twice. A second message would be
  an orphan, because the row remembers only one id.
- It writes `scrims.slotlist_message_id`.

### `refreshSlotListMessage(messageId)`

Re-renders a published message. The message is found through the scrim
row that holds its id, so a restart does not lose the list. A message
that is gone is a no-op — it is a refresh, not a repair.

### `buildSlotListPanel(scrimId)`

The panel rows: `slots:slotlist_edit`, `slots:slotlist_punish` and
`slots:slotlist_info`, each carrying the scrim id. The buttons are
answered by the slot area, whatever area rendered them.

---

## What the scrims area has to change

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

The scrims area's own `scrims:slotlist:*` buttons are then answered by
nobody. That is the point: there is one namespace for these buttons
across the bot, and it is `slots:slotlist_*`.

**One thing to know:** the *body* of the published message is the slot
area's (`buildSlotListEmbed`). The scrims area's `slotlist_format`
template (D32) still governs the scrims area's own manager preview, but
it does not govern the published slot list — a slot list looks the same
whoever published it.

---

## The two rules

### `scrims.slotlist_message_id` — written by the slot area, only

`publishSlotList` records the message it sent. **The scrims area must
not write the column.** Two writers means whichever re-renders last
wins, and a message id that points at a message nobody can edit.

### The `scrim_ban` job payload — `{ scrimIds, userIds }`

```ts
{ scrimIds: string[]; userIds: string[] }
```

That is what `repo.scheduleBanExpiry` writes, and it is what the
scrims area's `scrim_ban` handler reads (`allScrimIdsOf` for the
scrims, `userIdsOf` for the users). The scrims area's own ban flow
writes a superset of it (`scrimId`, `scrimIds`, `userIds`, `reason`),
and the handler reads both, so the two areas agree.

---

## The client

The client these functions need is captured once, when the area is
registered:

```ts
export function registerSlotsListeners(client: Client): void;
```

The manager's registry already looks for that name. A publish or a
refresh before the area is registered is a no-op, not a crash — so a
caller does not have to thread a client through.
