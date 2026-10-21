/**
 * The fixtures of this area's tests.
 *
 * **SQLite has one writer, and the client sets no busy timeout.** Two
 * writes that overlap — this test file and another one, or this test
 * file and another process — make the second one fail with
 * `SQLITE_BUSY` instead of waiting for the first to finish. The
 * fixtures here wait it out.
 *
 * The central fix is a busy timeout on the client: `createClient` takes
 * a `timeout` in milliseconds and applies it to every connection it
 * opens, including the ones a transaction borrows. That is a line in
 * `db/client.ts`, and until it is there, every area's tests are at the
 * mercy of whatever else is writing to the same file.
 *
 * Only the fixtures use this. The production writes go through
 * `repo.withWriteTransaction`, which does the same waiting.
 */

/** How many times a fixture write is tried again. */
const RETRIES = 8;

/** The pause before each retry, in milliseconds. */
const BACKOFF_MS = [2, 5, 10, 20, 40, 80, 120, 200] as const;

/**
 * Is this the "the database is locked" error?
 */
function isDatabaseLocked(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const message = (error as { readonly message?: unknown }).message;

  if (typeof message !== "string") return false;

  return (
    message.includes("SQLITE_BUSY") || message.includes("database is locked")
  );
}

/**
 * Runs a write, waiting out a locked database.
 *
 * The write is tried again only when SQLite says the file is busy;
 * every other failure is the failure it looks like.
 */
export async function withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isDatabaseLocked(error)) throw error;
      if (attempt >= RETRIES) throw error;

      const wait = BACKOFF_MS[attempt] ?? 200;

      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
