-- Run after both calendar migrations on a disposable database. All rows roll back.
begin;
set local role service_role;
insert into public.calendar_connections(id,owner_id,provider,secret) values ('00000000-0000-0000-0000-000000000011','demo','google','encrypted-placeholder');
insert into public.task_planning_rules(owner_id,series_id,rule) values ('demo',1,'{"enabled":true,"duration_minutes":45}');
insert into public.calendar_events(id,title,starts_at,ends_at,time_zone,kind,task_title,task_series_id) values
('00000000-0000-0000-0000-000000000012','Study','2026-11-24T18:00Z','2026-11-24T18:45Z','UTC','task','Study',1);
do $$ begin
  begin
    insert into public.calendar_events(id,title,starts_at,ends_at,time_zone,kind,task_title,task_series_id) values
    ('00000000-0000-0000-0000-000000000013','Study','2026-11-24T19:00Z','2026-11-24T19:45Z','UTC','task','Renamed study task',1);
    raise exception 'A rename must not create a second daily reservation';
  exception when unique_violation then null; end;
  begin
    update public.calendar_connections set mode='read', write_calendar_id='calendar';
    raise exception 'Read-only connections cannot have a write destination';
  exception when check_violation then null; end;
end; $$;
set local role anon;
do $$ begin
  begin
    perform count(*) from public.calendar_connections;
    raise exception 'Anonymous users must not access tokens';
  exception when insufficient_privilege then null; end;
end; $$;
set local role authenticated;
do $$ begin
  begin
    perform count(*) from public.task_planning_rules;
    raise exception 'Browser roles must not access planning data directly';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
do $$ begin
  if exists(select 1 from pg_class where oid in ('public.calendar_connections'::regclass,'public.task_planning_rules'::regclass) and not relrowsecurity) then
    raise exception 'All private tables require RLS';
  end if;
  if exists(select 1 from pg_proc where proname='stellar_calendar_touch' and prosecdef) then
    raise exception 'Calendar touch must not bypass RLS';
  end if;
end; $$;
rollback;
