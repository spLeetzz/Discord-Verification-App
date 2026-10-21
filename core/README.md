# `core/` — the shared runtime

Everything the ported features have in common: guards, routing, replies,
prompts, pagination, time and the small data structures they share.

`core/` has **no dependency on `db/`**. Where a guard needs to know whether
a guild holds an entitlement, the lookup is *injected*. That is what keeps
every module in `core/` unit-testable without a running Postgres.

It does depend on `utils/` for two things only: the logger and
`getGuildMember`. Both already existed and are frozen.

---

## `constants.ts`

The closed value sets the port inherits from Quotient: `Day`,
`AutocleanType`, `SSType`, `EsportsLog`, `EsportsRole`, `RegDeny`,
`RegMsg`, `LockType`, `ScrimBanType` and `PremiumFeature`, plus the two
embed colours (`EMBED_COLOR`, `ERROR_COLOR`).

Each set is an `as const` object *and* a union type derived from it, so
call sites read `Day.monday` while the compiler sees a closed set.

**A caller must know:** the values are Quotient's own wire values, not the
Python member names, because the old database columns and message templates
contain them. Do not "tidy" them.

## `emotes.ts`

The user-facing emoji. Unicode only (D36): Quotient's snowflake ids point
at its own emote server and would render as literal text here.

**A caller must know:** never hard-code an emoji string; take it from here.

## `text.ts`

`truncate`, `plural`, `humanJoin` and `titleCase`.

Ports of Quotient's `utils/formats.py`. `titleCase` reproduces Python's
`str.title()` exactly, because the team-name normaliser depends on it
("don't" becomes "Don'T").

**A caller must know:** `truncate` only cuts when the string is genuinely
too long. Quotient's version always cut the suffix length off, which made a
127 character name come out as 125.

## `team-name.ts`

`findTeam`, `normaliseTeamName`, `normaliseMessageContent`,
`teamNameFallback`, `TEAM_NAME_MAX_LENGTH`.

A verbatim port of Quotient's `find_team` (D27). It decides a name users
see on a slotlist, so the quirks survive: the search is for the lowercase
word `team`, it stops at the end of the first line, and the fallback is
`"{author}'s team"`.

**A caller must know:** the message is lower-cased on a *copy* — the
original is never mutated. The 30-character truncation happens at the model
boundary, not here.

## `custom-id.ts`

`makeCustomId`, `parseCustomId`, `randomId`, `TokenStore`,
`CUSTOM_ID_SEPARATOR`.

A custom id is `<type>:<action>[:<payload>]`. The first segment names the
owner; the router dispatches on it and never guesses (D7).

`TokenStore` is the ephemeral half of D18: a random token points into an
in-memory map with a time to live, used for state that has no database row
yet.

**A caller must know:**
- A token is only meaningful to the process that issued it. Never put a
  token in an id that references a database row.
- `TokenStore` keeps a sweep timer alive. It is `unref`ed, so it never holds
  the process open — but call `stop()` when the owner shuts down, and in
  tests.
- `parseCustomId("verify_btn:FF")` returns `{ type: "verify_btn", action:
  "FF", payload: null }`. The legacy verification id follows the same
  scheme; see `router.ts`.

## `escape.ts`

`escapeMarkdown` and `escapeMentions`.

discord.js has no markdown escaper and no mention escaper. Quotient's
`tag raw` needs both, because a tag body is stored verbatim and re-sent
later.

`escapeMarkdown` is a port of discord.py's, in both its modes: the default
escapes every markdown character, and `asNeeded` escapes only the
characters that open a formatting run.

**A caller must know:** `escapeMentions` also neutralises the `<@id>` form,
which discord.py leaves alone. That form is the syntax Discord actually
turns into a ping, and the text here is stored and re-sent, so it has to be
safe on its own.

## `premium.ts`

`EntitlementLookup`, `Entitlement`, `EntitlementSource`, `FREE_TIER`,
`FREE_TIER_FEATURES`, `FreeTierKey`, `FreeTierLimits`, `freeTierLimit`,
and a re-export of `PremiumFeature`.

The seam between `core/` and the premium module. `EntitlementLookup` is the
interface `guards.ts` depends on; the premium engineer implements it
against `guild_entitlements`.

**A caller must know:**
- `FREE_TIER` is the **canonical** free-tier allowance table (D45). It
  lives here because `core/` is the lower layer: `modules/premium/
  limits.ts` re-exports it, and the perk list is generated from it, so
  there is one table and not two that have to agree.
- `FreeTierKey` names the *gated features*, not the table's keys:
  `FREE_TIER` is a partial record over it. A feature the table has no
  entry for is unlimited, and `freeTierLimit` answers `null` for it.
  Read a limit with `freeTierLimit`, not with `FREE_TIER[key]` — the
  table only has an entry for the features it caps.
- `FreeTierLimits` is the table's own type. The features it caps keep
  their exact number (`3`, not `number | undefined`), so a reader that
  knows the feature is capped reads a definite value. The capped half
  is derivable from the type, so a caller that wants it does not have
  to keep its own list.
- `core/guards.ts` never reads a number from the table: `countLimitGuard`
  takes the limit as a parameter, so no allowance is hard-coded in the
  runtime layer.
- `assertEntitled(guildId, feature)` is the only place an entitlement is
  read, and it is always called *before* the state it guards changes.
- `modules/premium/entitlements.ts` already exports an `entitlementLookup`
  that satisfies {@link EntitlementLookup}. Use it.

## `errors.ts`

`DenialError` (re-exported from `utils/errors.ts`), `TypedDenialError`,
`PermissionDeniedError`, `RoleHierarchyError`, `PremiumRequiredError`,
`LimitExceededError`, `OwnershipError`, `NotStaffError`, `InputError`,
`denialMessage`.

A refusal is not a crash: it is an answer to show a person. The base class
is the `DenialError` that already existed, so `instanceof DenialError`
keeps working for every kind.

**A caller must know:** every message is built with a template literal at
construction time. There is deliberately no "format later" placeholder — a
refusal that still holds `{ctx.bot.prime_link}` when it reaches the user
is worse than no message at all.

## `guards.ts`

`Guard`, `isStaff`, `isAdmin`, `hasGuildPermissions`,
`hasChannelPermissions`, `canManageRole`, `ownerGuard`, `staffGuard`,
`adminGuard`, `premiumGuard`, `countLimitGuard`, `combineGuards`,
`Guards`, `STAFF_ROLE_NAME`, `STAFF_DENIAL_MESSAGE`,
`OWNER_DENIAL_MESSAGE`.

The one place authorisation is decided (D28). A guard is
`(interaction) => Promise<string | null>`: `null` allows, a string refuses.

The dispatcher runs guards in the order `guildOnly → staffOnly → guards`,
before `execute`.

**A caller must know:**
- `isStaff` is the check the **frozen** verification flow uses:
  Administrator, or a member of the role named `Moderator`. Do not
  "improve" it into a permission check.
- `canManageRole` applies Quotient's five hierarchy rules **in order** and
  returns Quotient's wording: managed role, above the bot's top role, above
  the caller's top role (the guild owner is exempt), more permissions than
  the caller, administrator.
- `premiumGuard` and `countLimitGuard` take an injected lookup. Nothing in
  `core/` may import `db/`.
- The count limit comes from `FREE_TIER`, so the number in the code and the
  number in the perk list cannot drift apart.

## `ratelimit.ts`

`RateLimiter`, `BucketType`, `RateLimiterOptions`, `describeWait`.

The limiter the dispatcher applies (D39). Quotient limited every command to
two per ten seconds per member, and the screenshot intake to one per seven
seconds per member and ten per minute per guild.

**A caller must know:**
- A **guild** bucket is a sliding window: ten submissions spread over a
  minute is not ten submissions inside three seconds.
- Every other bucket (member, user, channel) is a simple timestamp: one hit
  per window.
- A refused hit is **not** recorded. The window does not slide forward
  because somebody kept trying.
- `hit()` returns `null` when the hit is allowed, or the milliseconds the
  caller has to wait when it is not.

## `context.ts`

`respond`, `sendCollectable`, `replyError`, `replySuccess`, `replySimple`,
`sendFile`, `replyErrorUntilDeleted`, `ReplyOptions`, `ReplyPayload`,
`ReplyHandle`, `CollectableOptions`, `SendFileOptions`,
`ReplyErrorUntilDeletedOptions`.

The context, as functions rather than a class (D38). In discord.js the
interaction *is* the context.

**A caller must know:**
- `respond` is the only place that knows about the deferred/replied
  distinction. The dispatcher defers every chat-input command, so a helper
  that called `interaction.reply()` directly would fail on a deferred
  interaction.
- **Discord allows an interaction to be replied to once.** Every other
  rule here follows from that one, so it is worth stating plainly:

  | the interaction | what `respond` does          |
  | --------------- | ---------------------------- |
  | fresh           | `interaction.reply(...)`     |
  | deferred        | `interaction.editReply(...)` |
  | already replied | `interaction.followUp(...)`  |

  A second answer cannot be a reply — Discord throws — so it has to be a
  **follow-up**: a message of its own, which can carry its own
  components. That is the escape hatch for a flow that needs two inputs.
- The ephemeral flag is fixed when the response is first sent. On an
  interaction that was already deferred, the `ephemeral` option is ignored.
  A follow-up is a message of its own, so it can be ephemeral even when
  the reply was not.
- `sendCollectable` sends the message a component collector waits on. It
  is `respond` with one extra option — `asFollowUp` — and it is what
  `prompt` and `awaitSelect` use. A follow-up needs an interaction that
  has already answered, so `asFollowUp` on a fresh interaction falls back
  to the interaction's own reply.
- `replyErrorUntilDeleted` posts a refusal and then watches for the
  invoking message to be deleted; when it goes, the refusal goes with it.
  The watch is **non-blocking** — it subscribes to `messageDelete` and
  never awaits inside the handler. It only has an invoking message to
  watch for a message context-menu command; a plain slash command has none.
- `sendFile` escapes mentions by default. The contents of a file are user
  data.

## `prompt.ts`

`prompt`, `PromptOptions`, `PROMPT_CUSTOM_ID_PREFIX`.

The Confirm/Cancel row. Quotient's `ctx.prompt` blocked on
`await view.wait()`; here it is a promise resolved by a component collector
(D35).

**A caller must know:**
- The prompt is owned by the caller. The collector's filter checks the
  **clicker's user id**, so somebody else's click is ignored and the prompt
  keeps waiting for the owner. The random token in the custom id is *not*
  the guard: it is in the message, and the message is in a channel other
  people can read.
- `allowOthers: true` opens the prompt to the whole channel — a vote, a
  poll. It is off by default, and turning it on is a deliberate, visible
  choice at the call site.
- Each prompt's button ids carry a random token, so two prompts open in
  the same channel at the same time cannot be answered by the same click.
- The buttons are removed once the prompt is answered or times out. A
  prompt whose buttons are still live after it has been answered is a trap.
- The prompt message has to be public for a second moderator to see it
  (D43). The `ephemeral` option only has an effect when the interaction has
  not been replied to yet.
- A timeout is a refusal: `prompt` returns `false`.
- **One interaction yields one collection.** A flow that asks two questions
  needs the second on a follow-up (`asFollowUp: true`) or on a message it
  sent itself. This is a Discord constraint, not a limitation of these
  helpers.

**Behaviour change:** the owner check used to be *documented but not
enforced* — the filter matched the custom id alone, so anybody in the
channel could answer another moderator's prompt and confirm it on their
behalf. The check is now real, in `prompt`, `awaitSelect`,
`awaitChannelSelect` and `awaitRoleSelect`. A caller that relied on the
old, open behaviour has to pass `allowOthers: true`. **No caller in the
bot does:** every prompt and every menu is a moderator flow, and none of
them is a vote, so the change breaks nothing today.

## `select.ts`

`awaitSelect`, `awaitChannelSelect`, `awaitRoleSelect`, `SelectOption`,
`AwaitSelectOptions`, `AwaitAutoSelectOptions`, `AwaitChannelSelectOptions`,
`AwaitRoleSelectOptions`, `SELECT_CUSTOM_ID_PREFIX`,
`CHANNEL_SELECT_CUSTOM_ID_PREFIX`, `ROLE_SELECT_CUSTOM_ID_PREFIX`.

Waits for a select menu and returns the chosen values as
`Promise<string[]>` (D35). This replaces Quotient's `custom_id` string
packing (`"slot_id:tourney_id"`) and its `hasattr(v, "custom_id")`
sniffing.

**A caller must know:**
- At most 25 options, and Discord's own limits on label and value length.
  Anything outside them throws — it is a programming error, not a user
  error.
- The menu is owned by the caller. The filter checks the **clicker's user
  id**, so somebody else's choice is ignored and the menu keeps waiting for
  the owner. A menu's options are visible to everybody in the channel, so
  a menu in a public channel is at least as exposed as a button.
- `allowOthers: true` opens the menu to the whole channel — a vote, a
  poll. It is off by default, and turning it on is a deliberate, visible
  choice at the call site.
- The menu's custom id carries a random token, so two menus open in the
  same channel cannot be answered by the same click.
- A timeout returns an empty array, not `null`.
- **One interaction yields one collection.** A flow that asks two questions
  needs the second on a follow-up (`asFollowUp: true`) or on a message it
  sent itself. This is a Discord constraint, not a limitation of these
  helpers.
- **Three kinds of menu, one set of rules.** `awaitSelect` collects a
  *string* menu: the options are the ones the caller wrote down.
  `awaitChannelSelect` and `awaitRoleSelect` collect the two
  **auto-populated** menus, which Discord fills with the guild's channels
  and roles. They are a different component type, so they need a
  different helper — a string menu cannot stand in for a channel picker.
  The collection rules (owner, timeout, cleanup) are the same, and the
  three share one implementation.

**`awaitChannelSelect`:**
- `channelTypes` filters what the menu offers. It defaults to a text
  channel and an announcement channel — the two types every picker in the
  bot wants. Pass `[ChannelType.GuildVoice]`, `[ChannelType.GuildCategory]`
  and so on to widen it, or an empty list to let Discord offer every type
  it has. An empty list is *not* sent as an empty filter: `channel_types`
  is left off the component, which is how Discord is told "all of them".
- `guildId` restricts the answer to one guild. It defaults to the guild
  the interaction came from. **Discord's channel select has no "guild
  mode" parameter** — when the bot is in more than one guild, the client
  offers a guild picker, and the menu can hand back another guild's
  channel — so the filter is enforced here, on the answer: the channel is
  fetched, and a channel that is not in the guild is not an answer. The
  collector keeps waiting and the menu stays live for the owner.
- The menu is ephemeral by default. A picker is a private choice, and a
  public one shows the whole channel what is being picked.

**`awaitRoleSelect`:**
- Discord's role select has **no role-type filter**: the component
  carries no such field, so a menu cannot be narrowed to, say, the roles
  a bot manages. The menu offers the guild's roles.
- A role belongs to one guild, so there is no guild filter to apply.

## `time.ts`

`IST`, `discordTimestamp`, `formatRelativeTime`, `parseDuration`,
`parseNaturalTime`, `parseTimedText`, `formatTimestamp`, `dayName`,
`DiscordTimestampStyle`, `ParseTimeOptions`.

One natural-language parser, one time zone, no naive local time (D30).

**A caller must know:**
- `parseNaturalTime` is **the** parser for anything a user types. It takes
  an explicit reference instant and an explicit time zone; never parse a
  time with `new Date(string)`.
- A result in the past rolls forward by whole days until it is in the
  future. That is Quotient's rule: "7 PM" asked at 8 PM means 7 PM
  tomorrow. Pass `rollForward: false` to switch it off.
- `parseTimedText` is for a time of day ("7 PM") and requires one to be
  present — "tomorrow" on its own is not a time.
- `parseDuration` handles the fixed-length units only. Years and months are
  refused rather than silently turned into 30 days.
- `discordTimestamp` renders in each reader's own locale and time zone. Use
  it for user-facing times; use `formatTimestamp` when the server's zone
  matters.
- `dayName` reads the named zone, so the day boundary is where the users
  think it is. Quotient's `day_today()` used naive local time and put it
  in the wrong place for a few hours every day.

## `ttl-cache.ts`

`TtlCache`, `TtlCacheOptions`.

An in-memory cache with a time to live (D7). No Redis: the bot is one
process, and a cache that needs a network round trip is not a cache.

**A caller must know:**
- The name is `ttl-cache.ts` on purpose. `repo/cache.ts` already exists and
  means the example-image cache; two different things must not share a
  name.
- The sweep timer is `unref`ed, so the cache never holds the process open.
  Call `stop()` when the owner shuts down, and in tests.
- `maxSize` drops the **oldest** entry when the cache is full.

## `fire-and-forget.ts`

`run`, `runAsync`.

Node 20 terminates the process on an unhandled rejection. Quotient's
`create_task` only warned, which is why Quotient could survive a failing
background job.

**A caller must know:** every detached promise goes through `run`. A button
handler that fires a background job calls `run(...)` and returns — it must
not `await` inside the handler. `run` never rejects; `runAsync` waits for
the work but still never throws.

## `router.ts`

`registerButton`, `registerSelect`, `registerModal`,
`registerLegacyVerifyButton`, `dispatch`, `clearRegistry`,
`registeredPrefixes`, `LEGACY_VERIFY_PREFIX`, and the handler types.

Routes a component interaction to the module that owns it, by the prefix of
its custom id.

**A caller must know:**
- **Registration order matters.** The first registered prefix that matches
  an id wins, so a specific prefix has to be registered before a general
  one — `scrims:editor` before `scrims`.
- A prefix matches on a **segment boundary**: `scrims` matches
  `scrims:claim:42` and does not match `scrims_extra:claim:42`.
- **A prefix must not be a segment-prefix of another prefix in the same
  area.** `identity:ssmod` is a segment-prefix of `identity:ssmod:setup`,
  so when both are registered one of the two can never be reached — the
  router takes the first matching prefix, and the order decides which one
  that is. If an area needs `identity:ssmod:setup` and
  `identity:ssmod:edit`, it should register `identity:ssmod` **once** and
  dispatch on the second segment, or namespace the two so that neither can
  shadow the other. The router logs a warning, naming both prefixes, the
  area and the winner, when it sees such a pair.
  **The screenshot-verification area is the worked example:** it registers
  `identity:ssmod` once and its ids carry a *surface* — `identity:ssmod:wizard:save`
  is the wizard's save, `identity:ssmod:edit:delete` is the editor's delete —
  so the handler never has to guess whether a target is a draft token or a
  row id.
- **The segments of a custom id and the segments a handler switches on must
  be the same ones.** An id of `tourneys:select:pick` carries the action
  `select` and the sub-action `pick`; a handler that compares the action
  against `pick` refuses every pick. The id's shape and the handler's
  comparison are one thing, and they have to agree.
- **Registering the same prefix twice replaces the earlier handler in
  place**, keeping the order stable — and logs a warning, because two
  areas claiming the same id space is a bug, and the loser of it is a
  feature that silently does nothing.
- The handler is called with the interaction and the **rest** of the id.
- An id nobody owns is logged and refused politely. The router never
  guesses.
- `verify_btn` is **not** a module name. It is the frozen verification
  button of the existing flow, so it gets an explicit branch. Until
  `registerLegacyVerifyButton` is called, `dispatch` leaves those buttons
  alone and returns `false`, so the existing handler keeps working.

## `paginator.ts`

`Paginator`, `buildPagerEmbed`, `buildPagerRow`, `pagerCustomId`,
`parsePagerCustomId`, `registerPageSource`, `PAGER_CUSTOM_ID_PREFIX`,
`PAGER_ACTIONS`, `PagerAction`, `PageSource`, `PaginatorOptions`.

Pagination over a list of lines, with first/previous/next/last.

**A caller must know:**
- The custom ids are namespaced: `pager:<namespace>:<action>:<page>`.
  Quotient's bare `"first"` and `"previous"` ids collide globally (D7).
- The page number travels in the id, not in a token (D18). The button is
  stateless: a press can be understood without knowing which paginator
  object produced the message.
- The *content* is a separate question. A paginator over a database list
  has to be given a `loadPages` function, which is called again on every
  press so the list is current rather than a snapshot. Without one, the
  in-memory lines are used.
- One namespace per paginator on screen. Two paginators with the same
  namespace share their buttons.
- The buttons expire after `timeoutMs` (five minutes by default): the row is
  taken off the message and the page is left where it is. A component
  collector that never expires is a hazard.
- The router handler resolves the paginator through a registry, so a
  paginator that is rebuilt (a command run twice) does not orphan the older
  message. The handler is the same for every paginator of a namespace, so
  the prefix is registered **once**: a rebuild is not a duplicate
  registration, and the router would warn about one.

## `embed-builder.ts`

`EmbedTemplate`, `EmbedEditTarget`, `EmbedDesigner`, `EmbedDraft`,
`EmbedOpenOptions`, `EmbedSaveHandler`, `embedDesigner`,
`registerEmbedDesignerInteractions`, `EMBED_EDIT_TARGETS`,
`EMBED_DESIGNER_PREFIX`, `EMBED_DESIGNER_SELECT_ACTION`,
`EMBED_DESIGNER_SAVE_ACTION`, `EXPIRED_DRAFT_MESSAGE`,
`embedTemplateToBuilder`, `embedTemplateToJSON`, `parseEmbedTemplate`,
`parseEmbedColor`, `applyEmbedEdit`, `buildEmbedDesignerOptions`,
`buildEmbedDesignerModal`, `embedDesignerSelectCustomId`,
`embedDesignerModalCustomId`, `embedDesignerSaveCustomId`.

The embed designer: a select menu with the five edit targets — the message
itself, the thumbnail, the image, the footer icon and the colour — each
opening a modal.

**It is wired by core.** Its custom ids carry the `embeds` prefix, and this
module registers that prefix with the router: the **select** that opens the
modals, the **modal** that applies the edit, and the **save button** that
hands the finished design to the area. An area that uses the designer does
not have to know that the prefix needs registering — which is how a feature
ends up wired to nothing. The registration is **idempotent**: the prefix is
registered once, however many times `registerEmbedDesignerInteractions()` is
called, because a registration that fires twice is a duplicate and the
router warns about duplicates.

**A caller must know:**
- The stored value is a **plain JSON object** (D32). Never a Python
  literal string. `embedTemplateToJSON` and `parseEmbedTemplate` are the
  only way in and out.
- `parseEmbedTemplate` returns `null` for a malformed value rather than
  throwing: it is data, and data can be wrong.
- The designer keeps the template being edited in a **token** (D18) — it is
  a wizard mid-flight and has no database row yet. The token lives in the
  modal's custom id and expires with the token store.
- **A draft lives in memory, and it is lost when the bot restarts.** The
  draft is a wizard mid-flight, not a row: it is in the token store, it
  lives fifteen minutes, and a restart empties the store. The panel's
  buttons then answer "this draft has expired. Please run the command
  again" instead of throwing. The *design* is not lost by that, because
  nothing is saved until the design is saved: the area writes the finished
  template to its own column, and a draft that was never saved was never
  anything but an edit in progress. This is the behaviour Quotient's embed
  builder had.
- The select's custom id carries the token too (`embeds:options:<token>`),
  because the area has to be able to tell which draft a press is for.
- **The draft knows its owner.** `start(template, ownerId)` records who
  started it, and the draft is the only place that knows. The token is in
  the message and the message is in a channel other people can read, so
  the token is not a secret and cannot be the guard.
- An area checks the owner in **one call**: `await
  designer.guardOwner(interaction, token)` returns `true` when the caller
  may go on, and `false` when the interaction has been refused (the
  refusal has been sent by then). `designer.isOwner(token, userId)` is the
  same question with no side effect, for a handler that wants to refuse in
  its own words.
- A modal is inherently owner-only: Discord only lets the member who
  opened it submit it. The **select** is the exposed one — anybody in the
  channel can press it — so the owner check belongs there. The **save
  button** is exposed in exactly the same way, so it is checked too.
- `open(interaction, { template, ownerId, onSave })` is the whole flow in
  one call: it starts the draft, posts the panel, and keeps the handle to
  the panel in the draft. The re-render after an edit therefore lands on
  the message that actually carries the panel — the reply, or the follow-up
  the panel was sent as. `start(...)` makes a draft without a panel, for a
  caller that renders the panel itself; the re-render then lands on the
  message the modal was opened from, which is that panel.
- The **panel** is the designer's: the embed being edited, the select, and
  the save button. The save button is only there when the draft has
  something to save.
- **What a design is for is the area's business**, so the area hands the
  designer the action to run when the owner presses Save:
  `onSave(template, interaction)`. The designer answers the press, and
  confirms the save unless the area has already said something itself.
- An image URL is only accepted when it is an `https` URL; anything else
  clears the field, as in Quotient.
- `parseEmbedColor` accepts `r,g,b`, a hex value and a colour name. The
  name table is smaller than PIL's — a hex value always works.

---

## Tests

`npm test` runs them. The files sit beside the code they test:

| File | What it pins down |
|---|---|
| `team-name.test.ts` | Quotient's exact `find_team` behaviour, the fallback and the first-line-only rule (D27) |
| `text.test.ts` | `truncate`, `plural`, `humanJoin` and Python-compatible `titleCase` |
| `custom-id.test.ts` | round-tripping, that `verify_btn:FF` still parses, and the token store |
| `escape.test.ts` | markdown and mention escaping |
| `time.test.ts` | duration parsing, natural-language parsing with an explicit reference date and time zone, a past date rolling forward |
| `ratelimit.test.ts` | the sliding window and the simple timestamp bucket |
| `ttl-cache.test.ts` | expiry, sweeping and eviction |
| `context.test.ts` | `respond` on a fresh, a deferred and an already-replied interaction |
| `prompt.test.ts` | the Confirm/Cancel row, the follow-up a second question needs, and the owner check |
| `select.test.ts` | the select menu, **two collections out of one interaction**, the owner check, and the channel and role menus |
| `embed-builder.test.ts` | the draft's owner, the refusal a member who does not own it gets, and the wiring: the select opening the modal, the modal applying the edit, the panel being re-rendered, the save button, and a draft that is gone answering instead of throwing |

`interaction.fake.ts` is the stand-in for Discord the collection tests
share: an interaction whose state moves the way discord.js moves it, and
whose responses resolve a collector with the buttons that were actually
sent. Its collector takes the first click its **filter** accepts and
ignores the rest, so a click from the wrong member is not an answer — the
prompt keeps waiting, exactly as it does on Discord. It also stands in for
the three **component** interactions — a select menu, a modal submit and a
button — for the tests that drive the router. It is test-only code.

No test in `core/` talks to Discord or to a database.
