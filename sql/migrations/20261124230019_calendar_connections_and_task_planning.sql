-- Private provider permissions and task scheduling preferences. Provider tokens
-- and private feed URLs are encrypted by the application before storage.
begin;
create table public.calendar_connections (
    id uuid primary key,
    owner_id text not null,
    provider text not null check (provider in ('google', 'outlook', 'ics')),
    mode text not null default 'read' check (mode in ('read', 'write')),
    secret text not null,
    calendars jsonb not null default '[]',
    selected_ids jsonb not null default '[]',
    write_calendar_id text,
    updated_at timestamptz not null default clock_timestamp(),
    check (provider <> 'ics' or mode = 'read'),
    check (mode = 'write' or write_calendar_id is null)
);
create index calendar_connections_owner on public.calendar_connections(owner_id);
create table public.task_planning_rules (
    owner_id text not null,
    series_id bigint not null,
    rule jsonb not null,
    updated_at timestamptz not null default clock_timestamp(),
    primary key (owner_id, series_id)
);
alter table public.calendar_connections enable row level security;
alter table public.task_planning_rules enable row level security;
revoke all on public.calendar_connections, public.task_planning_rules from public, anon, authenticated;
grant select, insert, update, delete on public.calendar_connections, public.task_planning_rules to service_role;
create function public.stellar_calendar_touch() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
    NEW.updated_at := clock_timestamp();
    return NEW;
end;
$$;
revoke all on function public.stellar_calendar_touch() from public, anon, authenticated;
grant execute on function public.stellar_calendar_touch() to service_role;
create trigger calendar_connections_touch before update on public.calendar_connections for each row execute function public.stellar_calendar_touch();
create trigger task_planning_touch before update on public.task_planning_rules for each row execute function public.stellar_calendar_touch();
alter table public.calendar_events add column task_series_id bigint;
do $$
declare c record;
begin
    for c in select conname from pg_constraint where conrelid = 'public.calendar_events'::regclass
        and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
        execute format('alter table public.calendar_events drop constraint %I', c.conname);
    end loop;
end;
$$;
alter table public.calendar_events add constraint calendar_kind_check check (kind in ('event', 'run', 'task'));
alter table public.calendar_events add constraint calendar_task_check check (
    (kind in ('run', 'task') and run_day is not null and not all_day and ends_at - starts_at between interval '1 minute' and interval '8 hours')
    or (kind = 'event' and run_day is null and task_title is null and task_series_id is null)
);
drop index public.calendar_run_day;
create unique index calendar_task_day on public.calendar_events(run_day, coalesce(task_series_id::text, task_title, 'Run')) where kind in ('run', 'task');
create or replace function public.stellar_calendar_guard() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
    perform pg_advisory_xact_lock(1937006962, 1);
    if TG_OP = 'DELETE' then return OLD; end if;
    NEW.updated_at := clock_timestamp();
    if NEW.kind in ('run', 'task') then
        NEW.run_day := (NEW.starts_at at time zone NEW.time_zone)::date;
        if exists (select 1 from public.calendar_events e where e.id <> NEW.id
            and e.starts_at < NEW.ends_at and e.ends_at > NEW.starts_at) then
            raise exception 'calendar_run_conflict' using errcode = '23P01';
        end if;
    end if;
    return NEW;
end;
$$;
commit;
notify pgrst, 'reload schema';
