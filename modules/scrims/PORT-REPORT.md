# Area — Scrims: follow-up port report

A focused follow-up to the scrims area report, not a redo. Five things
were asked for:

1. close the registration bypass in the requirements matrix;
2. delete the premium stand-in and use the real gate;
3. move the channel cache to `core/`;
4. build the ban-log setup surface;
5. decide on the `autoslotlist` switch and the `scrims-mod` role name.

**Status: complete.** `npm run typecheck` is clean for these files, the
**116** tests in this area pass (was 108), the whole repo's suite passes
(913 at the time of writing — the other areas are still landing), and
`npm run smoke` is still **106/106**. The ban-log row was verified
against the live Postgres (one row per guild, re-setting replaces it,
and the check rolled back so nothing was left behind).

---

## 1. The requirements matrix — the bypass is closed

### What the hole was

The old matrix hung five of the eight guards off a `chainGuard`
wrapper:

```ts
export function elifChainApplies(context: RegistrationContext): boolean {
  if (context.settings.requiredMentions <= 0) return false;
  return !context.mentions.some((mention) => mention.isBot);
}
```

So on a scrim with `required_mentions = 0` the whole chain was skipped:
**the banned-user check, the line check, the one-registration check, the
duplicate-name check and the fake-tag check all stopped firing.** A
banned user could register on such a scrim. That was a bypass, and it
is gone.

### Why it was never a source quirk

The port's old note claimed the source behaved the same way. It did not,
and the difference is the whole point:

```python
if scrim.required_mentions and not all(...bot...):
    ...                                     # bot mention
elif not len(message.mentions) >= scrim.required_mentions:
    ...                                     # too few mentions
elif message.author.id in await scrim.banned_user_ids():
    ...                                     # banned
elif len(message.content.splitlines()) < scrim.required_lines:
    ...
```

In Python an `elif` chain runs when the `if` is **false**. With
`required_mentions = 0` the `if` is falsy, so the chain **ran**; its
first branch (`not len(mentions) >= 0`) was false, and control fell
through to the **banned** check. The chain did *not* run when somebody
mentioned a bot — but there the bot-mention reason won anyway, because
it was the `if`.

The first port read the chain as running when the `if` was **true**,
which is the opposite. The port was therefore *stricter* than the source
in one place (a bot mention on a zero-mention scrim was rejected) and
*looser* in five (everything else was skipped).

### The fixed matrix

`modules/scrims/requirements.ts` is now a flat list. The first match
wins, and the order is the source's order:

| # | Guard | Reason | When it runs |
|---|---|---|---|
| 1 | `teamNameRequired` | `no_team_name` | **Always.** |
| 2 | `botMentionsRejected` | `mentioned bots` | Only when `required_mentions > 0`. |
| 3 | `mentionCount` | `insufficient mentions` | Only when `required_mentions > 0`. |
| 4 | `bannedUser` | `banned` | **Always.** |
| 5 | `requiredLines` | `no_lines` | **Always.** |
| 6 | `oneRegistrationPerPerson` | `multiregister` | **Always.** |
| 7 | `duplicateTeamName` | `duplicate_name` | **Always.** |
| 8 | `duplicateTags` | `fake_tag` | **Always.** |

The one condition is a named function, so the two mention checks cannot
drift apart:

```ts
export function mentionsAreChecked(context: RegistrationContext): boolean {
  return context.settings.requiredMentions > 0;
}
```

`elifChainApplies` and the `chainGuard` wrapper are **deleted**. The
source's "the bot-mention reason wins" case is now reproduced by the
**ordering** (guard 2 sits before the rest), not by a chain — so the
port's behaviour now matches the source's on every input, rather than
merely being safe.

### The test that proves it

`modules/scrims/requirements.test.ts`:

```ts
it("still checks the ban on a scrim that asks for no mentions", async () => {
  const ctx = context({
    settings: { requiredMentions: 0 },
    authorId: "banned",
    bannedUserIds: ["banned"],
  });

  expect(mentionsAreChecked(ctx)).toBe(false);
  expect(await evaluateRegistration(ctx)).toBe(RegDeny.banned);
});
```

Plus a second one in the guard-4 block, and a third that breaks each
of the other four rules in turn on a zero-mention scrim (lines,
one-registration, duplicate name, fake tag) so none of them can be
conditioned away again.

And a **structural** test, because a behavioural test alone only proves
the one case:

```ts
it("lists the guards themselves, so no guard can be wrapped in a condition again", () => {
  expect(REGISTRATION_GUARDS).toEqual([
    teamNameRequired, botMentionsRejected, mentionCount, bannedUser,
    requiredLines, oneRegistrationPerPerson, duplicateTeamName, duplicateTags,
  ]);
});
```

`toEqual` on function references compares them by identity, so the
moment somebody wraps a guard in a condition again, this fails.

**The regression was proved, not assumed.** I re-introduced the old
behaviour (`if (!mentionsAreChecked(context)) return null;` inside
`bannedUser`) and ran the suite: **2 tests failed** — the bypass test
and the guard-4 test. The fix was then restored and the suite went
green again.

---

## 2. The premium stand-in is gone

`modules/scrims/entitlements.ts` is **deleted**. It read
`guild_entitlements` directly and implemented its own expiry rule.

### The call sites

The call sites did not change; the **import** did.

| File | Before | After |
|---|---|---|
| `views/modal-handlers.ts` | `import { assertEntitled, PremiumFeature } from "../entitlements.js";` | `import { assertEntitled } from "../../premium/index.js";` + `import { PremiumFeature } from "../../../core/constants.js";` |
| `views/button-handlers.ts` | `import { assertEntitled, isEntitled, PremiumFeature } from "../entitlements.js";` | `import { assertEntitled, FREE_TIER, isEntitled } from "../../premium/index.js";` + `PremiumFeature` from `core/constants.js` |
| `commands/create.ts` | `import { FREE_SCrim_LIMIT, isEntitled, PremiumFeature } from "../entitlements.js";` | `import { FREE_TIER, isEntitled } from "../../premium/index.js";` + `PremiumFeature` from `core/constants.js` |

Two details worth stating:

- **`PremiumFeature` is imported from `core/constants.js`, not from
  `modules/premium/index.js`.** The premium module's index re-exports
  `PremiumFeature` as a **type only**; the scrims code needs the
  **value** (`PremiumFeature.scrimSlots`). The tourneys area already
  does it this way, so this is the house pattern, not a new one.
- **`FREE_SCrim_LIMIT` is gone.** The stand-in exported a
  mis-capitalised alias of `FREE_TIER.scrims`; the call sites now read
  `FREE_TIER.scrims` from the premium module directly, which is the
  canonical table (D45) and has a name that matches it.

### The behaviour matches

The stand-in was not wrong about the expiry — it already evaluated it on
every read. The real one keeps that property and makes it the premium
module's single rule, so there is only one place the rule exists.

| | The stand-in | `modules/premium/entitlements.ts` |
|---|---|---|
| Query | `guild_id` + `feature`, `LIMIT 1` | the same (`findEntitlement`) |
| Enabled | `enabled` must be true | the same |
| Expiry | `expires_at <= now()` → inactive | `expires_at IS NULL OR expires_at > now()` — the same rule, written once, in `isEntitlementActive` |
| Refusal | `PremiumRequiredError` (a `DenialError`) | the same type, with the shared `premiumRequiredMessage` |
| Read time | evaluated on every call | evaluated on every call |

The expiry was already lazy in the stand-in; the real one keeps that
property and makes it the module's single rule. The only visible
difference is the **wording** of the refusal, which now comes from
`gateReason(feature)` — it names the feature and the way out
(`/premium`), so a gate that throws and a gate that renders say the same
thing. The call sites show `error.message`, so they needed no change.

**No other area may read the entitlement table directly.** A repo-wide
grep for `guildEntitlements` now matches only `modules/premium/`
(the owner) and `db/schema/premium.ts` (the schema). Nothing in this
area reads it, and `assertEntitled` is the only place a gate is read.

---

## 3. The channel cache moved to `core/`

`modules/scrims/channel-cache.ts` is **deleted**. The implementation is
now `core/channel-cache.ts` — the one file outside this area I was
allowed to touch.

### The interface

```ts
export type ChannelIdLoader = () => Promise<Iterable<string>>;

export class ChannelIdCache {
  has(channelId: string): boolean;
  add(channelId: string): void;
  remove(channelId: string): void;
  replace(channelIds: Iterable<string>): void;
  clear(): void;
  get size(): number;
  values(): string[];
  async rebuild(load: ChannelIdLoader): Promise<void>;
}
```

It is generic: a set of channel ids and a way to rebuild it from the
database. It knows nothing about scrims, tournaments or tag checks.

**The rebuild takes a loader, not a query.** `core/` cannot import
`db/` — the runtime layer must not depend on the storage layer, or
every test of a guard would need a database. So the area hands in the
query and the cache owns the invalidation:

```ts
await service.scrimChannelCache.rebuild(async () => {
  const scrims = await repo.listOpenScrims();

  return scrims.map((scrim) => scrim.registrationChannelId);
});
```

A loader that throws leaves the cache as it was: a database that is
briefly unavailable must not empty a cache that was working.

### Why the instance stayed in the scrims area

The **class** moved; the **instance** is per-area, and it lives in
`modules/scrims/service.ts`:

```ts
export const scrimChannelCache = new ChannelIdCache();
```

A scrim registration channel and a tourney registration channel are
different things, so the two areas must not share one set. A listener
that finds no record for a cached channel **removes that channel from
the cache** (`listeners.ts`), so a shared set would let the tourneys
listener evict the scrims' registration channels. The identity area
reached the same conclusion independently and has already adopted the
same pattern — one instance per kind.

Every import in this area was re-pointed:

| File | Was | Now |
|---|---|---|
| `service.ts` | `import { scrimChannelCache } from "./channel-cache.js";` | owns the instance |
| `jobs.ts` | `import { scrimChannelCache } from "./channel-cache.js";` | `service.scrimChannelCache` |
| `listeners.ts` | `import { scrimChannelCache } from "./channel-cache.js";` | `service.scrimChannelCache` |
| `register.ts` | `import { scrimChannelCache } from "./channel-cache.js";` | `from "./service.js"` |

### What the tourneys area should import

At the time of writing the tourneys area still has its own copy
(`modules/tourneys/channel-cache.ts`, with a `ChannelIdSet` class and
two instances). It should:

```ts
import { ChannelIdCache } from "../../core/channel-cache.js";
```

It should **delete `modules/tourneys/channel-cache.ts`** and own two
instances — one for the registration channels, one for the media-partner
channels — the same way this area owns one:

```ts
export const tourneyChannelCache = new ChannelIdCache();
export const mediaPartnerChannelCache = new ChannelIdCache();
```

The rebuild becomes a loader per set, e.g.

```ts
await tourneyChannelCache.rebuild(async () => {
  const tourneys = await repo.listOpenTourneys();

  return tourneys.map((tourney) => tourney.registrationChannelId);
});
```

**Do not share one instance between the two areas.** A shared set is
the bug described above, not a saving. The identity area has already
done this — `modules/identity/cache.ts` now imports `ChannelIdCache`
from `core/channel-cache.js` and holds one instance per kind.

---

## 4. The ban log has a setup surface

`/scrims banlog` — new file `modules/scrims/commands/banlog.ts`,
registered in `modules/scrims/commands/index.ts`.

| Invocation | What it does |
|---|---|
| `/scrims banlog` | Shows the channel the ban log goes to, or says that none is set. |
| `/scrims banlog channel:#scrim-logs` | Sets it. |

- The **mod guard**, like every other command in the group
  (`guards: [scrimsModGuard]` on the group, plus `canUseScrimMod`
  inside the subcommand, like its siblings).
- The option is optional and is restricted to guild text channels.
- Setting it again replaces the row: `ban_logs` is `UNIQUE (guild_id)`
  and `setBanLogChannel` upserts on it. Verified against the live
  Postgres — one row per guild, re-setting replaces the channel, and the
  check was rolled back.
- The command refuses a channel the bot cannot see or cannot send in, so
  a guild cannot configure a dead channel.

### The decision I made: the channel is also written to

The brief asked for the setup surface. A channel that is configured and
never receives anything is the same kind of trap as an unsettable
column, so I wired the write path as well — **`modules/scrims/views/ban-log.ts`**, one function:

```ts
export async function writeBanLog(guild: Guild, entry: BanLogEntry): Promise<void>;
```

It writes one embed per event:

| Event | Where |
|---|---|
| A ban | the ban panel's modal (`handleBanModal`) |
| An unban | the ban panel's "Unban Users" and "Unban All" buttons |
| An unban | `/scrims unban` |
| A ban that ran out | the `scrim_ban` job |
| A punish | the slot area's flow (`modules/slots/ban-log.ts`) — the slot area owns the published slot list, and with it the Punish button |

**The write never fails the ban.** The ban is already in the database
by the time the log is written, and every failure in the log path is
swallowed. The job needed the `Client` to find the guild, so
`onScrimBan(payload)` became `onScrimBan(payload, client)` — the only
signature change in the area.

---

## 5. The two smaller items

### `autoslotlist` — the switch exists now

The column **is** honoured when the scrim closes (`views/lifecycle.ts`
publishes the slotlist when `autoslotlist` is true), and nothing set
it.

**The editor was not an option:** it is exactly **25 components** —
twenty field buttons in four rows of five, plus a navigation row of
five — which is Discord's limit for one message. `assertComponentBudget`
checks it, and `manager.test.ts` asserts the count. A twenty-first
field would need a sixth row.

So the switch went in the **design panel**, which had room: the
close-time behaviour belongs there anyway, next to the close message and
the slotlist design.

- `views/panels.ts` — a fifth button, "Auto Slotlist: On/Off", and a
  line in the embed saying whether the slotlist is published on close.
- `views/button-handlers.ts` — the `design` action `autoslotlist`
  flips the column and re-renders the panel from the row that comes
  back.
- `views/manager.test.ts` — a test that the panel carries the switch.

The README says exactly this, including *why* it is not in the editor.

### The `cdn` countdown — still not ported, and now the README says so plainly

The source's countdown button was commented out of its own design
panel, so the source never had a live countdown either. The port's `cdn`
column is read and written back unchanged and always holds the column
default (`{status: false, countdown: 3, msg: {}}`); **nothing sets it
and nothing renders it**. The README's "what is not ported" table and a
new "columns that are honoured but not in the editor" table both say
this outright.

### The `scrims-mod` role — kept, and now one literal

The name lookup is **kept on purpose** (D16 forbids name lookups in
general; this role is a guild-wide convention with nowhere in the
schema to store its id). The README says so plainly, in the "ported
as-is, quirk and all" list.

The role name was a named constant that was then **repeated as a string
literal in two more places**. There is now exactly one literal:

- `guards.ts` — `export const SCRIM_MOD_ROLE_NAME = "scrims-mod";`
- `guards.ts` — the refusal message is built from it:
  `` `You need the **${SCRIM_MOD_ROLE_NAME}** role or **Manage Server** permissions…` ``
- `listeners.ts` — the "is this member a scrim moderator?" lookup uses
  the constant instead of a second `"scrims-mod"`.

---

## 6. What changed from my original report

| # | What I said before | Now |
|---|---|---|
| 1 | The `elif` chain is skipped when the scrim asks for no mentions, and that is preserved. | **Wrong, and fixed.** The source's chain runs in that case; the port skipped it, which was a bypass. The matrix is flat, only the two mention checks are conditional, and there is a test. |
| 2 | `modules/scrims/entitlements.ts` is a local stand-in; delete it when `modules/premium/` lands. | **Done.** The file is deleted and the imports point at `modules/premium/index.js`. |
| 3 | The channel cache is the scrims area's own copy until `core/channel-cache.ts` lands. | **Done.** The implementation is in `core/channel-cache.ts`; the area keeps one instance. |
| 4 | No command sets the ban log channel up — that is a gap. | **Closed.** `/scrims banlog` sets it or shows it, and the channel is written to on every ban and unban. |
| 5 | The `autoslotlist` column is honoured when the scrim closes; there is no button for it. | **Closed.** The switch is in the design panel. The `cdn` countdown is still unsettable, and the README says so. |
| 6 | The `scrims-mod` role name is looked up by name; it is a guild-wide convention. | **Unchanged, and the literal is now in one place.** |
| 7 | 46 files, ~11k lines, 108 tests. | Still **46 files** (four added, two deleted), ~11.4k lines, **116 tests**. |

Nothing else in the area moved: the state machine, the slot claim
(D14), the ban matrix, the durable jobs, the panels and the custom-id
scheme are untouched.

---

## 7. The files

**Added**

- `core/channel-cache.ts` — the shared channel-id cache (D21).
- `modules/scrims/commands/banlog.ts` — `/scrims banlog`.
- `modules/scrims/commands/banlog.test.ts` — the command's shape.
- `modules/scrims/views/ban-log.ts` — the ban-log writer.

**Deleted**

- `modules/scrims/entitlements.ts` — the premium stand-in.
- `modules/scrims/channel-cache.ts` — the area's own cache.

**Changed**

- `modules/scrims/requirements.ts` — the matrix.
- `modules/scrims/requirements.test.ts` — the bypass test, the
  per-guard tests, the structural test.
- `modules/scrims/service.ts` — owns the cache instance.
- `modules/scrims/jobs.ts`, `listeners.ts`, `register.ts` — the
  re-pointed imports; the ban-log write in the `scrim_ban` job.
- `modules/scrims/guards.ts` — one role-name literal.
- `modules/scrims/commands/create.ts`, `commands/index.ts`,
  `commands/unban.ts` — the premium imports; the new subcommand; the
  ban-log write.
- `modules/scrims/views/button-handlers.ts`, `views/modal-handlers.ts`,
  `views/panels.ts` — the premium imports; the auto-slotlist switch;
  the ban-log writes.
- `modules/scrims/views/manager.test.ts` — the auto-slotlist test.
- `modules/scrims/README.md` — every section above.

---

## 8. The checks

| Check | Result |
|---|---|
| `npm run typecheck` | Clean for these files. (The `modules/slots/` area was mid-edit and briefly red — not this area.) |
| `npx vitest run modules/scrims` | **116 passed** (9 files). Was 108. |
| `npx vitest run` (whole repo) | **913 passed** (64 files) — the other areas are still landing. |
| `npm run smoke` | **106/106**. |
| Live Postgres | The `ban_logs` upsert verified inside a transaction that was rolled back: one row per guild, re-setting replaces the channel, no rows left behind. |
| The bypass, re-introduced on purpose | **2 tests failed** — the bypass test and the guard-4 test. The fix was restored afterwards. |

---

## 9. The published slot list belongs to the slot area

The slot area and this area both published a slot list, with a panel of
their own each, and whichever re-rendered last won. **The manager
ruled that the slot area owns the panel** — its version has the
four-mode ban matrix, the reason modal and the real `total_slots`
bound — and this area keeps the lifecycle.

So this area publishes through the slot area's API
(`modules/slots/index.js`) instead of publishing a message of its own:

```ts
export async function publishSlotList(scrimId: string, channelId?: string): Promise<string | null>;
export async function refreshSlotListMessage(messageId: string): Promise<void>;
export function buildSlotListPanel(scrimId: string): ActionRowBuilder<ButtonBuilder>[];
```

What changed here:

- `views/slotlist.ts` — `publishSlotlist` and `refreshSlotlistMessage`
  are **gone**, and the manager's slotlist preview carries the slot
  area's row instead of this area's.
- `jobs.ts` — `publishAndStore` calls `publishSlotList` and
  `refreshPublishedSlotlist` calls `refreshSlotListMessage`. **This
  area does not write `scrims.slotlist_message_id` any more** — not
  even to clear it, because the column is not in this area's
  `ScrimUpdate` type any more, so a write would not compile.
- `views/lifecycle.ts` — the close flow publishes through
  `publishSlotList`.
- `views/button-handlers.ts` — "Repost Slotlist" publishes through
  `publishSlotList`.

The import direction is one-way (scrims → slots), so there is no
cycle. The slotlist **template** still governs this area's own
`/scrims slotlist` post; the published list is rendered by the slot
area and does not honour it yet — and neither does the manager's
preview, whose body is a plain list. One renderer for the preview and
the published list is the next step, and it is not this area's to
write.

---

## 10. The two team flows — the pick is a persistent menu

**The bug.** "Add Team" and "Change Team" called `awaitSelect` and then
`interaction.showModal(...)` on the *same* interaction. `awaitSelect`
answers the select interaction it opens — that is how it collects the
value — so `showModal` on it is a hard error
(`InteractionAlreadyReplied`). Both flows threw every time a moderator
used them.

**The fix.** The choice is made with a **persistent** menu: a real
component in the panel's own message, whose answer arrives as an
interaction of its own, still unanswered, so the modal is shown from it.
The tournaments area solves the same problem the same way, and the
slots area does it in `views/pick.ts`.

| | |
|---|---|
| The menu's custom id | `scrims:slotm_pick:<scrimId>:<kind>:<userId>` |
| The kind | `add` (the scrim's free slots) or `change` (its claimed ones) |
| The menu's value | the slot id |
| The modal's custom id | `scrims:modal:slot_team:<token>` |
| The token carries | the scrim, the slot and the member who asked |

**The owner check is the handler's own.** The menu is dispatched by
custom id through the router, and the router has no owner check of its
own, so the member who opened the menu is encoded in the custom id and
checked in the handler. A pick from another moderator is refused
("That menu is not yours.") and drives nothing; the modal's token
carries the member too, so a form that is not the member's is refused
as well.

**The menu goes on the panel's own message.** The pick is then an
interaction on the panel, and the modal that follows is opened from it
— so the modal submit's message is the panel, and the panel is
re-rendered in place. A press that has already answered cannot edit the
panel through the interaction, so the menu goes into a follow-up
instead; the flow is the same either way.

**A second bug fell out of it.** The modal handler switches on the
*kind* ("wizard", "field", "slot_team"), but the register passed the
id's own action — which is always "modal". Every scrims modal was
refused with "That form is no longer active." The register now splits
the kind out of the parts, the way the tournaments area does.

`views/slot-pick.test.ts` drives the whole flow through the real
router: the button's id opens the menu, the menu's id opens the modal,
and the modal's id applies the team name and the new leader.


