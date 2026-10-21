---
name: codebase-design
description: "Use when the shape of a module is in question: where the seam goes, how small the interface can get, whether an extraction removes complexity from its callers. Vocabulary reference, not a process."
---

# Codebase Design

A vocabulary for designing modules. This is a **reference, not a driver**. It runs no loop, produces no artifact, and never asks a question on its own. Read it, then use the words.

> Paraphrased from Matt Pocock's `codebase-design` skill (https://github.com/mattpocock/skills), which in turn builds on John Ousterhout's *A Philosophy of Software Design* and Michael Feathers' *Working Effectively with Legacy Code*. The glossary terms are general software-design vocabulary; this file is a condensed restatement, not a copy.


**Do not** treat this file as a runnable process. If you were pointed here and told to "go", do not start surveying or redesigning the codebase. Ask what to design, or hand off to a driver skill (`improve-codebase-architecture` to find candidates, `grilling` to argue one, `tdd` to build it) and use this as the vocabulary underneath.

## The vocabulary

The glossary is the skill. Each term is defined against the others and comes with the word it replaces.

| Term | Meaning | Don't say |
|---|---|---|
| **Module** | Anything with an interface and an implementation. Deliberately scale-agnostic: a function, a class, a package, a slice spanning tiers. | unit, component, service |
| **Interface** | Everything a caller must know to use it correctly: the type signature, plus invariants, ordering constraints, error modes, required config, performance characteristics. | API, signature |
| **Depth** | Leverage at the interface: how much behaviour a caller or a test can exercise per unit of interface they have to learn. Deep = a lot of behaviour behind a small interface. Shallow = the interface is nearly as complex as the implementation. | — |
| **Seam** | Michael Feathers' term: a place you can alter behaviour without editing in that place. It is the *location* of an interface, and where to put it is its own decision, separate from what goes behind it. | boundary |
| **Adapter** | A concrete thing satisfying an interface at a seam. It names a role, not a kind of thing: an in-memory fake and a Postgres repo are both adapters. | — |
| **Leverage** | What callers get from depth: more capability per unit of interface learned. | — |
| **Locality** | What maintainers get from depth: changes, bugs and verification stay in one place, so one fix covers every caller. | — |

Depth is **not** implementation-lines over interface-lines. That metric rewards padding the implementation. Depth is leverage at the interface.

Module is scale-agnostic on purpose: deep modules are about the design of the interface, not the file system. A directory layout may hint at module shape, but shallow modules can live in a tidy folder tree.

## The four principles

- **Depth is a property of the interface, not the implementation.** A deep module can be built internally from small swappable parts. Callers just don't see them. A module may have internal seams its own tests use, and one external seam at its interface.
- **The deletion test.** Imagine deleting the module. If complexity disappears, the module was a pass-through. If it reappears across N callers, the module was hiding real complexity.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't cut a seam until something varies across it. A single-adapter seam is just indirection.

## Supporting files

Read on demand, not up front:

- `DEEPENING.md` — classifies a candidate's dependencies into four categories (in-process, local-substitutable, remote-but-owned, true-external). The category decides how you test a deepened module across its seam.
- `DESIGN-IT-TWICE.md` — spawns parallel sub-agents to produce three or more radically different interfaces for the same module, then compares them on depth, locality and seam placement.

## House rules for this repo

- Discussion of an interface covers invariants, ordering and error modes, not only the type signature.
- A proposed seam comes with a second adapter named, not just the first one. "No second adapter exists — hypothetical seam, leave alone" is a valid and expected result.
- Naming a deep module well needs the domain's words too: an *email* means one thing here, a *ticket* another, and a *row* in the sheet is not a registration in the Free Fire flow. See `README.md` and `STAFF_GUIDE.md` before renaming anything.

## It's working if

- The design conversation stops producing "component", "service" and "boundary", and starts producing "module", "interface" and "seam".
- Someone can point at a proposed extraction and say whether it passes the deletion test, without hedging.
- Invoking this skill does not start a session. If an agent begins reading files and proposing refactors from `codebase-design` alone, it has mistaken the reference for a driver.
