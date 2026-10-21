/**
 * The tag-check rules.
 *
 * A tag-check channel is one where a captain registers his team by
 * mentioning his teammates. Quotient's listener checked two things and
 * then reacted:
 *
 * ```python
 * _react = True
 * if tagcheck.required_mentions and not all(map(lambda m: not m.bot, message.mentions)):
 *     _react = False
 *     await message.reply("Kindly mention your real teammate.", delete_after=5)
 *
 * if not len(message.mentions) >= tagcheck.required_mentions:
 *     _react = False
 *     await message.reply(f"You need to mention `...`.")
 * ```
 *
 * Two rules, in that order, and the first one that refuses wins — the same
 * shape as the screenshot-verification matrix, so both are tested the same
 * way.
 *
 * One thing changed: Quotient counted **every** mention, which in
 * discord.py includes role mentions. A role is not a teammate, so only
 * user mentions are counted here.
 */

/** A mention, as far as the rules care. */
export interface TagCheckMention {
  readonly id: string;
  readonly isBot: boolean;
}

/** What the rules are given. */
export interface TagCheckInput {
  /** How many teammates the captain has to mention. */
  readonly requiredMentions: number;
  /** The users the captain mentioned. */
  readonly mentions: readonly TagCheckMention[];
}

/**
 * One rule.
 *
 * @returns `null` when the message passes this rule, or the refusal
 *          message when it does not.
 */
export type TagCheckGuard = (input: TagCheckInput) => string | null;

/**
 * The name of a rule, for the logs and the tests.
 */
export interface NamedGuard {
  readonly id: string;
  readonly guard: TagCheckGuard;
}

/**
 * "Kindly mention your real teammate."
 *
 * Only fires when the channel actually asks for mentions: a channel with
 * `required_mentions = 0` accepts any message, bot mentions and all.
 */
export const rejectBotMentions: TagCheckGuard = (input) => {
  if (input.requiredMentions <= 0) return null;

  const everyMentionIsHuman = input.mentions.every(
    (mention) => !mention.isBot,
  );

  if (everyMentionIsHuman) return null;

  return "Kindly mention your real teammate.";
};

/**
 * "You need to mention `N teammate(s)`."
 */
export const requireEnoughMentions: TagCheckGuard = (input) => {
  if (input.requiredMentions <= 0) return null;

  if (input.mentions.length >= input.requiredMentions) return null;

  const noun = input.requiredMentions === 1 ? "teammate" : "teammates";

  return `You need to mention \`${input.requiredMentions} ${noun}\`.`;
};

/**
 * The rules of a tag-check channel, in the order they are checked.
 *
 * The bot-mention rule comes first, exactly as in Quotient: telling a
 * captain that they mentioned a bot is more useful than telling them they
 * mentioned too few people.
 */
export const TAG_CHECK_GUARDS: readonly NamedGuard[] = [
  { id: "bot_mentions", guard: rejectBotMentions },
  { id: "insufficient_mentions", guard: requireEnoughMentions },
];

/**
 * Checks a message against a tag-check channel.
 *
 * @returns `null` when the message is accepted, or the refusal message of
 *          the **first** rule that refused it.
 */
export function checkTagCheckMessage(input: TagCheckInput): string | null {
  for (const { guard } of TAG_CHECK_GUARDS) {
    const refusal = guard(input);

    if (refusal) return refusal;
  }

  return null;
}
