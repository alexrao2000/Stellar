# Calendar connections and task planning

Calendar supports Google Calendar and Outlook account connections, plus read-only
HTTPS iCalendar subscriptions. Account connections use OAuth; passwords and access
tokens never go into the browser. Event data is read on demand and held in memory,
not copied into task history. Open Calendar refreshes connected calendars about
every minute. It pauses refreshes when its tab is inactive.

Before authorization, **Allow edits from Stellar** is off with a read-only
suggestion. Turning it on requests provider write permission. After authorization,
choose which calendars appear, and optionally a suggested destination for new
events. Every event editor displays its destination. Existing Stellar events are
not automatically exported. A connection can be downgraded to read-only or
disconnected without deleting provider events. Upgrading requires authorization
again. Google and Microsoft may retain the provider-side grant after disconnect;
remove it in their account permissions if desired.

Private subscription links work with providers that expose HTTPS `.ics` feeds.
Subscriptions support expanded recurring events and remain read-only. High-frequency
recurrences, oversized feeds and private-network addresses are rejected.

## App configuration

Before migrating, export database roles, schema and data to a private directory
outside the repository. Check the export and retain its checksums so the original
calendar can be restored if necessary.

Apply the [calendar connection migration](../sql/migrations/20261124230019_calendar_connections_and_task_planning.sql)
after the original calendar migration. Its tables have RLS enabled and no grants
for browser roles. Only the existing authenticated server accesses them.

Configure these **server-only** environment variables for each deployment environment:

| Variable | Value |
| --- | --- |
| `CALENDAR_PUBLIC_URL` | The app’s canonical HTTPS origin, with no trailing path |
| `CALENDAR_TOKEN_KEY` | A persistent Fernet encryption key, generated once and kept secret |
| `GOOGLE_CALENDAR_CLIENT_ID` | Google OAuth **Web application** client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | That client’s secret |
| `MICROSOFT_CALENDAR_CLIENT_ID` | Microsoft Entra application/client ID |
| `MICROSOFT_CALENDAR_CLIENT_SECRET` | That application’s client secret value |

Generate the key using `cryptography.fernet.Fernet.generate_key()` in a trusted
local process. Send it directly into the hosting platform’s secret input; do not
paste it into chat, commit it, or print it in build logs. Retain it across releases:
replacing it makes stored connections unreadable. Use different keys and separate
OAuth clients for isolated environments.

The app remains usable before providers are configured. The connection dialog
explains that account connections are not yet enabled. No fake sign-in succeeds.
Deploy after changing environment variables.

## Google setup

1. Open [Google Cloud’s API Library](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   in the project that will own Stellar’s OAuth client, and enable Google Calendar API.
2. Configure the OAuth consent screen and audience. For testing, add the permitted
   test accounts. Review Google’s publishing and verification requirements before
   enabling accounts outside your test audience.
3. In [Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients),
   create a **Web application** OAuth client.
4. Add this exact authorized redirect URI, replacing the origin with the deployed app:
   `https://YOUR-APP/api/calendar/oauth/google/callback`.
5. Store the client ID and secret using the environment variables above. Redeploy,
   then open Calendar → Calendars → Google Calendar in Stellar.
6. Choose read-only or two-way access before continuing, grant the requested access,
   then select calendars and save preferences.

Read-only requests `calendar.readonly`. Two-way additionally requests
`calendar.events`. Offline access is requested to refresh tokens. An old desktop
client used by import scripts is separate and cannot serve as this web OAuth client.
See [Google’s web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

## Outlook setup

1. Open [Microsoft Entra → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
   and create an app registration.
2. For personal Outlook accounts as well as work/school accounts, choose the account
   audience that includes organizational directories **and personal Microsoft accounts**.
3. Add a **Web** redirect URI:
   `https://YOUR-APP/api/calendar/oauth/outlook/callback`.
4. Add delegated Microsoft Graph `Calendars.Read`, `Calendars.ReadWrite` and
   `offline_access` permissions. Stellar requests read or write access according to
   the toggle, not all permissions on every connection. Organization policy may
   require administrator consent.
5. Create a client secret. Store its **value**, not its secret ID, along with the
   application/client ID in the environment variables above. Redeploy.
6. Connect from Stellar, choose the access mode, select calendars and save.

See [Microsoft’s authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
and [calendar permissions](https://learn.microsoft.com/en-us/graph/permissions-reference#calendarsreadwrite).

## Task scheduling settings

In **Settings → Task planning**, enable suggestions per task and configure:

- Duration, earliest start, latest finish, and time free around other events.
- Any weather, dry conditions, or sunshine with dry conditions.
- Optional daylight-only, feels-like temperature limits, rain probability and gust limits.

A finish time before the earliest start represents an overnight window. The task’s
existing day coverage, recorded outcome and deadline still apply. Rules follow task
series identity across renames and do not rewrite historical completion records.

Calendar shows up to three alternatives for the selected task. Indoor tasks can be
planned without a forecast. Outdoor requirements must hold throughout the entire
slot. All selected calendars must load successfully before any new suggestions are
shown. Free/declined events do not block time. Suggestions reserve nothing until
confirmed, and booking does not complete the task. External calendars can still
change concurrently; conflicting booked tasks are marked when the next refresh
arrives. Editing a recurring provider event changes that occurrence only. Changes
to events with guests may cause the provider to notify those guests.

## Validation

Run the Python suite and `node --test tests/calendar_model.mjs tests/weather_model.mjs`.
Browser checks use an isolated fixture with all APIs intercepted. Provider consent
and end-to-end account access require the registrations above and a consenting
account; mocked checks are not evidence of live authorization.
