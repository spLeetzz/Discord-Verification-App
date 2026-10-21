/**
 * Text normalisation.
 *
 * Quotient lowercased the OCR text and removed spaces and newlines before
 * comparing it with a channel name or a keyword:
 *
 *     text.lower().replace(" ", "").replace("\n", "")
 *
 * Every rule in Quotient's `SSVerify` that looks at the text used that
 * normalised form (`ImageResponse.lower_text`), so the providers return it in
 * `OcrResult.text` and no consumer has to remember to normalise.
 */

/**
 * Lowercases the text and removes the whitespace between words.
 *
 * Quotient removed a space and a newline. This also removes a carriage
 * return and a tab: a service that answers with CRLF line endings leaves a
 * stray `\r` in Quotient's text, which splits a word in half and makes a
 * keyword check fail for the wrong reason.
 */
export function normaliseText(raw: string): string {
  return raw.toLowerCase().replace(/[ \n\r\t]/g, "");
}
