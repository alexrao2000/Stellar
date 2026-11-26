begin;
insert into public.push_subscriptions(id, endpoint, subscription, daily_warnings, collapse_warnings) values
  ('00000000-0000-0000-0000-000000000001', 'https://fcm.googleapis.com/demo-a', '{}', true, false),
  ('00000000-0000-0000-0000-000000000002', 'https://fcm.googleapis.com/demo-b', '{}', false, true),
  ('00000000-0000-0000-0000-000000000003', 'https://fcm.googleapis.com/demo-c', '{}', false, false);

insert into public.recurring_tasks(title, deadline_minutes, starts_on, ends_on)
  select title, (extract(hour from due)*60+extract(minute from due))::int, due::date, due::date
  from (values ('Due soon'),('Done'),('Unknown'),('Incomplete'),('Unreported')) t(title)
  cross join (select (now() + interval '20 minutes') at time zone 'UTC' due) clock_time;
insert into public.task_history(day,list_title,title,status,is_completed)
  select starts_on, 'Daily', title,
    case title when 'Done' then 'completed' else lower(title) end,
    title='Done'
  from public.recurring_tasks where title in ('Done', 'Unknown', 'Incomplete', 'Unreported');
insert into public.pool_tasks(title, created_at, resolved_at) values
  ('Approaching', now()-interval '89 days', null),
  ('Resolved', now()-interval '89 days', now()),
  ('Collapsed', now()-interval '90 days', null),
  ('Too early', now()-interval '86 days', null);

insert into public.recurring_tasks(title, deadline_minutes, starts_on, ends_on) values
  ('Overnight', 1470, '2026-11-21', '2026-11-21'),
  ('Fall overlap', 90, '2026-11-01', '2026-11-01'),
  ('Spring gap', 150, '2026-03-08', '2026-03-08');
set local role service_role;
do $$
declare returned text[]; test_token uuid;
begin
  select array_agg(title order by title) into returned from public.stellar_warning_events(now(), 'UTC');
  if returned is distinct from array['Approaching','Due soon','Unreported'] then raise exception 'eligibility mismatch: %', returned; end if;
  if not exists (select 1 from public.stellar_warning_events('2026-11-22 08:08Z','America/Los_Angeles') where title='Overnight' and url='/today?day=2026-11-21&view=day') then raise exception 'overnight deadline missing'; end if;
  if not exists (select 1 from public.stellar_warning_events('2026-11-01 08:10Z','America/Los_Angeles') where title='Fall overlap' and expires_at='2026-11-01 08:30Z') then raise exception 'first overlap deadline missing'; end if;
  if not exists (select 1 from public.stellar_warning_events('2026-03-08 10:10Z','America/Los_Angeles') where title='Spring gap' and expires_at='2026-03-08 10:30Z') then raise exception 'spring deadline missing'; end if;
  select array_agg(kind order by kind) into returned from public.claim_stellar_warnings('UTC');
  if returned is distinct from array['collapse','daily','daily'] then raise exception 'subscription gating mismatch: %', returned; end if;
  if exists (select 1 from public.claim_stellar_warnings('UTC')) then raise exception 'leased duplicates'; end if;
  select claim_token into test_token from public.stellar_warning_deliveries where kind='collapse';
  if not exists(select 1 from public.stellar_warning_for_delivery('UTC',test_token) where title='Approaching') then raise exception 'collapse delivery missing'; end if;
  update public.pool_tasks set resolved_at=now() where title='Approaching';
  if exists(select 1 from public.stellar_warning_for_delivery('UTC',test_token)) then raise exception 'resolved warning still eligible'; end if;
  select claim_token into test_token from public.stellar_warning_deliveries where kind='daily' limit 1;
  update public.push_subscriptions set daily_warnings=false;
  if exists(select 1 from public.stellar_warning_for_delivery('UTC',test_token)) then raise exception 'opted-out warning still eligible'; end if;
  if has_function_privilege('anon','public.claim_stellar_warnings(text,integer)','execute') or has_table_privilege('authenticated','public.stellar_warning_deliveries','select') then raise exception 'warning queue accessible to browser roles'; end if;
end;
$$;
rollback;
