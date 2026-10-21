/**
 * Where the checkout lives.
 *
 * The premium server and the Discord side have to agree on one public URL:
 * the server builds the payment form's `surl`/`furl` with it, and the
 * Discord side builds the link the buyer clicks with it. A single place
 * holds it, so the two cannot disagree.
 *
 * The URL is configuration, not code, so it is set when the server starts
 * and cleared when it stops.
 */

/** The public address of the premium server. */
export interface CheckoutConfig {
  /**
   * The base URL, without a trailing slash.
   *
   * It has to be the address the **buyer's browser** can reach — the
   * payment gateway redirects the browser to `surl`, and the webhook
   * posts to `/payu/webhook` from the gateway's servers.
   */
  readonly publicUrl: string;
}

let config: CheckoutConfig | null = null;

/**
 * Sets (or clears) the checkout configuration.
 */
export function setCheckoutConfig(next: CheckoutConfig | null): void {
  config = next ? { publicUrl: trimTrailingSlash(next.publicUrl) } : null;
}

/**
 * The current checkout configuration.
 */
export function getCheckoutConfig(): CheckoutConfig | null {
  return config;
}

/**
 * The URL of the payment page for a transaction.
 *
 * @throws Error when the checkout has not been configured. Callers that
 *         run before the server starts should check
 *         {@link getCheckoutConfig} first.
 */
export function buildCheckoutUrl(txnId: string): string {
  const current = config;

  if (!current) {
    throw new Error(
      "The premium checkout is not configured. Start the premium server with a public URL first.",
    );
  }

  return `${current.publicUrl}/getpremium?txnId=${encodeURIComponent(txnId)}`;
}

/**
 * The URL the gateway redirects to when a payment succeeds.
 */
export function buildSuccessUrl(txnId: string): string {
  return buildCallbackUrl("premium_success", txnId);
}

/**
 * The URL the gateway redirects to when a payment fails.
 */
export function buildFailureUrl(txnId: string): string {
  return buildCallbackUrl("premium_failed", txnId);
}

/**
 * The URL the gateway posts to, server to server.
 */
export function buildWebhookUrl(): string {
  const current = config;

  if (!current) {
    throw new Error(
      "The premium checkout is not configured. Start the premium server with a public URL first.",
    );
  }

  return `${current.publicUrl}/payu/webhook`;
}

function buildCallbackUrl(path: string, txnId: string): string {
  const current = config;

  if (!current) {
    throw new Error(
      "The premium checkout is not configured. Start the premium server with a public URL first.",
    );
  }

  return `${current.publicUrl}/${path}?txnId=${encodeURIComponent(txnId)}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
