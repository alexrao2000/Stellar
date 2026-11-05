-- Run after the reminder migration. Every fixture and delivery rolls back.
begin;
do $$
declare task bigint := -txid_current(); sub uuid; again uuid; old_job record; new_job record; rev uuid := gen_random_uuid();
begin
  if has_function_privilege('anon','public.claim_stellar_reminders(integer)','execute') then raise exception 'Anonymous queue access'; end if;
  if has_table_privilege('authenticated','public.push_subscriptions','select') then raise exception 'Subscription disclosure'; end if;
  select id into sub from public.register_stellar_push('{"endpoint":"https://fcm.googleapis.com/stellar-queue-test","keys":{}}');
  select id into again from public.register_stellar_push('{"endpoint":"https://fcm.googleapis.com/stellar-queue-test","keys":{}}');
  if sub<>again then raise exception 'Duplicate subscription'; end if;
  insert into public.pool_tasks(id,title,remind_at) values(task,'Reminder queue regression',now()-interval '1 minute');
  select * into old_job from public.claim_stellar_reminders(100) where task_id=task and subscription_id=sub;
  if old_job.delivery_id is null then raise exception 'Due reminder not claimed'; end if;
  if exists(select 1 from public.claim_stellar_reminders(100) where task_id=task and subscription_id=sub) then raise exception 'Active lease claimed twice'; end if;
  perform public.finish_stellar_reminder(old_job.delivery_id,gen_random_uuid(),'sent');
  if (select status from public.pool_reminder_deliveries where id=old_job.delivery_id)<>'sending' then raise exception 'Wrong claim token accepted'; end if;
  update public.pool_tasks set reminder_version=rev where id=task;
  perform public.finish_stellar_reminder(old_job.delivery_id,old_job.claim_token,'sent');
  if (select reminder_sent_at from public.pool_tasks where id=task) is not null then raise exception 'Old schedule completed new reminder'; end if;
  select * into new_job from public.claim_stellar_reminders(100) where task_id=task and subscription_id=sub;
  if new_job.delivery_id is null or new_job.delivery_id=old_job.delivery_id then raise exception 'Reschedule did not create new delivery'; end if;
  perform public.finish_stellar_reminder(new_job.delivery_id,new_job.claim_token,'retry');
  if exists(select 1 from public.claim_stellar_reminders(100) where task_id=task and subscription_id=sub) then raise exception 'Retry ignored backoff'; end if;
  update public.pool_reminder_deliveries set available_at=now()-interval '1 minute' where id=new_job.delivery_id;
  select * into new_job from public.claim_stellar_reminders(100) where task_id=task and subscription_id=sub;
  perform public.finish_stellar_reminder(new_job.delivery_id,new_job.claim_token,'sent');
  if (select reminder_sent_at from public.pool_tasks where id=task) is null then raise exception 'Successful reminder not completed'; end if;
  update public.pool_tasks set remind_at=now()-interval '1 minute',reminder_version=gen_random_uuid(),reminder_sent_at=null,resolved_at=now() where id=task;
  if exists(select 1 from public.claim_stellar_reminders(100) where task_id=task) then raise exception 'Resolved star reminded'; end if;
  update public.pool_tasks set resolved_at=null,remind_at=null where id=task;
  if exists(select 1 from public.claim_stellar_reminders(100) where task_id=task) then raise exception 'Cleared reminder sent'; end if;
  delete from public.pool_tasks where id=task;
  if exists(select 1 from public.pool_reminder_deliveries where task_id=task) then raise exception 'Deleted star left deliveries'; end if;
end $$;
rollback;
select 'Reminder queue regression passed; fixtures rolled back' as result;
