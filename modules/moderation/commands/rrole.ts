/**
 * `/rrole` — take a role away from members.
 *
 * Quotient's `rrole` group, whose subcommands all remove the role.
 */

import { buildRoleCommand } from "./role-factory.js";

const rroleCommand = buildRoleCommand({
  name: "rrole",
  description: "Take a role away from members.",
  action: "remove",
  memberSubcommand: "remove",
  verb: "remove",
  inverseVerb: "add",
});

export default rroleCommand;
