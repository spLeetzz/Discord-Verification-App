/**
 * The `/easytag` command.
 *
 * The loader scans `commands/<folder>/*.ts` one level deep, and the real
 * definitions live in the module.
 */

export { easyTagCommand as default } from "../../modules/identity/commands/index.js";
