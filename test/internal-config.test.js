'use strict';
/**
 * D11 owner settings: the watch.provider_rates namespace and /internal/config.
 *
 *   - watch.config.manage is required; a service token without it is 403;
 *   - WATCH_PROVIDER_RATES is a pin: it wins, is read-only, and a write is 409 config.pinned_in_env;
 *   - an owner change applies live: the API appears and the module starts reading the new value;
 *   - with no KEK the store works and reports sealed:false; with one it is sealed;
 *   - a secret-class value never leaves a summary, history or snapshot.
 */
const assert = require('assert');
const { boot, serviceToken, request, suite } = require('./helpers');
const test = suite('internal config');

const CAP = ['watch.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const SECRET = 'sk_watch_d11_toppsecret_123456';
const admin = () => serviceToken('network', CAP);

test('the summary: schema, the env pin, sealed:false without a KEK', async () => {
        const svc = await boot({ env: { WATCH_PROVIDER_RATES: '1' } });
        try {
            const r = await request(svc.base, 'GET', '/internal/config/watch.provider_rates', { token: admin() });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.body.namespace, 'watch.provider_rates');
            assert.strictEqual(r.body.sealed, false);
            assert.strictEqual(r.body.values.enabled, true);
            assert.deepStrictEqual(r.body.pins.enabled, { env: 'WATCH_PROVIDER_RATES', pinned: true });
            assert.ok(!r.text.includes(SECRET));
        } finally { await svc.stop(); }
    });

    test('a service token without watch.config.manage is refused', async () => {
        const svc = await boot();
        try {
            const r = await request(svc.base, 'GET', '/internal/config/watch.provider_rates', { token: serviceToken('services', ['watch.watch.read']) });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.body.code, 'capability.denied');
        } finally { await svc.stop(); }
    });

    test('an env-pinned key is read-only', async () => {
        const svc = await boot({ env: { WATCH_PROVIDER_RATES: '1' } });
        try {
            const r = await request(svc.base, 'POST', '/internal/config/watch.provider_rates', {
                token: admin(), headers: { 'x-ov-subject': OWNER }, body: { values: { enabled: false }, reason: 'off' },
            });
            assert.strictEqual(r.status, 409, r.text.slice(0, 300));
            assert.strictEqual(r.body.code, 'config.pinned_in_env');
        } finally { await svc.stop(); }
    });

    test('an owner change applies live: the API appears and the worker switch is on', async () => {
        const lines = [];
        const log = { log: (m) => lines.push(String(m)), info: (m) => lines.push(String(m)), warn: () => {}, error: () => {} };
        const svc = await boot({ log });
        try {
            assert.strictEqual(svc.config.providerRates.enabled, false);
            assert.strictEqual((await request(svc.base, 'GET', '/api/v1/provider-rates', { token: serviceToken('network', ['watch.watch.read']) })).status, 404);
            const r = await request(svc.base, 'POST', '/internal/config/watch.provider_rates', {
                token: admin(), headers: { 'x-ov-subject': OWNER }, body: { values: { enabled: true }, reason: 'owner turned it on' },
            });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.body.revision, 2);
            assert.strictEqual(svc.config.providerRates.enabled, true);
            assert.strictEqual(svc.providerRates.enabled, true);
            const got = await request(svc.base, 'GET', '/api/v1/provider-rates', { token: serviceToken('network', ['watch.watch.read']) });
            assert.strictEqual(got.status, 200, got.text.slice(0, 300));
            assert.ok(lines.join('\n').includes('by user:' + OWNER), 'the audit line names the actor');
            assert.ok(!lines.join('\n').includes(SECRET));
        } finally { await svc.stop(); }
    });

    test('with a KEK the store is sealed and boot reseals', async () => {
        const svc = await boot({ env: { OV_CONFIG_KEKS: 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', OV_CONFIG_KEK_CURRENT: 'k1' } });
        try {
            const r = await request(svc.base, 'GET', '/internal/config/watch.provider_rates', { token: admin() });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.body.sealed, true);
            assert.strictEqual(r.body.kek, 'k1');
        } finally { await svc.stop(); }
    });

    test('a secret is write-only and never appears in a summary, snapshot or history', async () => {
        const svc = await boot();
        try {
            const shared = require('openvibe-shared/config');
            const extra = await shared.createConfigStore({
                db: svc.db, service: 'watch', namespace: 'watch.test_secrets',
                schema: { type: 'object', additionalProperties: false, properties: { api_key: { type: 'string' } } },
                classify: () => 'secret',
            });
            const marker = await extra.setSecret('api_key', SECRET, { actor: { type: 'user', id: OWNER }, reason: 'test' });
            assert.strictEqual(marker.redacted, true);
            assert.ok(!JSON.stringify(marker).includes(SECRET));
            const summary = await extra.summary();
            assert.strictEqual(summary.values.api_key.redacted, true);
            assert.ok(!JSON.stringify(summary).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.history()).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.snapshot(1)).includes(SECRET));
        } finally { await svc.stop(); }
    });
test.run().catch((e) => { console.error(e); process.exit(1); });
