-- Tiny, durable revision counters let every device detect changes without
-- repeatedly downloading task history. Statement triggers share the data
-- transaction, including writes from outside the app. No task rows are changed.
begin;
create table if not exists public.stellar_changes (
    scope text primary key check (scope in ('records','definitions','pool')),
    version bigint not null default 0
);
insert into public.stellar_changes(scope) values ('records'),('definitions'),('pool')
    on conflict (scope) do nothing;
alter table public.stellar_changes enable row level security;
revoke all on public.stellar_changes from anon, authenticated;
grant select on public.stellar_changes to service_role;
create or replace function public.stellar_record_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare changed_scope text;
begin
    changed_scope := case TG_TABLE_NAME
        when 'task_history' then 'records'
        when 'recurring_tasks' then 'definitions'
        when 'pool_tasks' then 'pool'
        when 'pool_edges' then 'pool'
    end;
    update public.stellar_changes set version = version + 1 where scope = changed_scope;
    return null;
end;
$$;
revoke all on function public.stellar_record_change() from public, anon, authenticated;
drop trigger if exists stellar_changes_history on public.task_history;
create trigger stellar_changes_history after insert or update or delete or truncate
    on public.task_history for each statement execute function public.stellar_record_change();
drop trigger if exists stellar_changes_definitions on public.recurring_tasks;
create trigger stellar_changes_definitions after insert or update or delete or truncate
    on public.recurring_tasks for each statement execute function public.stellar_record_change();
drop trigger if exists stellar_changes_pool on public.pool_tasks;
create trigger stellar_changes_pool after insert or update or delete or truncate
    on public.pool_tasks for each statement execute function public.stellar_record_change();
drop trigger if exists stellar_changes_edges on public.pool_edges;
create trigger stellar_changes_edges after insert or update or delete or truncate
    on public.pool_edges for each statement execute function public.stellar_record_change();
commit;
notify pgrst, 'reload schema';
