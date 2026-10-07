'use strict';
/**
 * The only way Watch reaches the internet: GET (or HEAD) with an address guard (server/net/guard.js),
 * manual redirects re-checked hop by hop, conditional headers, one overall deadline covering
 * connect + headers + body, a byte cap applied to the decoded body, and no cookies.
 *
 *   fetchUrl(url, { method, headers, etag, lastModified, beforeHop(url) }) →
 *     { kind: 'response', status, headers, body (Buffer|null), finalUrl, bytes }
 *   or throws FetchError { code: timeout | too_large | address_refused | port_refused | bad_url |
 *     too_many_redirects | network | hop_refused, detail }
 *
 * Copied from OpenVibe.Sources/server/net/fetcher.js; Watch adds `method: 'HEAD'`, which a
 * conditional watch uses to ask "has this changed?" without pulling the body (the dossier's
 * "HEAD first when only change is needed").
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { GuardError } = require('./guard');

class FetchError extends Error {
    constructor(code, detail) { super(detail); this.code = code; }
}

function createFetcher({ guard, userAgent, timeoutMs = 20000, maxBytes = 5 * 1024 * 1024, maxRedirects = 5 }) {
    function once(url, method, headers, deadline, capBytes) {
        return new Promise((resolve, reject) => {
            const mod = url.protocol === 'https:' ? https : http;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return reject(new FetchError('timeout', 'deadline passed'));
            let settled = false;
            const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
            const req = mod.request(url, {
                method,
                headers,
                lookup: guard.lookup,
                agent: false,
                timeout: remaining,
            }, (res) => {
                const status = res.statusCode;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    return done(resolve, { redirect: res.headers.location, status, headers: res.headers });
                }
                // A HEAD answer carries no body by definition; nothing to cap or collect.
                if (method === 'HEAD') {
                    res.resume();
                    return done(resolve, { status, headers: res.headers, body: null, bytes: 0 });
                }
                const declared = Number(res.headers['content-length']);
                if (Number.isFinite(declared) && declared > capBytes && status === 200) {
                    req.destroy();
                    return done(reject, new FetchError('too_large', `content-length ${declared} exceeds ${capBytes} bytes`));
                }
                let stream = res;
                const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
                if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
                else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
                else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
                const chunks = [];
                let bytes = 0;
                stream.on('data', (c) => {
                    bytes += c.length;
                    if (bytes > capBytes) {
                        req.destroy();
                        done(reject, new FetchError('too_large', `body exceeds ${capBytes} bytes`));
                        return;
                    }
                    chunks.push(c);
                });
                stream.on('end', () => done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), bytes }));
                stream.on('error', (err) => done(reject, new FetchError('network', `body: ${err.message}`)));
                res.on('aborted', () => done(reject, new FetchError('network', 'response aborted')));
            });
            const timer = setTimeout(() => {
                req.destroy();
                done(reject, new FetchError('timeout', `no complete response within ${timeoutMs} ms`));
            }, remaining);
            req.on('timeout', () => {
                req.destroy();
                done(reject, new FetchError('timeout', `no complete response within ${timeoutMs} ms`));
            });
            req.on('error', (err) => {
                if (err instanceof GuardError) return done(reject, new FetchError(err.code, err.message));
                done(reject, new FetchError('network', `${err.code || 'error'}: ${err.message}`));
            });
            req.end();
        });
    }

    async function fetchUrl(input, { method = 'GET', headers = {}, etag = null, lastModified = null, beforeHop = null, capBytes = maxBytes, sensitiveHeaders = [] } = {}) {
        const verb = String(method).toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
        const deadline = Date.now() + timeoutMs;
        let url;
        try { url = guard.checkUrl(input); } catch (err) { throw new FetchError(err.code || 'bad_url', err.message); }
        const h = {
            'User-Agent': userAgent,
            Accept: headers.Accept || '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            ...headers,
        };
        if (etag) h['If-None-Match'] = etag;
        if (lastModified) h['If-Modified-Since'] = lastModified;
        for (let hop = 0; ; hop++) {
            const r = await once(url, verb, h, deadline, capBytes);
            if (!r.redirect) return { kind: 'response', status: r.status, headers: r.headers, body: r.body, bytes: r.bytes, finalUrl: url.toString() };
            if (hop >= maxRedirects) throw new FetchError('too_many_redirects', `more than ${maxRedirects} redirects`);
            let next;
            try { next = guard.checkUrl(new URL(r.redirect, url).toString()); } catch (err) { throw new FetchError(err.code || 'bad_url', `redirect: ${err.message}`); }
            if (beforeHop) {
                const verdict = await beforeHop(next);
                if (verdict && verdict.refuse) throw new FetchError('hop_refused', verdict.refuse);
            }
            // Conditional headers belong to the original resource only; credentials never leave
            // the origin they were configured for.
            delete h['If-None-Match'];
            delete h['If-Modified-Since'];
            if (next.origin !== url.origin) for (const name of sensitiveHeaders) delete h[name];
            url = next;
        }
    }

    return { fetchUrl };
}

module.exports = { createFetcher, FetchError };
