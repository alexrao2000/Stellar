-- Stars retain one current reminder; old deliveries cannot follow a reschedule.
-- Per-device leases prevent overlapping workers from sending the same reminder.
-- Only the server's service role can read subscriptions or invoke queue functions.
begin;
alter table public.pool_tasks add column if not exists remind_at timestamptz;
alter table public.pool_tasks add column if not exists reminder_sent_at timestamptz;
alter table public.pool_tasks add column if not exists reminder_version uuid not null default gen_random_uuid();
create index if not exists pool_tasks_reminders_due on public.pool_tasks(remind_at)
  where resolved_at is null and reminder_sent_at is null;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.pool_reminder_deliveries (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.pool_tasks(id) on delete cascade,
  reminder_version uuid not null,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  claim_token uuid,
  sent_at timestamptz,
  unique(task_id, reminder_version, subscription_id)
);
alter table public.push_subscriptions enable row level security;
alter table public.pool_reminder_deliveries enable row level security;
revoke all on public.push_subscriptions, public.pool_reminder_deliveries from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions, public.pool_reminder_deliveries to service_role;
grant usage, select on sequence public.pool_reminder_deliveries_id_seq to service_role;

create or replace function public.register_stellar_push(payload jsonb)
returns table(id uuid) language sql security definer set search_path = '' as $$
  insert into public.push_subscriptions(endpoint, subscription)
  values (payload->>'endpoint', payload)
  on conflict(endpoint) do update set subscription = excluded.subscription
  returning push_subscriptions.id;
$$;

create or replace function public.claim_stellar_reminders(batch_size integer default 25)
returns table(delivery_id bigint, claim_token uuid, task_id bigint, reminder_version uuid,
              title text, subscription_id uuid, subscription jsonb)
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pool_reminder_deliveries(task_id, reminder_version, subscription_id)
  select p.id, p.reminder_version, s.id
  from public.pool_tasks p cross join public.push_subscriptions s
  where p.resolved_at is null and p.remind_at <= now() and p.reminder_sent_at is null
  on conflict do nothing;

  return query
  with ready as (
    select d.id from public.pool_reminder_deliveries d join public.pool_tasks p on p.id=d.task_id
    where p.resolved_at is null and p.remind_at <= now() and p.reminder_version=d.reminder_version
      and d.status in ('pending','sending') and d.available_at <= now() and d.attempts < 8
    order by p.remind_at, d.id limit greatest(1, least(batch_size,100))
    for update of d skip locked
  ), claimed as (
    update public.pool_reminder_deliveries d set status='sending', attempts=d.attempts+1,
      available_at=now()+interval '5 minutes', claim_token=gen_random_uuid()
    from ready where d.id=ready.id returning d.*
  )
  select c.id,c.claim_token,p.id,p.reminder_version,p.title,s.id,s.subscription
  from claimed c join public.pool_tasks p on p.id=c.task_id
  join public.push_subscriptions s on s.id=c.subscription_id;
end;
$$;

create or replace function public.finish_stellar_reminder(delivery_id bigint, token uuid, outcome text)
returns void language plpgsql security definer set search_path = '' as $$
declare target bigint; revision uuid;
begin
  if outcome not in ('sent','retry','failed') then raise exception 'Invalid delivery outcome'; end if;
  update public.pool_reminder_deliveries d set
    status=case when outcome='retry' and d.attempts<8 then 'pending' when outcome='sent' then 'sent' else 'failed' end,
    sent_at=case when outcome='sent' then now() else null end,
    available_at=now()+least(interval '1 hour', interval '1 minute' * power(2,d.attempts)), claim_token=null
  where d.id=delivery_id and d.claim_token=token and d.status='sending'
  returning d.task_id,d.reminder_version into target,revision;
  if target is null then return; end if;
  update public.pool_tasks p set reminder_sent_at=now()
  where p.id=target and p.reminder_version=revision and p.resolved_at is null
    and exists(select 1 from public.pool_reminder_deliveries d where d.task_id=target and d.reminder_version=revision and d.status='sent')
    and not exists(select 1 from public.pool_reminder_deliveries d where d.task_id=target and d.reminder_version=revision and d.status in ('pending','sending'));
end;
$$;
revoke all on function public.register_stellar_push(jsonb), public.claim_stellar_reminders(integer), public.finish_stellar_reminder(bigint,uuid,text) from public, anon, authenticated;
grant execute on function public.register_stellar_push(jsonb), public.claim_stellar_reminders(integer), public.finish_stellar_reminder(bigint,uuid,text) to service_role;
notify pgrst, 'reload schema';
commit;
