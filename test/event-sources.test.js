'use strict';
/**
 * Event sources (plan T18 step 5): a watch whose source is an OpenVibe.Events pattern is checked when a matching public
 * event arrives, never on a cadence. Each event is handled once; only public events wake a watch; a watch has an hourly
 * budget of event checks; Check now answers watch.event_awaited; and the Events subscriptions follow the patterns in use.
 */
const assert = require('assert');
const { boot, suite, newUser } = require('./helpers');
const { createEventSources, patternRegExp, filterMatches } = require('../server/event-sources');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const SECRET = 'event-sources-test-secret-0123456789abcdef';

const t = suite('event-sources');
let svc;
const person = { sub: newUser() };
let n = 0;
const evt = (over = {}) => ({
    event_id: `evt_${String(++n).padStart(4, '0')}`, event_type: 'host.release.published', visibility: 'public',
    timestamp: new Date().toISOString(), subject: { type: 'release', id: `rel_${n}` },
    payload: { repo: 'OpenVibe.Bot', version: `1.${n}.0` }, ...over,
});
const def = (over = {}) => ({
    name: 'bot releases',
    source: { kind: 'event', pattern: 'host.release.published', filter: { repo: 'OpenVibe.Bot' } },
    cadence: null,
    extraction: { kind: 'json', value_path: 'payload.version' },
    condition: { op: 'changed' },
    action: [{ kind: 'notification' }],
    ...over,
});
const runs = async (id) => await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid').all(id);
const observations = async (id) => await svc.db.prepare('SELECT * FROM observations WHERE watch_id = ? ORDER BY rid').all(id);

t('boot', async () => {
    svc = await boot({ env: { WATCH_EVENT_MAX_PER_HOUR: '3', WATCH_EVENTS_SECRET: SECRET } });
});

t('patterns match as Events matches topics; filters read subject.id, subject.type and payload fields', () => {
    assert.ok(patternRegExp('host.release.published').test('host.release.published'));
    assert.ok(!patternRegExp('host.release.published').test('host.release.published.extra'));
    assert.ok(patternRegExp('media.*.ready').test('media.vod.ready'));
    assert.ok(patternRegExp('media.*.ready').test('media.clip.thumb.ready'), '* is one or more whole segments');
    assert.ok(!patternRegExp('media.*.ready').test('media.ready'));
    assert.ok(patternRegExp('live.stream.*').test('live.stream.started'));
    const ev = { subject: { type: 'release', id: 'rel_1' }, payload: { repo: 'OpenVibe.Bot', n: 2, ok: true } };
    assert.ok(filterMatches(null, ev) && filterMatches({}, ev));
    assert.ok(filterMatches({ 'subject.id': 'rel_1', 'subject.type': 'release', repo: 'OpenVibe.Bot', n: 2, ok: true }, ev));
    assert.ok(!filterMatches({ repo: 'OpenVibe.Live' }, ev));
    assert.ok(!filterMatches({ missing: null }, ev), 'a field the event does not carry never matches');
});

t('a matching public event runs the check with the event as its document; the value is recorded', async () => {
    const w = await svc.registry.create(def(), person);
    assert.strictEqual(Number((await svc.db.prepare('SELECT next_due_at FROM watches WHERE id = ?').get(w.id)).next_due_at) >= 0, true);
    const e = evt();
    assert.strictEqual(await svc.eventSources.onEvent(e), 'applied:1');
    const [r] = await runs(w.id);
    assert.deepStrictEqual([r.trigger, r.carrier, r.state], ['event', 'event', 'condition_met'], 'a first value is a change: the watch fires');
    assert.strictEqual(Number(r.triggers), 1);
    const [o] = await observations(w.id);
    assert.strictEqual(o.value, e.payload.version);
    const queued = await svc.db.prepare('SELECT kind, state FROM action_runs WHERE watch_id = ?').all(w.id);
    assert.strictEqual(queued.length, 1, 'its notification is queued like any firing');
    // The same delivery again (Events is at least once): a duplicate, and no second run.
    assert.strictEqual(await svc.eventSources.onEvent(e), 'duplicate');
    assert.strictEqual((await runs(w.id)).length, 1);
    await svc.registry.remove(w.id, person);
});

t('only public events wake a watch, and only the ones its pattern and filter match', async () => {
    const w = await svc.registry.create(def(), person);
    assert.strictEqual(await svc.eventSources.onEvent(evt({ visibility: 'internal' })), 'ignored:visibility');
    assert.strictEqual(await svc.eventSources.onEvent(evt({ visibility: 'private' })), 'ignored:visibility');
    assert.strictEqual(await svc.eventSources.onEvent(evt({ payload: { repo: 'OpenVibe.Live', version: '9.0.0' } })), 'applied:none');
    assert.strictEqual(await svc.eventSources.onEvent(evt({ event_type: 'host.release.failed' })), 'applied:none');
    assert.strictEqual(await svc.eventSources.onEvent(evt({ event_type: 'network.account.deleted' })), 'ignored:type', 'account events are the consumer\'s');
    assert.strictEqual((await runs(w.id)).length, 0);
    // A paused watch sleeps through its events.
    await svc.registry.patch(w.id, { status: 'paused' }, person);
    assert.strictEqual(await svc.eventSources.onEvent(evt()), 'applied:none');
    await svc.registry.remove(w.id, person);
});

t('a watch takes at most WATCH_EVENT_MAX_PER_HOUR event checks an hour; the rest are dropped and counted', async () => {
    const w = await svc.registry.create(def(), person);
    const before = svc.eventSources.stats().dropped;
    const outcomes = [];
    for (const e of [evt(), evt(), evt(), evt()]) outcomes.push(await svc.eventSources.onEvent(e));
    assert.deepStrictEqual(outcomes, ['applied:1', 'applied:1', 'applied:1', 'applied:none']);
    assert.strictEqual((await runs(w.id)).length, 3);
    assert.strictEqual(svc.eventSources.stats().dropped, before + 1);
    await svc.registry.remove(w.id, person);
});

t('through the signed loopback route: a delivery wakes the watch, and Events gets the outcome', async () => {
    const w = await svc.registry.create(def(), person);
    const e = evt();
    const body = JSON.stringify({ event: e });
    const res = await fetch(`${svc.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { event_id: e.event_id, outcome: 'applied:1' });
    const bad = await fetch(`${svc.base}/internal/events`, { method: 'POST', body: JSON.stringify({ event: evt() }), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, 'x'.repeat(40)) } });
    assert.strictEqual(bad.status, 401, 'an unsigned or mis-signed delivery wakes nothing');
    assert.strictEqual((await runs(w.id)).length, 1);
    await svc.registry.remove(w.id, person);
});

t('Check now on an event source answers watch.event_awaited and fetches nothing', async () => {
    const w = await svc.registry.create(def(), person);
    const out = await svc.check.run(w.id, { trigger: 'manual' });
    assert.strictEqual(out.run.state, 'skipped');
    assert.strictEqual(out.run.error_code, 'watch.event_awaited');
    assert.strictEqual(out.unavailable.code, 'watch.event_awaited');
    assert.match(out.run.detail, /host\.release\.published event arrives/);
    await svc.registry.remove(w.id, person);
});

t('sync: one subscription per pattern in use; re-enables, disables the unused, never touches the account topics', async () => {
    const endpoint = `http://127.0.0.1:${svc.config.port}/internal/events`;
    const subs = [
        { id: 'sub_acct', topic_pattern: 'network.account.deleted', endpoint, enabled: true },
        { id: 'sub_old', topic_pattern: 'shop.price.changed', endpoint, enabled: true },
        { id: 'sub_off', topic_pattern: 'media.*.ready', endpoint, enabled: false },
        { id: 'sub_other', topic_pattern: 'shop.price.changed', endpoint: 'http://127.0.0.1:9/elsewhere', enabled: true },
    ];
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        calls.push(`${opts.method || 'GET'} ${u.pathname}`);
        const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
        if (u.pathname === '/oauth/token') return json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 300 });
        if (u.pathname === '/api/v1/subscriptions' && opts.method === 'GET') return json(200, { subscriptions: subs });
        if (u.pathname === '/api/v1/subscriptions' && opts.method === 'POST') { const b = JSON.parse(opts.body); return json(201, { id: 'sub_new', topic_pattern: b.topic_pattern }); }
        if (/\/(enable|disable)$/.test(u.pathname)) return json(200, {});
        return json(404, {});
    };
    const w1 = await svc.registry.create(def(), person);
    const w2 = await svc.registry.create(def({ source: { kind: 'event', pattern: 'media.*.ready', filter: null } }), person);
    const config = { ...svc.config, events: { ...svc.config.events, url: 'http://events.test', secrets: ['s'.repeat(40)] } };
    const es = createEventSources({ db: svc.db, check: svc.check, config, fetchImpl, log: { log() {}, warn() {}, error() {} } });
    const done = await es.sync();
    assert.deepStrictEqual(done, { created: ['host.release.published'], enabled: ['media.*.ready'], disabled: ['shop.price.changed'] });
    assert.ok(calls.includes('POST /api/v1/subscriptions/sub_old/disable'));
    assert.ok(!calls.some((c) => c.includes('sub_acct') || c.includes('sub_other')), 'account and foreign subscriptions are left alone');
    await svc.registry.remove(w1.id, person);
    await svc.registry.remove(w2.id, person);
    // Off without Events or the secret: nothing is called.
    const off = createEventSources({ db: svc.db, check: svc.check, config: { ...svc.config, events: { ...svc.config.events, url: '' } }, fetchImpl });
    assert.strictEqual(await off.sync(), null);
    assert.strictEqual(off.enabled, false);
});

t('stop', async () => { await svc.stop(); });

t.run();
