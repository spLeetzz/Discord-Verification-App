# The embed designer is wired

`core/embed-builder.ts` builds the designer's ids under the `embeds`
prefix. Nothing registered that prefix with the router, so every press of
the select and every modal submission was refused with "no handler
registered". This is that fix, and it is in core, because the designer is
core's.

## Where the registration lives

`core/embed-builder.ts` exports `registerEmbedDesignerInteractions()` and
calls it **on import**, so the prefix is registered whether or not an area
remembers to. It is **idempotent**: the prefix is registered once, however
many times the function is called — the paginator's duplicate-registration
bug is not repeated here, and the router's duplicate warning stays quiet on
a normal path.

The prefix is registered for all three kinds of component, because the
panel carries all three:

| kind   | custom id                | what it does                                   |
|--------|--------------------------|------------------------------------------------|
| select | `embeds:options:<token>` | opens the edit modal for the target that was chosen |
| modal  | `embeds:<target>:<token>`| applies the edit to the draft                   |
| button | `embeds:save:<token>`    | hands the finished design to the area           |

The router dispatches each kind on its own list, so one prefix owns all
three without them shadowing each other.

`boot:check` now shows the prefix in the real startup path:

```
buttons: embeds, moderation:role_revert, identity:ssmod, scrims, slots, tourneys
selects: embeds, identity:ssmod, scrims, slots, tourneys
modals:  embeds, identity:ssmod, scrims, slots, tourneys
```

**Nothing else claims `embeds`.** Every `register*` call in the tree was
checked — `scrims`, `slots`, `tourneys`, `identity:ssmod`,
`identity:ssmod:wizard`, `moderation:role_revert`, `pager:<namespace>` —
and no other prefix is a segment-prefix of `embeds` or the other way
round, so the router's shadowing warning stays quiet too.

**One thing for the manager:** the module registers itself on import, which
today happens because the community area imports `core/embed-builder.js`.
That is one import away from not happening. Add
`registerEmbedDesignerInteractions();` to `handlers/listeners.ts` and the
wiring is explicit and independent of who imports what. It is idempotent,
so calling it there *and* on import is harmless.

## How the select and the modal are wired

**The select.** The router hands the handler the rest of the id,
`options:<token>`. The handler reads the token, checks the owner, reads
the chosen value, checks that it is one of the five edit targets, and
opens the modal for it with `showModal`.

**The modal.** The handler reads the target and the token out of the id,
reads the modal's fields, and applies the edit to the draft **in place** —
`apply()` writes the new template back into the token store, so the draft
stays one draft with one owner.

**The re-render.** The panel is the designer's: the embed being edited, the
select, and the save button. `designer.open(interaction, {...})` posts it
and keeps the handle to it in the draft, so the re-render after an edit
lands on the message that actually carries the panel — the reply, or the
follow-up the panel was sent as. That is the handle pattern from
`core/prompt.ts` and `core/select.ts`, followed exactly: the edit goes
through the handle, never through `interaction.editReply()`.

A draft whose panel the caller renders itself (`designer.start(...)`)
keeps the same behaviour with one fallback: the re-render lands on the
message the modal was opened from, which *is* that panel.

One thing the designer's modal path has to account for: the dispatcher
defers every modal submit with an ephemeral reply before it hands the
interaction to the router. That placeholder is resolved with a short
confirmation, or the member is left looking at a spinner for fifteen
minutes.

## The owner check

The draft remembers who started it, and the check is `guardOwner` — the
one call an area needs. It is applied to:

- **the select** — its custom id carries the token, and the token is in a
  message the whole channel can read, so anybody in the channel can press
  it;
- **the save button** — it is on the same panel, so it is exposed in
  exactly the same way.

It is **not** applied to the modal: Discord only shows a modal to the
member who opened it, and only that member can submit it, so a modal
submission is already owner-only. The select did that check before the
modal opened.

The brief called the select "the exposed one". The save button is exposed
in the same way, so it is checked too.

## The button

The brief asked for a button handler, and the designer's id scheme had
none: a select and five modals, and a flow with no end — nothing told the
area that the design was finished, so nothing could be saved.

The button is the **save** button, and it is the designer's, because what
a design is *for* is the area's business. The area hands the designer the
action to run when the owner presses it:

```ts
await designer.open(interaction, {
  template,
  ownerId: interaction.user.id,
  onSave: async (template, interaction) => {
    await repo.saveScrimMessage(scrimId, template);
  },
});
```

The designer answers the press, and confirms the save unless the area has
already said something itself. A save that throws is reported, not
swallowed: "Something went wrong and your design was not saved."

## Memory-only drafts, or persisted?

**Keep it in memory.** That is my answer, and the README says it plainly.

The reasons:

- **It is faithful.** Quotient's embed builder kept the draft in memory.
  A restart lost it there too.
- **The durable copy already happens at save time.** The area writes the
  finished template to its own column — the scrim's `jsonb`, the tag's
  body. A draft that was never saved was never anything but an edit in
  progress, so losing it loses nothing: the design is not lost because it
  is not saved until you press save.
- **A persisted draft buys little and costs a row.** A draft lives
  fifteen minutes and belongs to one member in one guild. Persisting it
  means a table with a guild, an owner, a payload and an expiry, written
  on every keystroke of a design and swept by a job — to hold, for a
  quarter of an hour, state that a restart throws away anyway.

What it costs, stated plainly: **a draft is lost on a restart.** The
panel's buttons then answer "This draft has expired. Please run the
command again" rather than throwing. That is a good trade for not having
a table of fifteen-minute state, but it is a trade, and it is now written
down in `core/README.md` rather than left to be discovered.

If the answer is ever "no", the change is small and local: the draft
becomes a row, `TokenStore` becomes that table, and the ids carry a row id
instead of a token.

## The tests

`core/embed-builder.test.ts` — 24 tests, all driving the **router**, the
way a real press arrives:

| test | what it pins down |
|---|---|
| the select opens the modal for the chosen target | the modal's id is `embeds:<target>:<token>` |
| the select refuses a member who does not own the draft | no modal, one refusal |
| the select refuses an option that is not one of the five | no modal, one refusal |
| the modal applies the change to the draft | the draft's template is updated in place |
| the modal re-renders the panel with the edited template | the edit lands on the handle, with the new title |
| the modal keeps the panel's components | the select and the save button survive the re-render |
| the modal resolves the deferral the dispatcher leaves behind | the ephemeral placeholder is answered |
| the save button hands the design to the area | the area's action runs with the template |
| the save button refuses a member who does not own the draft | the action does not run |
| the registration registers `embeds` for the three kinds | the prefix is there |
| the registration does not warn when it is registered again | no duplicate warning on a normal path |
| a draft that is gone answers the select, the modal and the button | no throw, a refusal |

`core/interaction.fake.ts` grew the three component fakes the tests need —
a select menu, a modal submit and a button — beside the command
interaction it already had.

`npm run typecheck` is clean and `npm test` passes: 86 files, 1243 tests.
