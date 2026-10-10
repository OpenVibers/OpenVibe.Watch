'use strict';
/**
 * The webhook poster (server/net/post.js): a JSON POST through the SSRF guard. It sends the body and headers it is
 * given and answers the receiver's status; it never follows a redirect; a URL the guard refuses (an internal IP
 * literal, a name that resolves to one at connect time, a port off the list) is refused before or at connect; a
 * receiver that never answers times out.
 */
const assert = require('assert');
const http = require('http');
const { createGuard } = require('../server/net/guard');
const { createPoster } = require('../server/net/post');
const { suite } = require('./helpers');

const t = suite('post');
let server;
let base;
const seen = [];

t('a receiver', async () => {
    server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/elsewhere' }); return res.end(); }
            if (req.url === '/slow') return;   // never answers
            res.writeHead(req.url === '/busy' ? 503 : 204);
            res.end();
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

t('it POSTs the body and headers through the guard and answers the status; a redirect is not followed', async () => {
    const guard = createGuard({ allowPrivateHosts: ['127.0.0.1'] });
    const post = createPoster({ guard, userAgent: 'OpenVibeWatch/test', timeoutMs: 2000 });
    const r = await post(`${base}/hook`, { headers: { 'X-OpenVibe-Event-Type': 'watch.watch.triggered' }, body: '{"a":1}' });
    assert.strictEqual(r.status, 204);
    const got = seen.pop();
    assert.deepStrictEqual([got.method, got.url, got.body], ['POST', '/hook', '{"a":1}']);
    assert.strictEqual(got.headers['content-type'], 'application/json');
    assert.strictEqual(got.headers['user-agent'], 'OpenVibeWatch/test');
    assert.strictEqual(got.headers['x-openvibe-event-type'], 'watch.watch.triggered');
    assert.strictEqual((await post(`${base}/busy`, { body: '{}' })).status, 503);
    const before = seen.length;
    assert.strictEqual((await post(`${base}/redirect`, { body: '{}' })).status, 302);
    assert.strictEqual(seen.length, before + 1, 'the Location was not fetched');
});

t('internal addresses are refused: an IP literal before anything is sent, a resolved name at connect time', async () => {
    const strict = createGuard({});
    const post = createPoster({ guard: strict, userAgent: 'x', timeoutMs: 2000 });
    const before = seen.length;
    await assert.rejects(post(`${base}/hook`, { body: '{}' }), (e) => e.code === 'address_refused' || e.code === 'port_refused');
    await assert.rejects(post('http://169.254.169.254/latest/meta-data/', { body: '{}' }), (e) => e.code === 'address_refused');
    await assert.rejects(post('https://user:pw@example.org/x', { body: '{}' }), (e) => e.code === 'bad_url');
    // A public-looking name whose DNS answer is internal: refused by the guard's lookup at connect.
    const rebinding = createGuard({ lookupImpl: (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) });
    const viaName = createPoster({ guard: rebinding, userAgent: 'x', timeoutMs: 2000 });
    await assert.rejects(viaName('https://hooks.example.org/w', { body: '{}' }), (e) => e.code === 'address_refused');
    assert.strictEqual(seen.length, before, 'nothing reached the receiver');
});

t('a receiver that never answers times out', async () => {
    const guard = createGuard({ allowPrivateHosts: ['127.0.0.1'] });
    const post = createPoster({ guard, userAgent: 'x', timeoutMs: 150 });
    await assert.rejects(post(`${base}/slow`, { body: '{}' }), (e) => e.code === 'ETIMEDOUT');
});

t('done', async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

t.run();
