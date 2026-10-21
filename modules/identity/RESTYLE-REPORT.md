# Identity area — the new look

`modules/identity/` only. `npm run typecheck` is clean for the area and
`npm test` passes (15 files, 277 tests — 20 of them new, in
`modules/identity/views/panels.test.ts`).

## What the area actually has

- **No local button helpers.** There was nothing named `button()` /
  `buttonRow()` / `makeButton` to replace: the panel built its buttons
  inline with `new ButtonBuilder()`. They go through the core helpers
  now.
- **One panel area**, in three surfaces: the **list** of a server's
  setups, the **wizard** that creates one, and the **editor** that
  changes one. All three are built in `views/ssmod.ts`.
- **Two modals**: the page details and the success message.
- The area's other embeds (`listeners.ts`) are **replies to a member**,
  not panels — they are not part of this restyle.

## The panels

Every panel is built with `core/ui.ts`: `panelEmbed` for the panels,
`emptyPanel` for the empty state, `actionRow` for the rows and
`successButton` / `secondaryButton` / `dangerButton` for the buttons.

| Panel | Where | New title | New footer |
|---|---|---|---|
| the list | `/ssverify` | "Screenshot verification" | "Press **Create setup** to add another one, or pick a setup to edit it." |
| the list (empty) | `/ssverify` | "Screenshot verification" | "A setup checks the screenshots posted in a channel and grants a role when they are valid." |
| the wizard | the list's **Create setup** | "Screenshot verification — setup" | "Still to set: **channel**, **role**, **type**, **page name**. Then press **Save setup**." |
| the editor | the list's **Edit …** | "Screenshot verification — edit" | "Every change is saved the moment you make it. **Delete setup** removes the verification and its submissions." |
| the FAQ | the list's **FAQ** | "Screenshot verification — FAQ" | "Press **Create setup** to begin." |
| a deleted setup | after **Delete setup** | "Setup deleted" | — |
| a closed panel | after **Close** / **Cancel** | "Screenshot verification" | "This panel is closed. Run `/ssverify` to open it again." |

### The one-line rule per family of buttons

- **The one green button is the one that creates something:** *Create
  setup* on the list, *Save setup* on the wizard. Green means "this adds
  something", so there is exactly one of them on a panel.
- **The one red button is the one that destroys something:** *Delete
  setup*, and nothing else. A red button means "this cannot be undone".
- **Everything else is grey,** and the navigation (*Cancel*, *Close*,
  *FAQ*) is grey and last in the panel's row.
- **A panel with no main action has no primary button.** The editor has
  none: every field is written the moment it is changed, so there is
  nothing to press "apply" to. Its only coloured button is the red one.

### The unset values

A missing channel, role, type, page name, page link, keyword or success
message is written in **italics** — `_Not set_` — so an unfinished setup
cannot be mistaken for a finished one. The wizard's footer names what is
still missing, so the disabled **Save setup** always has a reason next
to it.

Two settings the panel did not show before are shown now, read-only, from
the row that is already loaded: the **Keywords** the custom filter
matches on, and the **Duplicate threshold** the setup runs with (`7
(default)` when the setup has no threshold of its own).

### The rows

Discord gives a message **five action rows**, and a select menu has a row
to itself — so the four pickers (channel, role, type, count) take four
of them and the **five buttons share the last one**. The coloured
button is first in that row and the navigation is last.

> The panel used to build **six** rows (four pickers, a row of field
> buttons and a row of save/cancel). Discord rejects a message with more
> than five, so the wizard and the editor could not be sent at all. The
> new layout fits.

## The modals

Both are built with `buildModal` and `textInput`: the title names the
action, the fields have short noun labels, an example placeholder and an
explicit `required`.

| Modal | New title | Fields |
|---|---|---|
| page details | "Edit page details" | **Page name** (required, e.g. "Team Phoenix"), **Page link** (optional, e.g. "https://example.com/team-phoenix") |
| success message | "Edit success message" | **Success message** (optional, e.g. "Your screenshots are verified.") |

The field ids (`name`, `link`, `message`), the values, the maximum
lengths and the modal's custom ids are all unchanged — the handler reads
exactly what it read before.

**There is no Cancel button in a modal, and there cannot be.** Discord's
API only allows text inputs in a modal (`APIComponentInModalActionRow`
is `APITextInputComponent`, and a button "can only be used in
messages"), so a button in a modal's action row is rejected and the
modal would never open. The way out is the panel's grey **Cancel** /
**Close** behind it, plus Discord's own dismiss (Esc, or the client's
✕). See "What I wished `core/ui.ts` had" below.

## The labels I changed

Button labels:

- "Setup" → **"Create setup"** (it creates a setup; "Setup" was a noun).
- "Save & setup" → **"Save setup"**.
- "Page details" → **"Edit page details"**.
- "Allow same" → **"Allow same screenshot"**.
- "Success message" → **"Edit success message"**.
- "Delete setup", "Cancel", "Close", "FAQ" and "Edit `<type>`" are
  unchanged.

Titles and footers:

- "Screenshot Verification" → "Screenshot verification"; "… — Setup" →
  "… — setup"; "… — Edit" → "… — edit"; "… — FAQ" → "… — FAQ".
- The list's description (a numbered list of setups) became **fields**,
  one per setup: the type as the name, the channel and the count as the
  value.
- The FAQ answers now name the new buttons ("Press **Create setup** …
  Then press **Save setup**").
- The deleted-setup panel lost its 🗑️ and gained a title; the closed
  panel is no longer red — closing a panel is not an error.

Field values:

- `` `Not-Set` `` → **_Not set_** (in italics).
- "Yes"/"No" lost their code span; the page link's "[Click Here]" is
  now "[Open the page]".
- The modal placeholders are **examples** now, not descriptions: "Team
  Phoenix", "https://example.com/team-phoenix", "Your screenshots are
  verified." (the "leave empty to remove it" hint moved into the field
  being optional).

## What did not change

- **Custom ids**: none. Every id is exactly what it was —
  `identity:ssmod:list:setup`, `identity:ssmod:list:faq`,
  `identity:ssmod:list:edit:<configId>`, the four pickers, the three
  field buttons, `…:delete`, `…:close` and `…:save` on both the
  `edit` and the `wizard` surfaces.
- **Handler behaviour**: which button does what, what a modal writes and
  what gets saved — all unchanged. The premium gates, the authorisation
  checks, the refusals, the keyword set (stored raw, compared
  case-insensitively with the spaces stripped), the per-setup duplicate
  threshold with its 0–64 range and its fallback to 7, the corrupt-row
  decisions, the `any_ss` hole and the refusal messages are all as they
  were.
- **The queries and the data**: the same statements, the same rows, the
  same columns. The panel reads the setup it was already given; the two
  new fields are values of that row, not extra reads.
- The `SsPanel` type now carries `embeds` (an array) instead of a
  single `embed`, so the empty state and the panels have one shape. The
  call sites — `commands/ssverify.ts` and the renderer in
  `views/ssmod.ts` — pass it through.

## New files in the area

- `views/panels.test.ts` — the look, pinned down: the five-row limit,
  one coloured button per panel, the grey navigation, a footer on every
  panel, the unset values, and the modals' titles, labels and examples.

## What I wished `core/ui.ts` had

1. **A way out of a modal.** The design language says "the modal's
   second button is always Cancel", but Discord's API allows only text
   inputs in a modal, so that button cannot exist — a modal with a
   button in it is rejected and never opens. A `buildModal` that took
   the cancel id and said so (a hint line in the modal, or a note that
   the panel's grey Cancel is the way out) would settle it for every
   area. Until then the two modals here are submitted-only, and the way
   out is the panel behind them.
2. **A select-menu helper.** The four pickers (channel, role, type,
   count) still use discord.js's own builders, because the shared
   language has no select. A `stringSelect` / `channelSelect` / `roleSelect`
   would give the placeholders and the "one select per row" rule a
   single home.
3. **A row that says "the buttons of a panel".** `actionRow` and
   `navigationRow` both build a row, and a panel whose Discord limit
   forces every button into one row has to reach for `actionRow` and
   remember the rule itself. A `buttonRow` that says "the buttons, in
   order: the action, the fields, the navigation" would help.
4. `primaryButton` went unused here: every panel's main action either
   creates (green) or destroys (red), and the design language says green
   means "creates". If the team wants the main action to be blurple
   whatever it does, that is one line in three places.
