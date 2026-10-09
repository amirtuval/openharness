-- 0015_session_model.sql — sessions carry the model and system they run; the agent is
-- optional (epic #92, issue #93).
--
-- Until now a session was always created from an agent, and the agent's configuration *was*
-- the session's: `agent_model_id` and `agent_system` held what a turn ran. Model-first chat
-- makes the agent optional — a session is created from a model, and an agent is the preset it
-- snapshotted — so the configuration the session runs moves to columns of its own, `model`
-- (jsonb, the protocol's `{ id }`) and `system` (text), and the agent snapshot becomes
-- nullable.
--
-- The backfill is why this is a migration and not only a schema change: sessions created
-- since the auth epic already exist in real databases, and every read now takes the session's
-- effective configuration from `model`/`system`. The agent's values are copied into them, so
-- a session created before this change reads exactly as it did — `model: { id:
-- agent_model_id }`, `system: agent_system` — until a later migration or a rewrite says
-- otherwise. A row created after the change always writes `model` itself (the store refuses
-- to create a session without one), so the `where model is null` backfill matches nothing on
-- a re-run, and the whole file is idempotent like every migration here (the runner re-runs
-- every file on every `migrate()` call).
--
-- The `not null` is set only after the backfill, so a database with existing rows passes it;
-- `system` stays nullable, because `system: null` is a real configuration ("no system
-- prompt") and the default for a model-first session.
--
-- The four snapshot columns keep their pre-#93 names and become nullable together: an
-- `agent_id` still means the `agent_name`, `agent_model_id` and `agent_system` beside it, and
-- a model-first session leaves all four NULL. Nothing reads `agent_model_id` or `agent_system`
-- as the session's configuration any more — they are the preset's record.

alter table sessions add column if not exists model jsonb;
alter table sessions add column if not exists system text;

-- One-time backfill from the stored snapshot. Guarded by `model is null`, which only a row
-- written before this migration can be — see the header.
update sessions
   set model = jsonb_build_object('id', agent_model_id),
       system = agent_system
 where model is null;

alter table sessions alter column model set not null;

alter table sessions alter column agent_id drop not null;
alter table sessions alter column agent_name drop not null;
alter table sessions alter column agent_model_id drop not null;
