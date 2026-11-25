-- Allow confirmed calendar tasks as short as their one-second planning rules.
begin;
set local lock_timeout = '5s';
alter table public.calendar_events
    drop constraint calendar_task_check,
    add constraint calendar_task_check check (
        (kind in ('run', 'task') and run_day is not null and not all_day
         and ends_at - starts_at between interval '1 second' and interval '8 hours')
        or (kind = 'event' and run_day is null and task_title is null and task_series_id is null)
    );
commit;
