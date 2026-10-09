-- 0005_events_id_unique.sql — an event id is unique across the whole table.
--
-- An append may carry a caller-supplied `sevt_` id: the id the stream-only `event_start` and
-- `event_delta` previews of that event were already published under, so that a client replaces
-- the preview with the stored event by id. That id is the identity of one event for the whole
-- table rather than one per session, and two events may never share it. An append that
-- supplies an id the log already holds is refused whole — nothing of its batch is stored — and
-- reported as a `DuplicateEventIdError`.
--
-- The uniqueness itself is already enforced: `id` is the primary key (0003_events.sql). This
-- index states the guarantee under a name of this package's own, so a violation is reported
-- under a constraint the store can recognise without depending on the database's locale.

create unique index if not exists events_id_key on events (id);
