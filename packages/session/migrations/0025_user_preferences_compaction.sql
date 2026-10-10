-- 0025_user_preferences_compaction.sql — the compaction controls on `user_preferences`
-- (epic #277, C3; issue #282).
--
-- Three columns beside `default_model` and `theme`, holding the settings issue #282 puts in
-- the web app's Settings → Context section and `oh settings`:
--
--   * `compaction_threshold` — the share of the chat model's budget at which older history
--     is summarized, a fraction in `0.3..0.95`. **NULL means "follow the server's own"**
--     (`OPENHARNESS_COMPACTION_THRESHOLD`, default `0.7`), the rule
--     `0018_credential_key_provider.sql` uses: the default is a deployment's, not a
--     constant, so a stored `0.7` could not be told from a deliberate choice of `0.7`. The
--     protocol's `UserPreferences` carries it as `number | null` for the same reason.
--   * `summary_model` — which model writes summaries: the protocol's `same-as-chat`
--     sentinel or a `provider/model` id. A real default rather than NULL, the rule
--     `0019_user_preferences_theme.sql` uses: a write always supplies one, so an absent value
--     would be a bug, not a legitimate older shape.
--   * `summary_max_passes` — how many passes the chosen summary model may take before the
--     chat model takes over. **NULL means "follow the engine's own"** (3), again because a
--     stored 3 could not be told from a chosen 3.
--
-- Existing rows take the defaults, which is not a guess: before this migration every chat
-- already compacted at the server's threshold, used the chat model to summarize and let the
-- engine's pass limit apply — so NULL/NULL/'same-as-chat' is the behaviour that was already
-- in effect. Every statement is idempotent (`add column if not exists`), so the runner can
-- re-run the file, and nothing else in `user_preferences` changes.

alter table user_preferences
  add column if not exists compaction_threshold double precision;

alter table user_preferences
  add column if not exists summary_model text not null default 'same-as-chat';

alter table user_preferences
  add column if not exists summary_max_passes integer;
