'use strict';
/**
 * A five-field cron, for a watch that runs a routine rather than polling a page: `minute hour
 * day-of-month month day-of-week`, with `*`, lists, ranges, steps and the usual three-letter month
 * and day names (`mon-fri`, `jan`). Day-of-month and day-of-week follow the classic rule: when both
 * are restricted either may match; when one is `*` only the other decides.
 *
 * Time zones are Node's own Intl data (no table of ours), so a schedule in Europe/Berlin follows
 * the clock changes; the two-pass wall-clock conversion settles the offset for the day it is on.
 * The floor is fifteen minutes between two occurrences (the same floor Watch's cadence has): a
 * `*​/5` cron is refused at save, never silently throttled.
 *
 *   parse(expr) → { minutes, hours, days, months, weekdays, dayAny, weekdayAny }
 *   next(expr, timezone, afterMs) → ms of the first occurrence strictly after afterMs | null
 *   validate(expr, timezone) → { valid, error, next_at }
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MIN_EVERY_MS = 15 * 60_000;
const MAX_DAYS = 1500;   // enough for any calendar rule, including the 29 February gap

const ZONE_PARTS = { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };

function isZone(zone) {
    if (typeof zone !== 'string' || !zone.trim()) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() }); return true; } catch { return false; }
}

function partsInZone(date, zone) {
    const out = {};
    for (const part of new Intl.DateTimeFormat('en-US', { ...ZONE_PARTS, timeZone: zone }).formatToParts(date)) {
        if (part.type !== 'literal') out[part.type] = part.value;
    }
    return {
        year: Number(out.year), month: Number(out.month), day: Number(out.day),
        hour: Number(out.hour) % 24, minute: Number(out.minute), second: Number(out.second),
    };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetMs(date, zone) {
    const p = partsInZone(date, zone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in a zone (two passes settle the offset, DST included). */
function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, zone) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
    let ts = wall - offsetMs(new Date(wall), zone);
    ts = wall - offsetMs(new Date(ts), zone);
    return new Date(ts);
}

function parseField(text, { min, max, names = null, weekday = false }) {
    const out = new Set();
    const source = String(text || '').trim().toLowerCase();
    if (!source) throw new Error('an empty cron field');
    for (const part of source.split(',')) {
        if (!part) throw new Error(`bad cron field "${source}"`);
        const [rangeText, stepText] = part.split('/');
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new Error(`bad cron step "${part}"`);
        let lo, hi;
        if (rangeText === '*' || rangeText === '?') { lo = min; hi = max; }
        else {
            const [a, b] = rangeText.split('-');
            const value = (v) => {
                const n = names && Object.prototype.hasOwnProperty.call(names, v) ? names[v] : (/^\d+$/.test(v) ? Number(v) : NaN);
                if (!Number.isInteger(n)) throw new Error(`bad cron value "${v}"`);
                return n;
            };
            lo = value(a);
            hi = b === undefined ? (stepText === undefined ? lo : max) : value(b);
            if (weekday) { if (lo === 7) lo = 0; if (hi === 7) hi = 0; }
            if (lo < min || lo > max || hi < min || hi > max || lo > hi) {
                if (!(weekday && lo === 0 && hi === 6 && rangeText.includes('7'))) throw new Error(`cron value out of range in "${part}"`);
            }
        }
        for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
}

function parse(expr) {
    const fields = String(expr || '').trim().split(/\s+/);
    if (fields.length !== 5) throw new Error('a cron has five fields: minute hour day-of-month month day-of-week');
    return {
        expr: fields.join(' '),
        minutes: parseField(fields[0], { min: 0, max: 59 }),
        hours: parseField(fields[1], { min: 0, max: 23 }),
        days: parseField(fields[2], { min: 1, max: 31 }),
        months: parseField(fields[3], { min: 1, max: 12, names: MONTHS }),
        weekdays: parseField(fields[4], { min: 0, max: 6, names: DAYS, weekday: true }),
        dayAny: fields[2] === '*' || fields[2] === '?',
        weekdayAny: fields[4] === '*' || fields[4] === '?',
    };
}

const sorted = (set) => [...set].sort((a, b) => a - b);

/** The first occurrence strictly after `afterMs` in `timezone`; null when the rule never runs. */
function next(expr, timezone, afterMs = Date.now()) {
    const rule = typeof expr === 'string' ? parse(expr) : expr;
    const zone = isZone(timezone) ? timezone : 'UTC';
    const after = Number(afterMs) || Date.now();
    const start = partsInZone(new Date(after), zone);
    const hours = sorted(rule.hours);
    const minutes = sorted(rule.minutes);
    for (let offset = 0; offset <= MAX_DAYS; offset += 1) {
        const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        if (!rule.months.has(month)) continue;
        const weekday = date.getUTCDay();
        const byDay = rule.days.has(day);
        const byWeekday = rule.weekdays.has(weekday);
        const dayMatches = rule.dayAny && rule.weekdayAny ? true
            : rule.dayAny ? byWeekday
                : rule.weekdayAny ? byDay
                    : byDay || byWeekday;
        if (!dayMatches) continue;
        for (const hour of hours) {
            for (const minute of minutes) {
                const at = zonedToUtc({ year, month, day, hour, minute }, zone).getTime();
                if (at > after) return at;
            }
        }
    }
    return null;
}

/** Whether the rule is usable: a zone Node knows, an occurrence within reach, and 15 minutes or more between runs. */
function validate(expr, timezone = 'UTC') {
    if (!isZone(timezone)) return { valid: false, error: `unknown time zone "${timezone}"`, next_at: null };
    let rule;
    try { rule = parse(expr); } catch (err) { return { valid: false, error: err.message, next_at: null }; }
    const now = Date.now();
    const first = next(rule, timezone, now);
    if (first == null) return { valid: false, error: 'this cron never runs', next_at: null };
    let previous = first;
    for (let i = 0; i < 4; i += 1) {
        const following = next(rule, timezone, previous);
        if (following == null) break;
        if (following - previous < MIN_EVERY_MS) {
            return { valid: false, error: `the smallest interval is 15 minutes; this cron runs again after ${Math.round((following - previous) / 1000)} seconds`, next_at: new Date(first).toISOString() };
        }
        previous = following;
    }
    return { valid: true, error: null, next_at: new Date(first).toISOString() };
}

module.exports = { parse, next, validate, isZone, MIN_EVERY_MS, partsInZone, zonedToUtc };
