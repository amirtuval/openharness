-- 0034_task_notifications.sql — the two indexes behind background-task notifications
-- (epic #340, S4; issue #343).
--
-- A `session.task_notification` is a **queued** event, like a `user.message`: it is stored with
-- `processed_at` NULL, claimed by the event that answers it (`event_claims`, `0007`), and read
-- back as the brain's next request or as the result of a task wait. Two reads of it need an
-- index, and both narrow to one session and one event type.
--
-- **`events_task_notification_pending_idx`** is the one `getPendingTaskNotifications` and the
-- work scan use: "does this session hold a notification nobody has claimed?". `(session_id,
-- seq)` (`0003`) seeks a session's log by position rather than by type, so without this the read
-- would walk every event of the session. It is **partial** — the shape `0021`'s, `0026`'s and
-- `0028`'s — because only `session.task_notification` rows are ever read this way, which keeps
-- it a fraction of the log. `findSessionsNeedingWork` is what makes it load-bearing: a
-- notification is written by whatever ran the task, on an instance that may not be the parent's
-- owner and with no signal to send it, so the scan is the only thing that finds an idle session
-- whose news is waiting.
--
-- **`events_task_notification_source_key_idx`** is the one that makes delivery exactly once
-- (S4). `appendTaskNotification` is idempotent on the notification's `source_key` — the task
-- side's own key for one piece of news, e.g. `<child_session_id>:<idle seq>` — and this unique
-- index is what makes "idempotent" true under concurrency rather than only in a single writer's
-- memory: the second append of the same key violates it, and the store answers the notification
-- already in the log instead of writing a second one. It is unique over `(session_id,
-- payload->>'source_key')` and partial over the one event type, so it constrains nothing else in
-- the log, and the expression is exactly the JSON path the store reads the key from.
--
-- Both are indexes on an append-only table: built, never written back, and `if not exists` so a
-- re-run of the migrator leaves the rows (and the log) exactly as they were. There is nothing to
-- backfill — a log stored before this holds no notification, because nothing could write one.
--
-- **Migration number.** 0034, on both stores: the number this branch reserved while A1 (#341,
-- `0032`) and A2 (#342, `0033`) were being implemented in parallel on their own branches. Every
-- file runs on every `migrate()` in name order, so a rebase that brings those in settles the
-- order; a later branch that adds one from this base takes the next free number.

create index if not exists events_task_notification_pending_idx
  on events (session_id)
  where type = 'session.task_notification';

create unique index if not exists events_task_notification_source_key_idx
  on events (session_id, ((payload ->> 'source_key')))
  where type = 'session.task_notification';
