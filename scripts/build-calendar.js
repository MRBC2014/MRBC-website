// Builds the club's calendar feed (events.ics) from the events list (_data/events.json).
//
// People subscribe to events.ics in Google Calendar or Apple Calendar.
// This runs automatically on GitHub whenever the events list changes
// (see .github/workflows/build-calendar.yml). It needs nothing installed
// beyond Node.js, which GitHub provides.
//
// To run it by hand: node scripts/build-calendar.js

const fs = require('fs');
const path = require('path');

const SITE = 'macedonrangesbrewclub.com.au';
const ROOT = path.join(__dirname, '..');
const EVENTS_FILE = path.join(ROOT, '_data', 'events.json');
const OUTPUT_FILE = path.join(ROOT, 'events.ics');

// Characters that have a special meaning in calendar files must be "escaped".
function escapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Calendar files require long lines to be wrapped at 75 bytes,
// with each continuation line starting with a space.
function foldLine(line) {
  const parts = [];
  let current = '';
  let currentBytes = 0;
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    const limit = parts.length === 0 ? 75 : 74; // continuation lines lose 1 byte to the leading space
    if (currentBytes + charBytes > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

// Turns "2026-11-19" into a real date, or null if it isn't a valid date.
function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (date.getUTCMonth() !== +match[2] - 1) return null; // e.g. 31 February
  return date;
}

// Turns "14:00" (or "2:00 PM") into minutes after midnight, or null if blank/invalid.
function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(String(value || '').trim());
  if (!match) return null;
  let hours = +match[1];
  const minutes = +match[2];
  const ampm = match[3] && match[3][0].toLowerCase();
  if (ampm) {
    if (hours < 1 || hours > 12) return null;
    if (ampm === 'p' && hours !== 12) hours += 12;
    if (ampm === 'a' && hours === 12) hours = 0;
  }
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function dateStamp(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// "20261205T140000" for a date plus a number of minutes (which may run past midnight).
function dateTimeStamp(date, minutes) {
  const d = new Date(date.getTime() + minutes * 60 * 1000);
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '');
}

const TIMEZONE = 'Australia/Melbourne';
const DEFAULT_LENGTH_MINUTES = 2 * 60; // used when an event has a start time but no end time

// Melbourne's time zone rules (daylight saving starts on the first Sunday in
// October and ends on the first Sunday in April), so calendar apps place
// timed events correctly.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${TIMEZONE}`,
  `X-LIC-LOCATION:${TIMEZONE}`,
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+1100',
  'TZOFFSETTO:+1000',
  'TZNAME:AEST',
  'DTSTART:19700405T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+1000',
  'TZOFFSETTO:+1100',
  'TZNAME:AEDT',
  'DTSTART:19701004T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

// A short, stable name for each event so calendar apps can recognise it
// again next time they check the feed.
function slug(text) {
  return String(text || 'event')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'event';
}

function build() {
  const data = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  const events = Array.isArray(data.events) ? data.events : [];
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Macedon Ranges Brew Club//Events//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Macedon Ranges Brew Club',
    'X-WR-CALDESC:Events from the Macedon Ranges Brew Club',
    'X-WR-TIMEZONE:Australia/Melbourne',
    // Hints asking calendar apps to check for updates every hour.
    // (Apple Calendar respects this; Google Calendar uses its own schedule.)
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  const usedIds = new Set();
  let included = 0;
  let usesTimes = false;
  const timezoneAt = lines.length; // the time zone rules go here if any event has a time

  for (const event of events) {
    const start = parseDate(event && event.date);
    if (!start) {
      console.warn(`Skipping an event with a missing or invalid date: ${JSON.stringify(event)}`);
      continue;
    }
    // Events with a start time are placed at that time (Melbourne time).
    // Events without one are all-day: the end date is the day after the start date.
    const startMinutes = parseTime(event.start_time);
    let whenLines;
    if (startMinutes === null) {
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      whenLines = [`DTSTART;VALUE=DATE:${dateStamp(start)}`, `DTEND;VALUE=DATE:${dateStamp(end)}`];
    } else {
      let endMinutes = parseTime(event.end_time);
      if (endMinutes === null || endMinutes === startMinutes) {
        endMinutes = startMinutes + DEFAULT_LENGTH_MINUTES;
      } else if (endMinutes < startMinutes) {
        endMinutes += 24 * 60; // e.g. 7pm to 1am finishes the next morning
      }
      whenLines = [
        `DTSTART;TZID=${TIMEZONE}:${dateTimeStamp(start, startMinutes)}`,
        `DTEND;TZID=${TIMEZONE}:${dateTimeStamp(start, endMinutes)}`,
      ];
      usesTimes = true;
    }

    let id = `${dateStamp(start)}-${slug(event.title)}`;
    let n = 2;
    while (usedIds.has(id)) id = `${dateStamp(start)}-${slug(event.title)}-${n++}`;
    usedIds.add(id);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${id}@${SITE}`,
      `DTSTAMP:${now}`,
      ...whenLines,
      `SUMMARY:${escapeText(event.title || 'Club event')}`,
    );
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    lines.push(`URL:https://${SITE}/`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
    included++;
  }

  if (usesTimes) lines.splice(timezoneAt, 0, ...VTIMEZONE);
  lines.push('END:VCALENDAR');

  fs.writeFileSync(OUTPUT_FILE, lines.map(foldLine).join('\r\n') + '\r\n', 'utf8');
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_FILE)} with ${included} event(s).`);
}

build();
