"""Read-only iCalendar subscriptions, fetched without private-network access.

Each HTTPS request pins a validated public address while TLS verifies the feed
hostname. Redirects repeat validation, response size and recurrence expansion are
bounded, and feed URLs never appear in browser responses or error messages.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import http.client
import ipaddress
import socket
import ssl
from urllib.parse import urljoin, urlsplit
from zoneinfo import ZoneInfo

from fastapi import HTTPException


def download(url):
    if url.startswith('webcal://'): url = 'https://' + url[9:]
    for _ in range(4):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
            raise HTTPException(400, 'Use an HTTPS calendar subscription link')
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
            raise HTTPException(400, 'Use a publicly hosted calendar subscription')
        connection = http.client.HTTPSConnection(parsed.hostname, timeout=8)
        try:
            raw = socket.create_connection((addresses[0][4][0], 443), timeout=8)
            try: connection.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname)
            except Exception: raw.close(); raise
            connection.request('GET', (parsed.path or '/') + ('?' + parsed.query if parsed.query else ''),
                               headers={'Accept': 'text/calendar', 'Accept-Encoding': 'identity', 'User-Agent': 'Stellar-Calendar/1.0'})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location: break
                url = urljoin(url, location); continue
            if response.status != 200 or response.getheader('Content-Encoding', 'identity') != 'identity': break
            data = response.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise HTTPException(400, 'This calendar subscription is too large')
            if b'BEGIN:VCALENDAR' not in data[:1024]:
                raise HTTPException(400, 'This link does not contain an iCalendar feed')
            return data
        finally:
            connection.close()
    raise HTTPException(503, 'The calendar subscription could not be downloaded')


def read_events(data, first, last, zone):
    from icalendar import Calendar
    import recurring_ical_events
    try:
        calendar = Calendar.from_ical(data)
        definitions = calendar.walk('VEVENT')
        if len(definitions) > 1000: raise ValueError()
        for event in definitions:
            rule = event.get('RRULE')
            if rule and (str(rule.get('FREQ', [''])[0]) not in ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') or
                         any(name in rule for name in ('BYSECOND', 'BYMINUTE', 'BYHOUR'))):
                raise ValueError()
        result = []
        for event in recurring_ical_events.of(calendar).between(datetime.fromisoformat(first), datetime.fromisoformat(last)):
            if str(event.get('STATUS', '')).upper() == 'CANCELLED': continue
            start = event.decoded('DTSTART'); end = event.decoded('DTEND', start + (timedelta(0) if isinstance(start, datetime) else timedelta(days=1)))
            all_day = not isinstance(start, datetime)
            if all_day:
                start = datetime.combine(start, datetime.min.time(), ZoneInfo(zone))
                end = datetime.combine(end, datetime.min.time(), ZoneInfo(zone))
            if start.tzinfo is None: start = start.replace(tzinfo=ZoneInfo(zone))
            if end.tzinfo is None: end = end.replace(tzinfo=ZoneInfo(zone))
            result.append({'id': str(event.get('UID', 'event')) + ':' + start.isoformat(), 'summary': str(event.get('SUMMARY', 'Busy')),
                           'description': str(event.get('DESCRIPTION', '')), 'start': {'dateTime': start.isoformat()},
                           'end': {'dateTime': end.isoformat()}, 'isAllDay': all_day,
                           'showAs': 'free' if str(event.get('TRANSP', '')).upper() == 'TRANSPARENT' else 'busy',
                           '@odata.etag': str(event.get('LAST-MODIFIED', ''))})
            if len(result) > 2000: raise ValueError()
        return result
    except Exception:
        raise HTTPException(400, 'This calendar feed has too many events or unsupported recurrence rules') from None
