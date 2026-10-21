# Core restyle

Four files, one rule each. Every panel, button and modal below is built
from `core/ui.ts`, so the bot looks like one product.

**Nothing about the contract moved.** The prompt's, the paginator's and
the select's custom ids are byte-for-byte what they were, the pagination
behaviour is untouched, the prompt still belongs to the caller, and the
select helpers still scope to the guild and the owner. No module test
failed because of a change in `core/`.

---

## `core/prompt.ts`

> **Rule:** one question under a short title, a green Confirm, a grey
> Cancel, and the hint in the footer.

* The row is `actionRow(successButton, secondaryButton)` — green
  confirms, grey is everything else. A red Cancel would say the cancel
  destroys something, and it does not.
* The panel is a `panelEmbed`: title `Confirm`, the question as the
  description, footer `Confirm to go ahead, or cancel to stop.`
* The answer is read from the title and the colour, not from a line of
  emoji at the end of the question.

**Labels and colours that changed (user-visible):**

| before | after |
| --- | --- |
| description only, no title | title `Confirm` |
| `✅ Confirmed.` / `❌ Cancelled.` appended to the question | title `Confirmed` / `Cancelled`, question kept as the description |
| confirmed: bot blue | confirmed: green (`SUCCESS_COLOR`) |
| cancelled: red | cancelled: the ordinary panel colour — a refusal is not a problem, and red means destructive |
| `⏳ The prompt timed out. The action was cancelled.` | title `Timed out`, description `The prompt timed out. The action was cancelled.` |
| — | new footer: `Confirm to go ahead, or cancel to stop.` |

**Not changed:** the button labels (`Confirm`, `Cancel`), the custom ids
(`core:collect:prompt:<token>:confirm|cancel`), who may answer, the
timeout, and the clearing of the buttons.

---

## `core/paginator.ts`

> **Rule:** one row of grey navigation that reads as a unit, with the
> page count in the footer of the panel.

* The row is `navigationRow(secondaryButton × 4)` — the whole row is
  grey, because the whole row is navigation.
* The arrows are words now, so the row reads as one unit: `First`,
  `Previous`, `Next`, `Last` (from `label(action)`, so a label can never
  drift from the id it dispatches on).
* The ends of the list are still disabled, which is how the row says
  where the user is.
* The panel is a `panelEmbed`: the caller's title, the list as the
  description, `Page X of Y` in the footer exactly as before.

**Labels that changed (user-visible):**

| before | after |
| --- | --- |
| `⏮️` `⏪` `⏩` `⏭️` | `First` `Previous` `Next` `Last` |
| no title when the caller gave none | title `Results` (a panel without a title is not a panel) |
| — | empty list: the same panel shape, with the title |

**Not changed:** every custom id (`pager:<namespace>:<action>:<page>`),
the page the pager lands on, the bounds, the footer's text, and the
refresh.

---

## `core/embed-builder.ts`

> **Rule:** the panels the bot builds come from `core/ui.ts`; the
> user's own embed is rendered as the user wrote it.

* The save button is `actionRow(primaryButton(...))` — the panel's one
  main action, alone on its row. Still blue, still `Save`.
* The modals are built with `buildModal` and `textInput`, so the field
  rules (short noun label, an example in the placeholder, `required` set
  explicitly) are the shared ones.
* `embedTemplateToBuilder` uses `panelEmbed` for the title and the
  colour. A template with **no** title is still built on its own: a
  template is the user's own embed, and Discord will not take an embed
  with an empty title. The tag path renders these, so a title the user
  did not write would have been a change to their message.

**Labels that changed (user-visible):**

| before | after |
| --- | --- |
| menu placeholder `Select an option to design the message.` | `Pick what to edit` |
| `Edit Message (Title, Description, Footer)` | `Edit message` |
| `Edit Thumbnail Image` | `Edit thumbnail` |
| `Edit Main Image` | `Edit main image` |
| `Edit Footer Icon` | `Edit footer icon` |
| `Edit Embed Color` | `Set color` |
| modal `Set Embed Message` | `Edit message` |
| modal `Edit Thumbnail Image` / `Edit Main Image` / `Edit Footer Icon` | `Edit thumbnail` / `Edit main image` / `Edit footer icon` |
| modal `Set Embed Color` | `Set color` |
| field `Footer Text` | `Footer` |
| field `Enter a valid colour` | `Color` |
| field `Enter Image URL (optional)` | `Image URL` |
| placeholder `Enter text for the title of the embed here...` | `e.g. Match schedule` (and the same for the description, the footer, the colour and the URL) |
| decorative emoji on the five menu options | none — emoji is off by default |

**Not changed:** the public API, every call site, the option *values*
(`main`, `thumb`, `image`, `footer_icon`, `color`), the field ids
(`title`, `description`, `footer`, `url`, `color`), and the custom ids.

---

## `core/select.ts`

> **Rule:** a menu says what it wants in the same words everywhere.

* The placeholder on the menu and the footer of the panel it sits on
  say the same thing: `Pick an option`, `Pick a channel`, `Pick a role`.
* The question panel is a `panelEmbed`: title `Choose`, the question as
  the description, the hint in the footer. It is the counterpart of the
  prompt's `Confirm`: one asks, one chooses.

**Labels that changed (user-visible):**

| before | after |
| --- | --- |
| `Choose an option` | `Pick an option` |
| — | title `Choose` |
| — | new footers: `Pick an option from the menu below.` / `Pick a channel from the menu below.` / `Pick a role from the menu below.` |

**Not changed:** the placeholders a caller passes in, the custom ids, the
owner check, the guild scoping, the timeouts, and the multi-value rules.

---

## Two crashes fixed on the way

* `embedTemplateToBuilder` threw when a template had a footer icon and
  no footer text — Discord will not take a footer with empty text. Such
  a template now renders without the footer instead of taking the render
  down with it.
* `buildPagerEmbed` threw on an empty page — an empty description is
  not a valid Discord description. The panel helper skips it.

---

## Things `core/ui.ts` could have had

1. **A row helper for every kind of component.** `actionRow` takes
   buttons only, so the select helpers and the modal builders cannot
   use it. A generic `componentRow` would have let the select helpers
   compose with the core row helper, as asked.
2. **A `panelEmbed` that can leave the title out.** It always sets one,
   and Discord rejects an empty title, so it cannot render a
   user-authored embed that has no title. An optional title (or a
   `titleOrUndefined`) would have let `embedTemplateToBuilder` use one
   helper for every case.
3. **A `panelEmbed` that takes a thumbnail and an image.** The two
   fields the designer's template needs are the two the panel helper
   does not have.
4. **A colour on `emptyPanel`.** The paginator's empty state has to
   keep the colour its caller asked for, so it uses `panelEmbed` rather
   than `emptyPanel`.
5. **A way out of a modal.** The rule used to say every modal has a
   Cancel button, but discord.js v14 will not put a button in a modal
   (`Modals can only contain TextInput components`), so `buildModal`
   cannot offer one. `core/ui.ts` has since been corrected to say the
   modal is closed by the client (Escape, or the X in the corner) and
   that the panel behind the modal carries the way back — which is what
   the designer does: its panel holds the menu and the Save button, and
   the modal itself is the only thing in the window.

---

## Tests

* New: 5 prompt appearance tests, 6 paginator row/panel tests, 5 select
  wording tests, 4 embed designer appearance tests. They pin the
  labels, the styles, the footers and the custom ids.
* No existing test asserted on a label or a style, so none had to be
  changed. The one that asserted on copy — the timeout's description
  still contains "timed out" — still holds.
* `npm run typecheck` is clean for `core/`, and the whole suite passes
  (92 files, 1390 tests).
