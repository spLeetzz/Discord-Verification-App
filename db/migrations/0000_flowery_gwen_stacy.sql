CREATE TABLE "ban_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ban_logs_guild_id_unique" UNIQUE("guild_id")
);
--> statement-breakpoint
CREATE TABLE "banned_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scrim_id" uuid NOT NULL,
	"num" integer DEFAULT 0 NOT NULL,
	"user_id" text NOT NULL,
	"team_name" text,
	"members" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text,
	"expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banned_teams_scrim_id_user_id_unique" UNIQUE("scrim_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "media_partner_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_partner_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"jump_url" text,
	"members" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tourney_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_partners_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "reserved_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scrim_id" uuid NOT NULL,
	"num" integer NOT NULL,
	"user_id" text,
	"team_name" text,
	"members" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reserved_slots_scrim_id_num_unique" UNIQUE("scrim_id","num")
);
--> statement-breakpoint
CREATE TABLE "scrims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text DEFAULT 'Quotient-Scrims' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"registration_channel_id" text NOT NULL,
	"slotlist_channel_id" text NOT NULL,
	"slotlist_message_id" text,
	"role_id" text,
	"open_role_id" text,
	"ping_role_id" text,
	"host_id" text NOT NULL,
	"required_mentions" integer DEFAULT 4 NOT NULL,
	"required_lines" smallint DEFAULT 0 NOT NULL,
	"start_from" integer DEFAULT 1 NOT NULL,
	"total_slots" integer NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"match_time" timestamp with time zone,
	"autoclean" text[] DEFAULT '{"channel","role"}'::text[] NOT NULL,
	"autoclean_time" timestamp with time zone,
	"autoslotlist" boolean DEFAULT true NOT NULL,
	"multiregister" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"autodelete_rejects" boolean DEFAULT false NOT NULL,
	"autodelete_extras" boolean DEFAULT true NOT NULL,
	"teamname_compulsion" boolean DEFAULT false NOT NULL,
	"no_duplicate_name" boolean DEFAULT false NOT NULL,
	"allow_duplicate_tags" boolean DEFAULT true NOT NULL,
	"time_elapsed_seconds" integer,
	"open_days" text[] DEFAULT '{"monday","tuesday","wednesday","thursday","friday","saturday","sunday"}'::text[] NOT NULL,
	"slotlist_format" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"open_message" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"close_message" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emojis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cdn" jsonb DEFAULT '{"status": false, "countdown": 3, "msg": {}}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrims_registration_channel_id_unique" UNIQUE("registration_channel_id"),
	CONSTRAINT "scrims_status_check" CHECK ("scrims"."status" in ('draft', 'open', 'closed')),
	CONSTRAINT "scrims_autoclean_check" CHECK ("scrims"."autoclean" <@ ARRAY['channel', 'role']::text[]),
	CONSTRAINT "scrims_open_days_check" CHECK ("scrims"."open_days" <@ ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']::text[])
);
--> statement-breakpoint
CREATE TABLE "slot_manager_scrims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_manager_id" uuid NOT NULL,
	"scrim_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_manager_scrims_slot_manager_id_scrim_id_unique" UNIQUE("slot_manager_id","scrim_id"),
	CONSTRAINT "slot_manager_scrims_scrim_id_unique" UNIQUE("scrim_id")
);
--> statement-breakpoint
CREATE TABLE "slot_managers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"main_channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"toggle" boolean DEFAULT true NOT NULL,
	"allow_reminders" boolean DEFAULT true NOT NULL,
	"multiple_slots" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_managers_main_channel_id_unique" UNIQUE("main_channel_id")
);
--> statement-breakpoint
CREATE TABLE "slot_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scrim_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_reminders_scrim_id_user_id_unique" UNIQUE("scrim_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scrim_id" uuid NOT NULL,
	"num" integer NOT NULL,
	"state" text DEFAULT 'free' NOT NULL,
	"team_name" text,
	"owner_user_id" text,
	"members" text[] DEFAULT '{}'::text[] NOT NULL,
	"message_id" text,
	"jump_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slots_scrim_id_num_unique" UNIQUE("scrim_id","num"),
	CONSTRAINT "slots_state_check" CHECK ("slots"."state" in ('free', 'claimed', 'locked', 'banned')),
	CONSTRAINT "slots_claimed_has_owner_check" CHECK ("slots"."state" <> 'claimed' or "slots"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "tourney_banned_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tourney_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tourney_banned_users_tourney_id_user_id_unique" UNIQUE("tourney_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tourney_group_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tourney_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"group_number" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tourney_group_lists_message_id_unique" UNIQUE("message_id"),
	CONSTRAINT "tourney_group_lists_tourney_id_group_number_unique" UNIQUE("tourney_id","group_number")
);
--> statement-breakpoint
CREATE TABLE "tourney_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tourney_id" uuid NOT NULL,
	"num" integer NOT NULL,
	"team_name" text NOT NULL,
	"leader_id" text NOT NULL,
	"members" text[] DEFAULT '{}'::text[] NOT NULL,
	"message_id" text,
	"jump_url" text,
	"confirm_jump_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tourney_slots_tourney_id_num_unique" UNIQUE("tourney_id","num")
);
--> statement-breakpoint
CREATE TABLE "tourneys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text DEFAULT 'Quotient-Tourney' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"registration_channel_id" text NOT NULL,
	"confirm_channel_id" text NOT NULL,
	"role_id" text NOT NULL,
	"open_role_id" text,
	"ping_role_id" text,
	"host_id" text NOT NULL,
	"required_mentions" smallint DEFAULT 4 NOT NULL,
	"required_lines" smallint DEFAULT 0 NOT NULL,
	"total_slots" smallint NOT NULL,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"multiregister" boolean DEFAULT false NOT NULL,
	"teamname_compulsion" boolean DEFAULT false NOT NULL,
	"no_duplicate_name" boolean DEFAULT true NOT NULL,
	"autodelete_rejects" boolean DEFAULT false NOT NULL,
	"allow_duplicate_tags" boolean DEFAULT true NOT NULL,
	"start_from" smallint DEFAULT 2 NOT NULL,
	"group_size" smallint,
	"success_message" text,
	"emojis" jsonb DEFAULT '{"tick": "✅", "cross": "❌"}'::jsonb NOT NULL,
	"slotm_channel_id" text,
	"slotm_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tourneys_registration_channel_id_unique" UNIQUE("registration_channel_id"),
	CONSTRAINT "tourneys_status_check" CHECK ("tourneys"."status" in ('draft', 'open', 'paused', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "guild_entitlements" (
	"guild_id" text NOT NULL,
	"feature" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"source" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_entitlements_guild_id_feature_pk" PRIMARY KEY("guild_id","feature"),
	CONSTRAINT "guild_entitlements_feature_check" CHECK ("guild_entitlements"."feature" in ('scrim_slots', 'slot_reminders', 'idp_transfer', 'extra_channels', 'screenshot_types', 'success_message')),
	CONSTRAINT "guild_entitlements_source_check" CHECK ("guild_entitlements"."source" in ('premium', 'owner', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "premium_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" integer NOT NULL,
	"duration_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "premium_plans_code_unique" UNIQUE("code"),
	CONSTRAINT "premium_plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "premium_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"txn_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"plan_id" uuid,
	"plan_snapshot" jsonb,
	"email" text,
	"buyer_name" text,
	"raw_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "premium_transactions_txn_id_unique" UNIQUE("txn_id"),
	CONSTRAINT "premium_transactions_status_check" CHECK ("premium_transactions"."status" in ('pending', 'paid', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "easytag_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"delete_after" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "easytag_channels_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "ss_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"role_id" text NOT NULL,
	"required_ss" integer DEFAULT 4 NOT NULL,
	"channel_name" text NOT NULL,
	"channel_link" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"allow_same" boolean DEFAULT false NOT NULL,
	"ss_type" text NOT NULL,
	"success_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ss_configs_channel_id_unique" UNIQUE("channel_id"),
	CONSTRAINT "ss_configs_ss_type_check" CHECK ("ss_configs"."ss_type" in ('youtube', 'instagram', 'rooter', 'loco', 'any_ss', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "ss_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ss_config_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"dhash" text,
	"phash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tagcheck_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"required_mentions" integer DEFAULT 0 NOT NULL,
	"delete_after" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tagcheck_channels_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "alert_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_reads_alert_id_user_id_unique" UNIQUE("alert_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"message" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autopurge_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"delete_after" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autopurge_configs_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "autorole_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"humans" text[] DEFAULT '{}'::text[] NOT NULL,
	"bots" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autorole_configs_guild_id_unique" UNIQUE("guild_id")
);
--> statement-breakpoint
CREATE TABLE "blocklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" text NOT NULL,
	"block_id_type" text NOT NULL,
	"blocked_by" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocklist_block_id_block_id_type_unique" UNIQUE("block_id","block_id_type"),
	CONSTRAINT "blocklist_block_id_type_check" CHECK ("blocklist"."block_id_type" in ('1', '2'))
);
--> statement-breakpoint
CREATE TABLE "command_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"cmd" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"prefix" text DEFAULT 'q' NOT NULL,
	"embed_color" integer DEFAULT 2267063,
	"embed_footer" text DEFAULT '' NOT NULL,
	"private_channel_id" text,
	"dashboard_access" jsonb DEFAULT '{"embed": [], "scrims": [], "tourney": [], "slotm": []}'::jsonb NOT NULL,
	"premium_expires_at" timestamp with time zone,
	"made_premium_by" text,
	"lockdown" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_settings_guild_id_unique" UNIQUE("guild_id"),
	CONSTRAINT "guild_settings_prefix_length_check" CHECK (char_length("guild_settings"."prefix") <= 5)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_event_check" CHECK ("jobs"."event" in ('reminder', 'msg_delete', 'scrim_open', 'autoclean', 'scrim_match', 'scrim_ban', 'scrim_reserve', 'lockdown', 'user_premium', 'guild_premium', 'vote', 'alert', 'autopurge'))
);
--> statement-breakpoint
CREATE TABLE "lockdowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"type" text NOT NULL,
	"role_id" text,
	"channel_id" text,
	"channel_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"expire_time" timestamp with time zone,
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lockdowns_type_check" CHECK ("lockdowns"."type" in ('channel', 'guild', 'category', 'maintenance'))
);
--> statement-breakpoint
CREATE TABLE "snipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"nsfw" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snipes_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"is_embed" boolean DEFAULT false NOT NULL,
	"is_nsfw" boolean DEFAULT false NOT NULL,
	"owner_id" text NOT NULL,
	"usage" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_guild_id_name_unique" UNIQUE("guild_id","name")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"is_premium" boolean DEFAULT false NOT NULL,
	"premium_expire_time" timestamp with time zone,
	"premiums" integer DEFAULT 0 NOT NULL,
	"money" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"is_voter" boolean DEFAULT false NOT NULL,
	"expire_time" timestamp with time zone,
	"reminder" boolean DEFAULT false NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"total_votes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "banned_teams" ADD CONSTRAINT "banned_teams_scrim_id_scrims_id_fk" FOREIGN KEY ("scrim_id") REFERENCES "public"."scrims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_partner_slots" ADD CONSTRAINT "media_partner_slots_media_partner_id_media_partners_id_fk" FOREIGN KEY ("media_partner_id") REFERENCES "public"."media_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_partners" ADD CONSTRAINT "media_partners_tourney_id_tourneys_id_fk" FOREIGN KEY ("tourney_id") REFERENCES "public"."tourneys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserved_slots" ADD CONSTRAINT "reserved_slots_scrim_id_scrims_id_fk" FOREIGN KEY ("scrim_id") REFERENCES "public"."scrims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_manager_scrims" ADD CONSTRAINT "slot_manager_scrims_slot_manager_id_slot_managers_id_fk" FOREIGN KEY ("slot_manager_id") REFERENCES "public"."slot_managers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_manager_scrims" ADD CONSTRAINT "slot_manager_scrims_scrim_id_scrims_id_fk" FOREIGN KEY ("scrim_id") REFERENCES "public"."scrims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reminders" ADD CONSTRAINT "slot_reminders_scrim_id_scrims_id_fk" FOREIGN KEY ("scrim_id") REFERENCES "public"."scrims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_scrim_id_scrims_id_fk" FOREIGN KEY ("scrim_id") REFERENCES "public"."scrims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tourney_banned_users" ADD CONSTRAINT "tourney_banned_users_tourney_id_tourneys_id_fk" FOREIGN KEY ("tourney_id") REFERENCES "public"."tourneys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tourney_group_lists" ADD CONSTRAINT "tourney_group_lists_tourney_id_tourneys_id_fk" FOREIGN KEY ("tourney_id") REFERENCES "public"."tourneys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tourney_slots" ADD CONSTRAINT "tourney_slots_tourney_id_tourneys_id_fk" FOREIGN KEY ("tourney_id") REFERENCES "public"."tourneys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "premium_transactions" ADD CONSTRAINT "premium_transactions_plan_id_premium_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."premium_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ss_submissions" ADD CONSTRAINT "ss_submissions_ss_config_id_ss_configs_id_fk" FOREIGN KEY ("ss_config_id") REFERENCES "public"."ss_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_prompts" ADD CONSTRAINT "alert_prompts_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_reads" ADD CONSTRAINT "alert_reads_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "banned_teams_scrim_id_idx" ON "banned_teams" USING btree ("scrim_id");--> statement-breakpoint
CREATE INDEX "media_partner_slots_media_partner_id_idx" ON "media_partner_slots" USING btree ("media_partner_id");--> statement-breakpoint
CREATE INDEX "media_partners_tourney_id_idx" ON "media_partners" USING btree ("tourney_id");--> statement-breakpoint
CREATE INDEX "reserved_slots_scrim_id_idx" ON "reserved_slots" USING btree ("scrim_id");--> statement-breakpoint
CREATE INDEX "scrims_guild_id_idx" ON "scrims" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "slot_managers_guild_id_idx" ON "slot_managers" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "slot_reminders_user_id_idx" ON "slot_reminders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "slots_scrim_id_state_idx" ON "slots" USING btree ("scrim_id","state");--> statement-breakpoint
CREATE INDEX "tourney_slots_tourney_id_idx" ON "tourney_slots" USING btree ("tourney_id");--> statement-breakpoint
CREATE INDEX "tourneys_guild_id_idx" ON "tourneys" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "premium_transactions_user_id_idx" ON "premium_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "premium_transactions_guild_id_idx" ON "premium_transactions" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "easytag_channels_guild_id_idx" ON "easytag_channels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "ss_configs_guild_id_idx" ON "ss_configs" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "ss_submissions_ss_config_id_idx" ON "ss_submissions" USING btree ("ss_config_id");--> statement-breakpoint
CREATE INDEX "ss_submissions_author_id_idx" ON "ss_submissions" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "ss_submissions_dhash_phash_idx" ON "ss_submissions" USING btree ("dhash","phash");--> statement-breakpoint
CREATE INDEX "tagcheck_channels_guild_id_idx" ON "tagcheck_channels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "alert_prompts_alert_id_user_id_idx" ON "alert_prompts" USING btree ("alert_id","user_id");--> statement-breakpoint
CREATE INDEX "alert_reads_alert_id_idx" ON "alert_reads" USING btree ("alert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_active_unique" ON "alerts" USING btree ("active") WHERE "alerts"."active";--> statement-breakpoint
CREATE INDEX "command_usage_guild_id_cmd_idx" ON "command_usage" USING btree ("guild_id","cmd");--> statement-breakpoint
CREATE INDEX "command_usage_user_id_cmd_idx" ON "command_usage" USING btree ("user_id","cmd");--> statement-breakpoint
CREATE INDEX "jobs_expires_at_idx" ON "jobs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "jobs_user_id_idx" ON "jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "lockdowns_guild_id_type_idx" ON "lockdowns" USING btree ("guild_id","type");--> statement-breakpoint
CREATE INDEX "lockdowns_channel_id_type_idx" ON "lockdowns" USING btree ("channel_id","type");