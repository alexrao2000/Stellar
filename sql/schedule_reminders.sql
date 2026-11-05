-- Apply after the reminder migration and provision the dispatcher secret in
-- Vault as stellar_reminder_dispatch_secret. No secret value belongs in this file.
-- Cron checks eligibility in the database and calls the worker only when needed.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.dispatch_stellar_reminders()
returns void language plpgsql security definer set search_path = '' as $$
declare credential text;
begin
  if not exists (
    select 1 from public.pool_tasks p cross join public.push_subscriptions s
    left join public.pool_reminder_deliveries d on d.task_id=p.id
      and d.reminder_version=p.reminder_version and d.subscription_id=s.id
    where p.resolved_at is null and p.remind_at<=now() and p.reminder_sent_at is null
      and (d.id is null or (d.status in ('pending','sending') and d.available_at<=now() and d.attempts<8))
  ) then return; end if;
  select decrypted_secret into credential from vault.decrypted_secrets where name='stellar_reminder_dispatch_secret';
  if credential is null then raise exception 'Reminder dispatcher secret is not configured'; end if;
  perform net.http_post(
    url:='https://stellar-record.vercel.app/api/internal/reminders/dispatch',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||credential),
    body:='{}'::jsonb, timeout_milliseconds:=240000
  );
end;
$$;
revoke all on function public.dispatch_stellar_reminders() from public, anon, authenticated;
select cron.schedule('stellar-star-reminders','* * * * *','select public.dispatch_stellar_reminders()');
