'use strict';
/**
 * Provider-rate evidence (plan P6; flag WATCH_PROVIDER_RATES, off by default).
 *
 * Two providers publish their prices as a machine-readable document that needs no account: DeepInfra's
 * `/models/list` (documented in its OpenAPI) and Featherless AI's OpenAI-compatible `/v1/models`. Both are in
 * OpenVibe.AI's provider matrix; Featherless is the one provider whose terms permit resale (Scale, terms §3), so
 * its supply price is the one the exchange will most want to know; DeepInfra is an existing OpenAI-compatible
 * adapter target with an exact, keyless price list. This module records what those documents state as evidence:
 *
 *   provider, model, token class, nano-USD per million (an integer STRING, D1), currency, region, effective date,
 *   the URL fetched and the time it was fetched.
 *
 * Rate cards are NOT written here and nothing here is billable. When a rate differs from the last observation,
 * Watch raises a `provider_rate_changes` row (a change) and a `watch.rate.changed` event; a person approves or
 * rejects it. The approval is dated evidence for OpenVibe.AI's catalog operator, who alone changes the supply rate
 * card through AI's own path — no second authority. An approval response says `applied: false` for that reason.
 *
 * Units, exactly:
 *   DeepInfra  cents_per_input_token        cents/token × 1e13 = nano-USD per million tokens
 *              cents_per_output_token
 *              rate_per_input_token_cached a multiplier (the pricing page renders input × it), not a price
 *              discount, discount_ends_at a fraction off, while active: price × (1 - discount)
 *   Featherless pricing.prompt/completion   USD/token as decimal strings × 1e15 = nano-USD per million tokens
 *              pricing.input/output          USD per million numbers, read only when the string is absent
 *
 * A malformed document (invalid JSON, a price that is not a finite non-negative decimal, no priced model) records
 * a `parse_error` fetch and NO observation at all — a missing or unreadable price never becomes zero. An unchanged
 * value is not written again: its first observation keeps the effective date, and the fetch row's stated/observations
 * counts say what the document stated versus what was new. An unchanged document raises no change. The effective date
 * of a rate is the first day it was observed at that value, so the record shows effective periods.
 */
const crypto = require('crypto');
const { ids: contractIds } = require('openvibe-contracts');
const { hashValue, ParseError, decodeBody } = require('./util');
const { envelope } = require('./events/envelope');

/** The token classes a document may state (D1: input, cached read, cache write, output). */
const TOKEN_CLASSES = ['input', 'cached_read', 'cache_write', 'output'];
/** Fetch states that are failures (health `failing`, backoff). */
const FAILURE_STATES = new Set(['http_error', 'timeout', 'parse_error', 'rate_limited', 'disabled']);
/** A provider's published document is one of these. `kind` is the source kind this module registers. */
const KIND = 'provider-rate';

class ProviderRateError extends Error {
    constructor(detail, code = 'watch.rate_invalid') { super(detail); this.code = code; }
}

// ── Decimal arithmetic (D1: never a float) ────────────────────────────────────────────────────────

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,6}))?$/;
const TEN = 10n;

/** A non-negative decimal string or number → its exact value × 10^scale, rounded half-up to an integer. */
function scaled(value, scale, what) {
    let s;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) throw new ParseError(`${what} is not a finite non-negative number`);
        s = String(value);
    } else if (typeof value === 'string') {
        s = value.trim();
    } else {
        throw new ParseError(`${what} is not a decimal`);
    }
    const m = DECIMAL.exec(s);
    if (!m) throw new ParseError(`${what} is not a finite non-negative decimal: ${JSON.stringify(s).slice(0, 40)}`);
    const digits = m[1] + (m[2] || '');
    let n = BigInt(digits);
    if (n === 0n) return 0n;
    const exp = (m[3] ? Number(m[3]) : 0) - (m[2] ? m[2].length : 0) + scale;
    if (exp >= 0) return n * TEN ** BigInt(exp);
    const div = TEN ** BigInt(-exp);
    return (n + div / 2n) / div;
}

/** `base` (an integer) × a fraction `frac` already scaled by 10^scale, rounded half-up. */
const SCALE = 18;
const ONE = TEN ** BigInt(SCALE);
function mulFraction(base, fracScaled) {
    return (base * fracScaled + ONE / 2n) / ONE;
}

/** A fraction in [0,1] → its scaled integer, refusing anything outside the interval. */
function fraction(value, what) {
    const f = scaled(value, SCALE, what);
    if (f > ONE) throw new ParseError(`${what} is greater than 1: ${JSON.stringify(value)}`);
    return f;
}

/** A provider's active discount as a scaled fraction off: 0 when absent or its end has passed. */
function activeDiscount(price, fetchedAt, what) {
    if (price == null || price.discount == null) return 0n;
    if (price.discount_ends_at != null) {
        const ends = Number(price.discount_ends_at);
        if (!Number.isFinite(ends)) throw new ParseError(`${what}.discount_ends_at is not a Unix timestamp`);
        if (ends * 1000 <= fetchedAt) return 0n;
    }
    return fraction(price.discount, `${what}.discount`);
}

/** USD per million → nano-USD per million (×1e9), and the two provider scales. */
const USD_PER_M = 9;
const CENTS_PER_TOKEN = 13;
const USD_PER_TOKEN = 15;

// ── Parsers ──────────────────────────────────────────────────────────────────────────────────────

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const modelName = (v, what) => {
    if (typeof v !== 'string' || !v.trim()) throw new ParseError(`${what} is not a model name`);
    return v.trim();
};

/** One observation, before its effective date and hashes are filled in. */
function observation(provider, model, tokenClass, nano, fetchedAt) {
    return {
        provider,
        model,
        token_class: tokenClass,
        nano_usd_per_m: nano.toString(),
        // Currency and region are the document's own scope; each provider definition replaces both below.
        currency: 'USD',
        region: 'global',
        fetched_at: fetchedAt,
    };
}

/** DeepInfra `/models/list`: an array of model records; `pricing.type = tokens` carries the rates. */
function parseDeepInfra(body, { fetchedAt }) {
    if (!Array.isArray(body)) throw new ParseError('DeepInfra /models/list is not a JSON array');
    const observations = [];
    const seen = new Set();
    let skipped = 0;
    for (const [i, model] of body.entries()) {
        if (!isObject(model)) throw new ParseError(`DeepInfra model ${i} is not an object`);
        const name = modelName(model.model_name, `DeepInfra model ${i}.model_name`);
        if (model.private === 1 || model.private === true) { skipped++; continue; }
        const price = model.pricing;
        if (!isObject(price) || price.type !== 'tokens') { skipped++; continue; }
        if (seen.has(name)) throw new ParseError(`DeepInfra lists ${name} twice`);
        seen.add(name);
        const what = `DeepInfra ${name}`;
        const off = activeDiscount(price, fetchedAt, what);
        const factor = ONE - off;
        // cents/token × 1e13 = nano-USD per million; the discount is a fraction off while active.
        const input = mulFraction(scaled(price.cents_per_input_token, CENTS_PER_TOKEN, `${what}.cents_per_input_token`), factor);
        const output = mulFraction(scaled(price.cents_per_output_token, CENTS_PER_TOKEN, `${what}.cents_per_output_token`), factor);
        observations.push(observation('deepinfra', name, 'input', input, fetchedAt));
        observations.push(observation('deepinfra', name, 'output', output, fetchedAt));
        if (price.rate_per_input_token_cached != null) {
            // The field is a multiplier: the pricing page renders input × it as the cached price.
            const cached = mulFraction(input, fraction(price.rate_per_input_token_cached, `${what}.rate_per_input_token_cached`));
            observations.push(observation('deepinfra', name, 'cached_read', cached, fetchedAt));
        }
        // A cache-write price depends on the cache retention the document states as multipliers (5m/1h); it is not
        // one published rate, so no cache_write observation is invented from it.
    }
    if (!observations.length) throw new ParseError('DeepInfra stated no token-priced model');
    return { observations, models: seen.size, skipped };
}

/** Featherless `/v1/models`: values under pricing are USD per token as decimal strings. */
function parseFeatherless(body, { fetchedAt }) {
    if (!isObject(body) || !Array.isArray(body.data)) throw new ParseError('Featherless /v1/models has no data array');
    const observations = [];
    const seen = new Set();
    let skipped = 0;
    for (const [i, model] of body.data.entries()) {
        if (!isObject(model)) throw new ParseError(`Featherless model ${i} is not an object`);
        const name = modelName(model.id, `Featherless model ${i}.id`);
        const price = model.pricing;
        if (!isObject(price)) { skipped++; continue; }
        if (seen.has(name)) throw new ParseError(`Featherless lists ${name} twice`);
        seen.add(name);
        const what = `Featherless ${name}`;
        // The document states both the exact per-token strings and their per-million display numbers; the string
        // is authoritative, the number a fallback only. A gated model is kept: its published price is still evidence.
        const inNano = price.prompt != null ? scaled(price.prompt, USD_PER_TOKEN, `${what}.pricing.prompt`)
            : price.input != null ? scaled(price.input, USD_PER_M, `${what}.pricing.input`) : null;
        const outNano = price.completion != null ? scaled(price.completion, USD_PER_TOKEN, `${what}.pricing.completion`)
            : price.output != null ? scaled(price.output, USD_PER_M, `${what}.pricing.output`) : null;
        if (inNano == null && outNano == null) { skipped++; continue; }
        if (inNano != null) observations.push(observation('featherless', name, 'input', inNano, fetchedAt));
        if (outNano != null) observations.push(observation('featherless', name, 'output', outNano, fetchedAt));
    }
    if (!observations.length) throw new ParseError('Featherless stated no token-priced model');
    return { observations, models: seen.size, skipped };
}

/**
 * The two providers, their official documents and why reading them is permitted. `enabled` is NEVER true here:
 * the flag turns the feature on, and a person still has to enable a source (the row starts at 0).
 */
const PROVIDERS = Object.freeze({
    deepinfra: {
        provider: 'deepinfra',
        name: 'DeepInfra prices',
        url: 'https://api.deepinfra.com/models/list',
        homepage_url: 'https://deepinfra.com/pricing',
        docs_url: 'https://api.deepinfra.com/openapi.json',
        currency: 'USD',
        region: 'global',
        parser_version: 'deepinfra@1',
        parse: parseDeepInfra,
        terms_note: 'DeepInfra is RESTRICTED for managed resale in OpenVibe.AI docs/provider-matrix.md, so this source only records its published rates as evidence; it never resells or routes a call. GET /models/list is the keyless public listing documented in DeepInfra\'s own OpenAPI (https://api.deepinfra.com/openapi.json), not an HTML page, so nothing is scraped. DeepInfra\'s terms (https://deepinfra.com/terms) restrict resale, not reading the public price list. Checked 2026-11-04; a person reviews it before enabling.',
        robots_note: 'https://api.deepinfra.com/robots.txt answers 404 (the API host publishes no robots rules). Watch\'s fetcher reads only the documented JSON endpoint above, not a page. Checked 2026-11-04.',
    },
    featherless: {
        provider: 'featherless',
        name: 'Featherless AI prices',
        url: 'https://api.featherless.ai/v1/models',
        homepage_url: 'https://featherless.ai/pricing',
        docs_url: 'https://featherless.ai/terms',
        currency: 'USD',
        region: 'global',
        parser_version: 'featherless@1',
        parse: parseFeatherless,
        terms_note: 'Featherless is AUTHORIZED_WHOLESALE (Scale only) in OpenVibe.AI docs/provider-matrix.md: its terms §3 say Scale plans "may be used in arbitrary applications, including inference resale" (https://featherless.ai/terms, checked 2026-11-04), subject to an executed agreement. This source records the published rate as evidence only; it neither accepts the agreement nor routes a call. /v1/models is the documented OpenAI-compatible model list and needs no key (checked 2026-11-04), so nothing is scraped. A person reviews the terms and enables it.',
        robots_note: 'https://api.featherless.ai/robots.txt answers 404 (the API host publishes no robots rules); https://featherless.ai/robots.txt allows its public pages and disallows /dashboard, /login and /signup, none of which is read. The fetcher reads only /v1/models. Checked 2026-11-04.',
    },
});

/** Parse one provider document. Exposed for tests: no fetch, no database. */
function parse(provider, body, { fetchedAt = Date.now() } = {}) {
    const def = typeof provider === 'string' ? PROVIDERS[provider] : provider;
    if (!def) throw new ProviderRateError(`no provider-rate parser for ${provider}`, 'watch.rate.unknown_provider');
    const at = Number(fetchedAt);
    if (!Number.isFinite(at) || at <= 0) throw new ProviderRateError('fetchedAt must be a time in ms');
    const out = def.parse(body, { fetchedAt: at });
    return {
        ...out,
        observations: out.observations.map((o) => ({
            ...o,
            provider: def.provider,
            currency: def.currency,
            region: def.region,
            source_url: def.url,
            fetched_at: at,
            effective_date: new Date(at).toISOString().slice(0, 10),
        })),
    };
}

// ── The service module ──────────────────────────────────────────────────────────────────────────

const iso = (v) => (v == null ? null : new Date(Number(v)).toISOString());
const dateOf = (v) => new Date(Number(v)).toISOString().slice(0, 10);
const note = (v) => (v == null ? null : String(v).slice(0, 2000));

/** Retry-After in seconds or an HTTP date → ms from `at`, or 0. */
function retryAfterMs(value, at) {
    if (value == null) return 0;
    const s = String(value).trim();
    if (/^\d{1,7}$/.test(s)) return Number(s) * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - at) : 0;
}

function createProviderRates({ db, config, fetcher, spacer = null, outbox = null, now = () => Date.now(), log = console, ids = contractIds, providers = PROVIDERS }) {
    const settings = (config && config.providerRates) || {};
    const enabled = Boolean(settings.enabled);
    const maxBytes = Number.isSafeInteger(settings.maxBytes) && settings.maxBytes > 0 ? settings.maxBytes : 8 * 1024 * 1024;
    const pollSec = Number.isSafeInteger(settings.pollIntervalSec) && settings.pollIntervalSec > 0 ? settings.pollIntervalSec : 6 * 3600;
    const staleSec = Number.isSafeInteger(settings.staleAfterSec) && settings.staleAfterSec > 0 ? settings.staleAfterSec : 2 * pollSec;
    const tickMs = Number.isSafeInteger(settings.tickMs) && settings.tickMs > 0 ? settings.tickMs : 60_000;
    const inflight = new Set();
    let timer = null;

    const st = {
        seed: db.prepare(`INSERT INTO provider_rate_sources (key, kind, provider, name, url, homepage_url, currency, region,
            terms_note, robots_note, parser_version, enabled, poll_interval_sec, stale_after_sec, created_at, updated_at)
            VALUES (@key, 'provider-rate', @provider, @name, @url, @homepage_url, @currency, @region, @terms_note, @robots_note,
            @parser_version, 0, @poll_interval_sec, @stale_after_sec, @at, @at) ON CONFLICT (key) DO NOTHING`),
        sources: db.prepare('SELECT * FROM provider_rate_sources ORDER BY key'),
        source: db.prepare('SELECT * FROM provider_rate_sources WHERE key = ?'),
        enable: db.prepare('UPDATE provider_rate_sources SET enabled = @enabled, next_due_at = 0, updated_at = @at, updated_by = @by WHERE key = @key'),
        due: db.prepare(`SELECT * FROM provider_rate_sources WHERE enabled = 1 AND next_due_at <= @now AND not_before <= @now
            ORDER BY next_due_at, key LIMIT @limit`),
        success: db.prepare(`UPDATE provider_rate_sources SET last_fetch_at = @at, last_success_at = @at, last_state = @state,
            consecutive_failures = 0, next_due_at = @next_due, not_before = 0, etag = @etag, last_modified = @lm,
            last_body_hash = @hash WHERE key = @key`),
        failure: db.prepare(`UPDATE provider_rate_sources SET last_fetch_at = @at, last_state = @state,
            consecutive_failures = @failures, next_due_at = @next_due, not_before = @not_before WHERE key = @key`),
        insertFetch: db.prepare(`INSERT INTO provider_rate_fetches (id, source_key, trigger, started_at, finished_at, state, http_status,
            error_code, detail, bytes, raw_body_hash, parser_version, stated, observations, changed)
            VALUES (@id, @source_key, @trigger, @started_at, @finished_at, @state, @http_status, @error_code, @detail, @bytes,
            @raw_body_hash, @parser_version, @stated, @observations, @changed)`),
        latest: db.prepare(`SELECT DISTINCT ON (model, token_class) * FROM provider_rate_observations
            WHERE source_key = ? ORDER BY model, token_class, rid DESC`),
        insertObservation: db.prepare(`INSERT INTO provider_rate_observations (id, source_key, fetch_id, provider, model, token_class,
            nano_usd_per_m, currency, region, effective_date, source_url, fetched_at, value_hash, changed, previous_id, previous_nano_usd_per_m)
            VALUES (@id, @source_key, @fetch_id, @provider, @model, @token_class, @nano_usd_per_m, @currency, @region, @effective_date,
            @source_url, @fetched_at, @value_hash, @changed, @previous_id, @previous_nano_usd_per_m)`),
        insertChange: db.prepare(`INSERT INTO provider_rate_changes (id, source_key, observation_id, previous_id, provider, model, token_class,
            from_nano_usd_per_m, to_nano_usd_per_m, currency, region, effective_date, source_url, fetched_at, state, created_at)
            VALUES (@id, @source_key, @observation_id, @previous_id, @provider, @model, @token_class, @from_nano_usd_per_m,
            @to_nano_usd_per_m, @currency, @region, @effective_date, @source_url, @fetched_at, 'pending', @created_at)`),
        change: db.prepare('SELECT * FROM provider_rate_changes WHERE id = ?'),
        decide: db.prepare(`UPDATE provider_rate_changes SET state = @state, decided_at = @at, decided_by = @by, note = @note
            WHERE id = @id AND state = 'pending'`),
        pendingCount: db.prepare("SELECT COUNT(*) AS n FROM provider_rate_changes WHERE state = 'pending'"),
    };

    /** The first boot writes the two sources disabled; an existing row is never overwritten (a person may have notes). */
    async function init() {
        const at = now();
        for (const def of Object.values(providers)) {
            await st.seed.run({
                key: def.provider, provider: def.provider, name: def.name, url: def.url, homepage_url: def.homepage_url || null,
                currency: def.currency, region: def.region, terms_note: def.terms_note, robots_note: def.robots_note,
                parser_version: def.parser_version, poll_interval_sec: pollSec, stale_after_sec: staleSec, at,
            });
        }
    }

    const sourceRow = (key) => st.source.get(String(key || ''));
    async function sources() { return await st.sources.all(); }

    /** {status: disabled|never_fetched|failing|stale|healthy, times and the last state}; never invented. */
    function health(row, at = now()) {
        const out = {
            status: null,
            last_fetch_at: iso(row.last_fetch_at),
            last_success_at: iso(row.last_success_at),
            last_state: row.last_state == null ? null : row.last_state,
            consecutive_failures: Number(row.consecutive_failures) || 0,
            next_due_at: Number(row.enabled) ? iso(Math.max(Number(row.next_due_at) || 0, Number(row.not_before) || 0)) : null,
        };
        if (!Number(row.enabled)) out.status = 'disabled';
        else if (row.last_fetch_at == null) out.status = 'never_fetched';
        else if (row.last_state && FAILURE_STATES.has(row.last_state) && Number(row.consecutive_failures) > 0) out.status = 'failing';
        else if (row.last_success_at == null || at - Number(row.last_success_at) > Number(row.stale_after_sec) * 1000) out.status = 'stale';
        else out.status = 'healthy';
        return out;
    }

    function sourceView(row, at = now()) {
        const h = health(row, at);
        return {
            key: row.key, kind: row.kind, provider: row.provider, name: row.name, url: row.url, homepage_url: row.homepage_url,
            currency: row.currency, region: row.region, terms_note: row.terms_note, robots_note: row.robots_note,
            parser_version: row.parser_version, enabled: Boolean(Number(row.enabled)),
            poll_interval_sec: Number(row.poll_interval_sec), stale_after_sec: Number(row.stale_after_sec),
            health: h,
        };
    }

    function fetchView(row) {
        return {
            id: row.id, source_key: row.source_key, trigger: row.trigger,
            started_at: iso(row.started_at), finished_at: iso(row.finished_at), state: row.state,
            http_status: row.http_status == null ? null : Number(row.http_status),
            error_code: row.error_code == null ? null : row.error_code,
            detail: row.detail == null ? null : row.detail,
            bytes: row.bytes == null ? null : Number(row.bytes),
            raw_body_hash: row.raw_body_hash == null ? null : row.raw_body_hash,
            parser_version: row.parser_version == null ? null : row.parser_version,
            stated: Number(row.stated), observations: Number(row.observations), changed: Number(row.changed),
        };
    }

    function observationView(row) {
        return {
            id: row.id, source_key: row.source_key, fetch_id: row.fetch_id, provider: row.provider, model: row.model,
            token_class: row.token_class, nano_usd_per_m: row.nano_usd_per_m, currency: row.currency, region: row.region,
            effective_date: row.effective_date, source_url: row.source_url, fetched_at: iso(row.fetched_at),
            changed: Boolean(Number(row.changed)), previous_id: row.previous_id == null ? null : row.previous_id,
            previous_nano_usd_per_m: row.previous_nano_usd_per_m == null ? null : row.previous_nano_usd_per_m,
            value_hash: row.value_hash,
        };
    }

    function changeView(row) {
        return {
            id: row.id, state: row.state, approval_required: row.state === 'pending',
            source_key: row.source_key, provider: row.provider, model: row.model, token_class: row.token_class,
            from_nano_usd_per_m: row.from_nano_usd_per_m == null ? null : row.from_nano_usd_per_m,
            to_nano_usd_per_m: row.to_nano_usd_per_m, currency: row.currency, region: row.region,
            effective_date: row.effective_date, source_url: row.source_url, fetched_at: iso(row.fetched_at),
            observation_id: row.observation_id, previous_id: row.previous_id == null ? null : row.previous_id,
            created_at: iso(row.created_at), decided_at: iso(row.decided_at),
            decided_by: row.decided_by == null ? null : row.decided_by,
            note: row.note == null ? null : row.note,
            // Evidence only: no billable rate is written by Watch, approved or not.
            effect: 'evidence',
        };
    }

    const changeEvent = (row) => ({
        change_id: row.id, source_key: row.source_key, provider: row.provider, model: row.model, token_class: row.token_class,
        from_nano_usd_per_m: row.from_nano_usd_per_m == null ? null : row.from_nano_usd_per_m,
        to_nano_usd_per_m: row.to_nano_usd_per_m, currency: row.currency, region: row.region,
        effective_date: row.effective_date, source_url: row.source_url, fetched_at: iso(row.fetched_at),
        approval_required: true,
    });

    /**
     * Fetch and parse one source now. The fetch row and, on success, every observation and change commit together;
     * a failure commits only the fetch row and the source's failure state. One fetch of a source at a time.
     */
    async function fetchSource(key, { trigger = 'schedule' } = {}) {
        if (inflight.has(key)) return { busy: true };
        inflight.add(key);
        try {
            const row = await sourceRow(key);
            if (!row) return null;
            if (!Number(row.enabled)) return { disabled: true, source: sourceView(row) };
            const def = providers[row.provider];
            if (!def) return { unavailable: `no parser for provider ${row.provider}` };
            const startedAt = now();
            const run = {
                id: `prf_${ids.ulid(startedAt)}`, source_key: row.key, trigger, started_at: startedAt, finished_at: startedAt,
                state: null, http_status: null, error_code: null, detail: null, bytes: null, raw_body_hash: null,
                parser_version: def.parser_version, stated: 0, observations: 0, changed: 0,
            };
            let res = null;
            let failure = null;
            let notBefore = 0;
            try {
                if (spacer) await spacer.space(new URL(row.url).host);
                res = await fetcher.fetchUrl(row.url, {
                    headers: { Accept: 'application/json' },
                    etag: row.etag || null,
                    lastModified: row.last_modified || null,
                    capBytes: maxBytes,
                });
            } catch (err) {
                failure = { state: err.code === 'timeout' ? 'timeout' : 'http_error', error_code: err.code || 'fetch_error', detail: String(err.message || err).slice(0, 500) };
            }
            const finishedAt = now();
            run.finished_at = finishedAt;

            if (!failure) {
                run.http_status = res.status;
                run.bytes = res.bytes == null ? null : Number(res.bytes);
                if (res.status === 304) {
                    run.state = 'not_modified';
                } else if (res.status === 429) {
                    run.state = 'rate_limited';
                    run.error_code = 'http_429';
                    run.detail = 'the provider answered 429 Too Many Requests';
                    notBefore = finishedAt + retryAfterMs(res.headers && res.headers['retry-after'], finishedAt);
                } else if (res.status !== 200) {
                    run.state = 'http_error';
                    run.error_code = `http_${res.status}`;
                    run.detail = `the provider answered HTTP ${res.status}`;
                    notBefore = finishedAt + retryAfterMs(res.headers && res.headers['retry-after'], finishedAt);
                } else {
                    run.raw_body_hash = crypto.createHash('sha256').update(res.body || Buffer.alloc(0)).digest('hex');
                    let parsed = null;
                    try {
                        const text = decodeBody(res.body || Buffer.alloc(0), res.headers && res.headers['content-type']);
                        let body;
                        try { body = JSON.parse(text); } catch { throw new ParseError('the body is not JSON'); }
                        parsed = def.parse(body, { fetchedAt: finishedAt });
                    } catch (err) {
                        failure = { state: 'parse_error', error_code: err instanceof ParseError ? 'parse_error' : 'unreadable', detail: String(err.message || err).slice(0, 500) };
                    }
                    if (!failure) {
                        // Every observation and the changes it raises commit with the fetch row and the source's state.
                        const previous = new Map();
                        for (const p of await st.latest.all(row.key)) previous.set(`${p.model}\u0000${p.token_class}`, p);
                        const observations = [];
                        const changes = [];
                        for (const o of parsed.observations) {
                            const prev = previous.get(`${o.model}\u0000${o.token_class}`) || null;
                            const value = { nano_usd_per_m: o.nano_usd_per_m, currency: def.currency, region: def.region };
                            const valueHash = hashValue(value);
                            const changed = Boolean(prev) && prev.value_hash !== valueHash;
                            const effectiveDate = prev && !changed ? prev.effective_date : dateOf(finishedAt);
                            const obs = {
                                id: `pro_${ids.ulid(finishedAt)}`, source_key: row.key, fetch_id: run.id,
                                provider: def.provider, model: o.model, token_class: o.token_class,
                                nano_usd_per_m: o.nano_usd_per_m, currency: def.currency, region: def.region,
                                effective_date: effectiveDate, source_url: row.url, fetched_at: finishedAt,
                                value_hash: valueHash, changed: changed ? 1 : 0,
                                previous_id: prev ? prev.id : null,
                                previous_nano_usd_per_m: prev ? prev.nano_usd_per_m : null,
                            };
                            // An unchanged value is not written again: its first observation keeps the effective date and
                            // the fetch row says how many rates the document stated. A new model is evidence, not a change.
                            if (!prev || changed) observations.push(obs);
                            if (changed) {
                                changes.push({
                                    id: `prc_${ids.ulid(finishedAt)}`, source_key: row.key, observation_id: obs.id,
                                    previous_id: prev.id, provider: def.provider, model: o.model, token_class: o.token_class,
                                    from_nano_usd_per_m: prev.nano_usd_per_m, to_nano_usd_per_m: o.nano_usd_per_m,
                                    currency: def.currency, region: def.region, effective_date: effectiveDate,
                                    source_url: row.url, fetched_at: finishedAt, created_at: finishedAt,
                                });
                            }
                        }
                        run.state = 'ok';
                        run.stated = parsed.observations.length;
                        run.observations = observations.length;
                        run.changed = changes.length;
                        const events = changes.map((c) => ({
                            event_type: 'watch.rate.changed', subject: { type: KIND, id: row.key }, visibility: 'internal', priority: 'important',
                            payload: changeEvent(c),
                        }));
                        await db.tx(async () => {
                            await st.insertFetch.run(run);
                            await st.success.run({
                                key: row.key, at: finishedAt, state: 'ok', next_due: finishedAt + Number(row.poll_interval_sec) * 1000,
                                // A 200 states the current validators; carrying an old one forward could make the next
                                // conditional read a 304 for a representation that has no validator.
                                etag: (res.headers && res.headers.etag) || null,
                                lm: (res.headers && res.headers['last-modified']) || null,
                                hash: run.raw_body_hash,
                            });
                            for (const o of observations) await st.insertObservation.run(o);
                            for (const c of changes) await st.insertChange.run(c);
                            if (outbox) for (const e of events) await outbox.emit(envelope(e, config.serviceId || 'watch', now));
                        });
                        if (outbox && events.length) outbox.kick().catch(() => {});
                        return { fetch: fetchView(run), source: sourceView(await sourceRow(row.key)) };
                    }
                }
            }

            // A 304 is a successful read that states no new value; a failure writes no observation.
            if (!failure && run.state === 'not_modified') {
                await db.tx(async () => {
                    await st.insertFetch.run(run);
                    await st.success.run({
                        key: row.key, at: finishedAt, state: 'not_modified', next_due: finishedAt + Number(row.poll_interval_sec) * 1000,
                        etag: (res.headers && res.headers.etag) || row.etag || null,
                        lm: (res.headers && res.headers['last-modified']) || row.last_modified || null,
                        hash: row.last_body_hash,
                    });
                });
                return { fetch: fetchView(run), source: sourceView(await sourceRow(row.key)) };
            }

            const state = failure ? failure.state : run.state;
            Object.assign(run, {
                state,
                error_code: failure ? failure.error_code : run.error_code,
                detail: failure ? failure.detail : run.detail,
            });
            const failures = Number(row.consecutive_failures) + 1;
            const every = Number(row.poll_interval_sec) * 1000;
            const backoff = Math.min(every * 2 ** Math.min(failures - 1, 10), 6 * 3600 * 1000);
            const nextDue = finishedAt + Math.max(backoff, notBefore > finishedAt ? notBefore - finishedAt : 0);
            await db.tx(async () => {
                await st.insertFetch.run(run);
                await st.failure.run({ key: row.key, at: finishedAt, state, failures, next_due: nextDue, not_before: notBefore });
            });
            return { fetch: fetchView(run), source: sourceView(await sourceRow(row.key)) };
        } finally {
            inflight.delete(key);
        }
    }

    /** One scheduler tick: fetch every enabled source whose turn has come. */
    async function tick() {
        if (!enabled || !fetcher) return [];
        const due = await st.due.all({ now: now(), limit: 4 });
        for (const row of due) {
            fetchSource(row.key, { trigger: 'schedule' }).catch((err) => log.error(`[provider-rates] ${row.key}: ${err.stack || err}`));
        }
        return due.map((r) => r.key);
    }

    function start() {
        if (!enabled || timer) return;
        timer = setInterval(async () => { try { await tick(); } catch (err) { log.error(`[provider-rates] tick: ${err.message}`); } }, tickMs);
        timer.unref?.();
    }

    async function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        const deadline = Date.now() + 15000;
        while (inflight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    }

    async function setEnabled(key, want, principal) {
        if (typeof want !== 'boolean') throw new ProviderRateError('enabled must be true or false');
        const row = await sourceRow(key);
        if (!row) return null;
        if (want && (!row.terms_note || !row.robots_note)) throw new ProviderRateError('a provider-rate source needs its terms and robots notes before it can be enabled');
        await st.enable.run({ key: row.key, enabled: want ? 1 : 0, at: now(), by: principal && principal.sub ? principal.sub : null });
        return await sourceRow(key);
    }

    /** Latest observations first; `latest` returns the newest row per (model, token class). */
    async function observations({ latest = false, source = null, model = null, tokenClass = null, before = null, limit = 100 } = {}) {
        const l = Math.min(Math.max(Number(limit) || 100, 1), 500);
        if (latest) {
            return await db.prepare(`SELECT * FROM (
                    SELECT DISTINCT ON (model, token_class) * FROM provider_rate_observations
                    WHERE (@source::text IS NULL OR source_key = @source) AND (@model::text IS NULL OR model = @model)
                      AND (@class::text IS NULL OR token_class = @class)
                    ORDER BY model, token_class, rid DESC
                ) t ORDER BY model, token_class LIMIT @limit`).all({ source, model, class: tokenClass, limit: l });
        }
        const b = /^\d{1,18}$/.test(String(before || '')) ? Number(before) : Number.MAX_SAFE_INTEGER;
        return await db.prepare(`SELECT * FROM provider_rate_observations
            WHERE rid < @before AND (@source::text IS NULL OR source_key = @source)
              AND (@model::text IS NULL OR model = @model) AND (@class::text IS NULL OR token_class = @class)
            ORDER BY rid DESC LIMIT @limit`).all({ before: b, source, model, class: tokenClass, limit: l });
    }

    async function changes({ state = null, source = null, before = null, limit = 100 } = {}) {
        if (state != null && !['pending', 'approved', 'rejected'].includes(state)) throw new ProviderRateError('state must be pending, approved or rejected');
        const l = Math.min(Math.max(Number(limit) || 100, 1), 500);
        const b = /^\d{1,18}$/.test(String(before || '')) ? Number(before) : Number.MAX_SAFE_INTEGER;
        return await db.prepare(`SELECT * FROM provider_rate_changes WHERE rid < @before
            AND (@state::text IS NULL OR state = @state) AND (@source::text IS NULL OR source_key = @source)
            ORDER BY rid DESC LIMIT @limit`).all({ before: b, state, source, limit: l });
    }

    async function change(id) { return await st.change.get(String(id || '')); }
    async function pendingCount() { return Number((await st.pendingCount.get()).n) || 0; }
    async function fetch(id) {
        const row = await db.prepare('SELECT * FROM provider_rate_fetches WHERE id = ?').get(String(id || ''));
        return row ? fetchView(row) : null;
    }

    /**
     * A person approves or rejects a pending change. The decision is recorded and a `watch.rate.approved` /
     * `watch.rate.rejected` event is emitted; no billable rate is written and `applied` is always false.
     */
    async function decide(id, decision, principal, { note: text = null } = {}) {
        if (!['approved', 'rejected'].includes(decision)) throw new ProviderRateError('decision must be approved or rejected');
        if (!principal || principal.kind !== 'person' || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(principal.sub || ''))) {
            throw new ProviderRateError('a person approves a provider-rate change; a service or an agent may not', 'watch.rate.person_only');
        }
        const at = now();
        const row = await st.change.get(String(id || ''));
        if (!row) return null;
        if (row.state !== 'pending') return { conflict: row.state, change: changeView(row) };
        let updated = null;
        await db.tx(async () => {
            const r = await st.decide.run({ id: row.id, state: decision, at, by: principal.sub, note: note(text) });
            if (r.changes !== 1) {
                const raced = new ProviderRateError('this change was already decided', 'watch.rate.decided');
                raced.status = 409;
                throw raced;
            }
            updated = { ...row, state: decision, decided_at: at, decided_by: principal.sub, note: note(text) };
            if (outbox) {
                await outbox.emit(envelope({
                    event_type: decision === 'approved' ? 'watch.rate.approved' : 'watch.rate.rejected',
                    subject: { type: KIND, id: row.source_key },
                    visibility: 'internal', priority: 'important',
                    payload: { ...changeEvent(updated), approval_required: false, state: decision, decided_by: principal.sub, decided_at: iso(at), applied: false },
                }, config.serviceId || 'watch', now));
            }
        });
        if (outbox) outbox.kick().catch(() => {});
        return { change: changeView(updated), applied: false };
    }

    return {
        kind: KIND,
        enabled,
        providers,
        init, tick, start, stop,
        sources, source: sourceRow, sourceView, health,
        setEnabled, fetchNow: fetchSource, fetch, fetchView,
        observations, observationView, changes, change, changeView, pendingCount, decide,
        parse,
        inflight: () => [...inflight],
    };
}

module.exports = {
    createProviderRates, parse, scaled, PROVIDERS, TOKEN_CLASSES, KIND, FAILURE_STATES,
};
