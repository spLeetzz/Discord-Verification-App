# `db/` — the write queue: report

The hazard the moderation engineer found is a `db/` problem, and it is
fixed here: **one queue, in front of every write in the process.**

Nothing outside `db/` changed. `db`, `withTransaction`, `closeDatabase`
and every query the eight modules call keep their exact signatures, and
no module had to be touched.

---

## 1. The shape, and where it sits

`db/write-queue.ts` holds the queue. `db/client.ts` wires it in.

**It wraps the libsql client**, so it is in front of *every* statement
the application runs — the query builders, the raw `db.execute(sql…)`
statements, the boot migrations, the seed, the retention prune and the
scheduler's deletes. That is the whole point: a write that bypasses the
queue can still collide, so the queue is not "in front of the module
writes" but "in front of the connection".

```
module code  →  db (drizzle)  →  QueuedClient  →  libsql client  →  file
                                    ↑
                             the write queue
```

| | |
|---|---|
| **What is queued** | The writes. A statement is a write unless its first keyword is `select`, `pragma`, `explain` or `values`; `with` is deliberately a write, because SQLite allows a data-modifying statement after it. |
| **What is not queued** | The reads. A read must not wait behind a long write, or the whole bot stalls behind one slow transaction. |
| **The transaction is the unit** | A transaction holds the write lock for its whole body, so it holds the queue for its whole body too: the slot is taken when the transaction is opened and given back when it is committed or rolled back. |
| **The queue does not decide races** | The unique constraints are still the authority. The queue only makes two statements *reach* the database one after the other, so the loser gets the constraint's error rather than the driver's. |

**There is no busy timeout.** The driver can be told to wait for the
writer lock, and it was the wrong answer: the timeout is applied to
*every* connection the driver opens, so it covers the connection a
transaction is given — the one that already holds the write lock. Two
transactions that overlap in one process then stall for the whole
timeout and one of them fails with `SQLITE_BUSY` anyway. A fast failure
is the better answer, and the queue is what makes it a rare one: one
writer at a time, in this process, by construction. Nothing else writes
the file — the bot applies its own migrations at boot, and the deploy
pipeline has no migration step — so there is no second process to wait
for either.

---

## 2. Re-entrancy, and the transaction case

**A transaction's body must not go back through the queue**, or the
transaction waits for itself: it is holding the queue while it runs.

Two mechanisms, both in `db/write-queue.ts`:

1. **The transaction is the unit.** The statements a transaction runs
   through its own handle go to the transaction's connection, never
   through the queue. The queue slot is held from the open to the
   commit.

2. **The transaction context.** A transaction's body calls repository
   functions that themselves write, and those functions may write
   through the *database* handle rather than the transaction handle.
   An `AsyncLocalStorage` carries the open transaction through the async
   call chain (`db/write-queue.ts`, `transactionContext`), so a write
   issued anywhere inside the body is executed **on the transaction's
   connection** — it joins the transaction, and it is rolled back with
   it if the transaction fails.

   It is an `AsyncLocalStorage` and not a variable because a
   transaction and the rest of the bot run at the same time: a write
   from *outside* the body must not be dragged into somebody else's
   transaction. It is queued like any other write.

### How the context is entered, and how it is left

**The store holds a scope, not a transaction.** `transactionContext` is
an `AsyncLocalStorage<TransactionScope | undefined>`, and a scope is a
box: `{ transaction: Transaction | undefined }`.

The box is there because of two facts about `AsyncLocalStorage`, both
measured on the Node this runs on (v22.23.1):

- **A store reaches only the async resources created after it is set.**
  An `enterWith` in an asynchronous continuation never reaches the
  chain that called it, so a scope entered *after* `await
  client.transaction()` would be invisible to the caller.
- **A store cannot be unwound out of a frame that has moved on.** A
  clear issued from the commit's chain does not clear the caller's
  chain, and `AsyncLocalStorage.exitWith` — which unwinds one frame —
  **does not exist before Node 24**, so it cannot be used here at all.

So the scope is:

- **entered synchronously**, in `QueuedClient.transaction()`, *before*
  the first `await`. That is the caller's own frame, and the scope
  reaches every resource created after it — including the transaction
  body's chain, and the caller's own later awaits. The transaction does
  not exist yet at that moment, which is exactly why the store holds a
  box and not the transaction: `scope.transaction` is filled in when
  the driver has opened it.
- **filled in** when the transaction is open, so a write finds it.
- **emptied** when the transaction finishes — commit, rollback or
  `close()`, whichever happens first, exactly once
  (`QueuedTransaction.#finish()`). A write that finds an empty scope is
  an ordinary write and is queued like one, so the chain that opened the
  transaction is never left holding a transaction that has closed. This
  emptying of the box is the exit; the store itself is not restored,
  because it cannot be.

**Two paths drive a transaction's body, and they enter the context
differently.**

- **The callback path** — what the application uses. drizzle takes the
  body as a callback, so `db/client.ts` runs it with
  `transactionContext.run(scope, …)`: the store is in place for the
  body's own chain and taken out again when the body ends. The
  *caller's* chain is not in the transaction: the caller may go on to
  do other work while the body runs, and that work has to **wait** for
  the transaction rather than join it. So `db/client.ts` takes the
  scope out of the caller's chain as soon as the transaction has been
  opened.
- **The handle path** — the libsql transaction handle, where the caller
  writes the body itself. There is no callback for the queue to wrap,
  so the scope entered synchronously by `QueuedClient.transaction()` is
  what carries the transaction, and the caller's chain keeps it until
  the transaction finishes and empties it.

### The rule for a transaction opened inside another one

**A transaction that takes the queue slot enters a scope. A transaction
opened while another one is open in the same chain does not: it becomes
a savepoint on the parent's connection and joins the parent's scope.**

The queue is held by the parent, so the nested transaction cannot take a
slot of its own — it would wait for one its parent is holding, and
deadlock. It runs on the parent's connection instead, so its writes
belong to the parent either way.

Not entering a scope of its own is not a convenience, it is what keeps
the rule simple. If the nested transaction entered a second scope, it
would shadow the parent's: the parent would finish and empty the wrong
scope, the nested block's writes would find no transaction, and they
would go back into the queue — into a queue the parent is holding. The
deadlock the manager was warned about is exactly that.

---

## 3. Why the queue, and not the alternatives

The brief offered a single shared connection or a read/write split.
**The queue**, for three reasons:

- **A single connection is worse, not better.** SQLite gives a
  transaction its own connection *by design*; forcing every write onto
  one connection would make a second `BEGIN` an error ("cannot start a
  transaction within a transaction"), and an unrelated write would be
  committed or rolled back with somebody else's transaction.
- **A read/write split does not help here.** The contention is not
  between reads and writes — it is between two *writers*, one of which
  is a transaction that holds the write lock for its whole body. A
  dedicated writer connection would still be one connection, with the
  same problem.
- **Serialising writes is not "blunt" — it is what SQLite already
  does.** SQLite has one writer. A write that arrives while a
  transaction is open *cannot* proceed; today it fails with
  `SQLITE_BUSY`, and with the queue it waits its turn. The queue does
  not add a restriction SQLite did not already have; it replaces a
  driver error with the database's own answer.

The one real cost: a transaction blocks the other writes for its whole
duration, including the part of it that only reads. That is inherent to
a single-writer engine — a concurrent write would have failed rather
than succeeded — and the transactions here are milliseconds long.

---

## 4. The two `FOR UPDATE` sites

**Both are already gone in the working tree. No dispatch is needed.**

| Site | State |
|---|---|
| `modules/tourneys/repo.ts` | The `select id from "tourneys" where id = ? for update` is gone. It is a conditional `UPDATE` (`update "tourneys" set "updated_at" = ? where id = ? returning id`) — see `nextSlotNumberIn` and `modules/tourneys/SQLITE-PORT-REPORT.md`, "The row lock". |
| `modules/premium/repo.ts` | Both `.for("update")` calls are gone. `lockGuildSettings` and `markTransactionPaid` are conditional `UPDATE`s now. |

The evidence, over the whole tree:

```
$ grep -rn "\.for(" --include="*.ts" .            # → no matches
$ grep -rn -i "for update" --include="*.ts" .     # → comments and docs only
```

The only remaining mentions are the comments that *explain* the
replacement (`"SQLite has no SELECT … FOR UPDATE"`) and the porting
reports. The moderation engineer's report was accurate about the shape
of the hazard, but both sites had already been fixed — the tourneys one
in commit `6160eea`, the premium one in the working tree.

---

## 5. The tests

`db/write-queue.test.ts` (11 tests). It opens a temporary SQLite file,
applies the migration, and asserts against a real database.

| Test | What it proves |
|---|---|
| "answers a contended write with the constraint, not with SQLITE_BUSY" | Two overlapping writes: the loser gets `SQLITE_CONSTRAINT_UNIQUE`, **not** `SQLITE_BUSY`. |
| "makes a write outside a transaction wait for the transaction" | A write issued while a transaction is open waits for its turn instead of colliding. |
| "lets a transaction body write through the database handle" | The re-entrancy case: a write issued inside a transaction body through the *database* handle joins the transaction instead of deadlocking against it. |
| "rolls the inner write back with the transaction that made it" | That inner write is part of the transaction — it is rolled back with it. |
| "lets a transaction inside a transaction join it" | The nested case: a savepoint on the same connection, no deadlock. |
| "lets the constraint decide the race, not the driver" | The double-lock race: one caller is told "claimed", the other "already locked" — the constraint's answer, not a busy error. |
| "does not make a read wait for a write" | A read during an open write transaction is not queued. |
| "holds the transaction in the context while the body runs, and not after" | The context is entered for the body, and the caller's chain is not left inside the transaction. |
| "puts a write made during the transaction into the transaction" | **The handle path.** A write through the *client* while a raw transaction is open finds that transaction instead of waiting for a lock the transaction is holding. |
| "empties the context when the transaction finishes" | **The handle path.** After the transaction, the context holds nothing: a later write in the same chain is an ordinary write. |
| "makes a transaction opened inside a transaction a savepoint" | **The handle path.** The nested transaction does not shadow the parent's scope. |

**The tests fail without the fixes.** With the context enter removed,
the three handle-path tests fail — the write goes back into the queue
and waits for a lock its own transaction is holding. With the exit
removed, "empties the context when the transaction finishes" fails.

`npm run typecheck` passes. `npm test` passes: **90 files, 1343 tests**
(30 of them in `db/`).

---

## 6. What changed, file by file

| File | Change |
|---|---|
| `db/write-queue.ts` | The queue, the read/write classifier, the transaction context and its scope, the queued client. |
| `db/write-queue.test.ts` | The eleven tests above. |
| `db/client.ts` | The queued client, `db.transaction` wrapped so every transaction body runs inside the transaction's scope and the caller's chain is left outside it, the busy timeout removed, `closeDatabase` drains the queue first. |
| `db/README.md` | The queue and the seam, documented; what is left to do for Postgres. |
| `db/PORT-REPORT.md` | §5.5 updated: the timeout was the wrong answer, and it is off. |

Nothing else was touched. The module-local queues (moderation, scrims)
are still there and are harmless: they are taken *before* the global
queue, and no transaction body calls a function that takes one.
