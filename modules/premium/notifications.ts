/**
 * The purchase notification.
 *
 * Quotient dispatched its purchase notification **before** the guild row
 * was written, so the confirmation DM could show a stale expiry or crash
 * on `None` (D37). Here the notification is a separate step that runs
 * **after** the rows are committed: the module writes, then the caller
 * tells.
 *
 * The server takes a notifier as a dependency rather than reaching for the
 * Discord client, so the payment path can be tested without a bot and
 * without Discord.
 */

/** What the buyer is told. */
export interface PurchaseNotification {
  /** Who bought it. */
  readonly userId: string;
  /** Which server it was bought for. */
  readonly guildId: string;
  /** The server's name, for the message. */
  readonly guildName: string;
  /** The plan's name, as it was when the purchase was made. */
  readonly planName: string;
  /** The amount that was paid, as a decimal string. */
  readonly amount: string;
  /** How long the subscription runs for, in whole days. */
  readonly durationDays: number;
  /** When the subscription runs out. */
  readonly expiresAt: Date;
}

/**
 * Tells somebody that a purchase went through.
 *
 * A notifier that throws must not undo the purchase: the rows are already
 * committed by the time this runs.
 */
export type PremiumNotifier = (notification: PurchaseNotification) => Promise<void>;
