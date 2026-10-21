# Scrims area — the new look

`modules/scrims/` only. `npm run typecheck` is clean for the area and
`npm test` passes (92 files, 1372 tests — the whole suite, no failures).

## What the area actually has

- **Local button helpers, now gone.** `views/components.ts` had its own
  `button()`, `buttonRow()`, `buildModal()` and `panelEmbed()`. They
  are deleted; the area now uses `core/ui.ts` — `primaryButton`,
  `secondaryButton`, `successButton`, `dangerButton`, `actionRow`,
  `navigationRow`, `buildModal`, `textInput`, `panelEmbed`, `emptyPanel`
  and `label`. There is one way to do it.
- **Ten panels and seventeen modals.** All of them are rebuilt below.
- The area's `assertComponentBudget`, `selectRow`, `modalText`,
  `EDITOR_FIELDS` and `fieldLetter` stay: `core/ui.ts` has no
  equivalent.

## The panels

| Panel | Where | New title | New footer |
|---|---|---|---|
| the scrims list | `views/manager.ts` | "Scrims Manager" | "3 scrims here — pick one from the menu to manage it." |
| the scrims list (empty) | `views/manager.ts` | "Scrims Manager" | "Press **Create scrim** to make the first one." |
| one scrim | `views/manager.ts` | "Scrims Manager — `<name>`" | "Edit the settings here, or start the registration when you are ready." |
| the editor | `views/manager.ts` | "Edit scrim — `<name>`" | "Scrim 1 of 3 — press a letter to change that field." |
| the wizard | `views/manager.ts` | "Create a scrim" | "The scrim is created when you press Save." |
| bans | `views/panels.ts` | "Bans — `<name>`" | "Ban a team to keep it out of this scrim." |
| reserved slots | `views/panels.ts` | "Reserved slots — `<name>`" | "The free slots are the numbers not listed above." |
| autoclean | `views/panels.ts` | "Autoclean — `<name>`" | "A switch turns the setting on or off." |
| design | `views/panels.ts` | "Design — `<name>`" | "A field you leave empty keeps the default." |
| the slotlist editor | `views/panels.ts` | "Edit slotlist — `<name>`" | "Pick a slot to add a team to, or to change the team on." |
| the slotlist preview | `views/slotlist.ts` | "Slotlist — `<name>`" | "⚪ free · 🟢 claimed · 🔒 locked · 🚫 banned" |
| the ban log | `views/ban-log.ts` | "User banned" / "User unbanned" | — (a log entry, not a panel) |
| a refusal | `views/handlers.ts` | "Could not do that" | — (the message itself) |

**The two lists that get read at a glance.** The scrims list gives each
scrim a dot — 🟢 open, 🟡 closed, ⚫ disabled — so the state is read
before the name. The slotlist gives each slot a dot — ⚪ free, 🟢
claimed, 🔒 locked, 🚫 banned — and the team name, so the state of every
slot is obvious without reading the text.

**A list of records goes in the description; the attributes of one
record go in fields.** The scrims list and the slotlist are lists, so
they are a block of lines; a scrim, a wizard and a set of reservations
are one record, so they are fields.

### The one-line rule per family of buttons

- **The main action:** alone on its own row, and coloured by what it
  does — green when it creates something (Create scrim, Save scrim,
  Reserve slot, Add team), red when it destroys something (Ban users),
  blurple when it is a plain action (Edit settings, Set clean time,
  Edit open message).
- **Everything else that changes the world:** green when it creates or
  puts right (Unban user), red when it destroys or stops (Delete scrim,
  Remove team, Remove reservation, Stop registration), grey otherwise.
- **A switch:** grey, and its label says what the press will do
  ("Purge channel" / "Don't purge", "Enable scrim" / "Disable scrim",
  "Publish slotlist on close" / "Don't publish slotlist"). The state of
  each switch is a field of the panel, right above it — a button that
  reads "Purge channel" must never actually switch a purge off.
- **Navigation:** grey and last — "Back", "Back to list", "Cancel",
  "Previous" / "Skip to" / "Next".
- **The letter buttons of the editor and the wizard:** grey, and the
  📝 emoji is gone. The letter is the link to the field, and it is in
  the embed next to it.

### The empty states

- **The scrims list** uses `emptyPanel`: "This server has no scrims yet.
  A scrim is a registration channel, a list of slots, and the slotlist
  that goes out when it closes." and the footer "Press **Create scrim**
  to make the first one."
- **The slotlist** says "No team has registered yet. They show up here
  as they register in `<#channel>`." — the panel cannot use
  `emptyPanel`, because it carries the **slot area's** row and the way
  back.
- **The bans** say "Nobody is banned from this scrim." and the footer
  says what to do about it.
- **The reservations** say "Slots 1 to 10 — 0 slots reserved." and "No
  slot is reserved — every slot is free."

## The modals

Every modal is built with `core/ui.ts`'s `buildModal` and `textInput`:
the title names the action, the field labels are short nouns, every
field has an example in its placeholder and says whether it is
required, and there is a way out.

| Modal | Title | Fields |
|---|---|---|
| required mentions (wizard and editor) | "Set required mentions" | Mentions |
| total slots (wizard and editor) | "Set total slots" | Slots |
| open time (wizard and editor) | "Set open time" | Open time |
| reactions (wizard and editor) | "Set reactions" | Reactions |
| the scrim name | "Set scrim name" | Name |
| the slotlist start | "Set slotlist start" | First slot number |
| the required lines | "Set required lines" | Lines |
| skip to a scrim | "Skip to a scrim" | Scrim number |
| ban | "Ban users" | Users, Duration, Reason |
| reserve | "Reserve a slot" | Slot number, Team name, Team owner, Expires |
| the autoclean time | "Set clean time" | Clean at |
| a message design | "Design the open/close/slotlist message" | Title, Description, Footer |
| a team on a slot | "Add a team" / "Change the team" | Team name, Team leader |

**The way out of a modal is the panel it was opened from.** Every one
of them — the wizard, the editor, the bans, the reservations, the
autoclean, the design, the slotlist editor — has a grey "Back" or
"Cancel" on the panel underneath it. See the note on `core/ui.ts`
below: Discord will not put a button in a modal, so the design
language's "the modal's second button is always Cancel" cannot be
built as written.

## The labels I changed

Buttons:

- "Create Scrim" → **"Create scrim"**, "Save Scrim" → **"Save scrim"**.
- "Edit Settings" → **"Edit settings"**, "Delete" → **"Delete scrim"**.
- "Stop Reg" / "Start Reg" → **"Stop registration"** / **"Start
  registration"**.
- "Reserve Slots" → **"Reserve slots"**, "Ban / Unban" → **"Manage
  bans"**, "Manage Slotlist" → **"Manage slotlist"**, "Set Match Time"
  → **"Set match time"**, "Enable" / "Disable" → **"Enable scrim"** /
  **"Disable scrim"**.
- "Main Menu" → **"Back"** (the sub-panels and the editor) and **"Back
  to list"** (the scrim panel, which is where it actually goes).
- "Ban Users" / "Unban Users" / "Unban All" → **"Ban users"** / **"Unban
  user"** / **"Unban all"**.
- "Reserve Slot" / "Remove Reserved" → **"Reserve slot"** / **"Remove
  reservation"**.
- "Clean At" → **"Set clean time"**.
- The design panel's "A" / "B" / "C" (each with a 📝) → **"Edit open
  message"** / **"Edit close message"** / **"Edit slotlist message"**;
  "Auto Slotlist: On" / "Auto Slotlist: Off" → **"Publish slotlist on
  close"** / **"Don't publish slotlist"**.
- The slotlist editor's "Add Team" / "Remove Team" / "Change Team" →
  **"Add team"** / **"Remove team"** / **"Change team"**.
- "Skip to…" → **"Skip to"**; the 📝 emoji is gone from the twenty
  letter buttons of the editor and the eight of the wizard.

Modal titles:

- "Scrim name" → **"Set scrim name"**, "Required mentions" → **"Set
  required mentions"**, "Total slots" → **"Set total slots"**, "Open
  time" → **"Set open time"**, "Reactions" → **"Set reactions"**,
  "Slotlist start" → **"Set slotlist start"**, "Required lines" → **"Set
  required lines"**, "Autoclean time" → **"Set clean time"**.
- "Open message" / "Close message" / "Slotlist design" → **"Design the
  open message"** / **"Design the close message"** / **"Design the
  slotlist message"**.

Modal field labels (the questions became nouns, and the ranges moved
to the panel that knows them):

- "How many mentions are required? (0 - 10)" → **"Mentions"**, "How
  many slots does the scrim have? (1 - 30)" → **"Slots"**, "When should
  registration open? (IST)" → **"Open time"**, "Two emojis, separated by
  a comma" → **"Reactions"**.
- "The name of the scrim (max 30 characters)" → **"Name"**, "Which slot
  number does the slotlist start at?" → **"First slot number"**, "How
  many lines must a registration have? (0 - 100)" → **"Lines"**.
- "Who do you want to ban? (mention them)" → **"Users"**, "Ban duration
  (optional)" → **"Duration"**, "Reason (optional)" → **"Reason"**.
- "Slot number (1 - 10)" → **"Slot number"** (the range is in the
  panel's description now), "Team owner (optional)" → **"Team owner"**,
  "Expires (optional)" → **"Expires"**.
- "When should the autoclean run? (IST)" → **"Clean at"**, "Which scrim?
  (1 - 3)" → **"Scrim number"**.
- "Title (leave empty for the default)" / "Description (leave empty for
  the default)" / "Footer (leave empty for the default)" → **"Title"** /
  **"Description"** / **"Footer"** (the default is in the panel's
  footer).
- "The team name" → **"Team name"**, "The team leader (optional)" →
  **"Team leader"**.

Other text:

- The editor's twenty field names are sentence case now ("Registration
  channel", "Multi-register", "Autodelete late messages"), and the
  field name carries its letter as "A · Name".
- "`Not-Set`" → **"Not set"**.
- The ban log's "🔨 Banned" / "🔓 Unbanned" → **"User banned"** (red) /
  **"User unbanned"** (green).
- The design form's refusal "Fill in at least one of the fields, or
  press Cancel." → **"Fill in at least one of the fields, or close the
  form."** — there is no Cancel button in a Discord modal.
- A refusal now carries the title "Could not do that".

No test asserted on a label or a style, so no test had to be changed.

## What did not change

- **Custom ids**: every one, byte for byte. The router's contract is
  untouched — `scrims:new`, `scrims:pick`, `scrims:manager:<id>[:…]`,
  `scrims:editor:<field>:<id>`, `scrims:editor_nav:<dir>:<id>`,
  `scrims:wizard:<field>:<token>`, `scrims:modal:<kind>:<…>`,
  `scrims:ban:<id>[:…]`, `scrims:reserve:<id>[:…]`,
  `scrims:autoclean:<id>:<…>`, `scrims:design:<id>:<…>`,
  `scrims:slotlist:<id>:<…>`, `scrims:slotm_pick:<id>:<kind>:<userId>`
  and the slot area's `slots:slotlist_*`.
- **Handler behaviour**: which button does what, what a modal writes,
  what is saved. A button that was a toggle is still a toggle, the
  "apply to all scrims" question still comes before the write, the
  match-time editor still keeps its message collector, and the slot
  pick is still a persistent menu.
- **The premium gates, the free-tier limits, the claim's atomicity, the
  fake-tag check, the ban log, the autoclean pass and the slot state
  machine**: untouched.
- **The data and the queries**: the same statements, the same reads.
  The panels render the rows they were given.
- **The editor's shape**: still exactly twenty fields in four rows of
  five plus the navigation row — 25 components, Discord's limit, which
  is what `assertComponentBudget` checks and what the test pins. That
  is also why "Delete scrim" shares the navigation row there: there is
  no twenty-sixth component to give it a row of its own.

## The one helper the area keeps of its own

- `views/components.ts` — `emptyScrimsPanel`, a thin copy of the core's
  `emptyPanel`. **The core's `Panel` carries `readonly` arrays, and
  discord.js takes mutable ones**, so the area cannot hand the core's
  panel straight to `interaction.update()`. Everything else comes from
  `core/ui.ts`.
- The area also keeps `assertComponentBudget`, `selectRow`,
  `modalText`, `EDITOR_FIELDS` and `fieldLetter` — the core has no
  equivalents for them.

## What I wished `core/ui.ts` had

1. **A modal that can carry a Cancel.** Discord's modal only accepts
   text inputs (`APIComponentInModalActionRow` is
   `APITextInputComponent`), so a Cancel button cannot be put in a
   modal at all, and `buildModal` has no way to express one. The
   design language says "the modal's second button is always Cancel" —
   that cannot be built as written. The way out is the panel under the
   modal, and every modal here has one, but the core should say so
   rather than leave five areas to work it out. A `buildModal({ …,
   cancel: { customId } })` that documents the intent, or a line in the
   core's header, would settle it.
2. **A `Panel` that allows a select-menu row.** The core's `Panel` is
   `ActionRowBuilder<ButtonBuilder>[]`; the scrims list and the slot
   pick both carry a menu row, so the area keeps its own
   `PanelComponents` union. A core `PanelRow` would let the area drop
   it.
3. **`emptyPanel` with a navigation button.** It takes one `action`,
   and the action is the panel's one primary action. An empty panel
   that also wants a grey "Close" cannot have one.
4. **`MAX_COMPONENTS_PER_MESSAGE`** in the core, next to the other two
   limits. The area derives it as rows × per-row.
5. **A `textInput` that picks its style from the expected answer, not
   from `maxLength`.** The core makes the style `Paragraph` above a
   `maxLength` of ten, so a 25-character "Team name" draws a three-line
   box. The rule is right for a description and wrong for a name.
