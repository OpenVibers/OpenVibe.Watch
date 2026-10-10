'use strict';
/** The expand copy, transaction boundary, disabled relay and SDK delivery through Watch's wiring. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { load } = require('../server/config');
const { start } = require('../server/index');
const { envelope } = require('../server/events/envelope');
const { suite, silent, watchDef, newUser } = require('./helpers');

const t = suite('outbox');
const migrations = path.join(__dirname, '..', 'migrations');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-outbox-'));
const db = createDb({ pglite: true, service: 'watch-outbox-test', log: silent });
let svc;
const ms = 1750000000000;
const event = envelope({
    event_type: 'watch.watch.created', subject: { type: 'watch', id: 'wch_01J0000000000000000000000' },
    payload: { watch_id: 'wch_01J0000000000000000000000', owner: 'usr_01J0000000000000000000000', name: 'old', status: 'active' },
    priority: 'low',
}, 'watch', () => ms);

const config = (eventsUrl) => load({
    NODE_ENV: 'test', WATCH_WORKER: 'off', EVENTS_URL: eventsUrl,
    OV_NETWORK_INTERNAL_URL: 'http://network.test', OV_NETWORK_JWKS_URL: 'http://network.test/jwks',
    OV_OAUTH_CLIENT_ID: 'watch', OV_OAUTH_CLIENT_SECRET: 'test-secret',
});
const calls = [];
async function fakeFetch(url, opts = {}) {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/oauth/token')) {
        const body = new URLSearchParams(opts.body);
        assert.strictEqual(body.get('audience'), 'openvibe.events');
        assert.strictEqual(body.get('scope'), 'events.event.publish');
        return Response.json({ access_token: 'service-token', token_type: 'Bearer', expires_in: 300 });
    }
    if (String(url).endsWith('/api/v1/events')) {
        assert.strictEqual(new Headers(opts.headers).get('authorization'), 'Bearer service-token');
        return Response.json({ event_id: event.event_id, seq: 12, duplicate: false });
    }
    if (String(url).endsWith('/.well-known/openvibe')) {
        return Response.json({ issuer: 'http://network.test', contracts: { version: '0.129.0' }, services: [{ id: 'events', origin: 'http://events.test' }] });
    }
    if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
    throw new Error(`unexpected request ${url}`);
}

t('expand copies only pending legacy rows into the exact SDK table', async () => {
    try {
        for (const name of fs.readdirSync(migrations).filter(n => /^000[1-3]_/.test(n))) fs.copyFileSync(path.join(migrations, name), path.join(dir, name));
        await db.migrate({ dir, log: silent });
        await db.query('INSERT INTO event_outbox (event_id, event_type, envelope, created_at, attempts, next_attempt_at) VALUES ($1, $2, $3, $4, 2, 0)', [event.event_id, event.event_type, JSON.stringify(event), ms]);
        const sent = { ...event, event_id: 'evt_01J0000000000000000000001' };
        await db.query('INSERT INTO event_outbox (event_id, event_type, envelope, created_at, sent_at) VALUES ($1, $2, $3, $4, $5)', [sent.event_id, sent.event_type, JSON.stringify(sent), ms, ms]);
        fs.copyFileSync(path.join(migrations, '0004_sdk_outbox.sql'), path.join(dir, '0004_sdk_outbox.sql'));
        await db.migrate({ dir, log: silent });
        const rows = await db.many('SELECT event_id, envelope, attempts, next_attempt_at FROM service_outbox');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].event_id, event.event_id);
        assert.deepStrictEqual(rows[0].envelope, event);
        assert.strictEqual(rows[0].attempts, 2);
        assert.strictEqual(await db.value('SELECT count(*) FROM event_outbox'), 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('rows wait with the relay off and an aborted change has no event', async () => {
    svc = await start({ config: config(''), db, fetchImpl: fakeFetch, log: silent, listen: false });
    assert.deepStrictEqual(await svc.outbox.status(), { enabled: false, pending: 1, rejected: 0, last_error: null });
    await assert.rejects(db.tx(async () => {
        await db.query('INSERT INTO counters (name, value) VALUES ($1, 1)', ['aborted']);
        await svc.outbox.emit(envelope({ event_type: 'watch.watch.updated', subject: event.subject, payload: event.payload }, 'watch', () => ms + 1));
        throw new Error('abort');
    }), /abort/);
    assert.strictEqual(await db.value('SELECT count(*) FROM counters WHERE name = $1', ['aborted']), 0);
    assert.strictEqual((await svc.outbox.status()).pending, 1);
    assert.strictEqual(calls.filter(c => c.url.endsWith('/api/v1/events')).length, 0);
    await svc.close();
});

t('the SDK relay posts the migrated row with a service token', async () => {
    svc = await start({ config: config('http://events.test'), db, fetchImpl: fakeFetch, log: silent, listen: false });
    await svc.outbox.outbox.flush();
    const posts = calls.filter(c => c.url.endsWith('/api/v1/events'));
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(JSON.parse(posts[0].opts.body).event_id, event.event_id);
    assert.strictEqual((await svc.outbox.status()).pending, 0);
    assert.strictEqual(await db.value('SELECT count(*) FROM service_outbox WHERE sent_at IS NOT NULL'), 1);
});

t('a committed registry change and its event appear together', async () => {
    await svc.outbox.stop();
    const principal = { sub: newUser() };
    const row = await svc.registry.create(watchDef(), principal);
    const events = await db.many('SELECT envelope FROM service_outbox WHERE envelope->>\'event_type\' = $1', ['watch.watch.created']);
    assert.ok(await db.maybe('SELECT id FROM watches WHERE id = $1', [row.id]));
    assert.ok(events.some(r => r.envelope.subject.id === row.id));
    const before = await db.value('SELECT count(*) FROM service_outbox');
    await assert.rejects(db.tx(async () => {
        await svc.registry.create(watchDef(), principal);
        throw new Error('abort registry');
    }), /abort registry/);
    assert.strictEqual(await db.value('SELECT count(*) FROM service_outbox'), before);
    assert.strictEqual(await db.value('SELECT count(*) FROM watches'), 1);
    await svc.close();
    await db.close();
});

t.run();
