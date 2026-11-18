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

function dateStamp(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

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

  for (const event of events) {
    const start = parseDate(event && event.date);
    if (!start) {
      console.warn(`Skipping an event with a missing or invalid date: ${JSON.stringify(event)}`);
      continue;
    }
    // All-day events: the end date is the day after the start date.
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    let id = `${dateStamp(start)}-${slug(event.title)}`;
    let n = 2;
    while (usedIds.has(id)) id = `${dateStamp(start)}-${slug(event.title)}-${n++}`;
    usedIds.add(id);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${id}@${SITE}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${dateStamp(start)}`,
      `DTEND;VALUE=DATE:${dateStamp(end)}`,
      `SUMMARY:${escapeText(event.title || 'Club event')}`,
    );
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    lines.push(`URL:https://${SITE}/`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
    included++;
  }

  lines.push('END:VCALENDAR');

  fs.writeFileSync(OUTPUT_FILE, lines.map(foldLine).join('\r\n') + '\r\n', 'utf8');
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_FILE)} with ${included} event(s).`);
}

build();
