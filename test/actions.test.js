'use strict';
/**
 * Actions (plan T18 steps 4-5): a condition that fires queues the watch's actions in the run's own transaction, once per
 * trigger; the worker delivers a notification to the owner through Network (openvibe-sdk/notifications), retries a
 * refusal with backoff, skips an owner Network does not know and an owner that is not a person, and records the kinds
 * whose dispatchers are later steps as unavailable. A webhook action POSTs the firing signed like an Events delivery,
 * with a delivery id that is the same on every attempt; a busy receiver is retried, 410 and a refused URL fail at once;
 * its key must be granted to the owner (refused at save, unavailable at delivery once withdrawn) and long enough. An
 * actor-task action gives Actor a task for the owner (X-OV-Subject) with the firing as context and a stable
 * idempotency key; an invalid request fails at once, a busy Actor is retried, an agent-owned watch is skipped. The
 * watch page says what happened.
 */
const assert = require('assert');
const { verifyDeliveryV2 } = require('openvibe-sdk/events');
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
const stranger = { sub: newUser() };
const HOOK_KEY = 'k'.repeat(24) + 'Watch-hook-key-0123456789';
// The receiver, as server/net/post.js would reach it: every POST recorded; hookMode decides the answer.
const posts = [];
let hookMode = 'ok';
async function post(url, { headers, body }) {
    posts.push({ url, headers, body });
    if (hookMode === 'refused') throw Object.assign(new Error('hooks.example.org resolves to a non-public address'), { code: 'address_refused' });
    if (hookMode === 'down') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return { status: { ok: 204, busy: 503, gone: 410 }[hookMode] };
}
const hook = (env = 'WATCH_HOOK_TEST') => ({ kind: 'webhook', url: 'https://hooks.example.org/w', secret_env: env });
// OpenVibe.Actor, as server/actor.js would reach it: every create recorded; actorMode decides the answer.
const tasks = [];
let actorMode = 'ok';
const actor = {
    async create(req) {
        tasks.push(req);
        if (actorMode === 'refuse') throw Object.assign(new Error('over the tier'), { status: 422, code: 'actor.budget.over_tier', detail: 'The free tier allows up to $0.25 per task' });
        if (actorMode === 'busy') throw Object.assign(new Error('capacity'), { status: 503, code: 'actor.capacity.spent' });
        return { id: `tsk_01JAB2C3D4E5F6G7H8J9K0MN${String(tasks.length).padStart(2, '0')}`, state: 'queued' };
    },
    async runAgent(req) {
        tasks.push(req);
        if (actorMode === 'missing') throw Object.assign(new Error('not found'), { status: 404, code: 'actor.agent.not_found' });
        if (actorMode === 'limit') throw Object.assign(new Error('free tier limit'), { status: 429, code: 'actor.agent.limit' });
        if (actorMode === 'free') throw Object.assign(new Error('free tier refusal'), { status: 403, code: 'actor.agent.free_tier' });
        if (actorMode === 'busy') throw Object.assign(new Error('capacity'), { status: 503, code: 'actor.unavailable' });
        return { id: 'tsk_AGENT', state: 'queued' };
    },
};
// OpenVibe.Codes, as server/codes-tasks.js would reach it: every start recorded; codesMode decides the answer.
const codesStarts = [];
let codesMode = 'ok';
const codes = {
    async start(req) {
        codesStarts.push(req);
        if (codesMode === 'no_project') throw Object.assign(new Error('no /run task yet'), { status: 409, code: 'codes.no_project', detail: 'this person has not run a task on openvibe.codes/run yet' });
        if (codesMode === 'busy') throw Object.assign(new Error('unavailable'), { status: 503, code: 'run.unavailable' });
        return { id: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNCD', state: 'queued', url: 'https://openvibe.codes/run/tasks/tsk_01JAB2C3D4E5F6G7H8J9K0MNCD', created: codesStarts.length === 1 };
    },
};
const agentId = 'agt_01JAB2C3D4E5F6G7H8J9K0MNPQ';
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
    svc = await boot({
        notifications, post, actor, codes,
        env: {
            WATCH_HOOK_TEST: HOOK_KEY, WATCH_HOOK_SHORT: 'too-short', WATCH_HOOK_THEIRS: HOOK_KEY,
            WATCH_SECRET_GRANTS: JSON.stringify({
                WATCH_HOOK_TEST: { owners: [person.sub] }, WATCH_HOOK_SHORT: { owners: [person.sub] }, WATCH_HOOK_THEIRS: { owners: [stranger.sub] },
            }),
        },
    });
});

t('a check that does not fire queues nothing; one that fires queues each action once, with its run', async () => {
    mode = 'ok'; pushes.length = 0;
    const w = await create(person, { action: [{ kind: 'notification', priority: 'high' }, { kind: 'event', event_type: 'watch.something.else' }] });
    await setPrice('19.99');
    await check(w.id);
    assert.deepStrictEqual(await acts(w.id), [], 'no trigger, no action');
    await setPrice('7.50');
    const out = await check(w.id);
    const rows = await acts(w.id);
    assert.deepStrictEqual(rows.map((r) => [r.kind, r.state, r.check_run_id, Number(r.action_index)]),
        [['notification', 'queued', out.run.id, 0], ['event', 'unavailable', out.run.id, 1]]);
    assert.match(rows[1].last_error, /watch\.action_unavailable/);

    const r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 1, skipped: 0, retried: 0, failed: 0 });
    assert.strictEqual(pushes.length, 1);
    const p = pushes[0];
    assert.strictEqual(p.subjectId, person.sub);
    assert.deepStrictEqual([p.type, p.service, p.category, p.priority], ['WATCH_TRIGGERED', 'watch', 'service', 'high']);
    assert.strictEqual(p.title, '“Widget price” fired');
    assert.match(p.message, /^7\.50 \(was 19\.99\) · from http:\/\/127\.0\.0\.1:\d+\/price · fetched \d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(p.url, `https://openvibe.watch/watches/${w.id}`);
    assert.strictEqual(p.rich_content.check_run_id, out.run.id);
    // The alert carries its evidence: before and after, the source and when it was fetched.
    assert.deepStrictEqual(p.rich_content.evidence, {
        before: '19.99', after: '7.50', source_url: `${web.origin}/price`, fetched_at: p.rich_content.observed_at,
    });
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

t('a webhook action POSTs the firing, signed as an Events delivery; the receiver verifies it with the SDK', async () => {
    posts.length = 0; hookMode = 'ok';
    const w = await create(person, { name: 'hooked', action: [hook()] });
    const out = await fire(w);
    let [row] = await acts(w.id);
    assert.strictEqual(row.state, 'queued');
    const r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 1, skipped: 0, retried: 0, failed: 0 });
    assert.strictEqual(posts.length, 1);
    const p = posts[0];
    assert.strictEqual(p.url, 'https://hooks.example.org/w');
    const lower = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.strictEqual(lower['x-openvibe-event-type'], 'watch.watch.triggered');
    assert.strictEqual(lower['x-openvibe-delivery-id'], `${out.run.id}.0`);
    assert.strictEqual(lower['x-openvibe-delivery-attempt'], '1');
    assert.ok(verifyDeliveryV2(p.body, lower, HOOK_KEY), 'the signature verifies with the key');
    assert.ok(!verifyDeliveryV2(p.body, lower, 'x'.repeat(48)), 'and with no other key');
    assert.ok(!p.body.includes(HOOK_KEY), 'the key itself is never sent');
    const body = JSON.parse(p.body);
    assert.deepStrictEqual([body.type, body.watch.id, body.watch.name, body.check_run_id], ['watch.watch.triggered', w.id, 'hooked', out.run.id]);
    assert.strictEqual(body.watch.url, `https://openvibe.watch/watches/${w.id}`);
    assert.deepStrictEqual([body.observation.value, body.observation.previous_value], ['7.50', '19.99']);
    assert.deepStrictEqual(body.evidence, {
        before: '19.99', after: '7.50', source_url: `${web.origin}/price`, fetched_at: body.observation.observed_at,
    });
    [row] = await acts(w.id);
    assert.deepStrictEqual([row.state, row.last_error], ['sent', null]);
    const stored = await svc.db.prepare('SELECT request FROM action_runs WHERE rid = ?').get(row.rid);
    assert.ok(!JSON.stringify(stored).includes(HOOK_KEY), 'the key is never stored');
});

t('a busy receiver is retried on the backoff with the same delivery id; 410 and a refused URL fail at once', async () => {
    posts.length = 0; hookMode = 'busy';
    const w = await create(person, { name: 'busy', action: [hook()] });
    await fire(w);
    let r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 1, failed: 0 });
    let [row] = await acts(w.id);
    assert.deepStrictEqual([row.state, row.last_error], ['queued', 'http_503']);
    hookMode = 'down';
    await svc.db.prepare('UPDATE action_runs SET next_attempt_at = 0 WHERE watch_id = ?').run(w.id);
    r = await svc.actions.tick();
    assert.strictEqual(r.retried, 1, 'a lost connection is retried too');
    hookMode = 'ok';
    await svc.db.prepare('UPDATE action_runs SET next_attempt_at = 0 WHERE watch_id = ?').run(w.id);
    r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 1, skipped: 0, retried: 0, failed: 0 });
    assert.strictEqual(posts.length, 3);
    const ids = posts.map((x) => x.headers['X-OpenVibe-Delivery-Id']);
    assert.strictEqual(new Set(ids).size, 1, 'one delivery id across attempts');
    assert.deepStrictEqual(posts.map((x) => x.headers['X-OpenVibe-Delivery-Attempt']), ['1', '2', '3']);

    for (const [mode, code] of [['gone', /action_gone/], ['refused', /action_url_refused/]]) {
        hookMode = mode;
        const g = await create(person, { name: `hook ${mode}`, action: [hook()] });
        await fire(g);
        r = await svc.actions.tick();
        assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 0, failed: 1 }, mode);
        [row] = await acts(g.id);
        assert.strictEqual(row.state, 'failed');
        assert.match(row.last_error, code);
    }
    hookMode = 'ok';
});

t('a webhook key must be granted to the owner (refused at save, unavailable once withdrawn) and long enough', async () => {
    posts.length = 0; hookMode = 'ok';
    await assert.rejects(create(person, { name: 'theirs', action: [hook('WATCH_HOOK_THEIRS')] }),
        (e) => e.code === 'watch.secret_not_granted' && /\/action\/0\/secret_env: WATCH_HOOK_THEIRS is not granted to this owner/.test(e.message));
    await assert.rejects(create(person, { name: 'nobody', action: [hook('WATCH_HOOK_NOBODY')] }),
        (e) => e.code === 'watch.secret_not_granted' && /not granted to any owner/.test(e.message));
    const ok = await create(person, { name: 'patched' });
    await assert.rejects(svc.registry.patch(ok.id, { action: [hook('WATCH_HOOK_THEIRS')] }, person), (e) => e.code === 'watch.secret_not_granted', 'a patch is checked too');

    const short = await create(person, { name: 'short key', action: [hook('WATCH_HOOK_SHORT')] });
    await fire(short);
    let r = await svc.actions.tick();
    assert.strictEqual(r.skipped, 1);
    assert.match((await acts(short.id))[0].last_error, /action_secret_missing: WATCH_HOOK_SHORT is not set \(32 characters or more\)/);

    // Granted when it fired, withdrawn before delivery: the worker checks again.
    const later = await create(person, { name: 'withdrawn', action: [hook()] });
    await fire(later);
    const grants = svc.config.secretGrants;
    const { createSecretGrants } = require('../server/secret-grants');
    svc.config.secretGrants = createSecretGrants({ grants: {} });
    try {
        r = await svc.actions.tick();
    } finally { svc.config.secretGrants = grants; }
    assert.strictEqual(posts.length, 0, 'nothing was posted');
});

t('an actor-task action gives Actor a task for the owner, with the firing as context and one idempotency key', async () => {
    tasks.length = 0; actorMode = 'busy';
    const w = await create(person, { name: 'cheap widget', action: [{ kind: 'actor-task', brief: 'Buy two if it is still in stock.', budget_usd: 0.1 }] });
    const out = await fire(w);
    let r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 1, failed: 0 }, 'a busy Actor is retried');
    actorMode = 'ok';
    await svc.db.prepare('UPDATE action_runs SET next_attempt_at = 0 WHERE watch_id = ?').run(w.id);
    r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 1, skipped: 0, retried: 0, failed: 0 });
    assert.strictEqual(tasks.length, 2);
    const [first, second] = tasks;
    assert.strictEqual(first.subjectId, person.sub, 'the owner\'s task');
    assert.strictEqual(first.idempotencyKey, `watch.${out.run.id}.0`);
    assert.strictEqual(second.idempotencyKey, first.idempotencyKey, 'the retry is the same task');
    assert.strictEqual(first.budgetUsd, 0.1);
    assert.match(first.task, /^Buy two if it is still in stock\.\n\nContext: your watch “cheap widget” fired at /);
    assert.match(first.task, /Value: 7\.50 \(was 19\.99\)\./);
    assert.match(first.task, new RegExp(`Source: ${web.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/price\\.`));
    assert.match(first.task, /Fetched: \d{4}-\d{2}-\d{2}T/);
    assert.ok(first.task.includes(`https://openvibe.watch/watches/${w.id}`));
    const [row] = await acts(w.id);
    assert.deepStrictEqual([row.state, row.last_error], ['sent', 'Actor task tsk_01JAB2C3D4E5F6G7H8J9K0MN02']);

    actorMode = 'refuse';
    const over = await create(person, { name: 'too dear', action: [{ kind: 'actor-task', brief: 'x', budget_usd: 50 }] });
    await fire(over);
    r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 0, failed: 1 }, 'a request Actor refuses as invalid fails at once');
    assert.match((await acts(over.id))[0].last_error, /watch\.action_refused: actor\.budget\.over_tier/);
    actorMode = 'ok';

    const before = tasks.length;
    const bot = await create(agent, { name: 'agent task', action: [{ kind: 'actor-task', brief: 'x' }] });
    await fire(bot);
    const [b] = await acts(bot.id);
    assert.deepStrictEqual([b.state, /action_no_person/.test(b.last_error)], ['skipped', true]);
    await svc.actions.tick();
    assert.strictEqual(tasks.length, before, 'no task for an agent-owned watch');
});

t('a codes-run action starts a coding task for the owner on Codes, with the firing as context and one idempotency key', async () => {
    codesStarts.length = 0; codesMode = 'busy';
    const w = await create(person, { name: 'dependency bump', action: [{ kind: 'codes-run', repo: 'https://github.com/OpenVibers/OpenVibe.Watch', brief: 'Update the dependency and run the tests.' }] });
    const out = await fire(w);
    let r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 1, failed: 0 }, 'a busy Codes is retried');
    codesMode = 'ok';
    await svc.db.prepare('UPDATE action_runs SET next_attempt_at = 0 WHERE watch_id = ?').run(w.id);
    r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 1, skipped: 0, retried: 0, failed: 0 });
    const [first, second] = codesStarts;
    assert.strictEqual(first.subjectId, person.sub);
    assert.strictEqual(first.repo, 'https://github.com/OpenVibers/OpenVibe.Watch');
    assert.strictEqual(first.idempotencyKey, `watch.${out.run.id}.0`);
    assert.strictEqual(second.idempotencyKey, first.idempotencyKey, 'the retry is the same task');
    assert.match(first.prompt, /^Update the dependency and run the tests\.\n\nContext: your watch “dependency bump” fired at /);
    assert.ok(first.prompt.length <= 8000);
    const [row] = await acts(w.id);
    assert.deepStrictEqual([row.state, row.last_error], ['sent', 'Codes task tsk_01JAB2C3D4E5F6G7H8J9K0MNCD https://openvibe.codes/run/tasks/tsk_01JAB2C3D4E5F6G7H8J9K0MNCD (already started)']);

    codesMode = 'no_project';
    const fresh = await create(person, { name: 'no project yet', action: [{ kind: 'codes-run', repo: 'https://github.com/a/b', brief: 'x' }] });
    await fire(fresh);
    r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 0, failed: 1 }, 'no /run task yet fails at once');
    assert.match((await acts(fresh.id))[0].last_error, /watch\.action_refused: codes\.no_project/);
    codesMode = 'ok';

    const before = codesStarts.length;
    const bot = await create(agent, { name: 'agent coding', action: [{ kind: 'codes-run', repo: 'https://github.com/a/b', brief: 'x' }] });
    await fire(bot);
    const [b] = await acts(bot.id);
    assert.deepStrictEqual([b.state, /action_no_person/.test(b.last_error)], ['skipped', true]);
    await svc.actions.tick();
    assert.strictEqual(codesStarts.length, before, 'no task for an agent-owned watch');
});

t('server/codes-tasks.js asks Codes as Watch, for the owner, once', async () => {
    const { createCodesTasks } = require('../server/codes-tasks');
    const calls = [];
    const client = { async json(o) { calls.push(o); return { task: { id: 'tsk_X', state: 'queued', url: 'https://openvibe.codes/run/tasks/tsk_X' }, created: true }; } };
    const out = await createCodesTasks(client, { baseUrl: 'http://127.0.0.1:4900' }).start({ subjectId: person.sub, repo: 'https://github.com/a/b', prompt: 'do it', idempotencyKey: 'watch.r.0' });
    assert.deepStrictEqual(out, { id: 'tsk_X', state: 'queued', url: 'https://openvibe.codes/run/tasks/tsk_X', created: true });
    const c = calls[0];
    assert.deepStrictEqual([c.service, c.baseUrl, c.audience, c.method, c.path, c.retries], ['codes', 'http://127.0.0.1:4900', 'openvibe.codes', 'POST', '/api/v1/tasks', 0]);
    assert.deepStrictEqual(c.headers, { 'X-OV-Subject': person.sub });
    assert.deepStrictEqual(c.json, { repo: 'https://github.com/a/b', prompt: 'do it', idempotency_key: 'watch.r.0' });
});

t('server/actor.js asks Actor as Watch, for the owner, once', async () => {
    const { createActorTasks } = require('../server/actor');
    const calls = [];
    const client = { async json(o) { calls.push(o); return { id: 'tsk_X', state: 'queued' }; } };
    const out = await createActorTasks(client, { baseUrl: 'http://127.0.0.1:4950' }).create({ subjectId: person.sub, task: 'do it', budgetUsd: 0.2, idempotencyKey: 'watch.r.0' });
    assert.deepStrictEqual(out, { id: 'tsk_X', state: 'queued' });
    const c = calls[0];
    assert.deepStrictEqual([c.service, c.baseUrl, c.audience, c.method, c.path, c.retries], ['actor', 'http://127.0.0.1:4950', 'openvibe.actor', 'POST', '/api/v1/tasks', 0]);
    assert.deepStrictEqual(c.headers, { 'X-OV-Subject': person.sub });
    assert.deepStrictEqual(c.json, { task: 'do it', idempotency_key: 'watch.r.0', budget: { per_task_usd: 0.2 } });
    await createActorTasks(client, { baseUrl: 'x' }).create({ subjectId: person.sub, task: 'no budget', idempotencyKey: 'watch.r.1' });
    assert.ok(!('budget' in calls[1].json), 'no budget named: Actor applies the tier\'s');
    const agentRun = await createActorTasks(client, { baseUrl: 'http://127.0.0.1:4950' }).runAgent({ subjectId: person.sub, agentId, input: 'hello' });
    assert.deepStrictEqual(agentRun, { id: 'tsk_X', state: 'queued' });
    assert.deepStrictEqual([calls[2].baseUrl, calls[2].audience, calls[2].path, calls[2].retries],
        ['http://127.0.0.1:4950', 'openvibe.actor', `/api/v1/me/agents/${agentId}/run`, 0]);
    assert.deepStrictEqual(calls[2].headers, { 'X-OV-Subject': person.sub });
    assert.deepStrictEqual(calls[2].json, { input: 'hello' });
});

t('actor-agent validation checks id, note and person ownership', async () => {
    const action = [{ kind: 'actor-agent', agent_id: agentId, note: 'Review this change.' }];
    const w = await create(person, { action });
    assert.deepStrictEqual(svc.registry.view(w).action, action);
    await assert.rejects(create(person, { action: [{ ...action[0], agent_id: 'agt_bad' }] }), /agent_id/);
    await assert.rejects(create(person, { action: [{ ...action[0], note: 'x'.repeat(2001) }] }), /note/);
    await assert.rejects(create(agent, { action }), (e) => e.code === 'watch.invalid' && /action_no_person/.test(e.message));
    await assert.rejects(create({ sub: 'svc:watch-test' }, { action }), (e) => e.code === 'watch.invalid' && /action_no_person/.test(e.message));
    await assert.rejects(svc.registry.patch(w.id, { action: [{ ...action[0], agent_id: 'agt_bad' }] }, person), /agent_id/);
});

t('actor-agent sends note and bounded firing context, records its task, and classifies refusals', async () => {
    const { actorAgentInputFor } = require('../server/actions');
    const longInput = actorAgentInputFor({ config: svc.config, watch: { name: 'long value', id: 'wch_x' }, action: { note: 'N'.repeat(2000) }, value: 'V'.repeat(20000), previousValue: 'before', observedAt: Date.now() });
    assert.strictEqual(longInput.length, 8000);
    assert.ok(longInput.startsWith(`${'N'.repeat(2000)}\n\nContext:`), 'the note is never cut');
    tasks.length = 0; actorMode = 'ok';
    const note = 'N'.repeat(2000);
    const w = await create(person, { name: 'cheap widget', action: [{ kind: 'actor-agent', agent_id: agentId, note }] });
    await fire(w);
    let r = await svc.actions.tick();
    assert.strictEqual(r.sent, 1);
    assert.deepStrictEqual([tasks[0].subjectId, tasks[0].agentId], [person.sub, agentId]);
    assert.ok(tasks[0].input.startsWith(`${note}\n\nContext: your watch “cheap widget” fired at `));
    assert.match(tasks[0].input, /Value: 7\.50 \(was 19\.99\)\./);
    assert.ok(tasks[0].input.includes(`https://openvibe.watch/watches/${w.id}`));
    assert.ok(tasks[0].input.length <= 8000);
    assert.deepStrictEqual([(await acts(w.id))[0].state, (await acts(w.id))[0].last_error], ['sent', 'Actor task tsk_AGENT']);

    for (const [kind, expected] of [['missing', /actor\.agent\.not_found/], ['limit', /actor\.agent\.limit/], ['free', /actor\.agent\.free_tier/], ['busy', /actor\.unavailable/]]) {
        actorMode = kind;
        const next = await create(person, { action: [{ kind: 'actor-agent', agent_id: agentId }] });
        await fire(next);
        r = await svc.actions.tick();
        const row = (await acts(next.id))[0];
        assert.strictEqual(row.state, kind === 'busy' ? 'queued' : 'failed');
        assert.match(row.last_error, expected);
        assert.strictEqual(kind === 'busy' ? r.retried : r.failed, 1);
        if (kind === 'busy') {
            // Actor is back: the queued run goes out on the next due tick, so the queue ends empty.
            actorMode = 'ok';
            await svc.db.prepare('UPDATE action_runs SET next_attempt_at = 0 WHERE watch_id = ?').run(next.id);
            r = await svc.actions.tick();
            assert.strictEqual(r.sent, 1);
            assert.strictEqual((await acts(next.id))[0].state, 'sent');
        }
    }
    actorMode = 'ok';
});

t('readiness counts the queue, and the watch page says what the watch did when it fired', async () => {
    const st = await svc.actions.status();
    assert.strictEqual(st.enabled, true);
    assert.ok(st.sent >= 3 && st.queued === 0, JSON.stringify(st));
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
    // The page shows what the alert carried: before, after, source and fetch time.
    assert.match(body, /Before <code[^>]*>19\.99<\/code>; after <code[^>]*>7\.50<\/code>/);
    assert.match(body, new RegExp(`from <code>${web.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/price<\\/code>, fetched <time`));
});

t('an alert leaves out the source and fetched lines when the watch stored neither', () => {
    const { notificationFor } = require('../server/actions');
    const p = notificationFor({
        config: { baseUrl: 'https://openvibe.watch' },
        watch: { id: 'wch_01JAB2C3D4E5F6G7H8J9K0MNPQ', name: 'an event', source: { kind: 'event', pattern: 'live.stream.started' } },
        run: { id: 'ckr_01JAB2C3D4E5F6G7H8J9K0MNPQ' },
        action: {}, value: 'v1', previousValue: undefined, observedAt: null,
    });
    assert.strictEqual(p.message, 'v1', 'no invented URL or time');
    assert.deepStrictEqual(p.rich_content.evidence, { before: null, after: 'v1', source_url: null, fetched_at: null });
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
