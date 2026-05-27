-- Add new schema named "auth"
CREATE SCHEMA "auth";
-- Add new schema named "billing"
CREATE SCHEMA "billing";
-- Add new schema named "conversations"
CREATE SCHEMA "conversations";
-- Create "users" table
CREATE TABLE "auth"."users" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "email" public.citext NOT NULL,
  "password_hash" text NULL,
  "locale" text NOT NULL DEFAULT 'fr-FR',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz NULL,
  PRIMARY KEY ("id")
);
-- Create index "users_email_active_idx" to table: "users"
CREATE UNIQUE INDEX "users_email_active_idx" ON "auth"."users" ("email") WHERE (deleted_at IS NULL);
-- Create "usage_events" table
CREATE TABLE "billing"."usage_events" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NULL,
  "kind" text NOT NULL,
  "quantity" numeric NOT NULL,
  "unit" text NOT NULL,
  "cost_eur_micro" bigint NOT NULL DEFAULT 0,
  "metadata" jsonb NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "usage_events_kind_check" CHECK (kind = ANY (ARRAY['llm_tokens'::text, 'embeddings_tokens'::text, 'tool_runs'::text, 'storage_gb_day'::text])),
  CONSTRAINT "usage_events_quantity_check" CHECK (quantity >= (0)::numeric)
);
-- Create index "usage_events_idempotency_idx" to table: "usage_events"
CREATE UNIQUE INDEX "usage_events_idempotency_idx" ON "billing"."usage_events" ("idempotency_key");
-- Create index "usage_events_workspace_kind_occurred_idx" to table: "usage_events"
CREATE INDEX "usage_events_workspace_kind_occurred_idx" ON "billing"."usage_events" ("workspace_id", "kind", "occurred_at");
-- Create "workspaces" table
CREATE TABLE "auth"."workspaces" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "owner_id" uuid NOT NULL,
  "plan" text NOT NULL DEFAULT 'free',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT
);
-- Create index "workspaces_owner_idx" to table: "workspaces"
CREATE INDEX "workspaces_owner_idx" ON "auth"."workspaces" ("owner_id");
-- Create "conversations" table
CREATE TABLE "conversations"."conversations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "created_by" uuid NOT NULL,
  "title" text NULL,
  "model" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT "conversations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "auth"."workspaces" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "conversations_workspace_idx" to table: "conversations"
CREATE INDEX "conversations_workspace_idx" ON "conversations"."conversations" ("workspace_id", "updated_at" DESC) WHERE (deleted_at IS NULL);
-- Create "federated_identities" table
CREATE TABLE "auth"."federated_identities" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "subject" text NOT NULL,
  "email" public.citext NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_login" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "federated_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "federated_identities_provider_subject_idx" to table: "federated_identities"
CREATE UNIQUE INDEX "federated_identities_provider_subject_idx" ON "auth"."federated_identities" ("provider", "subject");
-- Create index "federated_identities_user_idx" to table: "federated_identities"
CREATE INDEX "federated_identities_user_idx" ON "auth"."federated_identities" ("user_id");
-- Create "messages" table
CREATE TABLE "conversations"."messages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "finish_reason" text NULL,
  "tokens_in" integer NULL,
  "tokens_out" integer NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"."conversations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "messages_role_check" CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text, 'tool'::text]))
);
-- Create index "messages_conversation_idx" to table: "messages"
CREATE INDEX "messages_conversation_idx" ON "conversations"."messages" ("conversation_id", "created_at");
-- Create "sessions" table
CREATE TABLE "auth"."sessions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "refresh_token_hash" bytea NOT NULL,
  "user_agent" text NULL,
  "ip" inet NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz NULL,
  "rotated_to" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "sessions_rotated_to_fkey" FOREIGN KEY ("rotated_to") REFERENCES "auth"."sessions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "sessions_refresh_hash_idx" to table: "sessions"
CREATE UNIQUE INDEX "sessions_refresh_hash_idx" ON "auth"."sessions" ("refresh_token_hash");
-- Create index "sessions_user_active_idx" to table: "sessions"
CREATE INDEX "sessions_user_active_idx" ON "auth"."sessions" ("user_id") WHERE (revoked_at IS NULL);
-- Create "plans" table
CREATE TABLE "billing"."plans" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "quota_llm_tokens" bigint NULL,
  "quota_embeddings_tokens" bigint NULL,
  "quota_tool_runs" bigint NULL,
  "quota_storage_gb" numeric(12,2) NULL,
  "price_eur_month_micro" bigint NOT NULL DEFAULT 0,
  "is_public" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "plans_slug_key" UNIQUE ("slug")
);
-- Create "subscriptions" table
CREATE TABLE "billing"."subscriptions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "status" text NOT NULL,
  "current_period_start" timestamptz NOT NULL,
  "current_period_end" timestamptz NOT NULL,
  "cancelled_at" timestamptz NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "billing"."plans" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT "subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "auth"."workspaces" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "subscriptions_period_chk" CHECK (current_period_end > current_period_start),
  CONSTRAINT "subscriptions_status_check" CHECK (status = ANY (ARRAY['active'::text, 'past_due'::text, 'cancelled'::text]))
);
-- Create index "subscriptions_plan_idx" to table: "subscriptions"
CREATE INDEX "subscriptions_plan_idx" ON "billing"."subscriptions" ("plan_id");
-- Create index "subscriptions_workspace_active_idx" to table: "subscriptions"
CREATE UNIQUE INDEX "subscriptions_workspace_active_idx" ON "billing"."subscriptions" ("workspace_id") WHERE (status = 'active'::text);
-- Create "workspace_members" table
CREATE TABLE "auth"."workspace_members" (
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "user_id"),
  CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "auth"."workspaces" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "workspace_members_role_check" CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'guest'::text]))
);
-- Create index "workspace_members_user_idx" to table: "workspace_members"
CREATE INDEX "workspace_members_user_idx" ON "auth"."workspace_members" ("user_id");
