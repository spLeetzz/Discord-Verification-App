# `modules/identity/` — the identity area

Three features that answer one question — *who is this person, and are
they really on this team?* — plus the tournament group manager.

| Feature | What it is |
|---|---|
| **Tag check** | A channel where a captain registers his team by mentioning his teammates. |
| **Easy tag** | A channel where the bot turns the raw ids and `@names` in a message into real mentions. |
| **Screenshot verification** | A channel where a participant proves they follow the tournament's page with a picture. |
| **Group management** | The tournament's group channels, roles and the published group list. |

Quotient modelled the first three as discord.py cogs with per-guild
configuration rows and a lot of `if` in the listeners. Here the rules are
**pure functions over plain data** (`tagcheck.ts`, `easytag.ts`,
`verification.ts`, `duplicate.ts`) and the state machines live in
`service.ts`. The rules can be tested without a Discord connection, and
they are.

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

The group manager has no command of its own: it is reached from the
tournament area, which opens the panel for a tourney.

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
- `warmIdentity()` loads the channel cache and warms the OCR provider up.
  The manager calls it on `ClientReady`.
- `shutdownIdentity()` releases the OCR worker and the two draft stores.

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
identity:ssmod:setup:<action>:<token>   the wizard — the setup does not exist yet
identity:ssmod:<action>:<configId>      the editor — the setup is a row
identity:groups:<action>[:<id>]         the group manager
```

The wizard's prefix is registered **before** the editor's, because
`identity:ssmod` would match the wizard's ids too (D7, D18).

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

The refusals are the source's wording:

```
This is not a valid youtube ss.
Screenshot must belong to [`Team Phoenix`](https://…) channel.
You must subscribe [`Team Phoenix`](https://…) to get verified.
```

#### How the rules behave against **this** port's OCR engine

The port runs the local Tesseract provider (`modules/ssverify/ocr/`),
not the remote service the source was calibrated against. The provider
answers with two texts, and the rules read them differently:

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

**A broken OCR refuses a screenshot.** A provider that fails answers
with an empty text, and every text rule rejects an empty text, so a
screenshot is never waved through because the OCR was down.

### The duplicate check

`duplicate.ts` refuses a screenshot that is already in the setup.

| Check | What it compares |
|---|---|
| `own` | The new dHash against **the same member's** stored dHashes, at a Hamming distance of 7 or less. |
| `same` | The new dHash **and** pHash against every stored pair, both equal. |

The threshold is a parameter (D20), not a constant: it is only
meaningful for a 64-bit hash, so it moves with the hash implementation
rather than being baked into the comparison.

A stored hash that is not a hash — a truncated row, a column that was
written by an older version — raises `MalformedHashError` instead of
comparing as "a different picture". A duplicate that hides itself is a
duplicate that lets a member farm the role.

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

**The group list.** `created → published → refreshed (every two minutes
at most)`.

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

- One provider for the whole bot, so the Tesseract worker starts once.
- `warmupOcr()` at boot, so the language model is downloaded at startup
  rather than on the first screenshot of the day.
- `shutdownOcr()` on exit, so the worker is terminated and the process
  can go.

`OCR_PROVIDER_URL` selects the Quotient-compatible remote service; when
it is absent the local provider is used, which needs no key and no
network.

---

## The bugs that were fixed rather than ported

| # | The source's behaviour | What happens now |
|---|---|---|
| **B8** | The screenshot type was assigned to the record **before** the entitlement was checked, and the editor then wrote every field of the record on the next interaction — so a free guild ended up with a premium type. | The entitlement is checked first, in both the wizard and the editor. A refused type is never written. |
| **B11** | The channel was added to the live set as soon as it was picked, so cancelling the wizard left a half-configured channel running. | The channel only goes live when the setup is saved. |
| **B12** | The success-message editor's button was disabled for a free guild and the wizard had no guard at all, so the gate was bypassable. | One `assertEntitled` call covers both paths, and the button is never silently disabled. |
| **B14** | `\b@\w+` matched `@name` and stopped before the discriminator, so `@their_full_discord_tag#1234` was truncated — the very form the error message advertises. And `\b` before the `@` needs a word character in front of it, so a tag at the start of a message never matched. | A full tag is matched whole, and the `@` is only required not to be preceded by a word character or a dot — which also keeps `mail@example.com` out. |
| **B15** | The group channel was found by a name substring, so "Group 1" also matched "Group 10". | The channel is chosen by the operator and stored on the row. |
| **B16** | The refresh button's two-minute cooldown read an `auto_now` column, so it depended on the last write of any kind. | The row's `updated_at` is written **only** by the refresh path, so it is the last refresh time. |
| **B17** | The roles and the channels were created in a loop and the function returned on the first failure, so a failure on the fourth of five groups left the first three behind. | Everything that is created is collected and removed again when something goes wrong. |
| **B18** | The update wrote `dict(self.record)` and relied on Tortoise internals to leave the right columns alone. | The patch is an explicit list of fields. |

The three rules that changed because the **OCR engine** changed are
described under [the screenshot verification](#the-screenshot-verification)
above: the tolerant page-name match, the case-insensitive literal button
checks, and the split between the raw text and the normalised text.

---

## The tests

`npx vitest run modules/identity` — 145 tests in 9 files.

| File | What it covers |
|---|---|
| `easytag.test.ts` | The mention extraction, including the full tag the source could not read. |
| `tagcheck.test.ts` | The two guards, their order, and the team name the reply shows. |
| `duplicate.test.ts` | The threshold, the two kinds of duplicate, and the malformed hash. |
| `verification.test.ts` | Every type's rules, against text this port's OCR provider produces. |
| `service.test.ts` | The premium gates (nothing is written when a gate refuses) and the rate limits. |
| `commands.test.ts` | The three commands serialise, and the adapter files register them. |
| `ignore-role.test.ts` | The ignore role is compared by id. |
| `cache.test.ts` | The three channel sets stay apart. |
| `views/ssmod.test.ts` | The panel's premium gates: the draft is untouched when a gate refuses. |
