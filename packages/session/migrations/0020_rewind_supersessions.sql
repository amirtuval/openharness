-- 0020_rewind_supersessions.sql — `event_supersessions.kind`: what a recorded range covers
-- (#238).
--
-- A superseding event is one of two kinds since #238, and the range it records means a
-- different thing for each:
--
--   - a reply's range — the one a finished `agent.message`, or the `span.model_request_end`
--     that closes a request which stored none, carries (D9, issue #46) — replaces the
--     `event_start`/`event_delta` chunks it was streamed as, and only those;
--   - a `session.rewind`'s range replaces the whole tail of the log from the `user.message`
--     the reader edited through the event before the rewind, whatever the events in it are.
--
-- `kind` is what tells the two apart: replay skips a range's events, and `compact()` deletes
-- them, by type as well as by `seq` — a chunk only for a reply's range, every type for a
-- rewind's. Without the column a reply's range could hide an event that is not a chunk, and a
-- rewind's would have to be read as one.
--
-- **Every row written before this migration is a reply's range**, which is exactly the
-- column's default: rewinds did not exist, so a ranged row could only have come from the
-- `agent.message`/span end of D9. There is nothing else to backfill, and `if not exists`
-- makes a re-run — the runner applies every file on every `migrate()` call — leave every row
-- as it was.
--
-- The check constraint is the same shape here as the range's own (`0009`): the store writes
-- only these two names, and a hand-edited row may not invent a third. It is added through a
-- `do` block because Postgres has no `add constraint if not exists`.

alter table event_supersessions
  add column if not exists kind text not null default 'chunks';

do $$
begin
  if not exists (
    select 1
      from information_schema.table_constraints
     where table_schema = current_schema()
       and table_name = 'event_supersessions'
       and constraint_name = 'event_supersessions_kind_check'
  ) then
    alter table event_supersessions
      add constraint event_supersessions_kind_check check (kind in ('chunks', 'rewind'));
  end if;
end
$$;
