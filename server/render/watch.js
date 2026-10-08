'use strict';
/**
 * A watch in words. Every page that shows a watch, an extraction, a condition or a check state says
 * what it means in plain sentences instead of printing the JSON the contract carries — the README's
 * honesty rule applied to the site: the words are derived from the stored watch and the recorded
 * state, never a guess, and everything goes through the escaping `html` tag.
 */
const { html } = require('./html');

const CADENCES = [
    { sec: 900, label: 'every 15 minutes' },
    { sec: 3600, label: 'every hour' },
    { sec: 21600, label: 'every 6 hours' },
    { sec: 86400, label: 'every day' },
];
/** The cadences the form offers a person; the contract's floor is 30 s, the site's floor is 15 min. */
const CADENCE_OPTIONS = CADENCES.map((c) => c.sec);
const MIN_CADENCE_SEC = 900;

function everyWords(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return 'on no cadence';
    const known = CADENCES.find((c) => c.sec === n);
    if (known) return known.label;
    if (n % 86400 === 0) return `every ${n / 86400} day${n / 86400 === 1 ? '' : 's'}`;
    if (n % 3600 === 0) return `every ${n / 3600} hour${n / 3600 === 1 ? '' : 's'}`;
    if (n % 60 === 0) return `every ${n / 60} minute${n / 60 === 1 ? '' : 's'}`;
    return `every ${n} seconds`;
}

const host = (url) => { try { return new URL(url).host; } catch { return url ? String(url) : 'an unnamed source'; } };
const short = (s, n = 80) => { const t = String(s == null ? '' : s); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };

/** The extracted value, as text, shortened. Objects are shown as their JSON, escaped. */
function valueWords(value, max = 90) {
    if (value === undefined || value === null) return html`<span class="muted">nothing stated</span>`;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return html`<code title="${String(text).slice(0, 200)}">${short(text, max)}</code>`;
}

function extractionWords(extraction) {
    const e = extraction || {};
    if (e.kind === 'text') return 'the page text';
    if (e.kind === 'html' || e.kind === 'css') return e.selector ? html`the text of <code>${e.selector}</code>` : 'the page text';
    if (e.kind === 'regex') return html`the first match of <code>${e.selector}</code>`;
    if (e.kind === 'json' || e.kind === 'jsonpath') return e.value_path ? html`the value at <code>${e.value_path}</code>` : 'the value';
    if (e.kind === 'ai') return 'an AI reading (not supported yet)';
    return 'the value';
}

function conditionWords(condition, { forSec = true } = {}) {
    const c = condition || {};
    const v = c.value;
    let core;
    switch (c.op) {
        case 'changed': core = 'changes'; break;
        case 'gt': core = html`goes above <b>${v}</b>`; break;
        case 'gte': core = html`reaches <b>${v}</b> or more`; break;
        case 'lt': core = html`drops below <b>${v}</b>`; break;
        case 'lte': core = html`is <b>${v}</b> or less`; break;
        case 'eq': core = html`equals <b>${v}</b>`; break;
        case 'ne': core = html`is not <b>${v}</b>`; break;
        case 'contains': core = html`contains “${v}”`; break;
        case 'matches': core = html`matches <code>${v}</code>`; break;
        case 'exists': core = 'is present'; break;
        case 'absent': core = 'is absent'; break;
        default: core = 'meets its condition';
    }
    if (forSec && Number.isInteger(c.for_sec) && c.for_sec > 0) {
        const sec = c.for_sec;
        const dur = sec % 3600 === 0 ? `${sec / 3600} hour${sec / 3600 === 1 ? '' : 's'}` : sec % 60 === 0 ? `${sec / 60} minute${sec / 60 === 1 ? '' : 's'}` : `${sec} seconds`;
        return html`${core} and stays that way for ${dur}`;
    }
    return core;
}

/** The watch as one sentence: "Tell me when … on …, checked every …". */
function inWords(watch) {
    const source = watch.source || {};
    const what = source.kind === 'feed'
        ? (watch.extraction && watch.extraction.value_path ? html`${extractionWords(watch.extraction)} of the newest item of the feed` : 'the newest item of the feed')
        : html`${extractionWords(watch.extraction)} on <b>${host(source.url)}</b>`;
    const every = watch.cadence ? `, checked ${everyWords(watch.cadence.every_sec)}` : '';
    return html`Tell me when ${what} ${conditionWords(watch.condition)}${every}.`;
}

/** The plain words for one check state; `run` supplies the HTTP status a failure answered with. */
function stateWords(state, run = null) {
    switch (state) {
        case 'ok': return 'Read, nothing new';
        case 'not_modified': return 'No change (the site said so)';
        case 'no_change': return 'No change';
        case 'changed': return 'Changed';
        case 'condition_met': return 'Condition met';
        case 'http_error': return run && run.http_status ? `The site answered ${run.http_status}` : 'The site answered an error';
        case 'timeout': return 'The site did not answer in time';
        case 'parse_error': return 'The answer could not be read';
        case 'rate_limited': return 'The site asked us to wait';
        case 'budget_exceeded': return "The watch's budget was reached";
        case 'skipped': return 'This kind of check is not run yet';
        case 'disabled': return 'The watch is not active';
        default: return state ? String(state) : 'No state recorded';
    }
}

/** How a check state is pill-coloured. */
function stateKind(state) {
    if (state === 'changed' || state === 'condition_met') return 'ok';
    if (state === 'http_error' || state === 'timeout' || state === 'parse_error' || state === 'rate_limited' || state === 'budget_exceeded') return 'bad';
    if (state === 'skipped' || state === 'disabled') return 'warn';
    return '';
}

const STATUS_WORDS = { active: 'Active', paused: 'Paused', disabled: 'Disabled', failed: 'Failing' };
const statusWords = (status) => STATUS_WORDS[status] || String(status || 'unknown');
const statusKind = (status) => (status === 'active' ? 'ok' : status === 'paused' ? 'warn' : status === 'failed' ? 'bad' : '');

module.exports = {
    inWords, conditionWords, extractionWords, valueWords, everyWords, stateWords, stateKind,
    statusWords, statusKind, host, short, CADENCES, CADENCE_OPTIONS, MIN_CADENCE_SEC,
};
