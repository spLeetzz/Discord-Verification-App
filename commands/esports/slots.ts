/**
 * The `/slotmanager` command.
 *
 * The loader scans `commands/<folder>/*.ts` one level deep, and the
 * real definitions live in the module.
 */

export { slotManagerCommand as default } from "../../modules/slots/commands/index.js";
