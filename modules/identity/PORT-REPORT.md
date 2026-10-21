# Identity area — port report

The port of Quotient's `tagcheck`, `eztag` and `ssverify` cogs. The
tournament group manager (`groupm`) was ported here as well and has since
been **deleted** — see §10. Everything lives in `modules/identity/` and
`commands/esports/`.

- `npm run typecheck` — **clean for this area** (zero errors in
  `modules/identity/` and `commands/esports/`, apart from `repo.ts`,
  which the SQLite port is in the middle of changing).
- `npm test` — **226 tests in this area, all passing** (12 files).
- `modules/identity/README.md` — the interface, the rules, the state
  machines, the premium gates, the bugs.
- `modules/identity/ROUTING-REPORT.md` — the one-prefix routing of the
  screenshot-verification panel, and why it is that way (§11).

---

## 1. The command surface

Three top-level commands. `commands/esports/<name>.ts` is a one-line
re-export of the command object in `modules/identity/commands/`, exactly
the shape the scrims, tourneys and slots areas use.

| Command | Subcommand | Options | Permission |
|---|---|---|---|
| `/tagcheck` | `set` | `channel` (channel, **required**), `mentions` (int 0–20, default 4) | Manage Server |
| | `config` | — | Manage Server |
| | `remove` | `channel` (channel, **required**) | Manage Server |
| | `autodelete` | `channel` (channel, **required**) | Manage Server |
| `/easytag` | `set` | `channel` (channel, **required**) | Manage Server |
| | `remove` | `channel` (channel, **required**) | Manage Server |
| | `config` | — | Manage Server |
| | `autodelete` | `channel` (channel, **required**) | Manage Server |
| `/ssverify` | — | — | Manage Server |

`/tagcheck set` and `/easytag set` also check the bot's own permissions
**in that channel** (`send_messages`, `embed_links`, `manage_messages`)
before anything is written.

The group manager has no command of its own: the tournament area opens
its panel.

### Why three files and not one

The brief asked for one file, `commands/esports/identity.ts`, holding
three groups. **That shape cannot work with this loader.**
`handlers/commands.ts` and `deploy.ts` both read **one command per
file** — the file's `default` export:

```ts
const module = await import(pathToFileURL(filePath).href);
if (isCommand(module.default)) client.commands.set(module.default.data.name, module.default);
```

A file with three commands in it registers **one** of them and loses the
other two, and the deployment payload would carry one command where the
guild expects three. Every other area in the repository has the same
shape — one file, one command — so this area has three files:
`commands/esports/tagcheck.ts`, `commands/esports/easytag.ts` and
`commands/esports/ssverify.ts`.

Two of those files (`commands/identity/{tagcheck,easytag,ssverify}.ts`)
existed already, from the manager's central-integration commit. They were
**moved** into `commands/esports/`, because the esports folder is where
the sibling esports areas (scrims, tourneys, slots) put their adapters
and where the brief asked for them. Keeping both would have registered
every command twice, and Discord rejects a deployment that carries the
same command name twice.

`modules/identity/commands.test.ts` pins the shape down: the three
commands serialise through `data.toJSON()`, the adapter files are found
by `listCommandFiles`, and each name is registered **exactly once**.

---

## 2. What was ported

| Source | Ported as |
|---|---|
| `src/cogs/tagcheck/` | `tagcheck.ts` (the rules) + `service.ts` (the state machine) + `commands/tagcheck.ts` + the message listener |
| `src/cogs/eztag/` | `easytag.ts` (the extraction and the resolution) + `service.ts` + `commands/easytag.ts` + the message listener |
| `src/cogs/ssverify/` | `verification.ts` (the rules) + `duplicate.ts` (the duplicate check) + `service.ts` + `commands/ssverify.ts` + `views/ssmod.ts` (the panel) + the message listener |
| `src/cogs/groupm/` | **deleted** — the tournament area owns the group manager; see §10 |
| `src/models/ssverify.py` | `db/schema/identity.ts` (the manager's file) + `repo.ts` |
| `src/utils/default.py:find_team` | **Not** reimplemented — `core/team-name.ts` (D27) is used as is |

The rules are **pure functions over plain data**. The listeners, the
command adapters and the panels are thin on top of `service.ts`, which is
the only thing that writes.

### The state machines

- **Tag-check channel**: `none → live → none`, with `deleteAfter` as a
  flag on the live state.
- **Easy-tag channel**: `none → live → none`, with the same flag.
- **Screenshot-verification setup**: `none → draft → live → none`. The
  draft lives in a **token** map (D18), the live state is a row whose id
  travels in the custom id.
- **One submission**: `attachments → rate limits → OCR → duplicate check
  → type rules → recorded → role granted`.

### The authorisation

The screenshot-verification panel is a **message**, so anybody who can
read the channel can press its buttons — and its buttons delete a
server's verification setup, repoint the channel the bot OCRs, change the
role the bot grants, and set the text and the link the bot posts. Every
handler therefore checks the caller itself, before the setup is read or
written (`guards.ts`), and every read and write of a setup is keyed by the
guild **and** the row id. `/ssverify` answers ephemerally as well. See
§10.

### The premium gates

| Gate | Entitlement | Stops |
|---|---|---|
| `assertChannelAllowance` | `extra_channels` | A second tag-check or easy-tag channel |
| `assertSsConfigAllowance` | `extra_channels` | A second screenshot-verification setup |
| `assertScreenshotTypeAllowed` | `screenshot_types` | Every type but YouTube |
| `assertSuccessMessageAllowed` | `success_message` | A custom success message |

Every gate runs **before** the state it guards changes (D15), and the
check goes through `assertEntitled` and nothing else. `service.test.ts`
and `views/ssmod.test.ts` prove it: when a gate refuses, the repository
is never written and the draft is untouched.

### The rate limits

1 submission per member every 7 s (a timestamp), 10 per guild every
minute (a sliding window). The clock is injectable, so the tests do not
sleep.

---

## 3. What was **not** ported, and why

| Not ported | Why |
|---|---|
| The remote OCR service | It is not in the source repository and cannot be run (D20). It is now the **only** engine: the port ships the HTTP adapter for it and **no local fallback**, so a deployment without `OCR_PROVIDER_URL` has no OCR at all — the feature is there, and it refuses every screenshot. See [the OCR switch](#9-the-ocr-switch). |
| Python's `imagehash` | Not available here. The hashes come from the OCR service, and `modules/ssverify/ocr/hash.ts` holds the comparison (a Hamming distance over a 64-bit hash), so the threshold of 7 still means what it meant. |
| `auto_now` | Replaced by a plain nullable timestamp written only by the refresh path (B16). |
| `dict(self.record)` as an update payload | An explicit field list (B18). |
| The `wait_for("message")` inputs | Modals and select menus (D17). |
| `PtableTourney`, `PtableTeam`, `PtableMatch` and the points-table renderer | Dead code in the source (D22). |
| The role lookups by name (`quotient-tag-ignore`, `tourney-mod`) | Everything is stored and compared **by id** (D16). |
| The source's `ssverify` per-type methods | Replaced by one ordered list of guards per type, so a new type is a list rather than a method. The behaviour is the same. |

---

## 4. The source bugs that were fixed rather than ported

One line each. The decision log's numbers are in brackets.

| # | What the source did | What happens now |
|---|---|---|
| **B8** | The screenshot type was assigned to the record **before** the entitlement was checked, and the editor's next refresh wrote every field of the record — so a free guild ended up with a premium type. | The entitlement is checked **first**, in the wizard and in the editor; a refused type is never assigned to the draft or the row. |
| **B11** | The channel was added to the live cache as soon as it was picked, so cancelling the wizard left a half-configured channel running. | The channel only goes live when the setup is **saved**. |
| **B12** | The success-message editor disabled its button for a free guild and the wizard had no guard at all, so the gate was bypassable. | One `assertEntitled` call covers both paths, and the button is never silently disabled (D29). |
| **B14** | `\b@\w+` matched `@name` and stopped before the discriminator, so `@their_full_discord_tag#1234` was truncated to `@their_full_discord_tag` — the very form the error message advertises. | A full tag is matched **whole**, discriminator included. |
| **B14** | `\b` in front of the `@` needs a word character before it, so a tag at the start of a message, or after a space, never matched at all. | The `@` only has to be **not** preceded by a word character or a dot, which also keeps `mail@example.com` out. |
| **B15** | The group channel was found by a name substring, so "Group 1" also matched "Group 10" and a list could be published into another group's channel. | The channel is chosen by the operator and **stored on the row** (D16). **Moved to the tournament area** with the group manager (§10). |
| **B16** | `refresh_at` was an `auto_now` column, so the two-minute cooldown depended on the last write of any kind. | The row's `updated_at` is written **only** by the refresh path, so it *is* the last refresh time. **Moved to the tournament area** with the group manager (§10). |
| **B17** | The roles and the channels were created in a loop and the function returned on the first failure, so a failure on the fourth of five groups left the first three behind. | Everything that is created is collected and **removed again** when something goes wrong. **Moved to the tournament area** with the group manager (§10). |
| **B18** | The update wrote `dict(self.record)`, which includes the M2M field and relies on Tortoise internals to leave the right columns alone. | The patch is an **explicit list of fields**. |

### Three more changes the OCR engine forced

The source's rules were calibrated against a remote OCR service that is
not in its repository. This port reads the screenshot with a remote service
too, and the two read a screenshot differently enough that these three
changes had to be decided here. They are not in the decision log's bug
list — they are consequences of D20.

| Change | Why |
|---|---|
| The page-name check accepts up to **two** stray characters inside the name. | An icon that the engine reads as a character *between* two words ("Team \| Phoenix" → `team\|phoenix`) broke a check a human would pass. The name is matched in three passes: as it is, with the punctuation stripped, and with a bounded-subsequence tolerance. A name shorter than four characters is never matched with noise. |
| The literal button checks are **case-insensitive** word matches. | An engine does not guarantee the casing the screen shows. They still refuse `SUBSCRIBED` and `Following`, exactly as Quotient's trailing space did. |
| The raw text is used for the literals and the normalised text for the contains-checks. | `OcrResult.text` has its whitespace stripped, which destroys `"SUBSCRIBE "`. `OcrResult.rawText` keeps it, so both sides of a contains-check are normalised with the *same* function. |

---

## 5. The decisions that were not in the log

| Decision | What was decided | Why |
|---|---|---|
| The screenshot-verification **count** limit | The `extra_channels` entitlement lifts it, the same one that lifts the tag-check limit. | The log names no entitlement for the screenshot-verification count. Both are "one more setup than the free tier allows", so one entitlement covers them. |
| The free screenshot type | YouTube only; the other five are behind `screenshot_types`. | The source marked everything but YouTube as premium-only and refused the others in the button handler. |
| The raw-id pattern | Seventeen to nineteen digits, not the source's exactly eighteen. | Snowflakes have grown past eighteen digits; the source's pattern misses the newer ones. |
| A mention of a member | `<@123>` is read as the **id** `123`, and the token list keeps one entry per member. | The source's pattern saw both the id and the `@id`, and the resolver did not know the second form, so a real mention came back as "Invalid Member!". |
| The order of the tokens | The order they appear in the message. | The source's single `findall` preserved the order; the port's first cut did not, and the reply listed the ids before the names. |
| The tag-check counts | Only **user** mentions. | The source counted every mention, and in discord.py that includes role mentions. A role is not a teammate. |
| The duplicate check's order | The member's own submissions first, then "the same picture, whoever submitted it". | The source's order. |
| The malformed hash | The check is **total**: it answers with a decision, never an exception. The member's own corrupt row **refuses** the submission; somebody else's corrupt row is **reported and passed over**. | A stored hash that cannot be compared must not compare as "a different picture". Refusing everywhere would let one bad row block every member of the setup, so the refusal is scoped to the member whose own history is broken — and every corrupt row is reported with the row id, so it can be cleaned up. |
| The channel cache | `core/channel-cache.ts` (D21), with **three** instances. | The log puts the shared cache in `core/`, and the scrims area already uses it. The three sets stay apart, because a listener that finds no record for a cached channel removes that channel from the cache. |
| The command adapters | One file per command, in `commands/esports/`. | The loader reads one command per file. See §1. |

### D20 is done: the threshold is the setup's own

D20 says the duplicate threshold "is a config value, not a constant". It
**is** a parameter of the check (`checkDuplicate(candidate, stored,
threshold)`) and the default comes from the hashing module
(`DEFAULT_DUPLICATE_THRESHOLD`). The `ss_configs` table has a
`duplicate_threshold` column, and the repository reads it: the duplicate
check of a submission runs with **that setup's** value.

| The setup's value | What the check runs with |
|---|---|
| a whole number from 0 to 64 | that number |
| nothing | the global default (7) |
| not a whole number, or outside 0…64 | the global default (7) |

A value that cannot be a Hamming distance over a 64-bit hash **falls
back** rather than fails: a nonsense number in a column must not stop a
member from being verified. The check is still on the **dHash** — the
pHash is stored beside it, but the threshold of 7 was calibrated on the
dHash.

The column is **read**, not yet written: nothing in the panel sets it, so
today only the database holds a value other than the default. A field in
the setup panel is the obvious next step, and it is not part of this
change.

### The keywords moved to a table of their own

`ss_configs.keywords` was a `text[]` column. It is `ss_config_keywords`
now — one row per keyword, with a unique index on `(ss_config_id,
keyword)`. The repository reads the set through that table and writes it
with an insert that carries a conflict clause (so a keyword that is
already there is stored once, and the write cannot fail on it) and a
delete for the keywords that are gone. The two statements share a
transaction with the setup's own columns, and the write is scoped to the
guild like every other write of this area.

The keywords are stored **as they were typed**: the comparison normalises
them — case-insensitively, with the spaces stripped, on both sides — when
it looks at them, so normalising on the way in would only lose what the
operator wrote. The set has no ordinal, so the refusal of a custom filter
names the **page** rather than "the first keyword".

---

## 6. The other areas' command adapters

The loader scans `commands/<folder>/*.ts` one level deep and reads the
file's `default` export, so an area whose commands live in
`modules/<area>/commands/` needs a **folder** under `commands/` with one
file per command. A file directly under `commands/` is not a category,
and the manager's hardening commit made the loader skip it.

Checked at the end of this session:

| Area | Adapter | Status |
|---|---|---|
| community | `commands/community/{autopurge,autorole,reminder,snipe,tag}.ts` | present |
| moderation | `commands/moderation/*.ts` (12 files) | present |
| premium | `commands/premium/{premium,premium-status}.ts` | present |
| scrims | `commands/esports/scrims.ts` | present |
| tourneys | `commands/esports/tourneys.ts` | present |
| slots | `commands/esports/slots.ts` | present — **it was missing when I started**; `modules/slots/commands/index.ts` promised "the file in `commands/esports/slots.ts`" and the file did not exist. The slots area added it while this area was being finished. |
| the frozen verification flow | `commands/utility/*.ts` (8 files) | present |
| **identity** | `commands/esports/{tagcheck,easytag,ssverify}.ts` | present (this area) |

**No area is missing an adapter any more.** The only one that was missing
at any point during this session was slots, and that was its own area's
to fix — this report does not create it.

---

## 7. The three discord.js mistakes that were fixed

All three were in this area's files and are fixed:

| Mistake | Fix |
|---|---|
| `GuildTextChannel` does not exist in discord.js v14. | `GuildTextBasedChannel` — the type the runtime's `core/guards.ts` uses, so the channel permission checks match. |
| `TextInputBuilder.setDefault` does not exist. | `setValue` — the pre-filled value, which is what the three modals meant. |
| `update` is not on the bare interaction union. | The panel narrows the type: a button or a select-menu press is answered with `update`, and a modal submit has no `update`, so the panel message is edited directly and the interaction is acknowledged with `deferUpdate` — the pattern the scrims area already uses. |

A fourth, found while fixing the third: **`channel.mention` does not
exist in discord.js v14** either (it is a discord.py property). The two
refusals that named the channel now use `<#id>`, the form the rest of
the repository uses.

---

## 8. The tests

`npx vitest run modules/identity` — 257 tests in 14 files.

| File | Tests | What it covers |
|---|---|---|
| `easytag.test.ts` | 31 | The full tag the source could not read, the `\b` bug, the email address, the resolution of all three shapes, the order of the tokens. |
| `tagcheck.test.ts` | 13 | The two guards, their order, the "no mentions required" channel, and the team name the reply shows. |
| `duplicate.test.ts` | 19 | The threshold **at** and **around** the boundary, the two kinds of duplicate, the absent hash, the hashes that cannot be compared, and the resolution of a setup's own threshold. |
| `repo.test.ts` | 16 | The repository against a **real database**: the keyword set round trip through `ss_config_keywords`, the threshold column, and the cascade that takes the keywords with the setup. |
| `threshold.test.ts` | 9 | The **setup's own** threshold, end to end: the setups are rows in a real database, and the configuration the service sees is the one the database holds. |
| `verification.test.ts` | 38 | Every type's rules, against text this port's OCR provider actually produces, plus the tolerant name match and the button checks. |
| `service.test.ts` | 20 | The four premium gates — nothing is written when a gate refuses — the two rate limits with an injected clock, and the guild scope of a setup. |
| `ocr.test.ts` | 27 | The boot decision (forced on, forced off, automatic) and the **effective** state of the provider; the refusal when the OCR is off, when the service is down and when the service sends rubbish — including that **nothing is stored**; the URL that reaches the service; and the stored hash that cannot be compared. |
| `commands.test.ts` | 10 | The three commands serialise through `toJSON()`, the adapter files are found, each name registers exactly once, and `/ssverify` answers ephemerally. |
| `ignore-role.test.ts` | 8 | The ignore role is compared by id, not by name. |
| `cache.test.ts` | 8 | The three sets stay apart, and a database that is down does not empty a working cache. |
| `guards.test.ts` | 8 | Who may manage a setup: the moderator, the administrator, the ordinary member, the member of another guild, the interaction with no guild. |
| `views/ids.test.ts` | 7 | The id scheme: one layout, the round trip, and that an action of another surface is refused. |
| `views/ssmod.test.ts` | 43 | The panel's authorisation, the panel's gates, the custom ids, and the **routing** of every id through the real router — in two registration orders. |

The repository's own suite was run as well: 906 tests in 63 files, all
passing. (Two of them failed in `modules/community/repo.test.ts` while
this area was being finished; that area has since fixed them.)

---

## 9. The OCR switch

The product owner asked for the OCR to be switchable off, so a deployment
that does not use screenshot verification does not pay for it. The switch
itself is the OCR area's (`modules/ssverify/ocr/`); this area owns the
**decision** and the **refusal**.

| Piece | Where | What it does |
|---|---|---|
| the decision | `ocr.ts` — `decideOcr()` | Made **once, at boot**: `OCR_ENABLED` when it is set, otherwise automatic (there is at least one `ss_configs` row). |
| `hasSsConfig()` | `repo.ts` | The automatic half's one query: is there at least one setup? |
| the effective state | `ocr.ts` — `isOcrAvailable()` | Asks the **provider** it got, not the flag it passed in. |
| the refusal | `service.ts` — `processSubmission()` | Refuses the submission when the OCR is off, before the duplicate check and before the rules, and stores nothing. |
| the refusal of a failed read | `ocr.ts` — `analyzeScreenshot()` | The service is down, it answers with rubbish, or it sends a hash nobody can compare: the screenshot is refused and nothing is stored. A decision, not a crash. |

**The provider is the only engine.** The local provider is gone, so a
deployment that configures no `OCR_PROVIDER_URL` has no OCR at all: the
feature is there, and it refuses every screenshot. That is the same
fail-closed behaviour the area always had, with the default made
explicit — but the feature **needs a remote service to be useful**, and
that is worth saying out loud.

Four decisions that were not in the brief:

| Decision | What | Why |
|---|---|---|
| `getOcrProvider()` **throws** when the decision has not been made | The provider is not built on first use any more. | A provider built with the wrong setting would be the wrong provider for the whole run of the bot. The call sites need it synchronous, so the alternative — awaiting the decision — was not available. |
| The decision is made **before** the channel cache is loaded | `warmIdentity()` does the decision, then the cache. | The cache is what makes a screenshot-verification channel live, so the answer has to be there before the first screenshot can be processed. |
| A database that is down at boot switches the OCR **off** | The decision never throws; the failure is logged and the provider is the switched-off one. | A screenshot that cannot be checked has to be refused, and the bot has no way of knowing whether one was expected. |
| The **provider** decides whether the OCR runs, not the flag | `decideOcr()` returns `!isOcrDisabled(provider)`, and the boot log says what is true. | `createOcrProvider({ enabled: true })` still hands back the switched-off provider when no service is configured. A log that said "the OCR is on" would send an operator hunting for a bug that is not there. |

**The refusal is the important half.** "The rules reject an empty text" is
not enough: `VERIFICATION_RULES.any_ss` is empty, and a `loco` or
`rooter` setup with an empty channel name has no rule that looks at the
text — for those, an empty text would be *accepted*. So the submission is
refused outright, and the disabled provider's zero hashes — the hash of
nothing — never reach the database.

The claim that "every text rule rejects an empty text" was in this area's
`ocr.ts` and `README.md`. It is not true for every setup, and it has been
corrected in both.

**The image is a URL, not a buffer.** The service fetches the picture
itself, so `SubmittedImage` carries the attachment's CDN URL and the bot
never downloads it: no bandwidth, no memory, and no failed download that
could leave a member without an answer.

---

## 10. The authorisation hole, and the group manager that was never reachable

### The hole

An independent security audit found that **the screenshot-verification
panel performed no authorisation at all**. The panel is a *message*, and
its buttons delete a server's verification setup, repoint the channel the
bot OCRs, change the role the bot grants on success, and set the text and
the link the bot posts. The three handlers that answered the buttons, the
select menus and the modals (`handleSsModButton`, `handleSsModSelect`,
`handleSsModModal`) had no `isStaff`, no `hasGuildPermissions` and no
member lookup — the only gates were the premium entitlement (checked
against the **config's own** guild, not the caller's) and the existence
of the row.

Every other public panel in the tree checks the caller and says so: the
slots area documents the rule outright ("the panel is public, so the
buttons check the caller themselves") and calls `canManageSlotManager`,
the moderation area calls `isStaff` and then checks the guild, and the
scrims and tourneys areas call `refuseUnlessMod`. **The identity area
was the one that did not.**

What was done:

| Piece | What |
|---|---|
| `guards.ts` (new) | `canManageSsConfig(interaction, guildId)` — the caller must be a moderator of the guild the interaction came from: Manage Server, Administrator, or the staff role the guild already uses. It fails **closed**: no member, no guild, another guild — all refusals. |
| Every handler | `handleSsModButton`, `handleSsModSelect` and `handleSsModModal` — one per kind of component, since §11 gave the area a single prefix — call it **before** the setup is read or written. |
| The rows | `repo.findSsConfigById(guildId, id)`, `repo.updateSsConfig(guildId, id, …)` and `repo.deleteSsConfig(guildId, id)` are keyed by the guild **and** the row id, the way the community area's `findTagById(guildId, id)` is. A uuid primary key makes a cross-guild guess unguessable rather than impossible, which is not a defence. |
| The wizard | The draft carries the guild it was started in (`startSsWizard(guildId)`), so a wizard cannot be driven from another server. |
| The command | `/ssverify` answers **ephemerally**. The panel is a moderator's control panel; it does not belong in the channel. This is not a substitute for the checks — a message only the moderator can see still travels, and the buttons still check the caller. |

### The group manager

The `identity:groups` handlers had the same shape: they created channels
and roles in a guild with no authorisation, and they were **not
reachable** — the only builder of those buttons was never called.

The tournament area has its own, complete group manager
(`modules/tourneys/views/groups.ts`, `modules/tourneys/views/group-channels.ts`,
`modules/tourneys/groups.ts` and its own repository), and it is the live
one. The identity copy was a **dead duplicate**, and it was **deleted**:
`views/groups.ts`, `groups.ts`, the group's repository functions, the
group's types and the `identity:groups` registration are gone. A latent
path that creates roles and channels is exactly the thing that gets
wired up by accident later.

### Two buttons that did nothing

Found on the way, and fixed:

| Button | What was wrong |
|---|---|
| the list panel's **Setup** | Its id was `identity:ssmod:setup`, and the wizard's prefix was `identity:ssmod:setup` — the router takes the first prefix that matches, so the wizard's handler swallowed the button and it did nothing. |
| the wizard's **Save & setup** and **Cancel** | They were built without the wizard's flag, so they carried the **editor's** prefix and were answered by the editor's handler, which knows no `save` action. The wizard could never be saved. |

Both are pinned down by `views/ssmod.test.ts`.

The wizard's prefix was then changed to `identity:ssmod:wizard` to get the
**Setup** button out of its way — which left the area with two prefixes
that shadow each other. §11 is the end of that.

---

## 11. The two prefixes that shadowed each other

The router warns when one prefix owns every id another one owns. It
warned about this area three times — once per kind of component — and
every warning was about the same pair:

```
[Router] Prefix shadowing in area "identity": the button prefix
"identity:ssmod" (registered first) shadows "identity:ssmod:wizard"
(registered now). … "identity:ssmod:wizard" is unreachable — the handler
behind it never runs.
```

The pair worked **only because the wizard was registered first**. The
router takes the first prefix that matches an id, so the order of two
lines of registration decided whether the wizard's **Save** button
worked. That is a load-bearing registration order, found by a warning
rather than by a test, and it would have broken the day someone
reordered the registrations or moved one into a lazily-imported module.

The area now has **one prefix** and the handler dispatches on the
segment after it — the shape the scrims and the tournaments areas
already use:

```
identity:ssmod:<surface>:<action>[:<target>]
```

The **surface** (`list`, `edit` or `wizard`) is that segment, and it
says what the target is: a token for the wizard, a row id for the
editor. The **action** is the next one, and it belongs to the surface.

| What changed | How |
|---|---|
| Two prefixes, one of them order-dependent | One prefix, `identity:ssmod`, registered once per kind of component. |
| Six handlers, one per surface and per kind | Three handlers, one per kind; each switches on the surface and then on the action. |
| The handler guessed what the target was (`resolveSetupTarget(target) ?? resolveEditTarget(target)`) | The surface says, so exactly one target is resolved. |
| The scheme spread over the panel | `views/ids.ts`: the surfaces, the actions, the builder and the parser — the only two places that know the layout. |

The parsed id is a union discriminated by the surface, so a handler that
switches on the surface knows which actions it has to answer, and the
builder refuses an action that belongs to another surface. An id that
names an action of another surface — `identity:ssmod:edit:save:<token>`
— is not one of this area's ids, and the parser refuses it.

`views/ssmod.test.ts` presses **every** id the panel builds through the
**real** router, in two registration orders, and records the *effect* of
each press; the same file asserts that the area registers one prefix per
kind of component and that the router logs no warning.

`ROUTING-REPORT.md` has the id table, the dispatch, and the tests.

