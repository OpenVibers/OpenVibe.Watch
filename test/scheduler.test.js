'use strict';
/**
 * The scheduler: due order (oldest due first), the concurrency cap, not_before/backoff holding a
 * watch back, and the worker actually checking on its own tick.
 */
const assert = require('assert');
const { boot, site, suite, sleep, newUser } = require('./helpers');

const owner = { sub: newUser() };
let svc;
let web;

const create = async (name, overrides = {}) => await svc.registry.create({
    name,
    source: { kind: 'http', url: `${web.origin}/page`, format: null },
    cadence: { every_sec: 60 },
    extraction: { kind: 'text' },
    condition: { op: 'eq', value: 'nothing' },
    action: [{ kind: 'notification' }],
    ...overrides,
}, owner);

const dueAt = async (id, next, notBefore = 0) => {
    await svc.db.prepare('UPDATE watches SET next_due_at = ?, not_before = ? WHERE id = ?').run(next, notBefore, id);
};
const quiet = async () => {
    for (let i = 0; i < 200 && svc.check.inflight().length; i++) await sleep(25);
    assert.deepStrictEqual(svc.check.inflight(), [], 'every check finished');
};

const t = suite('scheduler');

t('boot', async () => {
    web = await site({ '/page': () => ({ body: 'a page' }), '/slow': () => ({ delayMs: 300, body: 'slow' }) });
    svc = await boot({ env: { WATCH_MAX_CONCURRENT: '2' } });
});

t('tick starts the watches whose turn has come, oldest due first', async () => {
    const a = await create('a');
    const b = await create('b');
    const c = await create('c');
    // all due, in an order the creation ids do not happen to share
    await dueAt(c.id, 3000);
    await dueAt(a.id, 1000);
    await dueAt(b.id, 2000);
    assert.deepStrictEqual(await svc.scheduler.tick(), [a.id, b.id], 'two, the cap, oldest first');
    await quiet();
    assert.deepStrictEqual(await svc.scheduler.tick(), [c.id], 'the next tick takes the next one');
    await quiet();
    assert.deepStrictEqual((await svc.registry.due(10)).map(d => d.id), [], 'nothing is left due');
});

t('the concurrency cap holds: no more than WATCH_MAX_CONCURRENT checks at a time', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
        const w = await create(`slow ${i}`, { source: { kind: 'http', url: `${web.origin}/slow`, format: null }, condition: { op: 'eq', value: 'nothing' } });
        await dueAt(w.id, 1000 + i);
        ids.push(w.id);
    }
    const first = await svc.scheduler.tick();
    assert.strictEqual(first.length, 2, 'two, the cap');
    assert.deepStrictEqual(first, ids.slice(0, 2));
    assert.strictEqual(svc.scheduler.active().length, 2);
    assert.deepStrictEqual(await svc.scheduler.tick(), [], 'nothing is free while both are in flight');
    assert.deepStrictEqual(svc.check.inflight().sort(), first.slice().sort());
    await quiet();
    const third = await svc.scheduler.tick();
    assert.strictEqual(third.length, 2);
    assert.ok(!first.includes(third[0]));
    await quiet();
    assert.deepStrictEqual(svc.scheduler.active(), []);
});

t('a watch that is not due, or is waiting out a Retry-After, is not started', async () => {
    const later = await create('later');
    const waiting = await create('waiting');
    const paused = await create('paused');
    await svc.registry.patch(paused.id, { status: 'paused' }, owner);
    const gone = await create('gone');
    await svc.registry.remove(gone.id, owner);
    await dueAt(later.id, Date.now() + 3600_000);
    await dueAt(waiting.id, 1000, Date.now() + 3600_000);
    await dueAt(paused.id, 1000);
    await dueAt(gone.id, 1000);
    assert.deepStrictEqual(await svc.scheduler.tick(), [], 'nothing here is due');
    const due = new Set((await svc.registry.due(50)).map(d => d.id));
    for (const w of [later, waiting, paused, gone]) assert.ok(!due.has(w.id), `${w.id} is not in the queue`);
});

t('a failing watch backs off: the scheduler leaves it alone until its next due time', async () => {
    const w = await create('broken', { source: { kind: 'http', url: `${web.origin}/nope`, format: null } });
    await dueAt(w.id, 0);
    const out = await svc.check.run(w.id, { trigger: 'schedule' });
    assert.strictEqual(out.run.state, 'http_error');
    const row = await svc.db.prepare('SELECT * FROM watches WHERE id = ?').get(w.id);
    assert.strictEqual(row.next_due_at - row.last_check_at, 60000, 'first failure: every_sec · 2^0');
    let due = new Set((await svc.registry.due(50)).map(d => d.id));
    assert.ok(!due.has(w.id), 'not due until the backoff has run');
    await dueAt(w.id, row.next_due_at - 120000);
    due = new Set((await svc.registry.due(50)).map(d => d.id));
    assert.ok(due.has(w.id));
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();

// A second suite: with the worker on, the tick itself checks due watches.
const t2 = suite('scheduler (worker on)');
t2('the worker checks a due watch without anyone asking', async () => {
    const web2 = await site({ '/page': () => ({ body: 'tick' }) });
    const svc2 = await boot({ worker: 'on', env: { WATCH_TICK_MS: '40', WATCH_HOST_MIN_INTERVAL_MS: '0' } });
    try {
        const w = await svc2.registry.create({
            name: 'auto', source: { kind: 'http', url: `${web2.origin}/page`, format: null },
            cadence: { every_sec: 60 }, extraction: { kind: 'text' },
            condition: { op: 'eq', value: 'nothing' }, action: [{ kind: 'notification' }],
        }, { sub: newUser() });
        // a new watch is due at once (its first reading), then armed by cadence after each check;
        // bring its turn forward and let the worker find it on its own
        await svc2.db.prepare('UPDATE watches SET next_due_at = 0 WHERE id = ?').run(w.id);
        for (let i = 0; i < 100 && (await svc2.db.prepare('SELECT COUNT(*) AS n FROM check_runs WHERE watch_id = ?').get(w.id)).n === 0; i++) await sleep(50);
        const runs = await svc2.db.prepare('SELECT * FROM check_runs WHERE watch_id = ?').all(w.id);
        assert.strictEqual(runs.length, 1, 'the scheduler ran exactly one check (the cadence is a minute)');
        assert.strictEqual(runs[0].trigger, 'schedule');
        assert.strictEqual(runs[0].state, 'changed');

        const ready = await (await fetch(`${svc2.base}/api/ready`)).json();
        assert.strictEqual(ready.checks.db.status, 'ok');
        assert.strictEqual(ready.checks.checker.status, 'ok', JSON.stringify(ready.checks.checker));
        assert.strictEqual(ready.checks.checker.detail.running, true);
        assert.strictEqual(ready.ready, true);

        const metrics = await (await fetch(`${svc2.base}/metrics`)).text();
        assert.match(metrics, /watch_watches\{status="healthy"\} 1/);
        assert.match(metrics, /watch_last_check_timestamp_seconds/);
        assert.match(metrics, /watch_observations\{state="changed"\} 1/);
    } finally { await svc2.stop(); await web2.close(); }
});
t2.run();
