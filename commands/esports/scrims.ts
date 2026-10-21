/**
 * The `/scrims` command.
 *
 * The loader scans `commands/<folder>/*.ts` one level deep, and the
 * real definitions live in the module.
 */

export { scrimsCommand as default } from "../../modules/scrims/commands/index.js";
