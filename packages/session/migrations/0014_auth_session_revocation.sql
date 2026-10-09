-- 0014_auth_session_revocation.sql — announce revoked auth sessions on the revocation channel
-- (epic #65, A2; issue #76).
--
-- A revoked session must stop working immediately (A2), and that includes every long-lived
-- response it already opened — an SSE stream is one request, so the `/v1` auth guard's
-- one-look-per-request validation never sees the revocation. The server closes those streams
-- by listening for a revocation notification on the `ohr_auth_session_revoked` channel (see
-- `AUTH_SESSION_REVOCATION_CHANNEL` in `src/postgres/schema.ts`), which every instance shares.
--
-- This trigger is what publishes on that channel for the paths no application code observes:
-- a session row deleted by SQL — an operator revoking a session by hand — or swept up by a
-- `"user"` delete cascade. Deletions made through Better Auth itself are announced by the
-- server's `databaseHooks.session.delete.after` hook (`apps/server/src/auth.ts`); on Postgres
-- both fire, and two announcements of one revocation are harmless because closing an already
-- closed stream is a no-op.
--
-- The payload is the session's `id` and never its `token`: a NOTIFY payload is plaintext on a
-- channel every listener (and some server logs) can read, and the token is the credential
-- itself. The shape — `{"authSessionId": "..."}` — is what
-- `decodeAuthSessionRevocationNotification` parses, so the two have to move together.
--
-- The function and trigger are recreated on every `migrate()` run (the runner has no ledger),
-- which is what makes them idempotent: `create or replace` and a `drop trigger if exists`
-- before the `create trigger`. TRUNCATE does not fire row-level triggers, so a test harness
-- emptying `session` does not announce anything.

create or replace function openharness_notify_auth_session_revoked() returns trigger
language plpgsql as $$
begin
  perform pg_notify(
    'ohr_auth_session_revoked',
    json_build_object('authSessionId', old.id)::text
  );
  return old;
end;
$$;

drop trigger if exists openharness_auth_session_revoked on "session";

create trigger openharness_auth_session_revoked
  after delete on "session"
  for each row
  execute function openharness_notify_auth_session_revoked();
