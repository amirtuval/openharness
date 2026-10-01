-- 0011_better_auth.sql — the tables Better Auth needs (epic #65, decision A1).
--
-- Better Auth (the `user`, `session`, `account`, `verification` and `deviceCode` tables) is
-- mounted in the server and does its own reads and writes; this package owns the schema it
-- runs on, exactly as it owns the log's. The server sub-issue (#61) configures Better Auth
-- against these tables with its own migrator disabled, so they have to match what Better
-- Auth expects **exactly**: table names, column names (camelCase — Better Auth's own
-- spelling, unlike the log's snake_case) and types are the generator's, not ours.
--
-- Provenance: generated once with Better Auth 1.7.7's CLI, in a scratch directory, from a
-- config with the core library, the `google`, `github` and `microsoft` social providers and
-- the `device-authorization` and `bearer` plugins, on the Postgres/Kysely adapter:
--
--   npx @better-auth/cli generate --config ./auth.ts --output ./generated.sql
--
-- The generated SQL is reproduced here verbatim but for two things: the statements are
-- formatted one column per line, and every `create table`/`create index` carries
-- `if not exists`, which this package's migrator requires — it re-runs every file on every
-- `migrate()` call (there is no ledger; see `migrate.ts`). The same schema is what
-- `npx @better-auth/cli migrate` creates, verified against a scratch database; running
-- Better Auth's generator again on it answers "Your schema is already up to date."
--
-- Notes on what the plugin list adds, for the reader:
--
-- - the `google`, `github` and `microsoft` providers need no tables of their own; their
--   accounts are rows of `account`, keyed by `providerId`;
-- - `device-authorization` adds `deviceCode`. Its `userId` deliberately carries no foreign
--   key (the field is optional in the plugin's schema, and a device-code row exists before
--   anyone has signed in);
-- - `bearer` adds no table: a bearer token *is* a `session` row looked up by `token`.
--
-- `"user"` is a reserved word, so every reference to it is quoted. `email` is unique: a user
-- *is* a verified email (decision A3), and the same person through another provider is the
-- same row (account linking by email).

create table if not exists "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
);

create table if not exists "session" (
  "id" text not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

create index if not exists "session_userId_idx" on "session" ("userId");

create table if not exists "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz not null
);

create index if not exists "account_userId_idx" on "account" ("userId");

create table if not exists "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
);

create index if not exists "verification_identifier_idx" on "verification" ("identifier");

create table if not exists "deviceCode" (
  "id" text not null primary key,
  "deviceCode" text not null,
  "userCode" text not null,
  "userId" text,
  "expiresAt" timestamptz not null,
  "status" text not null,
  "lastPolledAt" timestamptz,
  "pollingInterval" integer,
  "clientId" text,
  "scope" text
);
