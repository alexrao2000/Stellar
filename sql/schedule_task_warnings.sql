-- Apply after the warning migration. Reuses the existing private Vault credential.
-- The check runs in the database so Vercel wakes only for actionable warnings.
create or replace function public.dispatch_stellar_warnings(app_tz text)
returns void language plpgsql security definer set search_path = '' as $$
declare credential text;
begin
  if not exists (select 1 from public.push_subscriptions where daily_warnings or collapse_warnings)
  then return; end if;
  if not exists (
    select 1 from public.stellar_warning_events(now(), app_tz) e
    join public.push_subscriptions s on (e.kind='daily' and s.daily_warnings)
      or (e.kind='collapse' and s.collapse_warnings)
    left join public.stellar_warning_deliveries d on
      d.kind=e.kind and d.event_key=e.event_key and d.subscription_id=s.id
    where d.event_key is null or (not d.finished and d.attempts<4 and d.available_at<=now())
  ) then return; end if;
  select decrypted_secret into credential from vault.decrypted_secrets where name='stellar_reminder_dispatch_secret';
  if credential is null then raise exception 'Reminder dispatcher secret is not configured'; end if;
  perform net.http_post(
    url:='https://stellar-record.vercel.app/api/internal/reminders/dispatch?warnings=true',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||credential),
    body:='{}'::jsonb, timeout_milliseconds:=240000
  );
end;
$$;
revoke all on function public.dispatch_stellar_warnings(text) from public, anon, authenticated;
-- Use the same time zone as the app's LOCAL_TIMEZONE.
select cron.schedule('stellar-task-warnings','*/5 * * * *',
  $$select public.dispatch_stellar_warnings('America/Los_Angeles')$$);
