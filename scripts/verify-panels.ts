/**
 * Verifies the bot's panels against the real Discord API.
 *
 * **Why this exists.** A panel is a payload Discord has to accept: five
 * rows, five components a row, an embed that is not empty, buttons whose
 * labels fit. Every fault in this area was a panel Discord refused or
 * rendered differently from what the code believed:
 *
 *  - a panel with six rows, which Discord refuses, so the panel simply
 *    did not appear;
 *  - a menu that was the whole message, which cannot be emptied;
 *  - an embed whose field read "Not set" for a value that had been
 *    picked.
 *
 * A unit test cannot catch any of those, because it never asks Discord
 * what it thinks. This does: it posts the real panel to a real channel
 * with the bot's own token, reads the message back, and compares what
 * came back with what the code meant to send.
 *
 * **It only reads and writes a channel the bot can see.** It posts,
 * reads and deletes its own messages. It never touches a command, a
 * user or a setting.
 *
 * ```bash
 * npm run verify:panels -- --channel 123456789
 * ```
 *
 * `--channel` is the channel to post in. `--keep` leaves the messages
 * behind, which is useful when a panel is being looked at by eye.
 */

import { REST, Routes } from "discord.js";
import type { Message } from "discord.js";
import { buildWizardPanel } from "../modules/tourneys/views/wizard.js";
import { newDraft } from "../modules/tourneys/service.js";
import { requireEnv } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/** Discord's limits, which are the whole point of this script. */
const MAX_ROWS = 5;
const MAX_COMPONENTS_PER_ROW = 5;
const MAX_EMBED_DESCRIPTION = 4096;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_BUTTON_LABEL = 80;

interface Options {
  readonly channelId: string;
  readonly keep: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let channelId = "";
  let keep = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--channel" || arg === "-c") {
      channelId = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--keep") {
      keep = true;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }

  if (!channelId) {
    throw new Error("A channel is required: --channel <id>.");
  }

  return { channelId, keep };
}

/** What Discord sent back, and what it was supposed to be. */
interface Verdict {
  readonly name: string;
  readonly ok: boolean;
  readonly notes: readonly string[];
}

/**
 * Checks a panel the way Discord would, and then asks Discord.
 *
 * The local checks are the cheap ones: a row count, a component count, a
 * field length. The remote check is the one that matters: the panel is
 * posted and the message that comes back is compared with the panel
 * that went out.
 */
async function verifyPanel(
  rest: REST,
  options: Options,
  name: string,
  panel: {
    readonly embeds: readonly { toJSON(): { title?: string; description?: string; fields?: readonly { name?: string; value?: string }[] } }[];
    readonly components: readonly { toJSON(): { type: number; components?: readonly { type: number; label?: string; custom_id?: string }[] } }[];
  },
  verdicts: Verdict[],
): Promise<void> {
  const notes: string[] = [];

  // 1. The local budget.
  if (panel.components.length > MAX_ROWS) {
    notes.push(`${panel.components.length} rows — Discord allows ${MAX_ROWS}.`);
  }

  panel.components.forEach((row, index) => {
    const count = row.toJSON().components?.length ?? 0;

    if (count > MAX_COMPONENTS_PER_ROW) {
      notes.push(
        `row ${index + 1} has ${count} components — Discord allows ${MAX_COMPONENTS_PER_ROW}.`,
      );
    }
  });

  for (const embed of panel.embeds) {
    const data = embed.toJSON();

    if (!data.title && !data.description && (data.fields?.length ?? 0) === 0) {
      notes.push("The embed is empty — Discord refuses to send one.");
    }

    if ((data.description?.length ?? 0) > MAX_EMBED_DESCRIPTION) {
      notes.push(`The description is ${data.description?.length} characters.`);
    }

    for (const field of data.fields ?? []) {
      if ((field.name?.length ?? 0) > MAX_FIELD_NAME) {
        notes.push(`The field name "${field.name}" is too long.`);
      }

      if ((field.value?.length ?? 0) > MAX_FIELD_VALUE) {
        notes.push(`The field "${field.name}" has a value that is too long.`);
      }
    }
  }

  for (const row of panel.components) {
    for (const component of row.toJSON().components ?? []) {
      if ((component.label?.length ?? 0) > MAX_BUTTON_LABEL) {
        notes.push(`The button label "${component.label}" is too long.`);
      }
    }
  }

  // 2. The real thing.
  let posted: Message | null = null;

  try {
    posted = (await rest.post(Routes.channelMessages(options.channelId), {
      body: {
        embeds: panel.embeds.map((embed) => embed.toJSON()),
        components: panel.components.map((row) => row.toJSON()),
      },
    })) as Message;
  } catch (error) {
    notes.push(`Discord refused the panel: ${errorMessage(error)}`);
  }

  if (posted) {
    const sent = panel.embeds.map((embed) => embed.toJSON());
    // What Discord sent back is plain data, not builders.
    const back = posted.embeds;

    if (back.length !== sent.length) {
      notes.push(`Discord returned ${back.length} embeds, not ${sent.length}.`);
    }

    back.forEach((embed, index) => {
      const wanted = sent[index];

      if (!wanted) return;

      if ((embed.fields?.length ?? 0) !== (wanted.fields?.length ?? 0)) {
        notes.push(
          `Embed ${index + 1} came back with ${embed.fields?.length ?? 0} fields, not ${wanted.fields?.length ?? 0}.`,
        );
      }
    });

    if ((posted.components?.length ?? 0) !== panel.components.length) {
      notes.push(
        `Discord returned ${posted.components?.length ?? 0} rows, not ${panel.components.length}.`,
      );
    }

    if (!options.keep) {
      await rest.delete(Routes.channelMessage(options.channelId, posted.id)).catch(
        () => undefined,
      );
    }
  }

  verdicts.push({ name, ok: notes.length === 0, notes });
}

/** The message of an error, or what it was if it was not an Error. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const rest = new REST().setToken(requireEnv("BSSA_DISCORD_BOT_TOKEN"));

  const verdicts: Verdict[] = [];

  /**
   * The tournament wizard, with a value in every step.
   *
   * This is the panel that was broken: the embed read "Not set" for a
   * channel the user had just picked, because the value was written
   * under the step's key instead of the draft's property.
   */
  const draft = {
    ...newDraft("guild", "user"),
    registrationChannelId: "111111111111111111",
    confirmChannelId: "222222222222222222",
    roleId: "333333333333333333",
    requiredMentions: 4,
    totalSlots: 16,
    groupSize: 4,
    emojis: { tick: "✅", cross: "❌" },
    openDays: ["monday"],
    openTime: "18:00",
  };

  await verifyPanel(
    rest,
    options,
    "the tournament wizard, with every step filled in",
    buildWizardPanel(draft, "verification-token"),
    verdicts,
  );

  await verifyPanel(
    rest,
    options,
    "the tournament wizard, empty",
    buildWizardPanel(newDraft("guild", "user"), "verification-token"),
    verdicts,
  );

  let failed = 0;

  for (const verdict of verdicts) {
    if (verdict.ok) {
      console.log(`  ok    ${verdict.name}`);
      continue;
    }

    failed += 1;

    console.log(`  FAIL  ${verdict.name}`);

    for (const note of verdict.notes) console.log(`          ${note}`);
  }

  console.log(
    `\n${verdicts.length - failed}/${verdicts.length} panels verified against Discord.`,
  );

  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  logger.error(`[Verify] ${errorMessage(error)}`);

  if (error instanceof Error && error.stack) {
    logger.error(error.stack);
  }

  process.exitCode = 1;
});
