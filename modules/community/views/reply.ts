/**
 * The community area's reply helper.
 *
 * Every reply the area sends goes through here, and every reply carries
 * `allowedMentions: { parse: [] }`: **the bot does not let a message
 * notify anybody unless the reply says so explicitly.**
 *
 * The reason is the tag. A tag's body is stored verbatim and posted as
 * message *content*, so without this a member could create a tag whose
 * body is `@everyone` and then have the bot — which holds "Mention
 * Everyone" — ping the whole server. The member would be using a
 * permission they do not have, and the bot would be holding it for them.
 * `/tag raw` already escaped its body; `/tag show` did not, and the two
 * paths are the same data.
 *
 * Two things stop it, and the area uses both:
 *
 *  1. `allowedMentions: { parse: [] }` on the reply, so Discord is told
 *     not to parse any mention out of the content at all;
 *  2. `escapeMentions` on the user content itself, so the text that is
 *     posted cannot be a mention even if the first one is missing.
 *
 * A reply that *means* to mention somebody says so: `/tag transfer` names
 * the new owner, and `/autorole` names the role. Both pass the id
 * explicitly, and nothing else gets through.
 *
 * > **The default belongs in `core/context.ts`.** Every area that posts
 * > user content has this problem, not this one, so the belt-and-braces
 * > default is a core change: `allowedMentions: { parse: [] }` on the
 * > reply path, with `ReplyPayload` carrying an optional override. This
 * > helper is the area's own copy of that rule, so the area is safe
 * > whether or not the core default has landed.
 * >
 * > It works because `respond` spreads the payload into
 * > `interaction.reply()`, and discord.js sends `allowedMentions` as
 * > `allowed_mentions`. If the core default ever stops spreading the
 * > payload, this helper stops working with it — which is one more reason
 * > for the default to live in `core/`.
 */

import type { MessageMentionOptions, RepliableInteraction } from "discord.js";
import { respond } from "../../../core/context.js";
import type { ReplyHandle, ReplyPayload } from "../../../core/context.js";

/**
 * Who a reply is allowed to mention.
 *
 * An empty list means nobody. There is no "everybody" here on purpose:
 * the bot must never ping a whole server on a member's say-so.
 */
export interface AllowedMentions {
  /** The users the reply may mention, by id. */
  users?: readonly string[];
  /** The roles the reply may mention, by id. */
  roles?: readonly string[];
}

/**
 * A payload that says what may be mentioned.
 *
 * It extends the core payload rather than replacing it, so the reply
 * helper in `core/context.ts` still decides *how* the message is sent.
 */
export interface CommunityReplyPayload extends ReplyPayload {
  readonly allowedMentions: MessageMentionOptions;
}

/**
 * Sends a reply that cannot notify anybody.
 *
 * @param interaction the interaction to answer.
 * @param payload     the message. Its content is the caller's business;
 *                    the user content in it must be escaped.
 * @param mentions    who the reply may mention, if anybody.
 */
export async function respondSafe(
  interaction: RepliableInteraction,
  payload: ReplyPayload,
  mentions: AllowedMentions = {},
): Promise<ReplyHandle> {
  const allowedMentions: MessageMentionOptions = {
    // Nothing is parsed out of the content. A mention that is *meant* to
    // notify is listed by id below, and nothing else is.
    parse: [],
    ...(mentions.users && mentions.users.length > 0
      ? { users: [...mentions.users] }
      : {}),
    ...(mentions.roles && mentions.roles.length > 0
      ? { roles: [...mentions.roles] }
      : {}),
  };

  const safe: CommunityReplyPayload = { ...payload, allowedMentions };

  return respond(interaction, safe);
}
