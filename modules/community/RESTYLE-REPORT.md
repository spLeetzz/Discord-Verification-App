# Community area — the new look

`modules/community/` only. `npm run typecheck` is clean for the area,
`npm test` passes (10 files, 135 tests — 15 of them new, in
`modules/community/panels.test.ts`).

## What the area actually has

- **No modals.** The area opens none, so there was no modal to rebuild.
  Every action is a slash command, and `registerCommunityInteractions()`
  still registers no component ids of its own.
- **No local button helpers.** There was nothing named `button()` /
  `buttonRow()` / `makeButton` to replace. The only hand-rolled button
  was the reminder's link row, and it now goes through the core
  `actionRow`.
- **One button in the whole area**: the reminder's "jump to the original
  message" link.

## The panels

Every panel is built with `core/ui.ts`: `panelEmbed` for the panels,
`emptyPanel` for the empty states.

| Panel | Command | New title | New footer |
|---|---|---|---|
| deleted message | `/snipe` | "Deleted message" | "Sniped messages are kept for ten days." |
| tag statistics | `/tag info` | "Tag: `<name>`" | "Post it with `/tag show <name>`." |
| auto-roles | `/autorole config` | "Auto-roles" | "Add a role with `/autorole humans` or `/autorole bots`." |
| auto-purge channels | `/autopurge list` | "Auto-purge channels" | "Set a channel up with `/autopurge set`." |
| guild tag statistics | `/tag stats` | "Tag stats" | "These statistics are for this server only." |
| member tag statistics | `/tag stats <member>` | "Tag stats for `<name>`" | "These statistics are for this server only." |
| a reminder | the delivery | "Reminder" | "Delete it early with `/reminder delete`." |
| a list of tags | `/tag list`, `/tag mine`, `/tag search` | the paginator's title | the header above the list |
| a list of reminders | `/reminder list` | "Running reminders (n)" | the header above the list |

### The one-line rule per family of buttons

- **Navigation (the reminder's link):** grey, and alone. A link takes the
  reader somewhere and changes nothing, so it is never green and never
  red.
- **Everything else in the area is a command, not a button:** the action
  is named in the panel's **footer**, never in a button, so a panel
  cannot end up with two things shouting.
- **The list's action is named in its header** (above the list), because
  the paginator's own footer carries the page count.

### The list panels

A tag list is a numbered row per tag: the **name in bold**, the id in a
code span, and the hint above the list — "Post one with `/tag show
<name>`." A reminder list is the same shape, and its header is "Delete
one with `/reminder delete`." — which is why the list shows the id.

### The empty states

`emptyPanel`, with the hint in the footer:

| Command | Title | Description | Footer |
|---|---|---|---|
| `/tag list` | "No tags" | "This server has no tags yet." | "Create one with `/tag create`." |
| `/tag list <member>` | "No tags" | "`<name>` does not own any tags yet." | "Create one with `/tag create`." |
| `/tag mine` | "No tags" | "You do not own any tags yet." | "Create one with `/tag create`." |
| `/tag search` | "No tags" | "No tag matches \"`<query>`\"." | "Try another name, or create one with `/tag create`." |
| `/reminder list` | "No reminders" | "You have no running reminders." | "Set one with `/reminder set`." |
| `/autopurge list` | "No auto-purge channels" | "This server has no channels set up for auto-purge." | "Set one up with `/autopurge set`." |
| `/autorole config` | "No auto-roles" | "This server has no auto-roles yet." | "Add one with `/autorole humans` or `/autorole bots`." |
| `/snipe` | "Nothing to snipe" | "No message has been deleted in this channel yet." | "Try again after a message is deleted." |

A **refusal** is not an empty state and stays a refusal ("That channel
is not an auto-purge channel.", "The auto-roles are already off.").

## The labels I changed

Panel titles and footers are new everywhere (the tables above). The
button label:

- "Jump to Original Message" → **"Jump to original message"** (sentence
  case).

The list rows:

- tag row: `` `01` rules (ID: 3f2b…) `` → `` `01` **rules** — `3f2b…` ``
  (name bold, id in a code span, no "ID:" prose).
- auto-purge row: `` `01` | #general (10 minutes) `` → `` `01` #general —
  10 minutes ``.
- reminder row: `` `id`: text (when) `` → `` `id` — text (when) ``.
- the statistics lists: the rank **emoji** (🥱 🥲 🥳) are gone — the
  rows are numbered `1.`, `2.`, `3.` now, and a missing entry says
  "No tags yet." / "Nobody has used a tag yet." instead of a
  "🥱 Owned Tag: Nothing!" placeholder row.
- "Not Set!" → "Not set", "Deleted Channel" → "Deleted channel".

The wording of the *content* replies is unchanged: "Created the tag
**x**", "Deleted **x**", "Alright, I left them alone." and the rest are
still one-line messages, not panels.

## What did not change

- **Custom ids**: none. The paginator's ids are still
  `pager:<namespace>:<action>:<page>` with the same namespaces
  (`tags-all-<guild>`, `tags-of-<guild>-<member>`, `tags-mine-…`,
  `tags-find-…`, `reminders-<user>`), and the area registers no ids of
  its own.
- **Handler behaviour**: which button does what, what is written and
  what is saved — all unchanged. The usage counter, the 25-tag and
  25-reminder allowances, the lower-cased tag name, the auto-role
  toggle's atomicity and the snipe rules are as they were.
- **The queries**: the same statements, the same number of reads. The
  tag lists read their rows once to answer "is the list empty?" and the
  paginator's first page is built from those rows, so opening a list
  still costs one read and every press still costs one read
  (`tagSource` in `commands/tag.ts`). The search still reads twice, as
  it did before.
- **The data**: nothing new is stored and nothing was dropped.

## New files in the area

- `views/buttons.ts` — `linkButton`. **This one is the area's own
  helper, because `core/ui.ts` has no link button**: a link is the one
  button that cannot carry a custom id, so it is not the router's
  business and the shared helpers do not cover it. It is grey, like
  every link.
- `views/lists.ts` — the rows of the tag and reminder lists.
- `views/panels.ts` — the empty states, and `panelPayload`, which turns
  a `Panel` into a reply payload.
- `panels.test.ts` — the look, pinned down.

## What I wished `core/ui.ts` had

1. **A link button** (`linkButton({ label, url })`). Three areas now
   need one; each has to write its own.
2. **A panel that is a list.** The paginator owns the row (four grey
   emoji buttons) and the footer ("Page 1 of 3"), so a list panel
   cannot carry a hint in its footer and cannot name its action. The
   hint had to go above the list, in the description. A
   `listPanel({ title, header, rows })` — or a paginator option for a
   header line and a footer that is not the page count — would fix it
   for every area.
3. **`panelEmbed` with an author line and a timestamp.** The old panels
   used `setAuthor` and `setTimestamp`; the core helper has neither, so
   the tag and member statistics panels lost their author line (the
   owner is a field now) and the reminder lost its corner timestamp
   (the "Set" field carries it).
4. **A `pageSize`/`footer` option on the paginator** — see (2).
5. `emptyPanel` is good, but an empty panel that also wants a **grey
   "Close" button** cannot have one: `emptyPanel` takes a single
   `action`, and the design language says the action is the panel's one
   primary action. A `secondaryAction` for the navigation row would
   round it off.
