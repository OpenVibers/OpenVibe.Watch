'use strict';
/**
 * ADR-033: Watch's part of an account export and of an account deletion, through the signed loopback route
 * POST /internal/events with a stand-in Network. A person's watches (with their check runs and observations) and
 * sign-in sessions go; someone else's watch stays; the export never carries a session; a redelivery erases nothing
 * twice; a bad signature and a forwarded request are refused.
 */
const assert = require('assert');
const http = require('http');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, request, userToken, site, suite, watchDef, newUser } = require('./helpers');

const t = suite('account-data');
const SECRET = `whsec_${'fixture'.repeat(6)}`;

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_watch', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const me = newUser();
const other = newUser();
let svc;
let web;
let stub;
const deliver = async (event, { secret = SECRET, headers = {} } = {}) => {
    const body = JSON.stringify({ event, seq: 1 });
    const res = await fetch(`${svc.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } });
    return { status: res.status, json: await res.json().catch(() => null) };
};
const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
const count = async (sql, args) => Number(await svc.db.value(sql, args));

t('boot, and the person\'s watches, checks and sessions', async () => {
    stub = await startNetworkStub();
    web = await site({ '/price': () => ({ body: '19.99' }) });
    svc = await boot({ env: { WATCH_EVENTS_SECRET: SECRET }, accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'watch', clientSecret: 'watch-secret' }) });
    for (const [who, name] of [[me, 'my price'], [other, 'their price']]) {
        const r = await request(svc.base, 'POST', '/api/v1/watches', { token: userToken(who), body: watchDef({ name, source: { kind: 'http', url: `${web.origin}/price`, format: null } }) });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual((await request(svc.base, 'POST', `/api/v1/watches/${r.body.watch.id}/check`, { token: userToken(who) })).status, 200);
    }
    await svc.signIn({ subject: me, username: 'me' });
    assert.strictEqual(await count('SELECT count(*) FROM check_runs c JOIN watches w ON w.id = c.watch_id WHERE w.owner_sub = $1', [me]), 1);
});

t('the export carries the person\'s watches and no session', async () => {
    const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: me }));
    assert.deepStrictEqual([r.status, r.json.outcome], [200, 'exported'], JSON.stringify(r.json));
    const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
    assert.strictEqual(part.auth, 'Bearer tok_watch');
    assert.deepStrictEqual(part.body.files.map((f) => f.name), ['watches.json']);
    assert.deepStrictEqual(part.body.files[0].content.map((w) => [w.name, w.check_runs]), [['my price', 1]]);
    assert.ok(!JSON.stringify(part.body).includes(other));
});

t('the deletion removes the person\'s watches with their checks and observations, and their sessions; once', async () => {
    const event = ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: me });
    const r = await deliver(event);
    assert.deepStrictEqual([r.status, r.json.outcome], [200, 'erased'], JSON.stringify(r.json));
    assert.strictEqual(await count('SELECT count(*) FROM watches WHERE owner_sub = $1', [me]), 0);
    assert.strictEqual(await count('SELECT count(*) FROM web_sessions WHERE subject = $1', [me]), 0);
    assert.strictEqual(await count('SELECT count(*) FROM check_runs WHERE watch_id NOT IN (SELECT id FROM watches)'), 0, 'no orphaned check runs');
    assert.strictEqual(await count('SELECT count(*) FROM observations WHERE watch_id NOT IN (SELECT id FROM watches)'), 0, 'no orphaned observations');
    assert.strictEqual(await count('SELECT count(*) FROM watches WHERE owner_sub = $1', [other]), 1, 'someone else\'s watch stays');
    const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
    assert.strictEqual(conf.length, 1);
    assert.deepStrictEqual([conf[0].body.erased.watches, conf[0].body.erased.check_runs, conf[0].body.erased.web_sessions], [1, 1, 1]);
    assert.strictEqual((await deliver(event)).json.outcome, 'unchanged');
    assert.strictEqual(stub.calls.filter((c) => c.url.includes('/confirmations')).length, 1);
});

t('the route refuses a bad signature and a request that came through a proxy', async () => {
    const event = ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX2', subject: me });
    assert.strictEqual((await deliver(event, { secret: `whsec_${'mismatch'.repeat(5)}` })).status, 401);
    assert.strictEqual((await deliver(event, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
});

t('stop', async () => { await svc.stop(); await web.close(); await stub.close(); });

t.run();
