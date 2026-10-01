-- 0010_drop_session_previews.sql — the preview table goes away (P4, issue #46).
--
-- `0006_session_previews.sql` introduced the table for the pre-D9 preview mechanism: a
-- connection that arrived mid-reply was told what had already streamed through a row the
-- store kept per session. Since D9 the chunks are stored events — an `event_start` and its
-- `event_delta`s are rows of `events` — so a reply in flight is replayed like anything else
-- and there is nothing to keep beside the log. P4 removed `publishEphemeral`, `getPreview`
-- and `SessionPreview` from the store contract, and the table they served has no reader or
-- writer left.
--
-- Dropping it deletes nothing of the log: the table only ever held a display aid for the
-- reply currently streaming, which the stored `agent.message` (and, since P3, the stored
-- chunks themselves) carry in full. No migration rewrites `events` or `event_claims`.

drop table if exists session_previews;
