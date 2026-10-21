/**
 * Discord errors carry a numeric `code` (10062 = Unknown Interaction,
 * 40060 = Already Acknowledged). `catch` gives us `unknown` under strict
 * mode, so these helpers keep the checks readable and type-safe.
 */
export function isDiscordErrorCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** True for the Discord interaction races we can safely ignore. */
export function isIgnorableInteractionError(error: unknown): boolean {
  return isDiscordErrorCode(error, 10062) || isDiscordErrorCode(error, 40060);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  // Not an Error. `String(error)` on a Map or a Collection is
  // "[object Map]", which says nothing at all — and a failure that says
  // nothing is a failure that costs an hour. So the shape is described
  // instead.
  if (error === null) return "null";
  if (error === undefined) return "undefined";

  if (typeof error === "object") {
    const named = error as { constructor?: { name?: string }; name?: string };
    const kind =
      named.constructor?.name ?? named.name ?? Object.prototype.toString.call(error);

    const keys = Object.keys(error).slice(0, 6);

    return `${kind} (${keys.length > 0 ? `keys: ${keys.join(", ")}` : "no keys"})`;
  }

  return String(error);
}

/**
 * A refusal that should be shown to staff as-is, rather than being reported
 * as a crash.
 */
export class DenialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DenialError";
  }
}
