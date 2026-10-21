/**
 * The `/tourney` command.
 *
 * The loader scans `commands/<folder>/*.ts` one level deep, and the
 * real definitions live in the module.
 */

export { tourneyCommand as default } from "../../modules/tourneys/commands/index.js";
