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
 */
export const transactionContext = new AsyncLocalStorage<
  Transaction | undefined
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
   * The transaction that holds the queue, if there is one.
   *
   * There is never more than one: a transaction holds the queue from
   * the moment it is opened until it is committed or rolled back.
   */
  #active: Transaction | undefined;

  constructor(inner: Client, queue: WriteQueue) {
    this.#inner = inner;
    this.#queue = queue;
  }

  /** The open transaction, if there is one. */
  get activeTransaction(): Transaction | undefined {
    return this.#active;
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
    const open = transactionContext.getStore();

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
    const open = transactionContext.getStore();

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
    const open = transactionContext.getStore();

    // A transaction inside a transaction. It cannot take the queue —
    // the queue is held by the transaction it is nested in — so it
    // becomes a savepoint on the same connection.
    if (open && !open.closed) return SavepointTransaction.open(open);

    const release = await this.#queue.acquire();

    let inner: Transaction;

    try {
      inner = await this.#inner.transaction(mode);
    } catch (error) {
      release();
      throw error;
    }

    const queued = new QueuedTransaction(inner, release, () => {
      this.#active = undefined;
    });

    this.#active = queued;

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
