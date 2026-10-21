/**
 * The write queue.
 *
 * **SQLite has one writer.** The libsql driver hands a transaction a
 * connection of its own, so two writes that overlap in this process do
 * not queue — they collide, and the second one is refused by the
 * *driver* with `SQLITE_BUSY` instead of by the *database* with the
 * constraint it violated. The loser of a race has to be told "already
 * locked", not "database busy", because only the first of those is
 * something the caller can act on.
 *
 * **What this file is.** One queue, in front of every write in the
 * process. It does not decide who wins a race: the unique constraints
 * are still the authority. It only makes two statements *reach* the
 * database one after the other, so the loser of a race gets the
 * constraint's error rather than the driver's.
 *
 * **Where it sits.** It wraps the libsql client, so it is in front of
 * every statement the application runs — the query builders, the raw
 * statements, the migrations, the seed, the retention prune and the
 * scheduler's deletes — without a single module having to know that it
 * exists.
 *
 * **Reads are not queued.** A read must not wait behind a long write,
 * or the whole bot stalls behind one slow transaction. Only writes are
 * serialised.
 *
 * **A transaction is the unit.** A transaction holds the write lock for
 * its whole body, so it holds the queue for its whole body too.
 * Everything inside it runs on its own connection, without going back
 * through the queue — otherwise the transaction would wait for itself.
 *
 * **The transaction context.** A write issued inside a transaction
 * belongs to that transaction, so it must not go back into the queue:
 * the transaction is holding the queue, and a write that waited for it
 * would be waiting for itself. The context is what tells a write which
 * transaction it belongs to. It is entered when the transaction opens
 * and emptied when the transaction finishes.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Client,
  InArgs,
  InStatement,
  Replicated,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";

/**
 * Releases a slot of the queue.
 *
 * Calling it twice is harmless: the second call does nothing. That
 * matters because a transaction can be closed by a commit, a rollback
 * *and* a `close()`, and the queue must not let go twice.
 */
export type Release = () => void;

/**
 * The queue of writes.
 *
 * A chain of promises: every caller appends itself to the chain and
 * waits for the one before it. A caller that throws does not break the
 * chain for the next one.
 */
export class WriteQueue {
  /** The tail of the chain. It never rejects. */
  #tail: Promise<void> = Promise.resolve();

  /**
   * Waits for the queue to be free, and holds it until the returned
   * function is called.
   *
   * The chain is extended *before* the wait, so the callers are served
   * in the order they arrived rather than in the order they were
   * scheduled.
   */
  async acquire(): Promise<Release> {
    let open!: () => void;

    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const previous = this.#tail;

    this.#tail = previous.then(() => gate);

    await previous;

    let released = false;

    return () => {
      if (released) return;

      released = true;
      open();
    };
  }

  /**
   * Runs `operation` with the queue held.
   *
   * The slot is released when the operation settles, whether it
   * succeeded or not.
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();

    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Waits for everything queued so far to finish.
   *
   * Used on shutdown, so that a write in flight is not cut off by the
   * close.
   */
  async drain(): Promise<void> {
    const release = await this.acquire();

    release();
  }
}

/* ------------------------------------------------------------------ *
 * Telling a read from a write
 * ------------------------------------------------------------------ */

/**
 * The statements that do not write.
 *
 * Everything else is treated as a write. A statement the classifier is
 * unsure about has to be queued rather than not: a read that waits for
 * the queue is a slower read, while a write that skips it is a
 * `SQLITE_BUSY`.
 */
const READ_KEYWORDS = new Set(["select", "pragma", "explain", "values"]);

/**
 * The first keyword of a statement, in lower case.
 *
 * Leading whitespace and comments are skipped, because a statement may
 * start with either. An empty string means the statement was nothing
 * but a comment, which is treated as a read.
 */
const LEADING_KEYWORD = /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)*([a-zA-Z]+)/;

/**
 * Does this statement write?
 *
 * **The rule is the first keyword.** `select`, `pragma`, `explain` and
 * `values` read; everything else writes. `with` is deliberately a
 * write: SQLite allows a data-modifying statement after a `with`, and
 * nothing in this codebase writes through one, so the safe reading is
 * the one that queues.
 */
export function isWriteStatement(sql: string): boolean {
  const keyword = LEADING_KEYWORD.exec(sql)?.[1]?.toLowerCase() ?? "";

  return !READ_KEYWORDS.has(keyword);
}

/**
 * Does this script write?
 *
 * A script is several statements in one string, so every one of them is
 * looked at: a script that starts with a `select` and goes on to
 * delete something is a write.
 */
export function scriptHasWrite(sql: string): boolean {
  return sql
    .split(";")
    .some((statement) => isWriteStatement(statement));
}

/**
 * The text of a statement, whatever form it was given in.
 */
export function statementText(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

/* ------------------------------------------------------------------ *
 * The transaction context
 * ------------------------------------------------------------------ */

/**
 * The transaction of the chain that is driving a transaction body.
 *
 * **A box, not the transaction itself.** The context has to be entered
 * *before* the transaction exists — the driver opens it asynchronously,
 * so there is nothing to enter at the moment the caller asks for a
 * transaction — and it has to be emptied *after* the transaction has
 * finished, by which time the caller's chain has moved on and the store
 * can no longer be unwound. A box can be both: it is entered
 * synchronously, filled in when the transaction opens, and emptied when
 * it finishes.
 */
export interface TransactionScope {
  /** The open transaction, or `undefined` once it has finished. */
  transaction: Transaction | undefined;
}

/**
 * The transaction the current call is inside, if it is inside one.
 *
 * **This is what makes the queue re-entrant.** A transaction's body
 * calls repository functions that write; those writes are part of the
 * transaction and must not go back into the queue, or the transaction
 * would wait for itself. The context carries the open transaction
 * through the async call chain, so a write issued anywhere inside the
 * body finds the transaction it belongs to.
 *
 * It is an `AsyncLocalStorage` rather than a variable because a
 * transaction and the rest of the bot are running at the same time: a
 * write from *outside* the body must not be dragged into the
 * transaction.
 *
 * **What is in the store is a scope, not a transaction.** The store
 * holds a box that is filled in when a transaction opens and emptied
 * when it finishes. `AsyncLocalStorage` propagates a store to the
 * async resources created *after* it is set, and it cannot unwind a
 * store out of a frame that has already moved on — so the box, rather
 * than the store, is what records whether the transaction is still
 * open.
 */
export const transactionContext = new AsyncLocalStorage<
  TransactionScope | undefined
>();

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

/**
 * A libsql client whose writes are serialised.
 *
 * Everything else — the reads, the transaction handle, the shape of the
 * client — is the inner client's. The modules cannot tell the
 * difference, which is the point: no area has to know that the queue
 * exists.
 */
export class QueuedClient implements Client {
  readonly #inner: Client;
  readonly #queue: WriteQueue;

  /**
   * The scope of the transaction that holds the queue, if there is one.
   *
   * There is never more than one: a transaction holds the queue from
   * the moment it is opened until it is committed or rolled back.
   */
  #activeScope: TransactionScope | undefined;

  constructor(inner: Client, queue: WriteQueue) {
    this.#inner = inner;
    this.#queue = queue;
  }

  /** The open transaction, if there is one. */
  get activeTransaction(): Transaction | undefined {
    return this.#activeScope?.transaction;
  }

  /**
   * The scope of the open transaction, if there is one.
   *
   * The scope is what the transaction context holds while the
   * transaction is open. Whoever drives a transaction's body runs it
   * inside this scope, so that a write issued through the client
   * during the body belongs to the transaction rather than to the
   * queue the transaction is holding.
   */
  get activeScope(): TransactionScope | undefined {
    return this.#activeScope;
  }

  async execute(stmt: InStatement): Promise<ResultSet>;
  async execute(sql: string, args?: InArgs): Promise<ResultSet>;
  async execute(stmt: InStatement, args?: InArgs): Promise<ResultSet> {
    const statement: InStatement =
      typeof stmt === "string" ? { sql: stmt, args } : stmt;

    // Inside a transaction, the statement belongs to the transaction.
    // It runs on the transaction's own connection, without the queue.
    //
    // A transaction that has already been committed is not a transaction
    // any more: a statement that outlived the body it was started in
    // is an ordinary write, and it is queued like one.
    const open = transactionContext.getStore()?.transaction;

    if (open && !open.closed) return open.execute(statement);

    // A read does not wait for a write.
    if (!isWriteStatement(statementText(statement))) {
      return this.#inner.execute(statement);
    }

    return this.#queue.run(() => this.#inner.execute(statement));
  }

  async batch(
    stmts: Array<InStatement | [string, InArgs?]>,
    mode?: TransactionMode,
  ): Promise<ResultSet[]> {
    const open = transactionContext.getStore()?.transaction;

    if (open && !open.closed) {
      return open.batch(stmts.map((statement) => toStatement(statement)));
    }

    const writes = stmts.some((statement) =>
      isWriteStatement(statementText(toStatement(statement))),
    );

    if (!writes) return this.#inner.batch(stmts, mode);

    return this.#queue.run(() => this.#inner.batch(stmts, mode));
  }

  async migrate(stmts: Array<InStatement>): Promise<ResultSet[]> {
    // A migration is DDL: it writes, whatever it says.
    return this.#queue.run(() => this.#inner.migrate(stmts));
  }

  async transaction(mode?: TransactionMode): Promise<Transaction> {
    const open = transactionContext.getStore()?.transaction;

    // A transaction inside a transaction. It cannot take the queue —
    // the queue is held by the transaction it is nested in — so it
    // becomes a savepoint on the same connection.
    //
    // **It does not enter a scope of its own.** The scope in the
    // context is the parent's, and a second one would shadow it: the
    // parent would finish, empty the wrong scope, and the writes of
    // the nested block would go back into the queue — into a queue the
    // parent is holding. The savepoint runs on the parent's
    // connection, so the nested block's writes belong to the parent
    // anyway.
    if (open && !open.closed) return SavepointTransaction.open(open);

    // The scope of this transaction, entered *synchronously*.
    //
    // The chain that opened the transaction has to be able to find it:
    // a write issued through the client while the transaction is open
    // belongs to the transaction, and a write that went back into the
    // queue would wait for a lock the transaction itself is holding.
    //
    // Entering the scope here, before the first `await`, is what makes
    // that work. `AsyncLocalStorage` gives a store to the async
    // resources created *after* it is set, so a scope entered from an
    // asynchronous continuation — which is where `await
    // this.#inner.transaction()` would put it — would never reach the
    // chain that opened the transaction.
    const scope: TransactionScope = { transaction: undefined };

    transactionContext.enterWith(scope);

    const release = await this.#queue.acquire();

    let inner: Transaction;

    try {
      inner = await this.#inner.transaction(mode);
    } catch (error) {
      // Nothing was opened, so there is nothing to empty — but the
      // scope is in the caller's chain, and it must not look like an
      // open transaction.
      scope.transaction = undefined;
      release();
      throw error;
    }

    const queued = new QueuedTransaction(inner, release, () => {
      this.#activeScope = undefined;

      // **The exit.** The transaction is finished, so the scope is
      // emptied: a write issued later in this chain is an ordinary
      // write and is queued like one. The store itself cannot be
      // unwound from here — the caller's chain is an outer frame, and
      // `AsyncLocalStorage` only unwinds the frame it is called in —
      // so the box is emptied instead of the store being restored.
      scope.transaction = undefined;
    });

    scope.transaction = queued;
    this.#activeScope = scope;

    return queued;
  }

  async executeMultiple(sql: string): Promise<void> {
    if (!scriptHasWrite(sql)) return this.#inner.executeMultiple(sql);

    return this.#queue.run(() => this.#inner.executeMultiple(sql));
  }

  async sync(): Promise<Replicated> {
    return this.#inner.sync();
  }

  close(): void {
    this.#inner.close();
  }

  reconnect(): void {
    this.#inner.reconnect();
  }

  get closed(): boolean {
    return this.#inner.closed;
  }

  get protocol(): string {
    return this.#inner.protocol;
  }
}

/**
 * A statement, whichever form it was given in.
 */
function toStatement(statement: InStatement | [string, InArgs?]): InStatement {
  if (Array.isArray(statement)) {
    const [sql, args] = statement;

    return { sql, args };
  }

  return statement;
}

/**
 * A transaction that holds the queue until it is finished.
 *
 * The queue slot is taken when the transaction is opened and given back
 * when it is committed or rolled back — a transaction holds the write
 * lock for its whole body, so it holds the queue for its whole body too.
 *
 * **Finishing is the exit.** `#finish()` runs exactly once, whichever
 * of the three ways out of a transaction happens first — a commit, a
 * rollback or a `close()` — and it is what empties the transaction's
 * scope, so that a write issued later in the chain that opened the
 * transaction is an ordinary write and is queued like one.
 */
class QueuedTransaction implements Transaction {
  readonly #inner: Transaction;
  readonly #release: Release;
  readonly #onFinish: () => void;

  #finished = false;

  constructor(inner: Transaction, release: Release, onFinish: () => void) {
    this.#inner = inner;
    this.#release = release;
    this.#onFinish = onFinish;
  }

  execute(stmt: InStatement): Promise<ResultSet> {
    return this.#inner.execute(stmt);
  }

  batch(stmts: Array<InStatement>): Promise<ResultSet[]> {
    return this.#inner.batch(stmts);
  }

  executeMultiple(sql: string): Promise<void> {
    return this.#inner.executeMultiple(sql);
  }

  async commit(): Promise<void> {
    try {
      await this.#inner.commit();
    } finally {
      this.#finish();
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.#inner.rollback();
    } finally {
      this.#finish();
    }
  }

  close(): void {
    try {
      this.#inner.close();
    } finally {
      this.#finish();
    }
  }

  get closed(): boolean {
    return this.#inner.closed;
  }

  /**
   * The one place a transaction ends.
   *
   * It runs once, whatever ended the transaction: a commit, a rollback
   * or a `close()`. It empties the scope — the exit — and gives the
   * queue slot back.
   */
  #finish(): void {
    if (this.#finished) return;

    this.#finished = true;
    this.#onFinish();
    this.#release();
  }
}

/**
 * A transaction nested inside another one.
 *
 * It is a savepoint on the parent's connection: the statements run on
 * the same connection, and a rollback undoes only what the nested block
 * wrote. The parent keeps the queue, which is the whole point — the
 * nested transaction must not wait for a slot the parent is holding.
 *
 * **It has no scope of its own.** The context still holds the parent's
 * scope, and the savepoint runs on the parent's connection, so the
 * nested block's writes belong to the parent either way.
 */
class SavepointTransaction implements Transaction {
  readonly #parent: Transaction;
  readonly #name: string;

  #finished = false;

  private constructor(parent: Transaction, name: string) {
    this.#parent = parent;
    this.#name = name;
  }

  /** Opens a savepoint on the parent's connection. */
  static async open(parent: Transaction): Promise<SavepointTransaction> {
    const name = `sp${savepointCounter++}`;

    await parent.execute({ sql: `savepoint ${name}` });

    return new SavepointTransaction(parent, name);
  }

  execute(stmt: InStatement): Promise<ResultSet> {
    return this.#parent.execute(stmt);
  }

  batch(stmts: Array<InStatement>): Promise<ResultSet[]> {
    return this.#parent.batch(stmts);
  }

  executeMultiple(sql: string): Promise<void> {
    return this.#parent.executeMultiple(sql);
  }

  async commit(): Promise<void> {
    if (this.#finished) return;

    this.#finished = true;

    await this.#parent.execute({ sql: `release savepoint ${this.#name}` });
  }

  async rollback(): Promise<void> {
    if (this.#finished) return;

    this.#finished = true;

    await this.#parent.execute({
      sql: `rollback to savepoint ${this.#name}`,
    });
  }

  close(): void {
    this.#finished = true;
  }

  get closed(): boolean {
    return this.#finished;
  }
}

/** The savepoints, numbered so that two of them cannot share a name. */
let savepointCounter = 0;
