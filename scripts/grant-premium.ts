/**
 * Grants a guild unlimited premium.
 *
 * **Why this is a script and not a command.** A premium subscription is
 * bought through a payment provider, and the provider's callback is the
 * only thing that grants one. That is the right default: nobody should be
 * able to hand themselves premium by typing a slash command. But it also
 * means there is no supported way to give a server premium for free — and
 * a server owner who is running the bot themselves, on their own guild,
 * has no other way to get it.
 *
 * This is that way. It writes the same rows the paid path writes, through
 * the same code and the same transaction, so nothing downstream can tell
 * the difference:
 *
 *  - `guild_settings.premium_expires_at` is set to null, which is the
 *    tier-level expiry. Null means "never ends" — the same rule the
 *    entitlement rows use.
 *  - one `guild_entitlements` row per feature, enabled, with a null
 *    expiry.
 *
 * **The entitlements are the authority.** `premiumGuard` and
 * `countLimitGuard` both ask `isEntitled`, and a null expiry is an
 * entitlement that never lapses, so the gates lift and the free-tier
 * counts stop applying. The tier-level expiry is what the status command
 * displays.
 *
 * **It is idempotent.** Running it twice changes nothing the second time,
 * and it never shortens an entitlement that already runs longer than
 * "never" — there is no such thing, but the intent is that a rerun
 * cannot accidentally clear a real subscription.
 *
 * ```bash
 * npm run grant:premium -- --guild 1147472972467159040 --source owner
 * ```
 *
 * `--guild` defaults to `GUILD_ID`. `--source` is `owner` (handed out by
 * the guild's owner) or `manual` (an operator set it by hand).
 */

import { eq } from "drizzle-orm";
import { closeDatabase, withTransaction } from "../db/client.js";
import { guildSettings } from "../db/schema/system.js";
import { PremiumFeature } from "../core/constants.js";
import { ensureGuildSettings, upsertEntitlement } from "../modules/premium/repo.js";
import { requireEnv } from "../utils/env.js";

/** The two ways an entitlement can be granted without a purchase. */
const SOURCES = ["owner", "manual"] as const;
type Source = (typeof SOURCES)[number];

interface Options {
  readonly guildId: string;
  readonly source: Source;
}

function parseArgs(argv: readonly string[]): Options {
  let guildId = "";
  let source: Source = "owner";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--guild" || arg === "-g") {
      guildId = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--source" || arg === "-s") {
      const value = argv[index + 1] ?? "";
      if (!SOURCES.includes(value as Source)) {
        throw new Error(
          `--source must be one of ${SOURCES.join(", ")}, not "${value}".`,
        );
      }
      source = value as Source;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }

  if (!guildId) guildId = requireEnv("GUILD_ID");

  return { guildId, source };
}

/**
 * The guild's owner, so the grant records who it was for.
 *
 * A missing token or a guild the bot cannot see is not a reason to fail
 * the grant: the entitlement is the thing that matters, and
 * `made_premium_by` is an audit note. A null there is honest — it says
 * "nobody paid for this".
 */
async function guildOwnerId(guildId: string): Promise<string | null> {
  const token = process.env.BSSA_DISCORD_BOT_TOKEN;

  if (!token) return null;

  try {
    const response = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}`,
      { headers: { Authorization: `Bot ${token}` } },
    );

    if (!response.ok) return null;

    const body = (await response.json()) as { owner_id?: string };

    return body.owner_id ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { guildId, source } = parseArgs(process.argv.slice(2));

  console.log(`Granting unlimited premium to guild ${guildId} (${source}).`);

  const ownerId = await guildOwnerId(guildId);
  console.log(`   guild owner: ${ownerId ?? "unknown"}`);

  // One transaction: the tier row and the entitlement rows land together
  // or not at all, so a guild is never half-premium. `withTransaction` is
  // the app's own wrapper, so the write goes through the write queue like
  // every other write in the process.
  await withTransaction(async (tx) => {
    await ensureGuildSettings(guildId, tx);

    await tx
      .update(guildSettings)
      .set({ premiumExpiresAt: null, madePremiumBy: ownerId })
      .where(eq(guildSettings.guildId, guildId));

    for (const feature of Object.values(PremiumFeature)) {
      // The area's own writer, so the grant goes through the same path a
      // purchase takes. The upsert is keyed on (guild, feature), so
      // granting twice updates the one row rather than making a second.
      await upsertEntitlement(
        {
          guildId,
          feature,
          enabled: true,
          expiresAt: null,
          source,
        },
        tx,
      );
    }
  });

  console.log(`   granted ${Object.keys(PremiumFeature).length} features.`);
  console.log("   every one of them has no expiry, so none of them lapses.");

  await closeDatabase();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await closeDatabase();
  process.exit(1);
});
