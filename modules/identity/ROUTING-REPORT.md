# The identity area's routing — one prefix, one dispatch

The router warned that this area's two prefixes shadow each other:

```
[Router] Prefix shadowing in area "identity": the button prefix
"identity:ssmod" (registered first) shadows "identity:ssmod:wizard"
(registered now). … "identity:ssmod:wizard" is unreachable — the handler
behind it never runs.
```

The pair worked **only because the wizard was registered first**. The
router takes the first prefix that matches an id, so the order of two
lines of registration decided whether the wizard's **Save** button
worked. That is a load-bearing registration order, found by a warning
rather than by a test.

## The shape

**One prefix, and the handler dispatches on the segment after it** — the
shape the scrims and the tournaments areas already use
(`scrims:editor:…` and `scrims:wizard:…` under the single prefix
`scrims`).

```
identity:ssmod:<surface>:<action>[:<target>]
```

- The **surface** is the segment right after the prefix, and it says
  what the target is: `wizard` (a token into the draft store) or `edit`
  (a row id in the database).
- The **action** is the next segment, and it belongs to the surface.
- The **target** is the rest: a row id, or the wizard's token.

## The ids, and how they are dispatched now

| Id | What it does |
|---|---|
| `identity:ssmod:list:setup` | The list panel's **Create setup** button. |
| `identity:ssmod:list:faq` | The list panel's **FAQ** button. |
| `identity:ssmod:list:edit:<configId>` | The list panel's **Edit** button. |
| `identity:ssmod:edit:set_channel:<configId>` | One field of the editor. |
| `identity:ssmod:edit:delete:<configId>` | The editor's **Delete setup** button. |
| `identity:ssmod:edit:close:<configId>` | The editor's **Close** button. |
| `identity:ssmod:wizard:set_channel:<token>` | One field of the wizard. |
| `identity:ssmod:wizard:save:<token>` | The wizard's **Save setup** button. |
| `identity:ssmod:wizard:close:<token>` | The wizard's **Cancel** button. |

`registerIdentityInteractions` now registers `identity:ssmod` **once** per
kind of component — button, select menu, modal. Each registration parses
the payload into a surface, an action and a target, and hands that to
the one handler for that kind. The handler switches on the surface and
then on the action: the segments the id carries and the segments the
handler switches on are the same ones.

The scheme lives in `views/ids.ts` — the surfaces, the actions, the
builder and the parser — so the id and the handler cannot drift apart.
The parsed id is a union discriminated by the surface, and the builder
refuses an action that belongs to another surface.

Two things fell out of it:

- The surface says whether the target is a token or a row id, so the
  handler resolves **one** target instead of trying the wizard first and
  falling back to the editor.
- The wizard's **Save setup** and the list panel's **Create setup** are
  actions of different surfaces, and neither can be mistaken for the
  other. The parser refuses `identity:ssmod:edit:save:<token>`.

## The tests

`views/ssmod.test.ts` presses **every** id the panel builds through the
**real** router, in two registration orders — the area first, and the
area last behind another area's prefix — and records the *effect* of
each press (a row written, a row deleted, a wizard opened). The two
records have to be equal, and no press may go unanswered.

The same file asserts that the area registers exactly one prefix per
kind of component, and that the router logs **no** warning when it
registers. Putting the old pair back (the broad prefix first) fails
both, and the warning test reproduces the three warnings the router
printed.

`views/ids.test.ts` covers the scheme itself: one layout, the round trip
through the builder and the parser, and the refusal of an action that
belongs to another surface.

## The embed designer

The runtime engineer's finding — `core/embed-builder.ts` builds its ids
under the `embeds` prefix and nothing registered that prefix — **does
not touch this area**. The identity area builds no ids outside
`views/ssmod.ts` and never uses the embed designer, so the fix in
`core/` changes nothing here.
