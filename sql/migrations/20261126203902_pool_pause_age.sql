-- Keep the creation date and shift the lifecycle only by time spent resolved.
begin;

alter table public.pool_tasks add column if not exists age_started_at timestamptz;

create or replace function public.stellar_resume_star_age()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.age_started_at = coalesce(old.age_started_at, old.created_at)
    + make_interval(secs => greatest(extract(epoch from now() - old.resolved_at), 0)::double precision);
  return new;
end;
$$;
revoke all on function public.stellar_resume_star_age() from public, anon, authenticated;

drop trigger if exists stellar_resume_star_age on public.pool_tasks;
create trigger stellar_resume_star_age before update of resolved_at on public.pool_tasks
for each row when (old.resolved_at is not null and new.resolved_at is null)
execute function public.stellar_resume_star_age();

create or replace function public.stellar_warning_events(at_time timestamptz, app_tz text)
returns table(kind text, event_key text, expires_at timestamptz, title text, url text)
language sql stable set search_path = '' as $$
  with days as (
    select (at_time at time zone app_tz)::date + offset_days as day
    from (values (-1), (0), (1)) as offsets(offset_days)
  ), scheduled as (
    select d.day, coalesce(r.series_id, r.id) as series_id, r.title, r.list_title,
      d.day::timestamp + r.deadline_minutes * interval '1 minute' as clock_time
    from days d
    join public.recurring_tasks r on r.active and r.deleted_at is null
      and (r.starts_on is null or r.starts_on <= d.day)
      and (r.ends_on is null or r.ends_on >= d.day)
    where r.deadline_minutes is not null
  ), deadlines as (
    select s.*, due.utc,
      -- Match the app's first occurrence in an autumn clock overlap.
      s.clock_time - ((due.utc - interval '24 hours') at time zone app_tz
        - (due.utc - interval '24 hours') at time zone 'UTC') as earlier_utc
    from scheduled s
    cross join lateral (select s.clock_time at time zone app_tz as utc) due
  ), daily as (
    select d.*,
      case when (d.earlier_utc at time zone 'UTC') at time zone app_tz = d.clock_time
        then least(d.utc, d.earlier_utc at time zone 'UTC') else d.utc end as due_at
    from deadlines d
  )
  select 'daily', d.series_id::text || ':' || d.day, d.due_at, d.title,
    '/today?day=' || d.day || '&view=day'
  from daily d
  where d.due_at > at_time and d.due_at <= at_time + interval '30 minutes'
    and not exists (
      select 1 from public.task_history h
      where h.day=d.day and h.list_title=d.list_title and h.title=d.title
        and (h.is_completed is true or h.status in ('incomplete','unknown','completed'))
    )
  union all
  select 'collapse', p.id::text, age.started_at + interval '2160 hours', p.title, '/pool?star=' || p.id
  from public.pool_tasks p
  cross join lateral (select coalesce(p.age_started_at, p.created_at) as started_at) age
  where p.resolved_at is null
    and age.started_at > at_time - interval '2160 hours'
    and age.started_at <= at_time - interval '2088 hours';
$$;

notify pgrst, 'reload schema';
commit;
