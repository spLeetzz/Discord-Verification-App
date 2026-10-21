/**
 * The form body parser.
 *
 * PayU posts `application/x-www-form-urlencoded`, and Fastify has no
 * parser for it out of the box — the usual answer is the
 * `@fastify/formbody` plugin, which is **not installed in this
 * repository** and cannot be added without a `npm install` the port does
 * not run.
 *
 * So the parser is here: twenty lines, one content type, and no
 * dependency. When the manager installs `@fastify/formbody`, this file
 * and its one call site can be deleted — the plugin registers the same
 * content type and the parser below is skipped because
 * `hasContentTypeParser` says it is already there.
 *
 * The parser is registered on the **root** instance, not inside a plugin:
 * Fastify encapsulates content type parsers added inside a plugin, and a
 * parser the routes cannot see is a parser that does not exist.
 */

import type { FastifyInstance } from "fastify";

/** The content type PayU posts. */
export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * Registers the form body parser on an instance.
 *
 * Safe to call twice: the second call does nothing.
 */
export function registerFormBodyParser(app: FastifyInstance): void {
  if (app.hasContentTypeParser(FORM_CONTENT_TYPE)) return;

  app.addContentTypeParser(
    FORM_CONTENT_TYPE,
    { parseAs: "string" },
    (_request, body, done) => {
      const raw = typeof body === "string" ? body : String(body);

      try {
        done(null, raw === "" ? {} : Object.fromEntries(new URLSearchParams(raw)));
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)), undefined);
      }
    },
  );
}
