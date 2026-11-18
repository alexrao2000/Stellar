-- A private timed calendar. Run bookings serialize against event writes so
-- simultaneous devices cannot reserve an occupied slot. Ordinary overlapping
-- events remain valid; the UI surfaces any resulting run conflict.
begin;
create table public.calendar_events (
    id uuid primary key,
    title text not null check (length(btrim(title)) between 1 and 160),
    notes text not null default '' check (length(notes) <= 2000),
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    all_day boolean not null default false,
    kind text not null default 'event' check (kind in ('event', 'run')),
    task_title text check (length(task_title) <= 200),
    run_day date,
    time_zone text not null,
    updated_at timestamptz not null default clock_timestamp(),
    check (ends_at > starts_at and ends_at - starts_at <= interval '31 days'),
    check ((kind = 'run' and run_day is not null and not all_day
        and ends_at - starts_at between interval '1 minute' and interval '3 hours')
        or (kind = 'event' and run_day is null and task_title is null))
);
create index calendar_events_start on public.calendar_events(starts_at);
create index calendar_events_end on public.calendar_events(ends_at);
create unique index calendar_run_day on public.calendar_events(run_day, coalesce(task_title, 'Run')) where kind = 'run';
alter table public.calendar_events enable row level security;
revoke all on public.calendar_events from public, anon, authenticated;
grant select, insert, update, delete on public.calendar_events to service_role;
create function public.stellar_calendar_guard() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
    perform pg_advisory_xact_lock(1937006962, 1);
    if TG_OP = 'DELETE' then return OLD; end if;
    NEW.updated_at := clock_timestamp();
    if NEW.kind = 'run' then
        NEW.run_day := (NEW.starts_at at time zone NEW.time_zone)::date;
        if exists (select 1 from public.calendar_events e where e.id <> NEW.id
            and e.starts_at < NEW.ends_at and e.ends_at > NEW.starts_at) then
            raise exception 'calendar_run_conflict' using errcode = '23P01';
        end if;
    end if;
    return NEW;
end;
$$;
revoke all on function public.stellar_calendar_guard() from public, anon, authenticated;
grant execute on function public.stellar_calendar_guard() to service_role;
create trigger calendar_events_guard before insert or update or delete on public.calendar_events
    for each row execute function public.stellar_calendar_guard();
commit;
notify pgrst, 'reload schema';
