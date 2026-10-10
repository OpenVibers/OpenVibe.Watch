'use strict';
/**
 * Actions (plan T18 step 4): a condition that fires queues the watch's actions in the run's own transaction, once per
 * trigger; the worker delivers a notification to the owner through Network (openvibe-sdk/notifications), retries a
 * refusal with backoff, skips an owner Network does not know and an owner that is not a person, and records the kinds
 * whose dispatchers are later steps as unavailable. The watch page says what happened.
 */
const assert = require('assert');
const { boot, site, suite, newUser, newAgent } = require('./helpers');

const t = suite('actions');
let svc;
let web;
let price = '19.99';
const pushes = [];
let mode = 'ok';
const notifications = {
    async push(req) {
        pushes.push(req);
        if (mode === 'fail') { const e = new Error('Network answered 503'); e.status = 503; e.code = 'notifications.unavailable'; throw e; }
        if (mode === 'unknown') return { sent: false, reason: 'unknown_subject' };
        return { sent: true, skipped: mode === 'muted' };
    },
};

const person = { sub: newUser() };
const agent = { sub: newAgent() };
const def = (overrides = {}) => ({
    name: 'Widget price',
    source: { kind: 'http', url: `${web.origin}/price`, format: null },
    cadence: { every_sec: 900 },
    extraction: { kind: 'text' },
    condition: { op: 'lt', value: 10 },
    action: [{ kind: 'notification', priority: 'high' }],
    ...overrides,
});
const create = async (principal, overrides = {}) => await svc.registry.create(def(overrides), principal);
const check = async (id) => await svc.check.run(id, { trigger: 'schedule' });
const acts = async (id) => await svc.db.prepare('SELECT * FROM action_runs WHERE watch_id = ? ORDER BY rid').all(id);
const setPrice = async (v) => { await fetch(`${web.origin}/set?v=${v}`); };
/** Fire a watch: one check at 19.99 (nothing), then the price drops below 10. */
async function fire(w) {
    await setPrice('19.99');
    await check(w.id);
    await setPrice('7.50');
    const out = await check(w.id);
    assert.strictEqual(out.run.state, 'condition_met');
    return out;
}

t('boot', async () => {
    web = await site({
        '/price': () => ({ headers: { 'content-type': 'text/plain' }, body: price }),
        '/set': (req, _res, ctx) => { price = ctx.url.searchParams.get('v') || price; return { body: 'ok' }; },
    });
    svc = await boot({ notifications });
});

t('a check that does not fire queues nothing; one that fires queues each action once, with its run', async () => {
    mode = 'ok'; pushes.length = 0;
    const w = await create(person, { action: [{ kind: 'notification', priority: 'high' }, { kind: 'webhook', url: 'https://hooks.example.org/w', secret_env: 'WATCH_HOOK_TEST' }] });
    await setPrice('19.99');
    await check(w.id);
    assert.deepStrictEqual(await acts(w.id), [], 'no trigger, no action');
    await setPrice('7.50');
    const out = await check(w.id);
    const rows = await acts(w.id);
    assert.deepStrictEqual(rows.map((r) => [r.kind, r.state, r.check_run_id, Number(r.action_index)]),
        [['notification', 'queued', out.run.id, 0], ['webhook', 'unavailable', out.run.id, 1]]);
    assert.match(rows[1].last_error, /watch\.action_unavailable/);

    const r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 1, skipped: 0, retried: 0, failed: 0 });
    assert.strictEqual(pushes.length, 1);
    const p = pushes[0];
    assert.strictEqual(p.subjectId, person.sub);
    assert.deepStrictEqual([p.type, p.service, p.category, p.priority], ['WATCH_TRIGGERED', 'watch', 'service', 'high']);
    assert.strictEqual(p.title, '“Widget price” fired');
    assert.strictEqual(p.message, '7.50 (was 19.99)');
    assert.strictEqual(p.url, `https://openvibe.watch/watches/${w.id}`);
    assert.strictEqual(p.rich_content.check_run_id, out.run.id);
    assert.strictEqual((await acts(w.id))[0].state, 'sent');

    await svc.actions.tick();
    assert.strictEqual(pushes.length, 1, 'a sent action is never sent again');
    await check(w.id);                                    // 7.50 still holds: no new trigger, no new action
    assert.strictEqual((await acts(w.id)).length, 2);
});

t('an event action for watch.watch.triggered is what the firing emitted (sent); another event type is not declared', async () => {
    const w = await create(person, { name: 'quiet', action: [{ kind: 'event', event_type: 'watch.watch.triggered' }, { kind: 'event', event_type: 'shop.price.dropped' }] });
    await fire(w);
    const rows = await acts(w.id);
    assert.deepStrictEqual(rows.map((r) => r.state), ['sent', 'unavailable']);
    assert.match(rows[0].last_error, /emitted with the check run/);
    assert.match(rows[1].last_error, /not an event Watch declares/);
});

t('a refusal waits with backoff; the next tick does not retry early; a later success sends it', async () => {
    pushes.length = 0; mode = 'fail';
    const w = await create(person);
    await fire(w);
    let r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 1, failed: 0 });
    let [row] = await acts(w.id);
    assert.strictEqual(row.state, 'queued');
    assert.strictEqual(Number(row.attempts), 1);
    assert.match(row.last_error, /notifications\.unavailable/);
    assert.ok(Number(row.next_attempt_at) > Date.now() + 50_000, 'the first retry waits about a minute');
    r = await svc.actions.tick();
    assert.strictEqual(pushes.length, 1, 'not due yet: no second push');
    mode = 'ok';
    await svc.db.prepare('UPDATE action_runs SET next_attempt_at = 0 WHERE watch_id = ?').run(w.id);
    r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 1, skipped: 0, retried: 0, failed: 0 });
    [row] = await acts(w.id);
    assert.deepStrictEqual([row.state, Number(row.attempts)], ['sent', 2]);
});

t('an owner Network does not know is skipped; a muted category is delivered; an agent-owned watch notifies nobody', async () => {
    pushes.length = 0; mode = 'unknown';
    const gone = await create(person, { name: 'gone' });
    await fire(gone);
    await svc.actions.tick();
    assert.strictEqual((await acts(gone.id))[0].state, 'skipped');
    assert.match((await acts(gone.id))[0].last_error, /owner_unknown/);

    mode = 'muted';
    const muted = await create(person, { name: 'muted' });
    await fire(muted);
    await svc.actions.tick();
    assert.strictEqual((await acts(muted.id))[0].state, 'sent', 'Network decided: the person switched the category off');

    mode = 'ok';
    const before = pushes.length;
    const bot = await create(agent, { name: 'agent watch' });
    await fire(bot);
    const [row] = await acts(bot.id);
    assert.deepStrictEqual([row.state, /action_no_person/.test(row.last_error)], ['skipped', true]);
    await svc.actions.tick();
    assert.strictEqual(pushes.length, before, 'nothing is pushed for an agent');
});

t('readiness counts the queue, and the watch page says what the watch did when it fired', async () => {
    const st = await svc.actions.status();
    assert.strictEqual(st.enabled, true);
    assert.ok(st.sent >= 3 && st.queued === 0 && st.failed === 0, JSON.stringify(st));
    const w = await create(person, { name: 'page check' });
    mode = 'ok';
    await fire(w);
    await svc.actions.tick();
    const cookie = await svc.signIn({ subject: person.sub, username: 'ana' });
    const res = await fetch(`${svc.base}/watches/${w.id}`, { headers: { cookie } });
    const body = await res.text();
    assert.strictEqual(res.status, 200);
    assert.match(body, /What it did when it fired/);
    assert.match(body, /Notification/);
    assert.match(body, /class="badge ok">sent</);
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
