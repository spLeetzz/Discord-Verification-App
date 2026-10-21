/**
 * `/role` — give a role to members.
 */

import { buildRoleCommand } from "./role-factory.js";

const roleCommand = buildRoleCommand({
  name: "role",
  description: "Give a role to members.",
  action: "add",
  memberSubcommand: "add",
  verb: "add",
  inverseVerb: "remove",
});

export default roleCommand;
