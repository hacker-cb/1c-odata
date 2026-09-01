CREATE TABLE "base_secrets" (
	"base_name" text PRIMARY KEY NOT NULL,
	"key_id" smallint NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bases" (
	"name" text PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"login" text NOT NULL,
	"server_timezone" text NOT NULL,
	"label" text,
	"shape" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"sub" text NOT NULL,
	"base_name" text NOT NULL,
	"scope" text DEFAULT 'read' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grants_sub_base_name_pk" PRIMARY KEY("sub","base_name")
);
--> statement-breakpoint
CREATE TABLE "health" (
	"base_name" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"last_check" timestamp DEFAULT now() NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "base_secrets" ADD CONSTRAINT "base_secrets_base_name_bases_name_fk" FOREIGN KEY ("base_name") REFERENCES "public"."bases"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_sub_user_id_fk" FOREIGN KEY ("sub") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_base_name_bases_name_fk" FOREIGN KEY ("base_name") REFERENCES "public"."bases"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health" ADD CONSTRAINT "health_base_name_bases_name_fk" FOREIGN KEY ("base_name") REFERENCES "public"."bases"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grants_sub_idx" ON "grants" USING btree ("sub");--> statement-breakpoint
CREATE INDEX "grants_base_name_idx" ON "grants" USING btree ("base_name");