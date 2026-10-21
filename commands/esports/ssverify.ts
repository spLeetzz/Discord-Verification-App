/**
 * The `/ssverify` command.
 *
 * The loader scans `commands/<folder>/*.ts` one level deep, and the real
 * definitions live in the module.
 */

export { ssVerifyCommand as default } from "../../modules/identity/commands/index.js";
