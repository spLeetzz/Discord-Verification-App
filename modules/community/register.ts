/**
 * The public interface of the community area.
 *
 * The manager wires three things:
 *
 * ```ts
 * // the job dispatcher
 * await handleCommunityJob(client, event, payload);
 *
 * // the router
 * registerCommunityInteractions();
 *
 * // the listeners
 * registerCommunityListeners(client);
 * ```
 *
 * and one thing it calls after every command:
 *
 * ```ts
 * await recordCommandUsage({ guildId, channelId, userId, cmd, prefix, failed });
 * ```
 *
 * Nothing here touches a file another area owns.
 */

import { logger } from "../../utils/logger.js";

export {
  COMMUNITY_JOB_EVENTS,
  ensureDailyJob,
  handleCommunityJob,
  handleCommunityJobEvent,
  handleRetentionJob,
  rearmDailyJob,
} from "./jobs.js";
export type { CommunityJobEvent } from "./jobs.js";

export { registerCommunityListeners } from "./listeners.js";

export { recordCommandUsage } from "./service.js";

export { autoPurgeChannels } from "./cache.js";

export {
  checkAutoPurgeAdmission,
  checkMemberQuota,
  isReservedTagName,
  normaliseTagName,
  splitTimedText,
  validateTagName,
  MAX_REMINDERS_PER_MEMBER,
  MAX_TAGS_PER_MEMBER,
  RESERVED_TAG_WORDS,
  TAG_CONTENT_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
} from "./rules.js";

export type {
  AutoPurgeAdmission,
  AutoPurgeRefusal,
  QuotaAdmission,
  QuotaRefusal,
  QuotaSubject,
  TagNameRejection,
  TagNameValidation,
  TimedText,
} from "./rules.js";

/**
 * Registers the community's component ids.
 *
 * The area has none of its own: the paginator and the confirm prompt
 * register theirs when they are built, and the tags, the snipe and the
 * reminders are all commands.
 *
 * The function exists so the manager has one stable wiring point for the
 * area, and so there is a place to register the first id that does need
 * one.
 */
export function registerCommunityInteractions(): void {
  logger.info(
    "[Community] No component ids of its own to register: the paginator and the prompt register theirs.",
  );
}
