'use strict';
/**
 * The check engine: a run writes its check_runs row and its observation and emits the released
 * watch.* events; a condition that fires emits watch.watch.triggered; every failure is a recorded
 * state and an event; a source whose carrier is a later step is never fetched; retention and the
 * for_sec debounce behave. Every event payload is validated against the released contract.
 */
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, site, suite, newUser, newAgent, rss } = require('./helpers');

const t = suite('check');
let svc;
let web;
let price = '19.99';

const person = { sub: newUser() };
const agent = { sub: newAgent() };
const service = { sub: 'svc:check-test' };

const def = (overrides = {}) => ({
    name: 'price watch',
    source: { kind: 'http', url: `${web.origin}/price`, format: null },
    cadence: { every_sec: 900 },
    extraction: { kind: 'text' },
    condition: { op: 'lt', value: 10 },
    action: [{ kind: 'notification' }],
    ...overrides,
});

const create = async (principal, overrides = {}) => await svc.registry.create(def(overrides), principal);
const check = async (id, trigger = 'schedule') => await svc.check.run(id, { trigger });
const row = async (id) => await svc.db.prepare('SELECT * FROM watches WHERE id = ?').get(id);
const runs = async (id) => await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid').all(id);
const observations = async (id) => await svc.db.prepare('SELECT * FROM observations WHERE watch_id = ? ORDER BY rid').all(id);
const allEnvelopes = async () => (await svc.db.many('SELECT envelope FROM service_outbox ORDER BY id')).map(r => r.envelope);
const payloads = async (type) => (await allEnvelopes()).filter(e => e.event_type === type).map(e => e.payload);
const envelopes = async (type) => (await allEnvelopes()).filter(e => e.event_type === type);

const valid = (ref, value) => {
    const r = validate(ref, value);
    assert.ok(r.valid, `${ref}: ${r.errors.map(e => `${e.path} ${e.message}`).join('; ')} — ${JSON.stringify(value)}`);
};

t('boot', async () => {
    web = await site({
        '/price': () => ({ headers: { 'content-type': 'text/plain' }, body: price }),
        '/set': (req, _res, ctx) => { price = ctx.url.searchParams.get('v') || price; return { body: 'ok' }; },
        '/rss': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: rss([{ guid: 'g1', title: 'Widget', link: 'https://example.org/1' }]) }),
        '/slow': () => ({ delayMs: 4000, body: 'late' }),
        '/busy': () => ({ status: 429, headers: { 'retry-after': '120' }, body: 'slow down' }),
        '/broken': () => ({ headers: { 'content-type': 'application/json' }, body: 'not json at all' }),
    });
    svc = await boot();
});

t('a check writes its run and its observation and emits watch.observation.recorded', async () => {
    price = '19.99';
    const w = await create(person);
    const out = await check(w.id);
    assert.strictEqual(out.run.state, 'changed');
    const r = (await runs(w.id))[0];
    assert.strictEqual(r.trigger, 'schedule');
    assert.strictEqual(r.carrier, 'http');
    assert.strictEqual(r.state, 'changed');
    assert.strictEqual(Number(r.observations), 1);
    assert.strictEqual(Number(r.triggers), 0);
    assert.strictEqual(Number(r.http_status), 200);
    assert.strictEqual(r.raw_body_hash.length, 64);
    const o = (await observations(w.id))[0];
    assert.strictEqual(o.value, '19.99');
    assert.strictEqual(o.check_run_id, r.id);
    assert.strictEqual(o.previous_hash, null);
    assert.strictEqual(Number(o.changed), 1);
    assert.strictEqual(Number(o.condition_met), 0, 'lt 10 does not hold at 19.99');
    assert.strictEqual(o.snapshot, '19.99');
    assert.strictEqual(o.value_hash.length, 64);
    assert.ok(o.retained_until > o.observed_at, 'retention is set from the watch (default 90 days)');
    assert.strictEqual(Math.round((o.retained_until - o.observed_at) / 86400000), 90);

    const events = await envelopes('watch.observation.recorded');
    assert.strictEqual(events.length, 1);
    valid('watch.observation.recorded@1', events[0].payload);
    assert.strictEqual(events[0].payload.watch_id, w.id);
    assert.deepStrictEqual([events[0].payload.changed, events[0].payload.condition_met], [true, false]);
    assert.strictEqual(events[0].source, 'watch');
    assert.deepStrictEqual(events[0].subject, { type: 'watch', id: w.id });
    assert.strictEqual(events[0].visibility, 'internal');
    assert.strictEqual(events[0].priority, 'low');
});

t('a condition that fires emits watch.watch.triggered with the observation that fired it', async () => {
    price = '19.99';
    const w = await create(person, { condition: { op: 'lt', value: 10 } });
    await check(w.id);                                     // 19.99: no fire
    assert.strictEqual((await runs(w.id))[0].state, 'changed');
    await fetch(`${web.origin}/set?v=7.50`);                // the price drops to 7.50
    const out = await check(w.id);
    assert.strictEqual(out.run.state, 'condition_met');
    assert.strictEqual(out.run.triggers, 1);
    assert.strictEqual(out.met, true);
    assert.strictEqual(out.value, '7.50');

    const [trig] = await envelopes('watch.watch.triggered');
    assert.ok(trig, 'the trigger was emitted');
    valid('watch.watch.triggered@1', trig.payload);
    assert.deepStrictEqual(trig.payload.recipient, person.sub);
    assert.strictEqual(trig.payload.watch_id, w.id);
    assert.strictEqual(trig.payload.observation.value, '7.50');
    assert.strictEqual(trig.payload.observation.previous_value, '19.99');
    assert.match(trig.payload.observation.id, /^wco_/);
    assert.deepStrictEqual(trig.payload.condition, { op: 'lt', value: 10 });
    assert.strictEqual(trig.priority, 'important');

    // the observation that fired it carries both changed and the predicate holding
    const last = (await observations(w.id)).pop();
    assert.deepStrictEqual([Number(last.changed), Number(last.condition_met)], [1, 1]);
    valid('watch.observation@1', svc.observations.view(last));
    valid('watch.check-run@1', svc.check.runView((await runs(w.id)).pop()));
});

t('a failing check is a recorded state and a watch.check.failed event, and it backs off', async () => {
    const w = await create(person, { source: { kind: 'http', url: `${web.origin}/broken`, format: null }, extraction: { kind: 'json' } });
    const first = await check(w.id);
    assert.strictEqual(first.run.state, 'parse_error');
    assert.strictEqual(first.run.error_code, 'unreadable');
    const [fail] = await envelopes('watch.check.failed');
    valid('watch.check.failed@1', fail.payload);
    assert.deepStrictEqual([fail.payload.state, fail.payload.consecutive_failures], ['parse_error', 1]);
    let r = await row(w.id);
    assert.strictEqual(r.last_state, 'parse_error');
    assert.strictEqual(Number(r.consecutive_failures), 1);
    assert.strictEqual(r.next_due_at - r.last_check_at, 900000, 'first failure: every_sec · 2^0');

    const second = await check(w.id);
    assert.strictEqual(second.failures, 2);
    r = await row(w.id);
    assert.strictEqual(Number(r.consecutive_failures), 2);
    assert.strictEqual(r.next_due_at - r.last_check_at, 1800000, 'second failure: every_sec · 2^1');
    assert.strictEqual((await payloads('watch.check.failed')).length, 2);

    // a success clears the backoff and the counter (19.99 is above the watch's lt 10, so it is a
    // change, not a fire)
    await fetch(`${web.origin}/set?v=19.99`);
    await svc.db.prepare('UPDATE watches SET source = ? WHERE id = ?').run(JSON.stringify({ kind: 'http', url: `${web.origin}/price`, format: null }), w.id);
    await check(w.id);
    r = await row(w.id);
    assert.deepStrictEqual([Number(r.consecutive_failures), r.last_state], [0, 'changed']);
    assert.ok(r.next_due_at - r.last_check_at >= 900000 && r.next_due_at - r.last_check_at <= 900100, 'back to the cadence');
});

t('a timeout is its own state, and a 429 waits as long as the site asked', async () => {
    const slow = await create(person, { source: { kind: 'http', url: `${web.origin}/slow`, format: null } });
    const out = await check(slow.id);
    assert.strictEqual(out.run.state, 'timeout');
    assert.strictEqual(out.run.error_code, 'timeout');

    const busy = await create(person, { source: { kind: 'http', url: `${web.origin}/busy`, format: null } });
    const limited = await check(busy.id);
    assert.strictEqual(limited.run.state, 'rate_limited');
    assert.strictEqual(limited.run.error_code, 'upstream_429');
    const r = await row(busy.id);
    assert.ok(r.not_before - r.last_check_at >= 119000, 'Retry-After: 120 s became not_before');
});

t('a pattern that hits its deadline is a recorded check error, never a hang', async () => {
    // A regex extraction whose pattern slips past the static check still runs, and the deadline
    // makes it a no-match with the reason recorded on the run (the process stays up).
    price = 'a'.repeat(40) + '!';
    const slowExtract = await create(person, { extraction: { kind: 'regex', selector: '^(\\w|\\w\\w)*$' } });
    const withExtract = await check(slowExtract.id, 'manual');
    assert.strictEqual(withExtract.run.detail, 'pattern took too long');
    assert.strictEqual(withExtract.run.state, 'changed', 'the run completed with no match');
    assert.strictEqual(withExtract.value, null);

    // The same, for a `matches` condition: no match, and the run records why.
    const slowMatch = await create(person, { condition: { op: 'matches', value: '^(\\w|\\w\\w)*$' } });
    const withMatch = await check(slowMatch.id, 'manual');
    assert.strictEqual(withMatch.run.detail, 'pattern took too long');
    assert.strictEqual(withMatch.verdict.error, 'pattern took too long');
    price = '19.99';
});

t('an event, webhook, node or run source is accepted but never fetched (steps 5-7)', async () => {
    const cases = [
        ['event', { kind: 'event', pattern: 'release.published' }, { op: 'exists' }],
        ['webhook', { kind: 'webhook', endpoint: '/internal/hooks/abc' }, { op: 'exists' }],
        ['node', { kind: 'node', node_id: 'nod_01J0000000000000000000000', probe: { path: '/tmp/x' } }, { op: 'exists' }],
        ['run', { kind: 'run', runtime: 'browser', url: `${web.origin}/price`, steps: [{ goto: 'https://example.org' }] }, { op: 'exists' }],
    ];
    const before = web.requests.length;
    for (const [kind, source, condition] of cases) {
        // an event or a webhook is pushed to and never polls; node and run sources poll through
        // OpenVibe.Node and OpenVibe.Run, so they carry a cadence — and still nothing is fetched
        const cadence = (kind === 'event' || kind === 'webhook') ? null : { every_sec: 900 };
        const w = await create(person, { source, cadence, extraction: { kind: 'text' }, condition });
        assert.strictEqual((await row(w.id)).status, 'active');
        const out = await check(w.id, 'manual');
        assert.strictEqual(out.run.state, 'skipped', `${kind}: ${out.run.detail}`);
        assert.strictEqual(out.run.error_code, 'watch.carrier_unavailable');
        assert.strictEqual(out.run.carrier, kind);
        assert.match(out.run.detail, /step [567]/);
        assert.strictEqual(out.unavailable.code, 'watch.carrier_unavailable');
        assert.strictEqual((await observations(w.id)).length, 0);
        const [fail] = (await payloads('watch.check.failed')).slice(-1);
        valid('watch.check.failed@1', fail);
        assert.strictEqual(fail.carrier, kind);
    }
    assert.strictEqual(web.requests.length, before, 'no carrier ever fetched');
    // a run source that does poll is armed, and the scheduler may ask for it — the carrier still refuses
    const due = await svc.registry.due(10);
    assert.ok(!due.some(d => d.id === undefined));
});

t('an ai extraction is not checked either: no fetch, a skipped run, and it explains why', async () => {
    const w = await create(person, { extraction: { kind: 'ai', ai: { prompt: 'read the price' } } });
    const before = web.requests.length;
    const out = await check(w.id, 'manual');
    assert.strictEqual(out.run.state, 'skipped');
    assert.strictEqual(out.run.error_code, 'watch.extraction_unavailable');
    assert.match(out.run.detail, /AI action/);
    assert.strictEqual(web.requests.length, before, 'the page was never fetched for a reading this release cannot do');
});

t('a watch that is not active is recorded disabled and never fetched', async () => {
    const w = await create(person);
    await svc.registry.patch(w.id, { status: 'paused' }, person);
    const before = web.requests.length;
    const out = await check(w.id, 'manual');
    assert.strictEqual(out.disabled, true);
    assert.strictEqual(out.run.state, 'disabled');
    assert.strictEqual(out.run.error_code, 'watch_paused');
    assert.strictEqual(web.requests.length, before);
    const [fail] = (await payloads('watch.check.failed')).slice(-1);
    valid('watch.check.failed@1', fail);
    assert.strictEqual(fail.state, 'disabled');
});

t('a watch is checked once at a time: a second run answers busy', async () => {
    const w = await create(person);
    const first = svc.check.run(w.id, { trigger: 'manual' });
    const second = await svc.check.run(w.id, { trigger: 'manual' });
    assert.deepStrictEqual(second, { busy: true });
    await first;
    assert.strictEqual((await runs(w.id)).length, 1, 'the busy call recorded nothing');
});

t('for_sec is measured from the observations, not from a timer in this process', async () => {
    price = '7.50';
    const w = await create(person, { source: { kind: 'http', url: `${web.origin}/price`, format: null }, condition: { op: 'lt', value: 100, for_sec: 120 } });
    const first = await check(w.id);
    assert.strictEqual(first.run.state, 'changed', 'the predicate holds but the debounce has not run');
    assert.strictEqual(Number((await observations(w.id))[0].condition_met), 1, 'the observation records that it held');
    // the trail says it has held since two minutes before this check
    const since = Date.now() - 130000;
    const firedBefore = (await envelopes('watch.watch.triggered')).length;
    await svc.db.prepare('UPDATE observations SET observed_at = ? WHERE watch_id = ?').run(since, w.id);
    const second = await check(w.id);
    assert.strictEqual(second.run.state, 'condition_met', 'an unchanged body still fires once the debounce has run');
    const fired = (await envelopes('watch.watch.triggered')).slice(firedBefore);
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].payload.watch_id, w.id);
    assert.strictEqual(fired[0].payload.observation.value, '7.50', 'the trigger points at the observation that holds the value');
    // once per run of holding: the same value and the same run fire nothing more
    const again = await check(w.id);
    assert.strictEqual(again.met, false);
    assert.strictEqual((await envelopes('watch.watch.triggered')).length, firedBefore + 1);
    // a value that stops holding resets the debounce
    const other = await create(person, { source: { kind: 'http', url: `${web.origin}/price`, format: null }, condition: { op: 'gt', value: 100, for_sec: 60 } });
    await check(other.id);
    const held = await svc.db.prepare('SELECT observed_at FROM observations WHERE watch_id = ?').get(other.id);
    await svc.db.prepare('UPDATE observations SET observed_at = ? WHERE watch_id = ?').run(held.observed_at - 600000, other.id);
    const after = await check(other.id);
    assert.strictEqual(after.met, false, 'gt 100 does not hold at 7.50, whatever the trail says');
    assert.strictEqual(after.run.state, 'no_change', 'the body did not change; the condition simply did not hold');
});

t('retention: keep_snapshots false stores none, and observations_days sets retained_until', async () => {
    const w = await create(person, { retention: { observations_days: 7, keep_snapshots: false } });
    await check(w.id);
    const o = (await observations(w.id))[0];
    assert.strictEqual(o.snapshot, null);
    assert.strictEqual(Math.round((o.retained_until - o.observed_at) / 86400000), 7);
    const pruned = await svc.observations.prune(Date.now() + 8 * 86400000);
    assert.strictEqual(pruned, 1);
    assert.strictEqual((await observations(w.id)).length, 0);
});

t('an owned-by-a-service watch records everything and emits no person-facing event', async () => {
    const w = await create(service, { condition: { op: 'lt', value: 100 } });
    const out = await check(w.id);
    assert.strictEqual(out.run.state, 'condition_met', 'the trigger is recorded on the run');
    const run = (await runs(w.id)).pop();
    assert.strictEqual(Number(run.triggers), 1);
    assert.strictEqual((await observations(w.id)).length, 1);
    const all = await allEnvelopes();
    const mine = all.filter(e => e.subject.id === w.id);
    // the contract names usr_/agt_ owners for an observation and a usr_ recipient for a trigger, so
    // a service-owned watch emits neither — it keeps the record in its own tables
    assert.deepStrictEqual(mine.filter(e => e.event_type === 'watch.observation.recorded'), []);
    assert.deepStrictEqual(mine.filter(e => e.event_type === 'watch.watch.triggered'), []);
});

t('an agent-owned watch emits observation.recorded but never a trigger (recipient is usr_ only)', async () => {
    const w = await create(agent, { condition: { op: 'lt', value: 100 } });
    await check(w.id);
    const all = (await allEnvelopes()).filter(e => e.subject.id === w.id);
    const observed = all.filter(e => e.event_type === 'watch.observation.recorded');
    assert.strictEqual(observed.length, 1);
    valid('watch.observation.recorded@1', observed[0].payload);
    assert.strictEqual(observed[0].payload.owner, agent.sub);
    assert.deepStrictEqual(all.filter(e => e.event_type === 'watch.watch.triggered'), []);
});

t('the trail carries previous_hash, and an identical body records no second observation', async () => {
    const w = await create(service, { source: { kind: 'http', url: `${web.origin}/rss`, format: null }, extraction: { kind: 'text' } });
    await check(w.id);
    const first = (await observations(w.id))[0];
    assert.strictEqual(first.previous_hash, null);
    assert.strictEqual(first.value_hash.length, 64);
    // the same body again: no_change, no second observation, and the first row is untouched
    const again = await check(w.id);
    assert.strictEqual(again.run.state, 'no_change');
    assert.strictEqual((await observations(w.id)).length, 1);
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
