CREATE TABLE `ban_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ban_logs_guild_id_unique` ON `ban_logs` (`guild_id`);--> statement-breakpoint
CREATE TABLE `banned_team_members` (
	`id` text PRIMARY KEY NOT NULL,
	`banned_team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`banned_team_id`) REFERENCES `banned_teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `banned_team_members_banned_team_id_user_id_unique` ON `banned_team_members` (`banned_team_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `banned_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`scrim_id` text NOT NULL,
	`num` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	`team_name` text,
	`reason` text,
	`expires` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scrim_id`) REFERENCES `scrims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `banned_teams_scrim_id_idx` ON `banned_teams` (`scrim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `banned_teams_scrim_id_user_id_unique` ON `banned_teams` (`scrim_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `media_partner_slot_members` (
	`id` text PRIMARY KEY NOT NULL,
	`media_partner_slot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`media_partner_slot_id`) REFERENCES `media_partner_slots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_partner_slot_members_media_partner_slot_id_user_id_unique` ON `media_partner_slot_members` (`media_partner_slot_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `media_partner_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`media_partner_id` text NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`jump_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`media_partner_id`) REFERENCES `media_partners`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_partner_slots_media_partner_id_idx` ON `media_partner_slots` (`media_partner_id`);--> statement-breakpoint
CREATE TABLE `media_partners` (
	`id` text PRIMARY KEY NOT NULL,
	`tourney_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tourney_id`) REFERENCES `tourneys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_partners_tourney_id_idx` ON `media_partners` (`tourney_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_partners_channel_id_unique` ON `media_partners` (`channel_id`);--> statement-breakpoint
CREATE TABLE `reserved_slot_members` (
	`id` text PRIMARY KEY NOT NULL,
	`reserved_slot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`reserved_slot_id`) REFERENCES `reserved_slots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reserved_slot_members_reserved_slot_id_user_id_unique` ON `reserved_slot_members` (`reserved_slot_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `reserved_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`scrim_id` text NOT NULL,
	`num` integer NOT NULL,
	`user_id` text,
	`team_name` text,
	`expires` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scrim_id`) REFERENCES `scrims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reserved_slots_scrim_id_idx` ON `reserved_slots` (`scrim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reserved_slots_scrim_id_num_unique` ON `reserved_slots` (`scrim_id`,`num`);--> statement-breakpoint
CREATE TABLE `scrim_autoclean` (
	`id` text PRIMARY KEY NOT NULL,
	`scrim_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scrim_id`) REFERENCES `scrims`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scrim_autoclean_kind_check" CHECK("scrim_autoclean"."kind" in ('channel', 'role'))
);
--> statement-breakpoint
CREATE INDEX `scrim_autoclean_scrim_id_idx` ON `scrim_autoclean` (`scrim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scrim_autoclean_scrim_id_kind_unique` ON `scrim_autoclean` (`scrim_id`,`kind`);--> statement-breakpoint
CREATE TABLE `scrim_open_days` (
	`id` text PRIMARY KEY NOT NULL,
	`scrim_id` text NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scrim_id`) REFERENCES `scrims`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scrim_open_days_day_check" CHECK("scrim_open_days"."day" in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'))
);
--> statement-breakpoint
CREATE INDEX `scrim_open_days_scrim_id_idx` ON `scrim_open_days` (`scrim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scrim_open_days_scrim_id_day_unique` ON `scrim_open_days` (`scrim_id`,`day`);--> statement-breakpoint
CREATE TABLE `scrims` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`name` text DEFAULT 'Quotient-Scrims' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`registration_channel_id` text NOT NULL,
	`slotlist_channel_id` text NOT NULL,
	`slotlist_message_id` text,
	`role_id` text,
	`open_role_id` text,
	`ping_role_id` text,
	`host_id` text NOT NULL,
	`required_mentions` integer DEFAULT 4 NOT NULL,
	`required_lines` integer DEFAULT 0 NOT NULL,
	`start_from` integer DEFAULT 1 NOT NULL,
	`total_slots` integer NOT NULL,
	`open_time` integer NOT NULL,
	`opened_at` integer,
	`closed_at` integer,
	`match_time` integer,
	`autoclean_time` integer,
	`autoslotlist` integer DEFAULT true NOT NULL,
	`multiregister` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`autodelete_rejects` integer DEFAULT false NOT NULL,
	`autodelete_extras` integer DEFAULT true NOT NULL,
	`teamname_compulsion` integer DEFAULT false NOT NULL,
	`no_duplicate_name` integer DEFAULT false NOT NULL,
	`allow_duplicate_tags` integer DEFAULT true NOT NULL,
	`time_elapsed_seconds` integer,
	`slotlist_format` text DEFAULT '{}',
	`open_message` text DEFAULT '{}',
	`close_message` text DEFAULT '{}',
	`emojis` text DEFAULT '{}',
	`cdn` text DEFAULT '{"status":false,"countdown":3,"msg":{}}',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "scrims_status_check" CHECK("scrims"."status" in ('draft', 'open', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `scrims_guild_id_idx` ON `scrims` (`guild_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scrims_registration_channel_id_unique` ON `scrims` (`registration_channel_id`);--> statement-breakpoint
CREATE TABLE `slot_manager_scrims` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_manager_id` text NOT NULL,
	`scrim_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`slot_manager_id`) REFERENCES `slot_managers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scrim_id`) REFERENCES `scrims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slot_manager_scrims_slot_manager_id_scrim_id_unique` ON `slot_manager_scrims` (`slot_manager_id`,`scrim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slot_manager_scrims_scrim_id_unique` ON `slot_manager_scrims` (`scrim_id`);--> statement-breakpoint
CREATE TABLE `slot_managers` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`main_channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`toggle` integer DEFAULT true NOT NULL,
	`allow_reminders` integer DEFAULT true NOT NULL,
	`multiple_slots` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `slot_managers_guild_id_idx` ON `slot_managers` (`guild_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slot_managers_main_channel_id_unique` ON `slot_managers` (`main_channel_id`);--> statement-breakpoint
CREATE TABLE `slot_members` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slot_members_user_id_idx` ON `slot_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slot_members_slot_id_user_id_unique` ON `slot_members` (`slot_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `slot_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`scrim_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scrim_id`) REFERENCES `scrims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slot_reminders_user_id_idx` ON `slot_reminders` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slot_reminders_scrim_id_user_id_unique` ON `slot_reminders` (`scrim_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `slots` (
	`id` text PRIMARY KEY NOT NULL,
	`scrim_id` text NOT NULL,
	`num` integer NOT NULL,
	`state` text DEFAULT 'free' NOT NULL,
	`team_name` text,
	`owner_user_id` text,
	`message_id` text,
	`jump_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scrim_id`) REFERENCES `scrims`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "slots_state_check" CHECK("slots"."state" in ('free', 'claimed', 'locked', 'banned')),
	CONSTRAINT "slots_claimed_has_owner_check" CHECK("slots"."state" <> 'claimed' or "slots"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE INDEX `slots_scrim_id_state_idx` ON `slots` (`scrim_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `slots_scrim_id_num_unique` ON `slots` (`scrim_id`,`num`);--> statement-breakpoint
CREATE TABLE `tourney_banned_users` (
	`id` text PRIMARY KEY NOT NULL,
	`tourney_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tourney_id`) REFERENCES `tourneys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tourney_banned_users_tourney_id_user_id_unique` ON `tourney_banned_users` (`tourney_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `tourney_group_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`tourney_id` text NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`group_number` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tourney_id`) REFERENCES `tourneys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tourney_group_lists_message_id_unique` ON `tourney_group_lists` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tourney_group_lists_tourney_id_group_number_unique` ON `tourney_group_lists` (`tourney_id`,`group_number`);--> statement-breakpoint
CREATE TABLE `tourney_slot_members` (
	`id` text PRIMARY KEY NOT NULL,
	`tourney_slot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tourney_slot_id`) REFERENCES `tourney_slots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tourney_slot_members_user_id_idx` ON `tourney_slot_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tourney_slot_members_tourney_slot_id_user_id_unique` ON `tourney_slot_members` (`tourney_slot_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `tourney_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`tourney_id` text NOT NULL,
	`num` integer NOT NULL,
	`team_name` text NOT NULL,
	`leader_id` text NOT NULL,
	`message_id` text,
	`jump_url` text,
	`confirm_jump_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tourney_id`) REFERENCES `tourneys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tourney_slots_tourney_id_idx` ON `tourney_slots` (`tourney_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tourney_slots_tourney_id_num_unique` ON `tourney_slots` (`tourney_id`,`num`);--> statement-breakpoint
CREATE TABLE `tourneys` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`name` text DEFAULT 'Quotient-Tourney' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`registration_channel_id` text NOT NULL,
	`confirm_channel_id` text NOT NULL,
	`role_id` text NOT NULL,
	`open_role_id` text,
	`ping_role_id` text,
	`host_id` text NOT NULL,
	`required_mentions` integer DEFAULT 4 NOT NULL,
	`required_lines` integer DEFAULT 0 NOT NULL,
	`total_slots` integer NOT NULL,
	`started_at` integer,
	`closed_at` integer,
	`multiregister` integer DEFAULT false NOT NULL,
	`teamname_compulsion` integer DEFAULT false NOT NULL,
	`no_duplicate_name` integer DEFAULT true NOT NULL,
	`autodelete_rejects` integer DEFAULT false NOT NULL,
	`allow_duplicate_tags` integer DEFAULT true NOT NULL,
	`start_from` integer DEFAULT 2 NOT NULL,
	`group_size` integer,
	`success_message` text,
	`emojis` text DEFAULT '{"tick":"✅","cross":"❌"}',
	`slotm_channel_id` text,
	`slotm_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "tourneys_status_check" CHECK("tourneys"."status" in ('draft', 'open', 'paused', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `tourneys_guild_id_idx` ON `tourneys` (`guild_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tourneys_registration_channel_id_unique` ON `tourneys` (`registration_channel_id`);--> statement-breakpoint
CREATE TABLE `guild_entitlements` (
	`guild_id` text NOT NULL,
	`feature` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`source` text DEFAULT 'owner' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `feature`),
	CONSTRAINT "guild_entitlements_feature_check" CHECK("guild_entitlements"."feature" in ('scrim_slots', 'tourney_features', 'slot_reminders', 'idp_transfer', 'extra_channels', 'screenshot_types', 'success_message')),
	CONSTRAINT "guild_entitlements_source_check" CHECK("guild_entitlements"."source" in ('premium', 'owner', 'manual'))
);
--> statement-breakpoint
CREATE TABLE `premium_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price` integer NOT NULL,
	`duration_days` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `premium_plans_code_unique` ON `premium_plans` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `premium_plans_name_unique` ON `premium_plans` (`name`);--> statement-breakpoint
CREATE TABLE `premium_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`txn_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`plan_id` text,
	`plan_snapshot` text,
	`email` text,
	`buyer_name` text,
	`raw_data` text DEFAULT '{}',
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `premium_plans`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "premium_transactions_status_check" CHECK("premium_transactions"."status" in ('pending', 'paid', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `premium_transactions_user_id_idx` ON `premium_transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `premium_transactions_guild_id_idx` ON `premium_transactions` (`guild_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `premium_transactions_txn_id_unique` ON `premium_transactions` (`txn_id`);--> statement-breakpoint
CREATE TABLE `easytag_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`delete_after` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `easytag_channels_guild_id_idx` ON `easytag_channels` (`guild_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `easytag_channels_channel_id_unique` ON `easytag_channels` (`channel_id`);--> statement-breakpoint
CREATE TABLE `ss_config_keywords` (
	`id` text PRIMARY KEY NOT NULL,
	`ss_config_id` text NOT NULL,
	`keyword` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ss_config_id`) REFERENCES `ss_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ss_config_keywords_ss_config_id_idx` ON `ss_config_keywords` (`ss_config_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ss_config_keywords_ss_config_id_keyword_unique` ON `ss_config_keywords` (`ss_config_id`,`keyword`);--> statement-breakpoint
CREATE TABLE `ss_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`role_id` text NOT NULL,
	`required_ss` integer DEFAULT 4 NOT NULL,
	`channel_name` text NOT NULL,
	`channel_link` text NOT NULL,
	`allow_same` integer DEFAULT false NOT NULL,
	`duplicate_threshold` integer DEFAULT 7 NOT NULL,
	`ss_type` text NOT NULL,
	`success_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ss_configs_ss_type_check" CHECK("ss_configs"."ss_type" in ('youtube', 'instagram', 'rooter', 'loco', 'any_ss', 'custom'))
);
--> statement-breakpoint
CREATE INDEX `ss_configs_guild_id_idx` ON `ss_configs` (`guild_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ss_configs_channel_id_unique` ON `ss_configs` (`channel_id`);--> statement-breakpoint
CREATE TABLE `ss_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`ss_config_id` text NOT NULL,
	`author_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`dhash` text,
	`phash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ss_config_id`) REFERENCES `ss_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ss_submissions_ss_config_id_idx` ON `ss_submissions` (`ss_config_id`);--> statement-breakpoint
CREATE INDEX `ss_submissions_author_id_idx` ON `ss_submissions` (`author_id`);--> statement-breakpoint
CREATE INDEX `ss_submissions_dhash_phash_idx` ON `ss_submissions` (`dhash`,`phash`);--> statement-breakpoint
CREATE TABLE `tagcheck_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`required_mentions` integer DEFAULT 0 NOT NULL,
	`delete_after` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tagcheck_channels_guild_id_idx` ON `tagcheck_channels` (`guild_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tagcheck_channels_channel_id_unique` ON `tagcheck_channels` (`channel_id`);--> statement-breakpoint
CREATE TABLE `alert_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_prompts_alert_id_user_id_idx` ON `alert_prompts` (`alert_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `alert_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_reads_alert_id_idx` ON `alert_reads` (`alert_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_reads_alert_id_user_id_unique` ON `alert_reads` (`alert_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`message` text DEFAULT '{}',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_active_unique` ON `alerts` (`active`) WHERE "alerts"."active";--> statement-breakpoint
CREATE TABLE `autopurge_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`delete_after` integer DEFAULT 10 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autopurge_configs_channel_id_unique` ON `autopurge_configs` (`channel_id`);--> statement-breakpoint
CREATE TABLE `autorole_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autorole_configs_guild_id_unique` ON `autorole_configs` (`guild_id`);--> statement-breakpoint
CREATE TABLE `autorole_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`role_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `autorole_configs`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "autorole_roles_kind_check" CHECK("autorole_roles"."kind" in ('human', 'bot'))
);
--> statement-breakpoint
CREATE INDEX `autorole_roles_guild_id_idx` ON `autorole_roles` (`guild_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `autorole_roles_guild_id_kind_role_id_unique` ON `autorole_roles` (`guild_id`,`kind`,`role_id`);--> statement-breakpoint
CREATE TABLE `blocklist` (
	`id` text PRIMARY KEY NOT NULL,
	`block_id` text NOT NULL,
	`block_id_type` text NOT NULL,
	`blocked_by` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "blocklist_block_id_type_check" CHECK("blocklist"."block_id_type" in ('1', '2'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocklist_block_id_block_id_type_unique` ON `blocklist` (`block_id`,`block_id_type`);--> statement-breakpoint
CREATE TABLE `command_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`cmd` text NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`failed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `command_usage_guild_id_cmd_idx` ON `command_usage` (`guild_id`,`cmd`);--> statement-breakpoint
CREATE INDEX `command_usage_user_id_cmd_idx` ON `command_usage` (`user_id`,`cmd`);--> statement-breakpoint
CREATE TABLE `guild_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`prefix` text DEFAULT 'q' NOT NULL,
	`embed_color` integer DEFAULT 2267063,
	`embed_footer` text DEFAULT '' NOT NULL,
	`private_channel_id` text,
	`dashboard_access` text DEFAULT '{"embed":[],"scrims":[],"tourney":[],"slotm":[]}',
	`premium_expires_at` integer,
	`made_premium_by` text,
	`lockdown` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "guild_settings_prefix_length_check" CHECK(length("guild_settings"."prefix") <= 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guild_settings_guild_id_unique` ON `guild_settings` (`guild_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`event` text NOT NULL,
	`payload` text DEFAULT '{}',
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "jobs_event_check" CHECK("jobs"."event" in ('reminder', 'msg_delete', 'scrim_open', 'autoclean', 'scrim_match', 'scrim_ban', 'scrim_reserve', 'lockdown', 'user_premium', 'guild_premium', 'vote', 'alert', 'autopurge', 'community_daily', 'tourney_open'))
);
--> statement-breakpoint
CREATE INDEX `jobs_expires_at_idx` ON `jobs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_user_id_idx` ON `jobs` (`user_id`);--> statement-breakpoint
CREATE TABLE `lockdown_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`lockdown_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lockdown_id`) REFERENCES `lockdowns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lockdown_channels_channel_id_idx` ON `lockdown_channels` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lockdown_channels_lockdown_id_channel_id_unique` ON `lockdown_channels` (`lockdown_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `lockdown_maintenance_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`lockdown_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lockdown_id`) REFERENCES `lockdowns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lockdown_maintenance_channels_lockdown_id_channel_id_unique` ON `lockdown_maintenance_channels` (`lockdown_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `lockdowns` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`type` text NOT NULL,
	`role_id` text,
	`channel_id` text,
	`expire_time` integer,
	`prior_state` text,
	`author_id` text NOT NULL,
	`lock_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "lockdowns_type_check" CHECK("lockdowns"."type" in ('channel', 'guild', 'category', 'maintenance'))
);
--> statement-breakpoint
CREATE INDEX `lockdowns_guild_id_type_idx` ON `lockdowns` (`guild_id`,`type`);--> statement-breakpoint
CREATE INDEX `lockdowns_channel_id_type_idx` ON `lockdowns` (`channel_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `lockdowns_lock_key_unique` ON `lockdowns` (`lock_key`);--> statement-breakpoint
CREATE TABLE `snipes` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`nsfw` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snipes_channel_id_unique` ON `snipes` (`channel_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`is_embed` integer DEFAULT false NOT NULL,
	`is_nsfw` integer DEFAULT false NOT NULL,
	`owner_id` text NOT NULL,
	`usage` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tags_guild_id_owner_id_idx` ON `tags` (`guild_id`,`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_guild_id_name_unique` ON `tags` (`guild_id`,`name`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`is_premium` integer DEFAULT false NOT NULL,
	`premium_expire_time` integer,
	`premiums` integer DEFAULT 0 NOT NULL,
	`money` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_settings_user_id_unique` ON `user_settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `votes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`is_voter` integer DEFAULT false NOT NULL,
	`expire_time` integer,
	`reminder` integer DEFAULT false NOT NULL,
	`notified` integer DEFAULT false NOT NULL,
	`total_votes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `votes_user_id_unique` ON `votes` (`user_id`);