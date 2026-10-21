# The tournaments restyle

Every panel and every modal of the tournaments area is built from
`core/ui.ts` now. The custom ids, the handlers, the premium gates, the
free-tier limits, the group algorithm, the slot state machine, the daily
open and the `idp` command are all untouched — this was a look change.

## The panels

| File | Panel |
|---|---|
| `views/manager.ts` | the manager panel (the tournament list, and its empty state) and the per-tournament panel |
| `views/wizard.ts` | the setup wizard |
| `views/editor.ts` | the tournament editor (twenty fields) |
| `views/groups.ts` | the group manager and the published group list |
| `views/slotm.ts` | the slot manager — the panel the teams use |
| `views/partner.ts` | the media-partner panel |
| `views/idp.ts` | the room-credential post |
| `views/lifecycle.ts` | the open, close and pause announcements |
| `views/handlers.ts` | the refusal and success follow-ups (red / green) |

## The modals

`views/modals.ts` builds every modal with `core/ui.ts`'s `buildModal`
and `textInput`. The words live in three tables so that the copy is in
one place and not spread over the handlers:

- `FIELD_MODAL_COPY` — the editor's and the wizard's field modals;
- `MODAL_COPY` — the moderator tools (export, slotlist start, ban,
  rename, media partner);
- `TWO_INPUT_COPY` — add a slot, cancel a slot, create group channels,
  swap two slots.

Every modal has a title that names the action, a short noun label, a
placeholder that shows an example, and `required` set explicitly.

## The rule for each family of buttons

- **The manager.** The tournament picker is the main path; "Create
  tournament" is the only green button; "Refresh" is grey and last.
  The empty state is an `emptyPanel`: it says what to do and the button
  that does it is right there.
- **The tournament hub.** "Edit settings" is the primary and sits alone
  on the first row. Green is the action that adds something *right now*:
  "Start registration" while the tournament is closed, "Add slot" once
  it is open. Red is what destroys: "Cancel a slot", "Close
  registration", "Ban or unban". Everything else is grey.
- **The editor.** A table of twenty peers has no "most likely" field, so
  all twenty buttons are grey letters (A–T) and the embed lists the
  same fields in the same order with the same letters. "Delete
  tournament" is red, "Back" is grey and last.
- **The wizard.** The steps are the letters; the embed shows what every
  step holds; the step that is next is the only blue button and the
  description names it. "Save tournament" is green and alone — saving is
  what creates the tournament. "Cancel" is grey and last.
- **The group manager.** "Publish group list" is the primary; "Create
  channels and roles" is green; Previous, Next, Refresh and Back are
  grey and share the last row.
- **The published list.** "Info" is the primary; "Refresh" is grey and
  last.
- **The slot manager.** "Change team name" is the primary; "Cancel my
  slot" is red and alone on its own row.
- **The media partners.** "Add partner" is green and alone; "Remove
  partner" is red; "Back" is grey.

## The labels that changed

| Before | After |
|---|---|
| Create Tournament | Create tournament |
| Start Reg / Pause Reg / Close Reg | Start registration / Pause registration / Close registration |
| Edit Settings | Edit settings |
| Manage Groups | Manage groups |
| Slot-Manager | Slot manager |
| Media-Partner | Media partners |
| Add Slot | Add slot |
| Cancel Slots | Cancel a slot |
| Ban/Unban | Ban or unban |
| Main Menu | Back |
| Publish Group List | Publish group list |
| Create Channels & Roles | Create channels and roles |
| Give Group Role | Give group role |
| Slotlist Start (button) | Set slotlist start |
| Save (wizard) | Save tournament |
| Cancel My Slot | Cancel my slot |
| My Groups | My groups |
| Change Team Name | Change team name |
| Swap Groups | Swap groups |
| Add New (partner) | Add partner |
| Remove (partner) | Remove partner |
| Get in Copy Format | Copy details |
| a Name, b Registration Channel, … (editor buttons) | A, B, C, … (the field names moved into the embed) |

The modal titles and field labels changed too: "The team leader" became
"Team leader", "The slot number" became "Slot number", "Type anything
to confirm" became "Confirmation", "Mention the users to ban or unban"
became "Users", and every field modal is now titled "Set …" ("Set total
slots", "Set reactions", "Set open time", …).

The embed titles moved to sentence case, and the editor's field names
are sentence case now ("Required mentions", "Duplicate / fake tags",
"Slotlist start from").

## What was found, and not fixed

**The tournament panel's "Edit settings" button is dead.** Its custom id
is `tourneys:editor:<tourneyId>` — one part — but `onEditor` reads
`parts[0]` as the field and `parts[1]` as the tournament's id, so the
press is refused with "That button is no longer active." The scrims
area has the same panel and solved it with a separate `editor_open`
action.

The custom id was left exactly as it is, because the ids are the
router's contract. The fix is a new `editor_open` action in
`views/ids.ts` plus a branch in `onEditor`, or a one-part fallback in
`onEditor` itself.
