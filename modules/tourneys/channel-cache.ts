/**
 * The channel caches of the tournaments area.
 *
 * Two sets of channel ids:
 *
 *  - the **registration channels** — the channels a tournament accepts
 *    registrations in;
 *  - the **media-partner channels** — the channels, in *other* guilds,
 *    a tournament accepts registrations through.
 *
 * They are rebuilt at startup and refreshed when a tournament opens,
 * pauses or closes, and when a media partner is added or removed.
 *
 * The point is that the registration listener must **not** hit the
 * database for every message it sees: a busy server sends thousands of
 * messages an hour, and only a handful are registrations.
 *
 * D21 puts the shared version of this in `core/channel-cache.ts`, and it
 * has landed: this file is the area's two **instances** of it. One
 * instance per set — a scrim registration channel and a tourney
 * registration channel are different things, and a shared set would let
 * one area evict the other area's channels.
 */

import { ChannelIdCache } from "../../core/channel-cache.js";

/** The registration channels of the tournaments area. */
export const tourneyChannelCache = new ChannelIdCache();

/** The media-partner channels of the tournaments area. */
export const mediaPartnerChannelCache = new ChannelIdCache();
