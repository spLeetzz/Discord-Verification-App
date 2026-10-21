/**
 * The pages the premium server renders.
 *
 * Quotient used a Jinja template (`src/server/templates/payu.html`) for
 * exactly one form. A template engine is a lot of machinery for one
 * static form, so the form is a template literal here and the escaping is
 * done by hand.
 *
 * The form **submits itself on load**: the buyer clicks one link in
 * Discord, lands on our page, and the page posts the payment details to
 * the gateway. That is what Quotient's template did, and it is one click
 * fewer for the buyer.
 */

/** Escapes text for an HTML attribute or a text node. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The fields the payment form posts to the gateway. */
export interface PayuFormFields {
  /** The gateway's form endpoint. */
  readonly action: string;
  /** The merchant key. */
  readonly key: string;
  /** The transaction id we issued. */
  readonly txnid: string;
  /** The amount, as a decimal string. */
  readonly amount: string;
  /** The product description. */
  readonly productinfo: string;
  /** The buyer's name. */
  readonly firstname: string;
  /** The buyer's email. */
  readonly email: string;
  /** The buyer's phone number. */
  readonly phone: string;
  /** Where the gateway sends the buyer when the payment succeeds. */
  readonly surl: string;
  /** Where the gateway sends the buyer when the payment fails. */
  readonly furl: string;
  /** The request hash. */
  readonly hash: string;
}

/**
 * The self-submitting payment form.
 */
export function renderPayuForm(fields: PayuFormFields): string {
  const hidden = (
    name: string,
    value: string,
  ): string =>
    `      <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Premium checkout</title>
  </head>
  <body>
    <p>Redirecting you to the payment gateway…</p>
    <form id="payu" method="post" action="${escapeHtml(fields.action)}">
${hidden("key", fields.key)}
${hidden("txnid", fields.txnid)}
${hidden("amount", fields.amount)}
${hidden("productinfo", fields.productinfo)}
${hidden("firstname", fields.firstname)}
${hidden("email", fields.email)}
${hidden("phone", fields.phone)}
${hidden("surl", fields.surl)}
${hidden("furl", fields.furl)}
${hidden("hash", fields.hash)}
      <noscript>
        <button type="submit">Continue to payment</button>
      </noscript>
    </form>
    <script>
      document.getElementById("payu").submit();
    </script>
  </body>
</html>
`;
}

/** How a page reads. */
export type PageTone = "success" | "error" | "info";

const TONE_COLOURS: Record<PageTone, string> = {
  success: "#00b894",
  error: "#d63031",
  info: "#0984e3",
};

/**
 * A plain page saying what happened.
 *
 * The browser routes answer with this rather than JSON: the buyer is
 * looking at it, and "your payment went through, go back to Discord" is
 * more use to them than `{"success": true}`.
 */
export function renderMessagePage(
  title: string,
  body: string,
  tone: PageTone = "info",
): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem 1rem;">
    <h1 style="color: ${TONE_COLOURS[tone]};">${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
  </body>
</html>
`;
}
