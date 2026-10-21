/**
 * The Discord side of the purchase flow.
 *
 * The components are the part that can be checked without a Discord
 * connection: the custom ids have to be namespaced and carry the token
 * they refer to (D18), and a wizard that forgets who started it is a
 * wizard somebody else can finish.
 */

import { describe, expect, it } from "vitest";
import { parseCustomId } from "../../core/custom-id.js";
import {
  buildEmailModal,
  buildPlanSelect,
  generateTransactionId,
  normaliseEmail,
  PREMIUM_EMAIL_ACTION,
  PREMIUM_EMAIL_CUSTOM_ID,
  PREMIUM_PLAN_ACTION,
} from "./views.js";

const PLAN = {
  id: "11111111-1111-1111-1111-111111111111",
  code: "trial",
  name: "Trial (7d)",
  description: "Duration: 7 days",
  price: 29,
  durationDays: 7,
};

describe("modules/premium/views — the components", () => {
  it("namespaces the plan select and carries the token", () => {
    const token = "abcdefghijklmnop";
    const row = buildPlanSelect(token, [PLAN]);
    const [select] = row.toJSON().components;

    const customId =
      typeof select === "object" && select !== null && "custom_id" in select
        ? String((select as { custom_id: unknown }).custom_id)
        : "";

    const parsed = parseCustomId(customId);

    expect(parsed?.type).toBe("premium");
    expect(parsed?.action).toBe(PREMIUM_PLAN_ACTION);
    expect(parsed?.payload).toBe(token);
  });

  it("offers one option per plan", () => {
    const row = buildPlanSelect("token", [PLAN, { ...PLAN, id: "other" }]);
    const [select] = row.toJSON().components;

    const options =
      typeof select === "object" && select !== null && "options" in select
        ? ((select as { options?: unknown[] }).options ?? [])
        : [];

    expect(options).toHaveLength(2);
  });

  it("namespaces the email modal and carries the token", () => {
    const token = "abcdefghijklmnop";
    const modal = buildEmailModal(token, PLAN);
    const parsed = parseCustomId(modal.data.custom_id ?? "");

    expect(parsed?.type).toBe("premium");
    expect(parsed?.action).toBe(PREMIUM_EMAIL_ACTION);
    expect(parsed?.payload).toBe(token);
  });

  it("uses a stable custom id for the modal's shape", () => {
    expect(PREMIUM_EMAIL_CUSTOM_ID).toBe("premium:email");
  });
});

describe("modules/premium/views — the small helpers", () => {
  it("generates a transaction id nobody can guess", () => {
    const first = generateTransactionId();
    const second = generateTransactionId();

    expect(first).toMatch(/^QP_[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });

  it("accepts a real email address and refuses the rest", () => {
    expect(normaliseEmail(" Buyer@Example.COM ")).toBe("buyer@example.com");
    expect(normaliseEmail("not an email")).toBeNull();
    expect(normaliseEmail("buyer@example")).toBeNull();
    expect(normaliseEmail("")).toBeNull();
  });
});
