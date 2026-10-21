# `modules/identity/` — the identity area

Three features that answer one question — *who is this person, and are
they really on this team?*

| Feature | What it is |
|---|---|
| **Tag check** | A channel where a captain registers his team by mentioning his teammates. |
| **Easy tag** | A channel where the bot turns the raw ids and `@names` in a message into real mentions. |
| **Screenshot verification** | A channel where a participant proves they follow the tournament's page with a picture. |

Quotient modelled the first three as discord.py cogs with per-guild
configuration rows and a lot of `if` in the listeners. Here the rules are
**pure functions over plain data** (`tagcheck.ts`, `easytag.ts`,
`verification.ts`, `duplicate.ts`) and the state machines live in
`service.ts`. The rules can be tested without a Discord connection, and
they are.

The tournament's **group manager** used to live here as well. It was a
second, unreachable copy of the tournament area's own group manager, and
its handlers created channels and roles without checking the caller. It
has been deleted — the tournament area's version is the live one.

---

## The interface

### Commands

Three top-level commands. `commands/esports/<name>.ts` is a one-line
re-export of the command object in `modules/identity/commands/`.

| Command | Subcommand | What it does |
|---|---|---|
| `/tagcheck` | `set` | Makes a channel a tag-check channel. Optional `mentions` (0–20, default 4). |
| | `config` | Lists the tag-check channels of this server. |
| | `remove` | Stops checking the mentions in a channel. |
| | `autodelete` | Deletes a rejected message after a while. |
| `/easytag` | `set` | Makes a channel an easy-tag channel. |
| | `remove` | Stops converting the tags in a channel. |
| | `config` | Lists the easy-tag channels of this server. |
| | `autodelete` | Deletes the message and the bot's answer after a while. |
| `/ssverify` | — | Opens the screenshot-verification panel. |

All three need **Manage Server** (`hasGuildPermissions(interaction,
PermissionFlagsBits.ManageGuild)`), and `/tagcheck set` and `/easytag
set` additionally check that the bot may send messages, embed links and
manage messages **in that channel** before they write anything.

`/ssverify` answers **ephemerally**. The panel is a moderator's control
panel — its buttons delete a server's verification setup, repoint the
channel the bot reads, change the role the bot grants and set the text
the bot posts — so it does not belong in the channel. The ephemeral reply
is not the authorisation: the panel's buttons check the caller
themselves, because a message that only the moderator can see still
travels. See [the panel's authorisation](#the-panels-authorisation).

### The module's entry points

```ts
import {
  registerIdentity,
  warmIdentity,
  shutdownIdentity,
} from "./modules/identity/register.js";
```

- `registerIdentity(client, router?)` attaches the `MessageCreate`
  listener and, when a router is given, wires the panel's buttons, select
  menus and modals into it.
- `warmIdentity()` decides whether the OCR runs and loads the channel
  cache. The manager calls it on `ClientReady`.
- `shutdownIdentity()` releases the OCR provider and the wizard's draft
  store.

### The service

`service.ts` is the only way to change a configuration. The command
adapters and the message listeners are thin on top of it.

```ts
import * as service from "./modules/identity/service.js";

await service.setTagCheckChannel({
  guildId, channelId, requiredMentions: 4, ignoreRoleId,
});

await service.setEasyTagChannel({ guildId, channelId, ignoreRoleId });

await service.createSsConfig({
  guildId, channelId, roleId, requiredSs: 2,
  channelName: "Team Phoenix", channelLink: "https://…",
  keywords: [], allowSame: false, ssType: "youtube", successMessage: null,
});
```

The four premium gates live here too, and they are the only way a
premium feature is enforced (D15): `assertChannelAllowance`,
`assertSsConfigAllowance`, `assertScreenshotTypeAllowed` and
`assertSuccessMessageAllowed`.

### Custom ids

```
identity:ssmod:<surface>:<action>[:<target>]
```

The panel has **one** prefix — `identity:ssmod` — and one registration per
kind of component, so no pair of prefixes can shadow each other and the
order the registrations are made in cannot decide which handler runs.

The **surface** is the segment right after the prefix, and it says what
the target is:

| Surface | What it is | The target |
|---|---|---|
| `list` | The list of a guild's setups. | none — its buttons start a wizard, show the FAQ and open the editor. |
| `edit` | The editor of one setup. | the **row id** (D18): the setup exists, so the panel survives a restart. |
| `wizard` | The wizard that creates a setup. | the **token**: the setup does not exist yet, so its state is a token. |

The action is the next segment, and it belongs to the surface: `save` is
the wizard's, `delete` is the editor's, and `setup` is the list panel's.
An id that names an action of another surface is not one of this area's
ids, and the parser refuses it.

| Id | What it does |
|---|---|
| `identity:ssmod:list:setup` | Open the wizard. |
| `identity:ssmod:list:faq` | Show the frequently asked questions. |
| `identity:ssmod:list:edit:<configId>` | Open the editor of a setup. |
| `identity:ssmod:edit:set_channel:<configId>` | One field of the editor. |
| `identity:ssmod:edit:delete:<configId>` | Delete a setup. |
| `identity:ssmod:wizard:set_channel:<token>` | One field of the wizard. |
| `identity:ssmod:wizard:save:<token>` | Save the wizard. |

The scheme lives in `views/ids.ts`: the surfaces, the actions, the
builder and the parser. The rule it exists for is the router's — *the
segments of a custom id and the segments a handler switches on must be
the same ones* — and the builder and the parser are the only two places
that know the layout.

### The panel's authorisation

The panel is a **message**, so anybody who can read the channel can press
its buttons. The buttons are not harmless: they delete a server's
verification setup, repoint the channel the bot OCRs, change the role the
bot grants on success, and set the text and the link the bot posts
afterwards. That is a privilege escalation over the bot's own
configuration, so **every** handler checks the caller itself
(`guards.ts`), before the setup is read or written.

| Rule | Where it is decided |
|---|---|
| The interaction must come from a guild. | `canManageSsConfig` |
| The caller must be a moderator of that guild — Manage Server, Administrator, or the staff role the guild already uses. | `canManageSsConfig` |
| The setup must belong to that guild. | the **lookup**: `repo.findSsConfigById(guildId, id)`, `repo.updateSsConfig(guildId, id, …)`, `repo.deleteSsConfig(guildId, id)` |
| The wizard must belong to that guild. | the draft carries its guild: `startSsWizard(guildId)` |

The third row is the important one. The row id of a setup travels in a
custom id, so a lookup by id alone would answer a question about another
server's configuration. A uuid primary key makes that guess unguessable
rather than impossible, which is not a defence — so the **guild is part
of the key** everywhere, the way the community area's `findTagById(guildId,
id)` does it.

The rest of the repository already worked this way: the slots area says
outright that "the panel is public, so the buttons check the caller
themselves", the tourneys area calls `refuseUnlessMod`, and the
moderation area calls `isStaff`.

---

## The rules

### The tag check

`tagcheck.ts` holds two guards, in the source's order. The first one
that refuses wins.

| Guard | Refuses with | Fires when |
|---|---|---|
| `bot_mentions` | `Kindly mention your real teammate.` | The message mentions a bot **and** the channel asks for at least one mention. |
| `insufficient_mentions` | ``You need to mention `N teammate(s)`.`` | The message mentions fewer users than the channel asks for. |

A channel with `requiredMentions = 0` accepts every message — bot
mentions and all.

One change from the source: Quotient counted **every** mention, and in
discord.py that includes role mentions. A role is not a teammate, so only
user mentions are counted here.

The accepted message is reacted to with ✅ and answered with an embed
that shows the team name and the players. The team name comes from
`core/team-name.ts` (`find_team`, D27) — a verbatim port that is **not**
reimplemented here.

### The easy tag

`easytag.ts` turns three shapes into a real mention.

| Written as | Resolved by |
|---|---|
| `123456789012345678` | The member whose id is exactly that. |
| `<@123456789012345678>` | The same — the `@` is how Discord writes an id. |
| `@name#1234` | The member whose id ends with `1234`. When several members share the discriminator, the username decides; when none of them has that username, the tag is ambiguous and **nothing** is returned. |
| `@name` | The member whose username or display name matches, case-insensitively. |

A tag that refers to nobody becomes the text `Invalid Member!` in the
answer, and the answer also repeats the original content so a captain can
see what the bot made of it.

### The screenshot verification

`verification.ts` holds one **ordered list of guards per screenshot
type**. The first guard that refuses wins, which is what the source's
`if`/`elif` chain did — but as data, so a new type is one list rather
than one method.

| Type | Rules, in order |
|---|---|
| `youtube` | Is it a YouTube screenshot? → Is it the right channel? → Is the **SUBSCRIBE** button still showing? |
| `instagram` | Is it an Instagram screenshot? → Is it the right page? → Is the **FOLLOW** button still showing? |
| `rooter` | Is it the right channel? → Is the **FOLLOW** button still showing? |
| `loco` | Is it the right channel? → Is the **FOLLOW** button still showing? |
| `any_ss` | — (everything is accepted) |
| `custom` | Does it show the filter's name **or** one of its keywords? |

The keywords of a custom filter live in their own table
(`ss_config_keywords`), one row per keyword, and they are **stored as they
were typed**. The comparison normalises them — lowercased, with the spaces
stripped, on both sides — when it looks at them, so normalising on the way
into the database would only lose what the operator wrote.

The refusals are the source's wording:

```
This is not a valid youtube ss.
Screenshot must belong to [`Team Phoenix`](https://…) channel.
You must subscribe [`Team Phoenix`](https://…) to get verified.
```

#### How the rules behave against **this** port's OCR engine

The port reads the screenshot with a Quotient-compatible **remote service**
(`modules/ssverify/ocr/`) — the same shape the source was calibrated
against, and the only engine there is. The provider answers with two
texts, and the rules read them differently:

- `OcrResult.text` — lower-cased, whitespace stripped. This is the
  source's `lower_text`, and it is what the contains-rules read.
- `OcrResult.rawText` — the text as the engine read it. This is what
  the literal button checks read, because normalisation destroys the
  trailing space Quotient's `"SUBSCRIBE "` check depended on.

What that means in practice:

| Rule | Reliability | Why |
|---|---|---|
| "is this the right app" (`subscribe` / `videos` / `followers`) | **reliable** | A contains-check on normalised text. |
| "is this the right page" (the page name) | **tolerant** | See below. |
| "is the SUBSCRIBE button showing" | **reliable** | A word-boundary match on the raw text, case-insensitive. |
| "is the FOLLOW button showing" | **reliable** | The same, with `Following` and `Unfollow` excluded. |

**The page name is the one rule that needed changing.** Quotient asked
for the configured name as one contiguous piece of the OCR text. An icon
that the engine reads as a character *inside* the name ("Team | Phoenix"
read as `team|phoenix`) broke a check a human would pass. The port
matches the name in three passes:

1. the name as one contiguous piece of the text;
2. the name with the punctuation removed from the text — this catches an
   icon read as `|` or `•`;
3. the name with up to **two** stray characters inside it — this catches
   an icon read as a *letter*.

Both sides are normalised with the same function first, so a space in
the configured name cannot make the comparison fail, and a name shorter
than four characters is never matched with noise (a two-letter name
would match almost anything).

The two literal button checks are also changed: they are case-insensitive
word matches now, and they still refuse `SUBSCRIBED` and `Following` —
exactly as Quotient's trailing space did.

**These three changes were made against a local engine**, which read
pictures differently from the service the source used. The port talks to
a remote service again, so the engine does not force them any more — but
they stay, because each of them is safe against any engine: the tolerant
name match accepts a picture the source would have refused (it can never
refuse one the source accepted), the case-insensitive button check refuses
a few pictures more than the source's exact `"SUBSCRIBE "` did, and the
raw/normalised split is required by the normalisation itself.

**A provider that fails refuses the screenshot outright.** The service is
down, it answers with rubbish, or it sends a hash nobody can compare: the
screenshot cannot be verified, so it is refused and **nothing is stored**.
The rules are not asked at all. The switched-off provider is the same case
for the same reason — it answers with an empty text, and most rule sets
reject an empty text, but **not every one does**: `any_ss` has no rules
at all, and a `loco` or `rooter` setup whose channel name is empty has
none that look at the text either — for those, an empty text would be
*accepted*. That is why the submission is refused **outright** when the
OCR is known to be **off** rather than being left to the rules. See [the
OCR provider](#the-ocr-provider).

### The duplicate check

`duplicate.ts` refuses a screenshot that is already in the setup.

| Check | What it compares |
|---|---|
| `own` | The new dHash against **the same member's** stored dHashes, at a Hamming distance of 7 or less. |
| `same` | The new dHash **and** pHash against every stored pair, both equal. |

The threshold is a parameter (D20), not a constant: it is only
meaningful for a 64-bit hash, so it moves with the hash implementation
rather than being baked into the comparison.

**The threshold is the setup's own.** `ss_configs.duplicate_threshold` is
a column of its own, and the duplicate check of a submission runs with
**that setup's** value — the global default of 7 is only the fallback:

| The setup's value | What the check runs with |
|---|---|
| a whole number from 0 to 64 | that number |
| nothing (no threshold of its own) | the global default (7) |
| not a whole number, or outside 0…64 | the global default (7) |

A value that cannot be a Hamming distance **falls back** rather than
fails: a nonsense number in a column must not stop a member from being
verified. Zero forgives nothing; 64 is the largest distance a 64-bit hash
can have, so nothing is ever a duplicate.

The check is still on the **dHash**. The pHash is stored beside it, but
the threshold of 7 was calibrated on the dHash.

**The check never throws.** A hash that is not sixteen hex characters
cannot be compared, and a comparison that could not be made is not a
comparison that clears the screenshot. The check answers with a decision
instead of an exception:

| What is broken | What happens |
|---|---|
| The **screenshot's own** hash (the service sent rubbish) | The screenshot is **refused**. A hash that cannot be compared verifies nothing. |
| The **member's own** stored row | The submission is **refused** — the check cannot tell whether the member is repeating themselves. |
| **Somebody else's** stored row | The row is **reported and passed over**. One bad row must not block every member of the setup. |

Every corrupt row is reported with the setup, the row, the member and the
broken value, so the operator can repair or delete it. The threshold
changes none of it: a row that cannot be compared is a row that cannot be
compared, whatever the distance the setup forgives.

### The state machines

**The tag-check channel.** `none → (set) → live → (remove) → none`.
`deleteAfter` is a flag on the live state, toggled by `/tagcheck
autodelete`.

**The easy-tag channel.** `none → (set) → live → (remove) → none`, with
the same `deleteAfter` flag.

**The screenshot-verification setup.** `none → (wizard) → draft → (save)
→ live → (delete) → none`.

- The wizard's state is a **token** into an in-memory map, because the
  setup does not exist as a row yet (D18).
- The editor's state is the **row id**, carried in the custom id, so the
  panel survives a restart and the message being moved.
- The channel only becomes live when the setup is **saved**. The source
  added the channel to its live set as soon as the channel was picked, so
  cancelling the wizard left a half-configured channel running (B11).

**One submission.** `attachments → rate limits → OCR → duplicate check →
type rules → recorded → role granted`. The stored submissions are re-read
after every accepted screenshot, so a second screenshot in the same
message cannot be a duplicate of the first one.

**One submission.** `attachments → rate limits → OCR → duplicate check →
type rules → recorded → role granted`. The stored submissions are re-read
after every accepted screenshot, so a second screenshot in the same
message cannot be a duplicate of the first one.

**One submission while the OCR is off.** `refused → nothing stored`. The
refusal comes before the duplicate check and before the rules, because
the rules cannot refuse it on their own — see [the OCR
provider](#the-ocr-provider).

**One submission the OCR could not read.** `refused → nothing stored`. The
service is down, it answered with rubbish, or it sent a hash nobody can
compare: the screenshot cannot be verified, so it is refused. The member
gets an answer either way — a refusal is a decision, not a crash.

### The premium gates

| Gate | Entitlement | What it stops |
|---|---|---|
| `assertChannelAllowance` | `extra_channels` | A second tag-check or easy-tag channel. The free tier allows one of each (D45). |
| `assertSsConfigAllowance` | `extra_channels` | A second screenshot-verification setup. The free tier allows one. |
| `assertScreenshotTypeAllowed` | `screenshot_types` | Any type but YouTube. YouTube is the only free flavour. |
| `assertSuccessMessageAllowed` | `success_message` | A custom success message. |

**Every gate runs before the state it guards changes** (D15). A refusal
that arrives after the state changed cannot be undone, and the source had
exactly that bug twice: the screenshot type was written to a free guild's
row before the entitlement was checked (B8), and the success message had
no gate in the wizard at all (B12). One `assertEntitled` call covers
both paths now, and the button is never silently disabled (D29).

### The ignore role

A guild role called `quotient-tag-ignore` lets a member opt out of the
tag check and the easy tag. The port stores the role's **id** on the
configuration row (D16); the name is only ever used to **create** the
role. A role that merely carries the name does not opt anybody out.

### The channel cache

The message listener asks "is this channel one of ours?" on **every**
message, so the answer must not touch the database. `cache.ts` holds
three `ChannelIdCache` instances from `core/channel-cache.ts` (D21) — one
per kind — and they are rebuilt from the database at startup.

The cache is **only ever a hint**: a channel id in the cache does not
mean the row exists, and the row is always read before anything is
written. A listener that finds no record for a cached channel removes
that channel from the cache.

### The rate limits

| Limit | Shape |
|---|---|
| 1 submission per member every 7 s | a timestamp |
| 10 submissions per guild every minute | a sliding window |

Ten submissions spread over a minute is different from ten submissions
inside three seconds, and only a sliding window can tell the difference.
The clock is injectable, so the tests do not have to sleep.

---

## The OCR provider

`ocr.ts` owns the provider's **lifecycle**; the provider itself lives in
`modules/ssverify/ocr/` and is not this area's to change.

- One provider for the whole bot, so the calls stay serialised and only
  one of them is ever shut down.
- The **decision** whether the OCR runs at all, made **once at boot**.
- `shutdownOcr()` on exit, so the requests that are on the wire are
  aborted and the process can go.

### There is no local engine

The provider is a **remote service**. It does the text recognition *and*
the hashing, and it **fetches the image itself** — so the image has to be
a publicly reachable URL, and the bot never downloads the attachment.

There is no Tesseract worker, no language model and no image library
behind it, and **no local fallback**. A deployment that configures no
service has no OCR at all.

> **The feature needs a remote service to be useful.** Without
> `OCR_PROVIDER_URL` the screenshot verification is **off**, and every
> submission is refused. That is deliberate — it is the same fail-closed
> behaviour the area has always had, made explicit — but it is not a
> working feature: it needs a service.

| Configuration | Provider | What happens |
|---|---|---|
| `OCR_PROVIDER_URL` set | the remote one | The screenshot's URL is sent to the service, and the answer is checked against the rules. |
| `OCR_PROVIDER_URL` unset | the switched-off one | Every screenshot is refused. Nothing is stored. |
| `OCR_ENABLED=false` | the switched-off one | Every screenshot is refused. Nothing is stored. |

### Switching the OCR off

A deployment that does not use screenshot verification should not pay for
OCR, and a deployment that has no service configured has no engine to pay
for at all. The switch is made **here**, at boot, and it is made **once**:

| `OCR_ENABLED` | Decision |
|---|---|
| `true` / `1` | **Forced on** — the OCR runs whatever the database says. |
| `false` / `0` | **Forced off** — the OCR does not run whatever the database says. |
| unset, or a value that is not understood | **Automatic** — the OCR runs when there is at least one screenshot-verification setup. |

A value that is neither of those is **not a guess**: it counts as unset,
so a typo falls back to the automatic decision rather than quietly
switching the OCR off.

**The decision is at boot** because that is when the operator wants to
know whether the OCR is on, and because it keeps `getOcrProvider()`
synchronous — which is what the call sites assume. `getOcrProvider()`
**throws** when the decision has not been made: the provider is not built
on first use any more, because a provider built with the wrong setting
would be the wrong provider for the whole run of the bot.

`warmIdentity()` makes the decision **before** it loads the channel
cache, because the cache is what makes a screenshot-verification channel
live — the answer has to be there before the first screenshot can be
processed.

The automatic decision is a snapshot of the world at boot. A setup that is
created *after* the boot does not switch the OCR on: the bot has to be
restarted, or `OCR_ENABLED=true` has to be set. The area says so in the
log when a setup is created while the OCR is off.

### The provider is the last word

`createOcrProvider({ enabled: true })` still hands back the switched-off
provider when no service is configured, so the **flag that was passed in
is not the state the bot runs in**. The area asks the provider it got:

```ts
const provider = createOcrProvider({ enabled });
const running = !isOcrDisabled(provider);
```

`isOcrAvailable()` does exactly that, and `decideOcr()` returns the same
thing. The log line at boot says what is **true** — "the OCR is on
(http)" or "the OCR is off (disabled): no OCR service is configured" —
and never the flag it was given.

### The refusal when the OCR is off

The switched-off provider answers with an **empty text** and two hashes
of nothing. That is not enough on its own: `any_ss` has no rules at all,
and a `loco` or `rooter` setup whose channel name is empty has none that
look at the text — an empty text would be *accepted* there.

So the **submission itself** is refused when the OCR is off, before the
duplicate check and before the rules run:

```
**Screenshot verification is not currently available. Please try again later.**
```

It is a normal refusal, not a crash and not a silent pass. **Nothing is
stored**: no `ss_submissions` row, and no hash — the hash of nothing
never reaches the database. The message listener refuses before it even
asks the service to read the picture.

### The refusal when the OCR fails

A **broken** OCR is a different thing from a switched-off one: the
service is down, it answers with rubbish, or it sends a hash nobody can
compare. The screenshot cannot be verified, so it is **refused** — with
the same message, because from the member's side the answer is the same:
the bot cannot check this screenshot right now.

The refusal is a **decision, not a crash**. `analyzeScreenshot()` never
throws; it answers `{ ok: false, reason }` and the service turns that
into a message and moves on to the next screenshot. **Nothing is stored.**

### The image is a URL

`SubmittedImage` carries the attachment's **URL**, not its bytes:

```ts
export interface SubmittedImage {
  readonly url: string;      // the CDN link the service fetches
  readonly channelId: string;
  readonly messageId: string;
}
```

The bot has no use for the bytes — the service fetches the picture
itself — so it does not download it. A ten-megabyte attachment costs the
bot nothing, and a failed download can no longer leave a member without
an answer.

---

## The bugs that were fixed rather than ported

| # | The source's behaviour | What happens now |
|---|---|---|
| **B8** | The screenshot type was assigned to the record **before** the entitlement was checked, and the editor then wrote every field of the record on the next interaction — so a free guild ended up with a premium type. | The entitlement is checked first, in both the wizard and the editor. A refused type is never written. |
| **B11** | The channel was added to the live set as soon as it was picked, so cancelling the wizard left a half-configured channel running. | The channel only goes live when the setup is saved. |
| **B12** | The success-message editor's button was disabled for a free guild and the wizard had no guard at all, so the gate was bypassable. | One `assertEntitled` call covers both paths, and the button is never silently disabled. |
| **B14** | `\b@\w+` matched `@name` and stopped before the discriminator, so `@their_full_discord_tag#1234` was truncated — the very form the error message advertises. And `\b` before the `@` needs a word character in front of it, so a tag at the start of a message never matched. | A full tag is matched whole, and the `@` is only required not to be preceded by a word character or a dot — which also keeps `mail@example.com` out. |
| **B18** | The update wrote `dict(self.record)` and relied on Tortoise internals to leave the right columns alone. | The patch is an explicit list of fields. |

Three more were fixed here and have moved with the group manager to the
tournament area, which owns the group feature: **B15** (the group channel
was found by a name substring), **B16** (the refresh cooldown read an
`auto_now` column) and **B17** (a failed creation left the earlier
groups behind).

The three rules that changed when the **OCR engine** changed are
described under [the screenshot verification](#the-screenshot-verification)
above: the tolerant page-name match, the case-insensitive literal button
checks, and the split between the raw text and the normalised text. The
port talks to a remote service again, so the engine does not force them
any more — they stay because each of them is safe against any engine.

---

## The tests

`npx vitest run modules/identity` — 257 tests in 14 files.

| File | What it covers |
|---|---|
| `easytag.test.ts` | The mention extraction, including the full tag the source could not read. |
| `tagcheck.test.ts` | The two guards, their order, and the team name the reply shows. |
| `duplicate.test.ts` | The threshold, the two kinds of duplicate, the hashes that cannot be compared, and the resolution of a setup's own threshold. |
| `repo.test.ts` | The repository against a **real database**: the keyword set round trip through `ss_config_keywords`, the threshold column, and the cascade that takes the keywords with the setup. |
| `threshold.test.ts` | The **setup's own** threshold, end to end — the setups are rows in a real database and the configuration the service sees is the one the database holds. |
| `verification.test.ts` | Every type's rules, against text this port's OCR provider produces. |
| `service.test.ts` | The premium gates (nothing is written when a gate refuses), the rate limits, and the guild scope of a setup. |
| `ocr.test.ts` | The boot decision (forced on, forced off, automatic) and the **effective** state of the provider; the refusal when the OCR is off, when the service is down, and when the service sends rubbish — including that **nothing is stored**; the URL that reaches the service; and the stored hash that cannot be compared. |
| `commands.test.ts` | The three commands serialise, the adapter files register them, and `/ssverify` answers ephemerally. |
| `ignore-role.test.ts` | The ignore role is compared by id. |
| `cache.test.ts` | The three channel sets stay apart. |
| `guards.test.ts` | Who may manage a setup: the moderator, the administrator, the ordinary member, the member of another guild. |
| `views/ids.test.ts` | The id scheme: one layout, the round trip, and that an action of another surface is refused. |
| `views/ssmod.test.ts` | The panel's authorisation (an ordinary member changes nothing; a moderator may; another guild's row is not found), the premium gates, the custom ids, and the **routing**: every id pressed through the real router, in two registration orders. |
