-- Run against an isolated database after the calendar migration. Every test
-- row rolls back. Check booking boundaries, uniqueness, versions and RLS grants.
begin;
set local role service_role;
insert into public.calendar_events(id,title,starts_at,ends_at,time_zone) values
('00000000-0000-0000-0000-000000000001','Busy','2026-11-18T09:00Z','2026-11-18T10:00Z','UTC');
do $$
begin
    begin
        insert into public.calendar_events(id,title,starts_at,ends_at,time_zone,kind,task_title) values
        ('00000000-0000-0000-0000-000000000002','Run','2026-11-18T09:55Z','2026-11-18T10:05Z','UTC','run','Run');
        raise exception 'Expected occupied running slot to be rejected';
    exception when exclusion_violation then null; end;
end;
$$;
insert into public.calendar_events(id,title,starts_at,ends_at,time_zone,kind,task_title) values
('00000000-0000-0000-0000-000000000003','Run','2026-11-18T10:00Z','2026-11-18T10:10Z','UTC','run','Run');
do $$
declare initial_version timestamptz; changed integer;
begin
    if (select run_day from public.calendar_events where id='00000000-0000-0000-0000-000000000003') <> '2026-11-18'::date then
        raise exception 'Run day must be derived by the database';
    end if;
    begin
        insert into public.calendar_events(id,title,starts_at,ends_at,time_zone,kind,task_title) values
        ('00000000-0000-0000-0000-000000000004','Run','2026-11-18T11:00Z','2026-11-18T11:10Z','UTC','run','Run');
        raise exception 'Expected a duplicate daily run to be rejected';
    exception when unique_violation then null; end;
    select updated_at into initial_version from public.calendar_events where id='00000000-0000-0000-0000-000000000003';
    update public.calendar_events set title='Moved run' where id='00000000-0000-0000-0000-000000000003' and updated_at=initial_version;
    delete from public.calendar_events where id='00000000-0000-0000-0000-000000000003' and updated_at=initial_version;
    get diagnostics changed = row_count;
    if changed <> 0 then raise exception 'An old version must not delete an edited event'; end if;
end;
$$;
insert into public.calendar_events(id,title,starts_at,ends_at,time_zone) values
('00000000-0000-0000-0000-000000000005','Overlapping meeting','2026-11-18T09:30Z','2026-11-18T10:30Z','UTC');
set local role anon;
do $$
begin
    begin
        perform count(*) from public.calendar_events;
        raise exception 'Anonymous calendar access must be denied';
    exception when insufficient_privilege then null; end;
end;
$$;
reset role;
do $$ begin
    if not (select relrowsecurity from pg_class where oid='public.calendar_events'::regclass) then
        raise exception 'Calendar must have RLS enabled';
    end if;
end; $$;
rollback;
