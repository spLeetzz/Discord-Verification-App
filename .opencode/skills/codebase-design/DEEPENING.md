# Deepening: classifying a candidate's dependencies

Read this when you have a candidate module and need to decide how a deepened version of it would be tested across its seam.

The question is not "how do I mock this?" but "what kind of thing is on the other side of the seam?" The category decides the test strategy, and it also decides whether the seam is real.

## The four categories

### 1. In-process

Pure code inside this runtime. No I/O, no network, no clock you don't control. A function over plain data.

- **Test strategy:** call it directly. No fake needed.
- **Seam reality:** the seam between caller and module is real; there is usually no *second* adapter unless something else varies across it.

### 2. Local-substitutable

Something on the local machine that can be replaced with an equivalent local thing: a file, a directory, a subprocess, a local HTTP server, a SQLite file standing in for Postgres.

- **Test strategy:** substitute the real thing locally. A temp directory, an in-process server, a fixture file.
- **Seam reality:** real, if a second adapter genuinely exists (file-backed vs. Postgres-backed, for example). If only one implementation exists anywhere, the seam is hypothetical — see principle 4.

### 3. Remote but owned

A service you own and control: the Google Sheets API, your own REST API, a queue you run.

- **Test strategy:** fake at the seam. Record/replay the wire format, or serve recorded responses from a local stub. The module behind the seam stays real; only the transport is substituted.
- **Seam reality:** real, and the adapter is the transport. This is where a second adapter most often justifies itself — the live client and the recorder are two adapters.

### 4. True external

Someone else's service you do not control: the Discord API, a payment processor, a third-party identity provider.

- **Test strategy:** fake at the seam. The module behind the seam is exercised against recorded payloads and a fake of the external service's own semantics.
- **Seam reality:** real, and the faking is mandatory rather than optional. If a module talks to Discord directly from several callers, that is a missing seam, not a missing adapter.

## How to use the category

1. List the candidate's dependencies.
2. Put each in one of the four categories.
3. Ask for each category-2/3/4 dependency: is there a second adapter, or could one exist without inventing a fake the product will never use?
4. A dependency that varies across the seam justifies the seam. One that does not, does not. **One adapter means a hypothetical seam.**
5. Where two or more callers each reach past the same category-3 or category-4 dependency directly, that is the deepening candidate: put one module behind the seam and let the callers cross it.

## This repo's dependencies

| Dependency | Category | Notes |
|---|---|---|
| Pure helpers in `utils/` | in-process | Direct call in tests |
| Local cache under `.cache/` | local-substitutable | The example-image cache writes to disk |
| Google Sheets API | remote but owned | `repo/sheet.ts` is the adapter seam here |
| Discord API | true external | Fake at the seam for any test that must not hit Discord |
| `config/events.ts`, `config/messageIds.json` | in-process | Config, not I/O |

`npm run smoke` is the existing local-substitutable verification path: it covers config, embed and modal payloads, the command loader, sheet lookup helpers, form validation, thread renaming and the deploy payload, with no Discord or Google credentials.
