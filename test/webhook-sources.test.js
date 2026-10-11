'use strict';
/**
 * Webhook sources (plan T18 step 5): a webhook watch is woken by a POST to /hooks/<watch id> signed with its own
 * secret (HMAC-SHA256 of the body, GitHub's form, or the secret as a bearer token), never on a cadence. The secret is
 * shown once at creation (and on rotation); the address is always the watch's own; deliveries have an hourly budget.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, userToken, suite, newUser } = require('./helpers');
const { verified } = require('../server/webhook-sources');

const t = suite('webhook-sources');
let svc;
const me = newUser();
const ME = userToken(me);
const OTHER = userToken(newUser());

const def = (over = {}) => ({
    name: 'shop orders',
    source: { kind: 'webhook', endpoint: '/internal/hooks/someone-elses' },
    cadence: null,
    extraction: { kind: 'json', value_path: 'order.total' },
    condition: { op: 'gt', value: 100 },
    action: [{ kind: 'notification' }],
    ...over,
});
const api = (method, p, opts = {}) => request(svc.base, method, p, opts);
const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
const deliver = (id, body, headers = {}) => fetch(`${svc.base}/hooks/${id}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
const runs = async (id) => await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid').all(id);

let watch;
let secret;

t('boot', async () => {
    svc = await boot({ env: { WATCH_WEBHOOK_MAX_PER_HOUR: '4' } });
});

t('creating a webhook watch answers its address and secret once; the endpoint is the watch\'s own', async () => {
    const made = await api('POST', '/api/v1/watches', { token: ME, body: def() });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    watch = made.body.watch;
    assert.deepStrictEqual(watch.source, { kind: 'webhook', endpoint: `/internal/hooks/${watch.id}` }, 'never another watch\'s address');
    assert.strictEqual(made.body.webhook.url, `${svc.config.baseUrl}/hooks/${watch.id}`);
    assert.match(made.body.webhook.secret, /^whk_[A-Za-z0-9_-]{43}$/);
    secret = made.body.webhook.secret;
    const read = await api('GET', `/api/v1/watches/${watch.id}`, { token: ME });
    assert.strictEqual(read.body.webhook, undefined, 'a read never shows the secret');
    assert.ok(!JSON.stringify(read.body).includes(secret));
});

t('a signed delivery runs the check with its JSON body as the document; the condition fires', async () => {
    const body = JSON.stringify({ order: { id: 'o1', total: 250 } });
    const res = await deliver(watch.id, body, { 'X-Hub-Signature-256': sign(secret, body) });
    assert.strictEqual(res.status, 200);
    const out = await res.json();
    assert.deepStrictEqual(out, { watch_id: watch.id, state: 'condition_met', triggered: true });
    const [r] = await runs(watch.id);
    assert.deepStrictEqual([r.trigger, r.carrier], ['webhook', 'webhook']);
    // The bearer form, for a sender that cannot sign.
    const small = JSON.stringify({ order: { id: 'o2', total: 20 } });
    const res2 = await deliver(watch.id, small, { Authorization: `Bearer ${secret}` });
    assert.deepStrictEqual(await res2.json(), { watch_id: watch.id, state: 'changed', triggered: false });
});

t('refused: a wrong or missing signature (401), an unknown or non-webhook address (404), a paused watch (409)', async () => {
    const body = JSON.stringify({ order: { total: 999 } });
    assert.strictEqual((await deliver(watch.id, body)).status, 401);
    assert.strictEqual((await deliver(watch.id, body, { 'X-Hub-Signature-256': sign('whk_wrong', body) })).status, 401);
    assert.strictEqual((await deliver(watch.id, body, { 'X-Hub-Signature-256': sign(secret, `${body} `) })).status, 401, 'the signature covers the exact bytes');
    assert.strictEqual((await deliver(watch.id, body, { Authorization: 'Bearer whk_wrong' })).status, 401);
    assert.strictEqual((await deliver('wch_01JZ0000000000000000000000', body, { Authorization: `Bearer ${secret}` })).status, 404);
    assert.strictEqual((await deliver('not-an-id', body)).status, 404);
    const page = await svc.registry.create({ ...def(), source: { kind: 'http', url: 'https://example.org/' }, cadence: { every_sec: 900 }, extraction: { kind: 'text' } }, { sub: me });
    assert.strictEqual((await deliver(page.id, body, { Authorization: `Bearer ${secret}` })).status, 404, 'a page watch has no webhook');
    await api('POST', `/api/v1/watches/${watch.id}/pause`, { token: ME });
    assert.strictEqual((await deliver(watch.id, body, { Authorization: `Bearer ${secret}` })).status, 409);
    await api('POST', `/api/v1/watches/${watch.id}/resume`, { token: ME });
    assert.strictEqual((await runs(watch.id)).length, 2, 'no refused delivery ran a check');
});

t('the hourly budget answers 429 with Retry-After; a body over 256 KB is 413', async () => {
    const body = JSON.stringify({ order: { total: 1 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await deliver(watch.id, body, { Authorization: `Bearer ${secret}` })).status);
    assert.deepStrictEqual(statuses, [200, 200, 429], 'two deliveries were already used this hour (budget 4)');
    const limited = await deliver(watch.id, body, { Authorization: `Bearer ${secret}` });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const big = 'x'.repeat(300 * 1024);
    assert.strictEqual((await deliver(watch.id, big, { Authorization: `Bearer ${secret}` })).status, 413);
});

t('rotating replaces the secret at once; only the owner may; Check now waits for a delivery', async () => {
    const rotated = await api('POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: ME });
    assert.strictEqual(rotated.status, 200);
    assert.notStrictEqual(rotated.body.webhook.secret, secret);
    assert.strictEqual((await api('POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: OTHER })).status, 404);
    const out = await svc.check.run(watch.id, { trigger: 'manual' });
    assert.strictEqual(out.run.error_code, 'watch.webhook_awaited');
    assert.strictEqual(verified(secret, Buffer.from('{}'), { authorization: `Bearer ${secret}` }), true, 'the helper itself');
    const stored = await svc.db.prepare('SELECT secret FROM webhook_secrets WHERE watch_id = ?').get(watch.id);
    assert.strictEqual(stored.secret, rotated.body.webhook.secret, 'the old secret is gone');
    secret = rotated.body.webhook.secret;
});

t('a non-JSON delivery is read as text; JSON that is not JSON is a parse error, recorded', async () => {
    const text = await svc.registry.create(def({ name: 'plain', extraction: { kind: 'text' }, condition: { op: 'contains', value: 'paid' } }), { sub: me });
    const { secret: s } = await svc.webhookSources.issue(text.id);
    const ok = await fetch(`${svc.base}/hooks/${text.id}`, { method: 'POST', body: 'order paid', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${s}` } });
    assert.strictEqual((await ok.json()).triggered, true);
    const bad = await fetch(`${svc.base}/hooks/${text.id}`, { method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s}` } });
    assert.strictEqual((await bad.json()).state, 'parse_error');
});

t('deleting the watch forgets its secret', async () => {
    assert.strictEqual((await api('DELETE', `/api/v1/watches/${watch.id}`, { token: ME })).status, 200);
    assert.strictEqual(await svc.db.prepare('SELECT secret FROM webhook_secrets WHERE watch_id = ?').get(watch.id), undefined);
    assert.strictEqual((await deliver(watch.id, '{}', { Authorization: `Bearer ${secret}` })).status, 404);
});

t('stop', async () => { await svc.stop(); });

t.run();
