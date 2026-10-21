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
  return error instanceof Error ? error.message : String(error);
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
