'use strict';
/**
 * The http carrier: one URL, fetched conditionally.
 *
 * The binding preference order of plan T18 puts ETag/Last-Modified first among the pull rungs, so
 * every carrier here goes through conditionalGet():
 *
 *   - source.conditional !== false and a stored validator → If-None-Match / If-Modified-Since;
 *     a 304 is `not_modified` and costs nothing (no body, no observation).
 *   - when the watch only needs to know WHETHER the page changed (condition.op 'changed'), a HEAD is
 *     tried first while a validator is stored: the answer is the validators, not the body.
 *   - a 200 whose body hashes to the hash of the last body is `no_change`: the value cannot have
 *     changed, so no observation is recorded and the cadence is not disturbed.
 *   - 429 and 503+Retry-After set not_before: Watch waits as long as the site asked.
 *
 * Every URL goes through the SSRF guard inside the fetcher (ports 80/443 unless configured, no
 * private hosts, every redirect hop re-checked, byte cap, one deadline). A source's credential is
 * read from the environment by NAME at fetch time (config.secrets[auth.env]) and never stored,
 * logged, or sent to another origin than the one it was configured for.
 */
const { sha256, decodeBody } = require('../util');

const ACCEPT = {
    http: 'text/html, application/xhtml+xml, application/json;q=0.9, text/plain;q=0.8, */*;q=0.1',
    feed: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
    api: 'application/json, application/xml;q=0.9, */*;q=0.1',
};

/** Retry-After (seconds or an HTTP date) → ms from now, or null. */
function retryAfterMs(value, now) {
    if (value == null) return null;
    const s = String(value).trim();
    if (/^\d{1,7}$/.test(s)) return Number(s) * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * The headers a source asks for: its own (minus the ones the fetcher owns), its Accept, and its
 * credential when it names an environment variable that is set.
 */
function requestFor(source, secrets, accept) {
    const headers = { ...(source.headers || {}) };
    const sensitive = [];
    let url = String(source.url);
    if (accept) headers.Accept = accept;
    const auth = source.auth;
    if (auth && auth.mode && auth.mode !== 'none') {
        const secret = secrets ? secrets[auth.env] : null;
        if (!secret) return { missing: auth.env };
        if (auth.mode === 'bearer') { headers.Authorization = `Bearer ${secret}`; sensitive.push('Authorization'); }
        else if (auth.mode === 'header' && auth.header) { headers[auth.header] = secret; sensitive.push(auth.header); }
        else if (auth.mode === 'query' && auth.param) { const u = new URL(url); u.searchParams.set(auth.param, secret); url = u.toString(); }
    }
    return { url, headers, sensitive };
}

/** True when the watch only needs to know whether the value changed (a HEAD may answer it). */
function onlyChange(watch) {
    const mode = (watch.comparison && watch.comparison.mode) || 'changed';
    const op = (watch.condition && watch.condition.op) || 'changed';
    return op === 'changed' && mode !== 'none';
}

/**
 * One conditional fetch of a source, shared by the http, feed and api carriers.
 * → { state, http_status, bytes, raw_body_hash, etag, last_modified, body, content_type, detail, error_code, notBefore, final_url }
 */
async function conditionalGet({ source, state = {}, fetcher, secrets, accept, now = () => Date.now(), onlyChangeNeeded = false }) {
    const req = requestFor(source, secrets, accept);
    if (req.missing) {
        return {
            state: 'disabled', error_code: 'credential_missing',
            detail: `environment variable ${req.missing} is not set`, http_status: null, bytes: null, raw_body_hash: null,
            etag: null, last_modified: null, body: null, content_type: null, notBefore: null,
        };
    }
    const conditional = source.conditional !== false;
    const etag = conditional ? (state.etag || null) : null;
    const lastModified = conditional ? (state.last_modified || null) : null;
    const base = {
        http_status: null, bytes: null, raw_body_hash: null, etag, last_modified: lastModified,
        body: null, content_type: null, detail: null, error_code: null, notBefore: null,
    };
    const fetchOpts = { headers: req.headers, etag, lastModified, sensitiveHeaders: req.sensitive };
    const method = String(source.method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';

    const sameValidators = (h) => Boolean(
        (etag && h.etag === etag) || (lastModified && h['last-modified'] === lastModified),
    );

    // HEAD first when only change is needed and there is something to compare with: a page that has
    // not changed costs two headers instead of a body.
    if (onlyChangeNeeded && conditional && (etag || lastModified) && method === 'GET') {
        let head = null;
        try { head = await fetcher.fetchUrl(req.url, { ...fetchOpts, method: 'HEAD' }); } catch { head = null; }
        if (head) {
            if (head.status === 304) return { ...base, state: 'not_modified', http_status: 304 };
            if ((head.status === 200 || head.status === 204) && sameValidators(head.headers)) {
                return { ...base, state: 'not_modified', http_status: head.status };
            }
        }
    }

    let res;
    try {
        res = await fetcher.fetchUrl(req.url, { ...fetchOpts, method });
    } catch (err) {
        const code = err.code || 'network';
        return {
            ...base,
            state: code === 'timeout' ? 'timeout' : 'http_error',
            error_code: code,
            detail: String(err.message).slice(0, 500),
        };
    }
    const out = {
        ...base,
        http_status: res.status,
        bytes: res.bytes != null ? res.bytes : null,
        etag: res.headers.etag || etag,
        last_modified: res.headers['last-modified'] || lastModified,
        content_type: res.headers['content-type'] || null,
        final_url: res.finalUrl,
    };
    if (res.status === 304) return { ...out, state: 'not_modified' };
    if (res.status === 429) {
        const wait = Math.min(retryAfterMs(res.headers['retry-after'], now()) ?? 10 * 60 * 1000, 24 * 3600 * 1000);
        return { ...out, state: 'rate_limited', error_code: 'upstream_429', detail: `the site asked us to wait ${Math.round(wait / 1000)} s`, notBefore: now() + wait };
    }
    if (res.status === 503) {
        const wait = retryAfterMs(res.headers['retry-after'], now());
        return { ...out, state: 'http_error', error_code: 'http_503', detail: 'HTTP 503', notBefore: wait == null ? null : now() + Math.min(wait, 24 * 3600 * 1000) };
    }
    if (res.status !== 200 && res.status !== 203) {
        return { ...out, state: 'http_error', error_code: `http_${res.status}`, detail: `HTTP ${res.status}` };
    }
    if (method === 'HEAD') {
        return { ...out, state: 'ok', document: { status: res.status, etag: out.etag, last_modified: out.last_modified, content_type: out.content_type, content_length: Number(res.headers['content-length']) || null } };
    }
    const hash = sha256(res.body);
    out.raw_body_hash = hash;
    out.bytes = res.body.length;
    if (state.last_body_hash && state.last_body_hash === hash) {
        return { ...out, state: 'no_change', detail: `the body hashed ${hash.slice(0, 16)}… again` };
    }
    return { ...out, state: 'ok', body: res.body };
}

function createHttpCarrier({ fetcher, config }) {
    return {
        name: 'http',
        run: async ({ watch, state }) => conditionalGet({
            source: watch.source, state, fetcher, secrets: config.secrets, accept: ACCEPT.http,
            onlyChangeNeeded: onlyChange(watch),
        }),
    };
}

module.exports = { createHttpCarrier, conditionalGet, retryAfterMs, onlyChange, requestFor, ACCEPT, decodeBody };
