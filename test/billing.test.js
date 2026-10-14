'use strict';
/**
 * Usage readings → Billing (plan T5 step 14, Watch slice; server/billing.js, migrations/0008_billing_readings.sql):
 * a completed check queues exactly one check-operation reading with its run, keyed by the run id, so a replay inserts
 * nothing; a failed check queues nothing; a watch without a project sends no project; WATCH_BILLING_INTERVAL_MS=0
 * starts no timer; only Billing refusing the reading itself (400/422) is permanent, a 429 or 5xx stays pending; and no
 * secret or token reaches a log line.
 */
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, site, suite, newUser } = require('./helpers');
const { createWatchBilling, METRIC } = require('../server/billing');
const { load } = require('../server/config');

const t = suite('billing');
let svc;
let web;

const P = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPS';
const person = { sub: newUser() };
const TOKEN = 'not-a-real-token-' + 'x'.repeat(12);
const CLIENT_SECRET = 'billing-client-secret-456';
const lines = [];
const capture = (...a) => lines.push(a.map(String).join(' '));
const log = { log: capture, warn: capture, error: capture };
const projects = { async check(project, subject) { return { ok: project === P && subject === person.sub }; } };

const def = (overrides = {}) => ({
    name: 'price watch',
    source: { kind: 'http', url: `${web.origin}/price`, format: null },
    cadence: { every_sec: 900 },
    extraction: { kind: 'text' },
    condition: { op: 'changed' },
    action: [{ kind: 'notification' }],
    ...overrides,
});
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const readings = async () => (await svc.db.many('SELECT * FROM billing_readings ORDER BY id')).map((r) => ({ ...r, envelope: json(r.envelope) }));
const rowOf = (key) => svc.db.prepare('SELECT * FROM billing_readings WHERE event_id = ?').get(key);

t('boot', async () => {
    web = await site({
        '/price': () => ({ headers: { 'content-type': 'text/plain' }, body: '19.99' }),
        '/down': () => ({ status: 500, body: 'oops' }),
    });
    svc = await boot({ log, projects, env: { WATCH_BILLING_INTERVAL_MS: '3600000' } });
    assert.strictEqual(svc.billing.enabled, true);
    assert.strictEqual(svc.billing.reporting, false, 'no OV_BILLING_INTERNAL_URL: readings stay queued');
});

t('a completed check queues exactly one check-operation reading with its run', async () => {
    const w = await svc.registry.create(def(), person);
    const out = await svc.check.run(w.id, { trigger: 'manual' });
    assert.ok(!['http_error', 'timeout'].includes(out.run.state), out.run.state);
    const rows = (await readings()).filter((r) => r.envelope.idempotency_key === `watch:check:${out.run.id}`);
    assert.strictEqual(rows.length, 1);
    const r = rows[0].envelope;
    assert.deepStrictEqual(r, {
        id: `watch:check:${out.run.id}`, idempotency_key: `watch:check:${out.run.id}`, service: 'watch', subject: person.sub,
        resource: METRIC, provider: 'http', operation: 'http', quantity: 1, unit: 'check',
        at: new Date(Number(out.run.finished_at)).toISOString(), cost_estimate: 0, source: 'watch.check',
    });
    assert.ok(!('project' in r), 'a watch without a project sends no project');
    const v = validate('platform.usage-sample@1', r);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.strictEqual((await svc.billing.status()).pending, (await readings()).length);
    // Readiness (loopback) reports the relay: counts only, never the URL or a credential.
    const ready = await (await fetch(`${svc.base}/api/ready`)).json();
    assert.deepStrictEqual(ready.billing, { enabled: true, reporting: false, pending: (await readings()).length, rejected: 0, last_error: null });
});

t('a replay of the same run inserts nothing', async () => {
    const w = await svc.registry.create(def(), person);
    const out = await svc.check.run(w.id, { trigger: 'manual' });
    const before = (await readings()).length;
    const watch = svc.registry.fromRow(await svc.db.prepare('SELECT * FROM watches WHERE id = ?').get(w.id));
    const run = await svc.db.prepare('SELECT * FROM check_runs WHERE id = ?').get(out.run.id);
    const inserted = await svc.db.tx((tx) => svc.billing.queue(tx, { watch, run }));
    assert.strictEqual(inserted, false);
    assert.strictEqual((await readings()).length, before);
});

t('a watch with a project names it; the run cost becomes cost_estimate', async () => {
    const w = await svc.registry.create(def({ project_id: P }), person);
    const out = await svc.check.run(w.id, { trigger: 'manual' });
    const row = await rowOf(`watch:check:${out.run.id}`);
    assert.strictEqual(json(row.envelope).project, P);
    const costed = svc.billing.readingOf({ watch: { project_id: P, owner: person.sub }, run: { ...out.run, cost_usd: '0.25' } });
    assert.strictEqual(costed.cost_estimate, 0.25);
});

t('a failed check queues nothing', async () => {
    const w = await svc.registry.create(def({ source: { kind: 'http', url: `${web.origin}/down`, format: null } }), person);
    const before = (await readings()).length;
    const out = await svc.check.run(w.id, { trigger: 'manual' });
    assert.strictEqual(out.run.state, 'http_error');
    assert.strictEqual((await readings()).length, before);
    assert.strictEqual(await rowOf(`watch:check:${out.run.id}`), undefined);
});

t('WATCH_BILLING_INTERVAL_MS=0 (the default) starts no timer; an interval starts one and stop() clears it', async () => {
    const config = load({ NODE_ENV: 'test' }).billing;
    assert.strictEqual(config.intervalMs, 0);
    assert.strictEqual(config.clientId, 'watch');
    assert.strictEqual(config.audience, 'openvibe.billing');
    assert.strictEqual(config.timeoutMs, 5000);
    const off = createWatchBilling({ db: svc.db, config, log });
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.start(), false);
    assert.strictEqual(off.running, false);
    await off.stop();
    const on = createWatchBilling({ db: svc.db, config: { ...config, intervalMs: 60000 }, log });
    assert.strictEqual(on.start(), true);
    assert.strictEqual(on.running, true);
    assert.strictEqual(on.start(), false, 'one timer');
    await on.stop();
    assert.strictEqual(on.running, false);
});

t('Billing 5xx or 429 leaves a reading pending; 400/422 rejects it; no secret or token is logged', async () => {
    const FIXED = Date.UTC(2026, 9, 13, 12, 0, 0);
    // Push the check readings out of the relay's way: this part posts one reading at a time.
    await svc.db.exec('UPDATE billing_readings SET next_attempt_at = $1', [FIXED + 10 * 86400000]);
    const statuses = { 'k-500': 500, 'k-503': 503, 'k-429': 429, 'k-400': 400, 'k-422': 422 };
    const posted = [];
    const fetchImpl = async (url, opts) => {
        if (!String(url).startsWith('http://billing.test/')) {
            return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ access_token: TOKEN, token_type: 'Bearer', expires_in: 300 }), text: async () => '' };
        }
        assert.strictEqual(String(url), 'http://billing.test/api/v1/usage');
        assert.strictEqual(opts.headers.Authorization, `Bearer ${TOKEN}`);
        const sent = JSON.parse(opts.body);
        posted.push(sent.idempotency_key);
        const status = statuses[sent.idempotency_key];
        return { ok: false, status, headers: new Headers(), text: async () => `status ${status}`, json: async () => ({}) };
    };
    const talking = createWatchBilling({
        db: svc.db, clock: { now: () => FIXED }, fetchImpl, log, networkUrl: 'http://network.test',
        config: { url: 'http://billing.test', clientId: 'watch', clientSecret: CLIENT_SECRET, audience: 'openvibe.billing', timeoutMs: 2000, intervalMs: 1000 },
    });
    assert.strictEqual(talking.reporting, true);
    for (const [k, status] of Object.entries(statuses)) {
        const reading = talking.reporter.sample({ idempotency_key: k, subject: person.sub, resource: METRIC, provider: 'http', operation: 'http', quantity: 1, unit: 'check', at: new Date(FIXED).toISOString() });
        await svc.db.tx((tx) => talking.reporter.record(tx, reading));
        await talking.flush();
        const r = await rowOf(k);
        assert.ok(!r.sent_at, `${status} is not sent`);
        if (status === 400 || status === 422) assert.ok(r.rejected_at, `${status} refuses the reading`);
        else {
            assert.ok(!r.rejected_at, `${status} stays pending`);
            assert.ok(Number(r.next_attempt_at) > FIXED, `${status} backs off`);
        }
    }
    assert.deepStrictEqual(posted, Object.keys(statuses));
    const status = await talking.status();
    assert.strictEqual(status.rejected, 2);
    await talking.stop();
    const leaked = lines.filter((l) => l.includes(TOKEN) || l.includes(CLIENT_SECRET) || l.includes('watch-secret'));
    assert.deepStrictEqual(leaked, [], 'no secret or token in any log line');
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
