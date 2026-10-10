'use strict';
/**
 * The one way a webhook action reaches a receiver (plan T18 step 5): POST a JSON body to a URL the watch's owner chose,
 * through the same SSRF guard as every fetch (server/net/guard.js: http(s) on the allowed ports, no credentials in the
 * URL, every resolved address public at connect time, so a DNS answer cannot change between check and connect).
 *
 *   const post = createPoster({ guard, userAgent, timeoutMs });
 *   const { status } = await post(url, { headers, body });     // throws on a refused URL, a timeout or a lost connection
 *
 * A redirect is never followed: a 3xx is the receiver's answer, like any other non-2xx. The response body is read only
 * up to a few KiB and discarded; nothing a receiver says is stored.
 */
const http = require('http');
const https = require('https');

const MAX_RESPONSE_BYTES = 4096;

function createPoster({ guard, userAgent, timeoutMs = 10_000 }) {
    return async function post(url, { headers = {}, body = '' } = {}) {
        const u = guard.checkUrl(url);                                   // GuardError: bad_url, port_refused, address_refused
        const mod = u.protocol === 'https:' ? https : http;
        const payload = Buffer.from(String(body));
        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
            const req = mod.request(u, {
                method: 'POST',
                lookup: guard.lookup,
                timeout: timeoutMs,
                headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'User-Agent': userAgent, ...headers },
            }, (res) => {
                let seen = 0;
                res.on('data', (chunk) => { seen += chunk.length; if (seen > MAX_RESPONSE_BYTES) res.destroy(); });
                const done = () => finish(resolve, { status: res.statusCode });
                res.on('end', done);
                res.on('close', done);
                res.on('error', done);
            });
            req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
            req.on('error', (err) => finish(reject, err));
            req.end(payload);
        });
    };
}

module.exports = { createPoster };
