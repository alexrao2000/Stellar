-- Per-device opt-ins and leases for warnings. The existing Pool reminders are independent.
begin;

alter table public.push_subscriptions
  add column if not exists daily_warnings boolean not null default false,
  add column if not exists collapse_warnings boolean not null default false;

create table if not exists public.stellar_warning_deliveries (
  kind text not null check (kind in ('daily', 'collapse')),
  event_key text not null,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  expires_at timestamptz not null,
  available_at timestamptz not null default now(),
  claim_token uuid,
  attempts integer not null default 0,
  finished boolean not null default false,
  primary key (kind, event_key, subscription_id)
);
alter table public.stellar_warning_deliveries enable row level security;
revoke all on public.stellar_warning_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.stellar_warning_deliveries to service_role;

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
  select 'collapse', p.id::text, p.created_at + interval '2160 hours', p.title, '/pool?star=' || p.id
  from public.pool_tasks p
  where p.resolved_at is null
    and p.created_at > at_time - interval '2160 hours'
    and p.created_at <= at_time - interval '2088 hours';
$$;

create or replace function public.claim_stellar_warnings(app_tz text, batch_size integer default 25)
returns table(kind text, event_key text, subscription_id uuid, claim_token uuid)
language plpgsql set search_path = '' as $$
begin
  -- Keep only recent deduplication records, including records with edited deadlines.
  delete from public.stellar_warning_deliveries d where d.expires_at < now() - interval '7 days';

  insert into public.stellar_warning_deliveries as d (kind, event_key, subscription_id, expires_at)
  select e.kind, e.event_key, s.id, e.expires_at
  from public.stellar_warning_events(now(), app_tz) e
  join public.push_subscriptions s on
    (e.kind='daily' and s.daily_warnings) or (e.kind='collapse' and s.collapse_warnings)
  on conflict on constraint stellar_warning_deliveries_pkey
    do update set expires_at=excluded.expires_at where d.expires_at<>excluded.expires_at;

  return query
  with ready as (
    select d.kind, d.event_key, d.subscription_id
    from public.stellar_warning_deliveries d
    join public.stellar_warning_events(now(), app_tz) e using (kind, event_key)
    join public.push_subscriptions s on s.id=d.subscription_id
    where not d.finished and d.available_at<=now() and d.attempts<4
      and ((d.kind='daily' and s.daily_warnings) or (d.kind='collapse' and s.collapse_warnings))
    order by d.expires_at, d.kind, d.event_key, d.subscription_id
    limit greatest(1, least(batch_size, 25)) for update of d skip locked
  )
  update public.stellar_warning_deliveries d set attempts=d.attempts+1,
    claim_token=gen_random_uuid(), available_at=now()+interval '10 minutes'
  from ready r
  where (d.kind, d.event_key, d.subscription_id)=(r.kind, r.event_key, r.subscription_id)
  returning d.kind, d.event_key, d.subscription_id, d.claim_token;
end;
$$;

create or replace function public.stellar_warning_for_delivery(app_tz text, token uuid)
returns table(title text, url text, subscription jsonb, ttl integer)
language sql stable set search_path = '' as $$
  select e.title, e.url, s.subscription, greatest(0, floor(extract(epoch from (e.expires_at - now())))::integer)
  from public.stellar_warning_deliveries d
  join public.stellar_warning_events(now(), app_tz) e using (kind, event_key)
  join public.push_subscriptions s on s.id=d.subscription_id
  where d.claim_token=token and not d.finished
    and ((d.kind='daily' and s.daily_warnings) or (d.kind='collapse' and s.collapse_warnings));
$$;

create index if not exists stellar_warning_claim_token on public.stellar_warning_deliveries(claim_token)
  where claim_token is not null;

revoke all on function public.stellar_warning_events(timestamptz,text),
  public.claim_stellar_warnings(text,integer), public.stellar_warning_for_delivery(text,uuid)
  from public, anon, authenticated;
grant execute on function public.stellar_warning_events(timestamptz,text),
  public.claim_stellar_warnings(text,integer), public.stellar_warning_for_delivery(text,uuid)
  to service_role;

notify pgrst, 'reload schema';
commit;
