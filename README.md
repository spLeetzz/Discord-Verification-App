# Discord Verification App

A Discord bot that runs ticket-based registration verification for esports
events.

A Google Sheet holds the registrations; Discord handles the human review. A
participant clicks a button, fills in their email, and gets a private ticket
thread. Staff verify, deny, or flag the ticket, and the bot keeps the sheet,
the role, and the thread status in sync.

See [STAFF_GUIDE.md](./STAFF_GUIDE.md) for what each command does.

## Requirements

- Node.js 20 or newer
- A Discord bot token and application id
- A Google Cloud service account with access to the registration spreadsheet

## Setup

```bash
npm install
```

Create a `.env` file:

```dotenv
BSSA_DISCORD_BOT_TOKEN=your-bot-token
BSSA_CLIENT_ID=your-application-id     # for a bot, this equals the bot user id
ALLOWED_GUILD_ID=1147472972467159040   # interactions from other guilds are ignored
GUILD_ID=1147472972467159040           # where slash commands are registered

GOOGLE_KEY_PATH=/absolute/path/to/service-account.json
# or: GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
SPREADSHEET_ID=your-shared-spreadsheet-id

FREE_FIRE_SPREADSHEET_ID=...
FREE_FIRE_CHANNEL_ID=...
FREE_FIRE_BACKUP_CHANNEL_ID=...
FREE_FIRE_ROLE_ID=...
```

Every Discord ID also has a fallback in `config/events.ts`, so the env vars
are optional if you are happy editing the config.

## Running

```bash
npm run dev      # run from source with hot reload (tsx)
npm run build    # compile TypeScript to dist/
npm start        # run the compiled build
```

Register the slash commands with Discord (required once, and after adding or
renaming a command). They are registered **guild-scoped**, to `GUILD_ID` only:

```bash
npm run deploy        # from source
npm run deploy:prod   # from the compiled build
```

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm run smoke       # offline smoke test, no credentials needed
```

`npm run smoke` covers config, embed and modal payloads, the command loader,
the sheet lookup helpers, form validation, thread renaming and the
slash-command deploy payload. It needs no Discord or Google credentials.

## Layout

```
main.ts              entry point
deploy.ts            registers slash commands with Discord
config/events.ts     per-event channel, role, sheet and column configuration
handlers/            interaction routing: commands, buttons, modals, startup
commands/utility/    the staff slash commands
repo/                Google Sheets access: config, cache, sheet helpers
utils/               embeds, threads, logging, paths, errors, validation
scripts/             one-off maintenance scripts, plus the smoke test
types/               shared types and the discord.js module augmentation
```

## The two flows

`config/events.ts` declares a `mode` per event.

**`sheet-lookup`** — the original flow. The email is looked up in a
registration sheet *before* the ticket is created, and `/verify` writes back
to that pre-existing row (setting `Verified?`, `Verified by`, `Discord ID
Final` and `Thread Link`).

**`direct-registration`** — the Free Fire flow. There is no registration
sheet to look up. The team registers through the modal, and a row is
*appended* to a sheet only once staff verify.

Both flows share the embed, the button, the modal shell, thread creation, the
pinned message, the staff commands, the status emoji and the media backup.
Only the sheet layer differs, and it is driven by each event's `columns` map
rather than hardcoded header names.

## Free Fire, end to end

1. The bot posts a verification embed with a **Start Verification** button in
   the Free Fire channel. The message id is kept in `config/messageIds.json`.
2. Clicking it opens a modal for **Team Name**, **Email** and **Phone**. The
   phone number is normalised to bare digits (10-15).
3. The bot opens a private thread, pins the registration details and asks the
   captain to:
   - **mention his teammates** — everyone mentioned is added to the thread so
     they can post their own screenshot,
   - give the IGN and UID of every player,
   - post each player's gamerscult.in account screenshot.

   The example screenshot is sent as its own embed right after. It is
   downloaded once from Discord and cached in `.cache/`, because Discord's
   CDN links carry an expiry — the file on disk never does.
4. Staff run `/verify` inside the ticket. The bot appends a row, grants the
   role, renames the thread to `✅` and archives the screenshots.

Sheet columns: `Team Name | Email Address | Phone | Discord ID | Timestamp |
Thread Link`.

### Letting the other players in

Ticket threads are private, so a mention on its own does not give anyone else
access. When the captain mentions his players, the bot adds them to the
thread and posts a short notice:

```
👋 <@player1> <@player2> have been added to this ticket by <@captain>.
```

The captain can also mention them one message at a time — anyone mentioned
while a ticket thread is open gets added, and only if they are not already in
it. Bots are ignored, and a message with no mentions changes nothing.

To check it against the live server (creates and deletes a test thread):

```bash
npm run test:mentions -- <captain-user-id> <player-user-id>
```

### One verification only

The rule is enforced at three points:

- **Button click** — if the account already holds the event role.
- **Modal submit** — if the email is already in the sheet.
- **`/verify`** — both checks again, before anything is written.

The check is per event: being verified for one event does not block another.

## The other events

BGMI, Chess, E-Football Mobile, FC 26 and Street Fighter 6 are still in the
config but marked `enabled: false`. Disabled events are skipped at startup and
are not read from their sheet, so the bot no longer depends on the old
spreadsheet. Flip `enabled: true` to bring one back.

## Staff commands

| Command | What it does |
|---|---|
| `/verify` | Marks the ticket verified: writes the sheet, grants the role, renames the thread `✅`, archives the media |
| `/deny` | Renames the thread `❌`, tells the participant, and **removes their row from the sheet** (Free Fire only) |
| `/noreply` | Renames the thread `❗` |
| `/setemail` | Corrects a typo'd email and re-checks uniqueness |
| `/lookup` | Searches an email across every enabled event's sheet |
| `/count` | Verified registration count per enabled event |
| `/fetch_threads` | Lists every ticket in a channel, alphabetically |

`/forceverify` still exists for the sheet-lookup events, but is refused for
Free Fire — every Free Fire verification is a sheet append, so there is
nothing to bypass.

### Why `/deny` deletes a row

In the Free Fire flow the sheet holds **verified teams and nothing else** —
rows are appended on `/verify`, never pre-registered. So a denied team must
not stay in it, otherwise they would still read as verified and the
duplicate check would block them from ever registering properly.

In the original sheet-lookup flow a row is the person's *pre-existing
registration*, so `/deny` leaves it alone — being denied this tournament is
not the same as cancelling your registration.

If the row is gone already, `/deny` just says so and carries on.
