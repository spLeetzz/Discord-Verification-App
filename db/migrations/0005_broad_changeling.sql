ALTER TABLE "lockdowns" ADD COLUMN "lock_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "lockdowns" ADD CONSTRAINT "lockdowns_lock_key_unique" UNIQUE("lock_key");