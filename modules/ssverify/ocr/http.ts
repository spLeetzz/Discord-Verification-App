/**
 * The Quotient-compatible remote OCR provider.
 *
 * Quotient posted `[{"url": ...}]` to its OCR service with an
 * `authorization` header and read back an array of
 * `{url, dhash, phash, text}`. The service itself is not in Quotient's
 * repository, so it cannot be run — this adapter exists for the case where
 * somebody still has one, and it is only used when `OCR_PROVIDER_URL` is
 * configured.
 */

import { hashToHex, hexToHash } from "./hash.js";
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
        "The remote OCR provider needs a publicly reachable image URL, because the service fetches the image itself. Use the local provider for binary data.",
      );
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

  private async post(body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

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
 * Normalises a hash the service returned, and rejects one that is not a
 * 64-bit hash.
 */
function canonicalHash(value: string, field: string): string {
  try {
    return hashToHex(hexToHash(value));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The OCR service answered with an unusable ${field}: ${reason}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
