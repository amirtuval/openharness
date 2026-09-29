-- 0006_session_previews.sql — `session_previews`: the preview in flight, per session.
--
-- A preview is the `event_start`/`event_delta` pair announcing an `agent.message` that is
-- still being streamed: `event_id` is the `sevt_` id the previews carry, and `text` is every
-- delta published for it so far, concatenated in publish order. It exists so that a connection
-- that opens mid-stream — a reloaded page, a second tab — can be told what was already sent;
-- deltas themselves are delivered only to the listeners attached when they are published.
--
-- There is at most one preview per session: an `event_start` resets the row, and any other
-- `event_delta` appends to it only while it names the same `event_id`. The row is deleted in
-- the append transaction that stores the previewed event (the `agent.message` taking its
-- preview's place) or a `span.model_request_end` for the session, whichever comes first.
--
-- UNLOGGED on purpose: a preview is a display aid, not the record. It lives for the length of
-- one model request, and losing it to a crash costs a reconnecting client the beginning of a
-- reply it will see in full when the stored message lands — the same thing it costs today.
-- The table is not replicated and is truncated by a crash recovery, which is exactly what the
-- data is worth. `updated_at` is written from the store's injected clock, like every other
-- timestamp in this schema.

create unlogged table if not exists session_previews (
  session_id text collate "C" primary key references sessions (id) on delete cascade,
  event_id text collate "C" not null,
  text text not null,
  updated_at timestamptz not null
);
