/**
 * The service layer of the moderation area.
 *
 * One façade over the deep modules, so that a caller does not have to
 * know which file a function lives in. The functions themselves are the
 * ones in the modules — nothing is wrapped or renamed here.
 */

/* Purge */
export {
  BULK_DELETE_BATCH_SIZE,
  BULK_DELETE_MAX_AGE_MS,
  CONTAINS_MIN_LENGTH,
  CUSTOM_EMOJI_PATTERN,
  PURGE_SEARCH_LIMIT,
  chunkForBulkDelete,
  isTooOld,
  matchesFilter,
  partitionByAge,
  validateContains,
} from "./purge.js";
export { clampSearch, clearReactions, purgeMessages } from "./purge-service.js";

/* Reasons */
export {
  MAX_ACTION_REASON_LENGTH,
  actionReasonPrefix,
  defaultActionReason,
  formatActionReason,
  maxReasonLength,
} from "./reason.js";

/* Hierarchy */
export {
  ACTOR_HIERARCHY_REFUSAL,
  BOT_HIERARCHY_REFUSAL,
  checkActorHierarchy,
  checkBotHierarchy,
  outranks,
} from "./hierarchy.js";

/* Permissions */
export { planRestore, readOverwriteState } from "./permissions.js";

/* The lockdown state machine */
export {
  evaluateLock,
  evaluateUnlock,
  findCoveringLock,
  lockKey,
} from "./lock-state.js";

/* Lockdowns and maintenance */
export {
  channelsForCategory,
  channelsForMaintenance,
  channelsForServerLock,
  channelsToHideForMaintenance,
  channelsToLockForServer,
  hideCategory,
  isLockableChannel,
  lockChannel,
  lockServer,
  maintenanceOff,
  maintenanceOn,
  recordForPayload,
  releaseLock,
  unhideCategory,
  unlockChannel,
  unlockServer,
} from "./lockdown.js";
export type {
  LockApplyResult,
  LockContext,
  LockReleaseResult,
  LockableChannel,
} from "./lockdown.js";

/* The maintenance channels */
export {
  MAINTENANCE_CHANNEL_NAMES,
  createMaintenanceChannels,
  deleteMaintenanceChannels,
  findChannelsByName,
} from "./maintenance.js";

/* Roles */
export {
  applyRoleToMembers,
  assertCanManageRole,
  parseMentionIds,
  selectMembersForRole,
} from "./roles.js";
export type {
  RoleAction,
  RoleApplyRequest,
  RoleApplyResult,
  RoleScope,
} from "./roles.js";

/* Members */
export {
  assertTargetHierarchy,
  banTarget,
  checkTargetHierarchy,
  describeTarget,
  kickTarget,
  parseUserId,
  resolveMemberTarget,
  unbanTarget,
} from "./members.js";

/* Categories */
export {
  assertCanManageCategory,
  deleteCategory,
  nukeCategory,
} from "./category.js";

/* The block list */
export {
  BLOCK_ID_TYPE,
  blocklistKey,
  isBlocked,
  isBlockedSync,
} from "./blocklist.js";
export type { BlocklistEntry } from "./types.js";
