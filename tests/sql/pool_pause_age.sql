begin;
set local role service_role;
set local time zone 'America/Los_Angeles';

do $$
declare star public.pool_tasks%rowtype; deadline timestamptz;
begin
  insert into public.pool_tasks(title, created_at, resolved_at)
    values ('Paused test star', now() - interval '2304 hours', now() - interval '168 hours')
    returning * into star;
  if exists (select 1 from public.stellar_warning_events(now(), 'UTC') where event_key = star.id::text) then
    raise exception 'Resolved stars must not get collapse warnings';
  end if;
  update public.pool_tasks set resolved_at = null where id = star.id returning * into star;
  if star.created_at <> now() - interval '2304 hours' or star.age_started_at <> now() - interval '2136 hours' then
    raise exception 'Restoration must keep the creation date and resume the paused age';
  end if;
  select expires_at into deadline from public.stellar_warning_events(now(), 'UTC')
    where kind = 'collapse' and event_key = star.id::text;
  if deadline is distinct from now() + interval '24 hours' then
    raise exception 'The collapse warning must use the effective age';
  end if;
  update public.pool_tasks set resolved_at = now() - interval '2 hours' where id = star.id;
  update public.pool_tasks set resolved_at = null where id = star.id returning * into star;
  if star.age_started_at <> now() - interval '2136 hours' + interval '2 hours' then
    raise exception 'A second resolution must add only the second pause';
  end if;
  update public.pool_tasks set title = 'Renamed test star' where id = star.id returning * into star;
  if star.age_started_at <> now() - interval '2136 hours' + interval '2 hours' then
    raise exception 'An ordinary update must not change the effective age';
  end if;
  insert into public.pool_tasks(title, created_at, resolved_at)
    values ('Daylight change test star', '2026-10-30 12:00Z', now() - interval '240 hours')
    returning * into star;
  update public.pool_tasks set resolved_at = null where id = star.id returning * into star;
  if star.age_started_at <> '2026-11-09 12:00Z'::timestamptz then
    raise exception 'The paused duration must use actual hours across daylight saving time';
  end if;
end;
$$;
rollback;
