-- Run against an isolated fixture database after the live_changes migration.
-- Statement counters include all mutation types and roll back with the write.
begin;
do $$
declare before_version bigint;
begin
  if has_table_privilege('anon','public.stellar_changes','select') then raise exception 'Anonymous revision access'; end if;
  if has_table_privilege('authenticated','public.stellar_changes','select') then raise exception 'Direct revision access'; end if;
  if has_function_privilege('anon','public.stellar_record_change()','execute') then raise exception 'Anonymous trigger access'; end if;
  if not has_table_privilege('service_role','public.stellar_changes','select') then raise exception 'Server cannot read revisions'; end if;
  select version into before_version from public.stellar_changes where scope='records';
  insert into public.task_history(id) values(1),(2);
  if (select version from public.stellar_changes where scope='records')<>before_version+1 then raise exception 'Insert must count once per statement'; end if;
  update public.task_history set id=id+1;
  delete from public.task_history;
  truncate public.task_history;
  if (select version from public.stellar_changes where scope='records')<>before_version+4 then raise exception 'Mutation types missing'; end if;
  begin
    insert into public.task_history(id) values(3);
    raise exception 'test rollback';
  exception when raise_exception then null;
  end;
  if (select version from public.stellar_changes where scope='records')<>before_version+4 then raise exception 'Rollback left a change'; end if;
  insert into public.recurring_tasks(id) values(1);
  insert into public.pool_tasks(id) values(1);
  insert into public.pool_edges(id) values(1);
  if (select version from public.stellar_changes where scope='definitions')<>1 then raise exception 'Definitions did not count'; end if;
  if (select version from public.stellar_changes where scope='pool')<>2 then raise exception 'Both pool tables must count'; end if;
end $$;
rollback;
select 'Live change triggers passed; fixture mutations rolled back' as result;
