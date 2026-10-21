/**
 * The tag storage rules, against the live database.
 *
 * The source's converter lower-cased the name for the reserved-word
 * check and returned the **original** casing, and the lookup was an exact
 * match. So `/tag Rules` and `/tag rules` were two different tags, while
 * the reserved-word check treated them as the same word.
 *
 * The port stores the **canonical** name — trimmed and lower-cased — so
 * the database's `UNIQUE (guild_id, name)` constraint *is* the
 * case-insensitive constraint, and the lookup is case-insensitive with
 * it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, db } from "../../db/client.js";
import { tags } from "../../db/schema.js";
import * as service from "./service.js";

/** A guild id no real row can have, unique to this test run. */
const GUILD_ID = `community-tag-test-${Date.now()}`;

/** The member who owns the tags. */
const OWNER = "555555555555555555";

/** Another member. */
const OTHER = "666666666666666666";

/**
 * Is the database there?
 *
 * The test is skipped rather than failed when it is not, so the unit
 * tests still run on a machine without Postgres.
 */
async function databaseIsReachable(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);

    return true;
  } catch {
    return false;
  }
}

const reachable = await databaseIsReachable();

beforeAll(async () => {
  if (!reachable) return;

  await db.delete(tags).where(eq(tags.guildId, GUILD_ID));
});

afterAll(async () => {
  if (reachable) {
    await db.delete(tags).where(eq(tags.guildId, GUILD_ID));
  }

  await closeDatabase();
});

describe.skipIf(!reachable)("the tag storage", () => {
  it("stores the canonical name", async () => {
    const tag = await service.createTag({
      guildId: GUILD_ID,
      name: "  Server Rules ",
      content: "Be nice.",
      isEmbed: false,
      ownerId: OWNER,
    });

    expect(tag.name).toBe("server rules");
  });

  it("finds a tag whatever case it is asked for", async () => {
    for (const name of ["server rules", "Server Rules", "SERVER RULES"]) {
      const found = await service.findTag(GUILD_ID, name);

      expect(found?.name, name).toBe("server rules");
    }
  });

  it("finds a tag by its id, as the source's converter did", async () => {
    const tag = await service.findTag(GUILD_ID, "server rules");

    expect(tag).not.toBeNull();

    const byId = await service.findTag(GUILD_ID, tag?.id ?? "");

    expect(byId?.id).toBe(tag?.id);
  });

  it("refuses a second tag whose name differs only in case", async () => {
    // The unique constraint is on the canonical name, so the second
    // insert is refused by the database rather than by a read-then-write.
    await expect(
      service.createTag({
        guildId: GUILD_ID,
        name: "server rules",
        content: "Something else.",
        isEmbed: false,
        ownerId: OTHER,
      }),
    ).rejects.toThrow(/already taken/i);
  });

  it("refuses a name that starts with a reserved word", async () => {
    await expect(
      service.createTag({
        guildId: GUILD_ID,
        name: "raw stuff",
        content: "Something.",
        isEmbed: false,
        ownerId: OWNER,
      }),
    ).rejects.toThrow(/reserved/i);
  });

  it("counts a use on the canonical row", async () => {
    const before = await service.findTag(GUILD_ID, "server rules");

    await service.countTagUse(GUILD_ID, "Server Rules");

    const after = await service.findTag(GUILD_ID, "server rules");

    expect(after?.usage).toBe((before?.usage ?? 0) + 1);
  });

  it("refuses an edit from somebody who does not own the tag", async () => {
    await expect(
      service.editTag({
        guildId: GUILD_ID,
        name: "server rules",
        content: "Hacked.",
        isEmbed: false,
        callerId: OTHER,
        canManage: false,
      }),
    ).rejects.toThrow(/does not belong to you/i);
  });

  it("lets an edit through for somebody who does own the tag", async () => {
    const tag = await service.editTag({
      guildId: GUILD_ID,
      name: "server rules",
      content: "Be nice, please.",
      isEmbed: false,
      callerId: OWNER,
      canManage: false,
    });

    expect(tag.content).toBe("Be nice, please.");
  });

  it("deletes the tags of a member", async () => {
    await service.createTag({
      guildId: GUILD_ID,
      name: "temporary",
      content: "Something.",
      isEmbed: false,
      ownerId: OTHER,
    });

    const deleted = await service.purgeTagsOfOwner(GUILD_ID, OTHER);

    expect(deleted).toBe(1);
    expect(await service.findTag(GUILD_ID, "temporary")).toBeNull();
  });
});
