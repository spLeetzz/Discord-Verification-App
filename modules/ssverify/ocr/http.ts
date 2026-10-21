/**
 * The Quotient-compatible remote OCR provider.
 *
 * Quotient posted `[{"url": ...}]` to its OCR service with an
 * `authorization` header and read back an array of
 * `{url, dhash, phash, text}`. The service itself is not in Quotient's
 * repository, so it cannot be run — this adapter talks to one when a
 * deployment has one, and it is the **only** provider the bot has.
 *
 * There is no local engine behind it. The service does the OCR and the
 * hashing; this file posts the image and reads the answer back.
 *
 * ## The image has to be a URL
 *
 * The service fetches the image itself, so the image has to be publicly
 * reachable. A `Buffer` cannot be sent — there is nowhere for the service
 * to fetch it from — and a buffer is refused rather than silently sent as
 * something the service cannot read.
 *
 * ## A hash the service cannot be trusted with
 *
 * The answer is checked here rather than passed on: a hash that is not
 * sixteen hex characters is refused with an {@link UnusableHashError},
 * because a hash the duplicate check cannot compare is a hash that cannot
 * verify anything.
 */

import { UnusableHashError, hashToHex, hexToHash, isHashHex } from "./hash.js";
import { SerialQueue } from "./queue.js";
import { normaliseText } from "./text.js";
import type { OcrProvider, OcrResult } from "./index.js";

export interface HttpOcrProviderOptions {
  /** Base URL of the service, for example "https://example.com/ocr". */
  url: string;
  /** Sent in the `authorization` header, the way Quotient's service expects. */
  apiKey?: string;
  /** How long to wait for the service, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Replaces the global `fetch`. Used by the tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpOcrProvider implements OcrProvider {
  readonly name = "http";

  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private readonly queue = new SerialQueue();

  /** The requests that are on the wire right now. */
  private readonly inFlight = new Set<AbortController>();

  private disposed = false;

  constructor(options: HttpOcrProviderOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Sends one image to the remote service and reads the result back.
   *
   * The service fetches the image itself, so the image has to be a publicly
   * reachable URL. A `Buffer` cannot be sent: the service has nowhere to
   * fetch it from.
   */
  async analyze(image: Buffer | string): Promise<OcrResult> {
    if (typeof image !== "string") {
      throw new Error(
        "The OCR provider needs a publicly reachable image URL, because the service fetches the image itself. There is no local engine to hand binary data to.",
      );
    }

    if (this.disposed) {
      throw new Error("The OCR provider was shut down and cannot be used.");
    }

    return this.queue.run(async () => {
      const payload = await this.post([{ url: image }]);
      const entry = firstResult(payload);
      const rawText = entry.text;

      return {
        text: normaliseText(rawText),
        dhash: canonicalHash(entry.dhash, "dhash"),
        phash: canonicalHash(entry.phash, "phash"),
        rawText,
      };
    });
  }

  /**
   * Ends the HTTP client.
   *
   * The requests that are on the wire are aborted, so the provider holds
   * nothing once the bot is on its way out. The connection pool of the
   * global `fetch` is closed by the process itself.
   */
  async shutdown(): Promise<void> {
    this.disposed = true;

    for (const controller of this.inFlight) {
      controller.abort();
    }

    this.inFlight.clear();
  }

  private async post(body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    this.inFlight.add(controller);

    let response: Response;

    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: this.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The OCR service at ${this.url} could not be reached: ${reason}`);
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }

    if (!response.ok) {
      throw new Error(
        `The OCR service at ${this.url} answered with HTTP ${response.status}.`,
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The OCR service at ${this.url} did not answer with JSON: ${reason}`,
      );
    }
  }
}

interface OcrEntry {
  dhash: string;
  phash: string;
  text: string;
}

/**
 * Reads the first result out of the service's answer.
 *
 * The service answers with one entry per submitted image. The shape is
 * checked here rather than trusted, because a malformed answer that is
 * passed on would end up as a hash nobody can compare.
 */
function firstResult(payload: unknown): OcrEntry {
  if (!Array.isArray(payload)) {
    throw new Error(
      "The OCR service did not answer with an array of results.",
    );
  }

  const entry: unknown = payload[0];

  if (!isRecord(entry)) {
    throw new Error("The OCR service answered with an empty result.");
  }

  const { dhash, phash, text } = entry;

  if (typeof dhash !== "string" || typeof phash !== "string") {
    throw new Error("The OCR service answered without usable hashes.");
  }

  if (typeof text !== "string") {
    throw new Error("The OCR service answered without text.");
  }

  return { dhash, phash, text };
}

/**
 * Normalises a hash the service returned, and refuses one that is not a
 * 64-bit hash.
 *
 * The refusal is an {@link UnusableHashError} rather than a plain error, so
 * the caller can tell "the service sent a hash nobody can compare" from
 * "the service could not be reached". Both refuse the screenshot; the
 * second is worth a louder log.
 *
 * @throws UnusableHashError when the hash is not sixteen hex characters.
 */
function canonicalHash(value: string, field: string): string {
  if (!isHashHex(value)) {
    throw new UnusableHashError(
      value,
      `The OCR service answered with an unusable ${field}: "${value}" is not a 64-bit hash.`,
    );
  }

  return hashToHex(hexToHash(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
