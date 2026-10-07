'use strict';
/**
 * Comparison and conditions (watch.watch@1 $defs/comparison, $defs/condition).
 *
 *   changed   the value differs from the previous observation. No previous observation means it
 *             changed (there is nothing it is equal to). `tolerance` (absolute) and `percent`
 *             apply to numbers: a price that moved less than the tolerance has not changed.
 *   holds     the predicate over the value: gt/gte/lt/lte (numbers, else strings), eq/ne, contains
 *             (a substring, an array member, or a key of an object), matches (a regular expression
 *             over the text), exists/absent.
 *   met       holds AND the predicate has held continuously for `for_sec` seconds. The "since" is
 *             measured from the observations themselves (observations.heldSince), never from a
 *             timer in this process: a restart does not lose a pending debounce.
 *
 * Numeric comparison refuses to guess: a value that is not a number (or a plain decimal string) is
 * never "greater than" anything, and an unknown value is never low (the same rule Deals' watches
 * use). `matches` compiles the watch's own pattern with a length cap and tests a bounded string.
 */
const { canonicalJson } = require('./util');

const MAX_PATTERN = 200;
// Bounded input: the watch's own pattern only ever runs over this much text (see extract.js: a
// value is capped at the same size), so a pathological pattern cannot scan a whole body.
const MAX_TESTED = 65536;

/** The numeric value of a number, or of a string that is exactly a decimal number; else null. */
function asNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

const same = (a, b) => canonicalJson(a) === canonicalJson(b);

function isAbsent(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
}

/** changed: does `value` differ from the previous observation's value? */
function hasChanged({ comparison }, { value, previous }) {
    const mode = (comparison && comparison.mode) || 'changed';
    if (mode === 'none') return false;
    if (!previous) return true;
    const before = previous.value;
    const a = asNumber(value);
    const b = asNumber(before);
    const tolerance = comparison && comparison.tolerance != null ? Number(comparison.tolerance) : null;
    const percent = comparison && comparison.percent != null ? Number(comparison.percent) : null;
    if (a != null && b != null && tolerance != null && Number.isFinite(tolerance)) return Math.abs(a - b) > tolerance;
    if (a != null && b != null && percent != null && Number.isFinite(percent)) return Math.abs(a - b) > Math.abs(b) * (percent / 100);
    return !same(value, before);
}

/** The predicate alone: does the condition hold for this value? */
function holds({ comparison, condition }, { value, previous, changed }) {
    const op = (condition && condition.op) || 'changed';
    const target = condition ? condition.value : null;
    switch (op) {
        case 'changed': return changed;
        case 'gt': case 'gte': case 'lt': case 'lte': {
            const a = asNumber(value);
            const b = target === undefined ? (previous ? asNumber(previous.value) : null) : asNumber(target);
            if (a != null && b != null) {
                if (op === 'gt') return a > b;
                if (op === 'gte') return a >= b;
                if (op === 'lt') return a < b;
                return a <= b;
            }
            if (typeof value === 'string' && typeof target === 'string') {
                if (op === 'gt') return value > target;
                if (op === 'gte') return value >= target;
                if (op === 'lt') return value < target;
                return value <= target;
            }
            return false;
        }
        case 'eq': {
            if (target === undefined || target === null) return isAbsent(value);
            const a = asNumber(value);
            const b = asNumber(target);
            return a != null && b != null ? a === b : same(value, target);
        }
        case 'ne': return !holds({ comparison, condition: { ...condition, op: 'eq' } }, { value, previous, changed });
        case 'contains': {
            if (typeof value === 'string') return typeof target === 'string' && value.includes(target);
            if (Array.isArray(value)) return value.some((v) => same(v, target));
            if (value && typeof value === 'object') return typeof target === 'string' && Object.prototype.hasOwnProperty.call(value, target);
            return false;
        }
        case 'matches': {
            if (typeof value !== 'string' || typeof target !== 'string') return false;
            if (!target || target.length > MAX_PATTERN) return false;
            let re;
            try { re = new RegExp(target); } catch { return false; }
            return re.test(value.slice(0, MAX_TESTED));
        }
        case 'exists': return !isAbsent(value);
        case 'absent': return isAbsent(value);
        default: return false;
    }
}

/**
 * evaluate({ comparison, condition }, { value, previous, heldSince, now })
 *   → { changed, holds, met, since }
 *
 * `previous` is the previous observation ({ value, condition_met, observed_at }) or null;
 * `heldSince` (ms) is when the predicate began holding continuously, from the observation trail —
 * pass it from observations.heldSince(). When the predicate holds and no start is known, it starts
 * now, so a for_sec condition never fires on the first sighting.
 */
function evaluate({ comparison = null, condition = {} } = {}, { value, previous = null, heldSince = null, now = Date.now(), changed: given } = {}) {
    // The caller may know better: a check that got a 304 or an unchanged body knows nothing changed,
    // whatever comparing the values would say.
    const changed = given === undefined ? hasChanged({ comparison }, { value, previous }) : Boolean(given);
    const hold = holds({ comparison, condition }, { value, previous, changed });
    const forSec = condition && Number.isInteger(condition.for_sec) ? Math.max(0, condition.for_sec) : 0;
    const since = hold ? (heldSince != null ? heldSince : now) : null;
    const met = hold && (forSec === 0 || (since != null && now - since >= forSec * 1000));
    return { changed, holds: hold, met, since };
}

module.exports = { evaluate, hasChanged, holds, asNumber, isAbsent };
