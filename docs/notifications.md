# Star reminders

New Pool stars get a single reminder 24 hours after creation. Existing stars keep
no reminder until you set one. Open a star to choose a different local date and
time, reset it to **In 24 hours**, or **Clear** it. Resolving or deleting a star
cancels pending deliveries. Restoring a resolved star does not restore its old
reminder.

Open any star and choose **Enable notifications** on each device you want to
receive reminders. Permission is requested only after that click. **Send test**
sends an immediate notification to that device; **Turn off** removes its
subscription. On iPhone and iPad, open Stellar from its installed Home Screen
icon before enabling notifications.

A notification opens the matching star. Reminders can arrive while Stellar is
closed. Delivery depends on the browser push service, device permissions, and
connectivity; a push already accepted by the push service cannot be recalled.
Notifications may show the star title on the device's lock screen.

## Server setup

After applying the base [schema](../sql/schema.sql), apply the additive
[reminder migration](../sql/migrations/2026-11-04_pool_reminders.sql). It adds
reminder fields, private device subscriptions, and a delivery queue. It does
not schedule existing stars or change their titles, positions, or notes.

Configure these production environment variables:

- `VAPID_PUBLIC_KEY`: URL-safe base64 of an uncompressed P-256 public key.
- `VAPID_PRIVATE_KEY`: base64 DER of the matching P-256 private key.
- `REMINDER_DISPATCH_SECRET`: a separate random server-to-server credential.
- `VAPID_SUBJECT` (optional): a contact URL or `mailto:` address; defaults to the
  Stellar production URL.

Keep the private key and dispatcher credential in the hosting platform's secret
store. Keep the signing key stable across deployments; changing it requires
subscribing devices again. Preview deployments do not receive production push
credentials.

Store the same dispatcher credential in Supabase Vault under
`stellar_reminder_dispatch_secret`, then apply
[the scheduler](../sql/schedule_reminders.sql). For a fork, change the public
worker URL in that file. The database's cron job checks once per minute and
calls the worker only when eligible deliveries exist. Its Vault credential is
separate from database credentials. It does not rely on a browser timer or a
computer staying awake.

The dispatcher accepts only a matching bearer credential. Browser subscription,
test, and reminder APIs use the app's existing authenticated, same-origin write
boundary. Subscriptions are for this single-owner app's allowed account and its
devices; they are not shared across unrelated accounts.

Each reminder revision has a separate delivery per device. Leases keep workers
from claiming a delivery simultaneously. Retryable errors use bounded backoff;
expired subscriptions are removed. Rescheduling invalidates previous revisions.
A device without permission receives nothing; a new subscription can receive
an overdue reminder that has not already been completed.

## Verification

Run `python -m pytest -q` for API, timing, authentication, and encrypted payload
checks. Run [the SQL regression](../tests/sql/pool_reminders.sql) after migration;
it rolls back its fixtures and checks leases, retries, revisions, cancellation,
and permissions.

With a local server running using `AUTH_ENABLED=false VERCEL=1`, run
`node tests/browser/pool_reminders.cjs` with Playwright installed. This replaces
all API and device Push calls with demo data. `PLAYWRIGHT_MODULE`,
`CHROMIUM_EXECUTABLE`, and `STELLAR_TEST_URL` can select a local browser runtime
and test URL. It never sends an OS notification.

Run `node tests/browser/notification_worker.cjs` to verify notification display,
safe links, and focusing an existing app window. Finish real-device setup using
**Enable notifications → Send test** in the deployed app.
