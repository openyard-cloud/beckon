// Five-field cron ("minute hour day-of-month month day-of-week") evaluated in a time zone.
// Supports *, numbers, ranges (1-5), lists (1,15) and steps (*/10, 0-30/5). Day of week is
// 0-7 with both 0 and 7 meaning Sunday. When both day fields are restricted, either may match,
// as in classic cron.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron ${name}: "${part}" is not understood`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron ${name}: "${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" needs 5 fields: minute hour day-of-month month day-of-week`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')],
  };
}

export function cronMatches(cron, date, timeZone = 'UTC') {
  const t = zonedParts(date, timeZone);
  if (!cron.minute.has(t.minute) || !cron.hour.has(t.hour) || !cron.month.has(t.month)) return false;
  const domOk = cron.dom.has(t.day);
  const dowOk = cron.dow.has(t.weekday);
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dowOk;
  if (cron.dowAny) return domOk;
  return domOk || dowOk;
}

export function minuteKey(date, timeZone = 'UTC') {
  const t = zonedParts(date, timeZone);
  return `${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}`;
}
