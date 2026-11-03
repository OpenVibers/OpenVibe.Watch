'use strict';
/**
 * A webhook watch signed by the sender's own secret (agent plan A3, triggers v1). Slack and Stripe sign with a secret
 * they make, not Watch's: the person pastes it (POST …/webhook-secret { provider, secret }) and that scheme checks each
 * delivery. Slack's url_verification gets its challenge back and a retry is acknowledged without a second check; a
 * delivery older than five minutes is refused; Telegram's secret-token header works with Watch's own secret.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, request, userToken, suite, newUser } = require('./helpers');
const { verified, PROVIDERS } = require('../server/webhook-sources');

const t = suite('webhook-providers');
let svc;
const me = newUser();
const ME = userToken(me);
const OTHER = userToken(newUser());
const api = (method, p, opts = {}) => request(svc.base, method, p, opts);
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
const deliver = (id, body, headers = {}) => fetch(`${svc.base}/hooks/${id}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
const runs = async (id) => await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid').all(id);
const def = (name) => ({ name, source: { kind: 'webhook', endpoint: '/internal/hooks/x' }, cadence: null, extraction: { kind: 'json', value_path: 'event.type' }, condition: { op: 'contains', value: 'app_mention' }, action: [{ kind: 'notification' }] });

const SLACK = 'a'.repeat(16) + '0123456789abcdef';
const STRIPE = 'whsec_' + 'Zx9'.repeat(10);
let slackWatch, stripeWatch;

t('boot', async () => { svc = await boot(); });

t('the helper: Slack v0, Stripe v1 (any of several), each in time; Telegram with Watch\'s own secret', () => {
    const body = Buffer.from('{"event":{"type":"app_mention"}}');
    const ts = String(nowSec());
    const slack = { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${hmac(SLACK, `v0:${ts}:${body}`)}` };
    assert.strictEqual(verified(SLACK, body, slack, { provider: 'slack' }), true);
    assert.strictEqual(verified(SLACK, body, { ...slack, 'x-slack-request-timestamp': String(nowSec() - 301) }, { provider: 'slack' }), false, 'older than five minutes');
    assert.strictEqual(verified(SLACK, Buffer.from(`${body} `), slack, { provider: 'slack' }), false, 'the exact bytes');
    assert.strictEqual(verified(SLACK, body, { authorization: `Bearer ${SLACK}` }, { provider: 'slack' }), false, 'a Slack watch takes only Slack\'s signature');
    const stripe = { 'stripe-signature': `t=${ts},v1=deadbeef,v1=${hmac(STRIPE, `${ts}.${body}`)}` };
    assert.strictEqual(verified(STRIPE, body, stripe, { provider: 'stripe' }), true);
    assert.strictEqual(verified(STRIPE, body, { 'stripe-signature': `t=${nowSec() - 400},v1=${hmac(STRIPE, `${nowSec() - 400}.${body}`)}` }, { provider: 'stripe' }), false);
    assert.strictEqual(verified('whk_x', body, { 'x-telegram-bot-api-secret-token': 'whk_x' }), true, 'Telegram\'s secret_token');
    assert.strictEqual(verified('whk_x', body, { 'x-telegram-bot-api-secret-token': 'whk_y' }), false);
    assert.strictEqual(verified(SLACK, body, slack, { provider: 'github' }), false, 'an unknown provider checks nothing');
    assert.deepStrictEqual(Object.keys(PROVIDERS), ['slack', 'stripe', 'discord']);
});

t('the owner pastes Slack\'s signing secret; it is kept, never echoed; a bad one changes nothing', async () => {
    const made = await api('POST', '/api/v1/watches', { token: ME, body: def('slack mentions') });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    slackWatch = made.body.watch;
    const own = made.body.webhook.secret;
    const bad = await api('POST', `/api/v1/watches/${slackWatch.id}/webhook-secret`, { token: ME, body: { provider: 'slack', secret: 'not-hex' } });
    assert.strictEqual(bad.status, 422);
    assert.strictEqual((await api('POST', `/api/v1/watches/${slackWatch.id}/webhook-secret`, { token: ME, body: { provider: 'fax', secret: SLACK } })).status, 422);
    assert.strictEqual((await svc.db.prepare('SELECT secret FROM webhook_secrets WHERE watch_id = ?').get(slackWatch.id)).secret, own, 'unchanged');
    assert.strictEqual((await api('POST', `/api/v1/watches/${slackWatch.id}/webhook-secret`, { token: OTHER, body: { provider: 'slack', secret: SLACK } })).status, 404);
    const set = await api('POST', `/api/v1/watches/${slackWatch.id}/webhook-secret`, { token: ME, body: { provider: 'slack', secret: SLACK } });
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    assert.strictEqual(set.body.webhook.provider, 'slack');
    assert.strictEqual(set.body.webhook.url, `${svc.config.baseUrl}/hooks/${slackWatch.id}`);
    assert.ok(!JSON.stringify(set.body).includes(SLACK), 'their secret is never echoed');
    assert.strictEqual(await svc.webhookSources.providerOf(slackWatch.id), 'slack');
});

t('Slack: the challenge comes back, a signed event runs the check once, a retry is acknowledged, an old one is refused', async () => {
    const ts = String(nowSec());
    const sign = (body, at = ts) => ({ 'X-Slack-Request-Timestamp': at, 'X-Slack-Signature': `v0=${hmac(SLACK, `v0:${at}:${body}`)}` });
    const challenge = JSON.stringify({ type: 'url_verification', challenge: 'c4ll3ng3', token: 'old' });
    const c = await deliver(slackWatch.id, challenge, sign(challenge));
    assert.strictEqual(c.status, 200);
    assert.deepStrictEqual(await c.json(), { challenge: 'c4ll3ng3' });
    assert.strictEqual((await runs(slackWatch.id)).length, 0, 'the challenge runs no check');
    const ev = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention', text: 'hey' } });
    const r = await deliver(slackWatch.id, ev, sign(ev));
    assert.deepStrictEqual(await r.json(), { watch_id: slackWatch.id, state: 'condition_met', triggered: true });
    const retry = await deliver(slackWatch.id, ev, { ...sign(ev), 'X-Slack-Retry-Num': '1', 'X-Slack-Retry-Reason': 'http_timeout' });
    assert.strictEqual((await retry.json()).retry, true);
    assert.strictEqual((await runs(slackWatch.id)).length, 1, 'the retry did not check again');
    const old = String(nowSec() - 600);
    assert.strictEqual((await deliver(slackWatch.id, ev, sign(ev, old))).status, 401, 'a replayed request');
    assert.strictEqual((await deliver(slackWatch.id, challenge, { Authorization: `Bearer ${SLACK}` })).status, 401, 'no challenge for an unsigned caller');
});

t('Stripe: a signed event runs the check; the wrong secret is refused', async () => {
    const made = await api('POST', '/api/v1/watches', { token: ME, body: { ...def('stripe payments'), extraction: { kind: 'json', value_path: 'type' }, condition: { op: 'contains', value: 'payment_intent.succeeded' } } });
    stripeWatch = made.body.watch;
    assert.strictEqual((await api('POST', `/api/v1/watches/${stripeWatch.id}/webhook-secret`, { token: ME, body: { provider: 'stripe', secret: STRIPE } })).status, 200);
    const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const ts = String(nowSec());
    const ok = await deliver(stripeWatch.id, body, { 'Stripe-Signature': `t=${ts},v1=${hmac(STRIPE, `${ts}.${body}`)}` });
    assert.deepStrictEqual(await ok.json(), { watch_id: stripeWatch.id, state: 'condition_met', triggered: true });
    assert.strictEqual((await deliver(stripeWatch.id, body, { 'Stripe-Signature': `t=${ts},v1=${hmac('whsec_other', `${ts}.${body}`)}` })).status, 401);
});

t('Discord: the ping gets { type: 1 }, a command a quiet reply at once and a check right after; a bad signature 401', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const made = await api('POST', '/api/v1/watches', { token: ME, body: { ...def('discord commands'), extraction: { kind: 'json', value_path: 'data.name' }, condition: { op: 'contains', value: 'deploy' } } });
    const w = made.body.watch;
    assert.strictEqual((await api('POST', `/api/v1/watches/${w.id}/webhook-secret`, { token: ME, body: { provider: 'discord', secret: 'not-a-key' } })).status, 422);
    const set = await api('POST', `/api/v1/watches/${w.id}/webhook-secret`, { token: ME, body: { provider: 'discord', secret: pub } });
    assert.strictEqual(set.body.webhook.provider, 'discord');
    const sign = (body, ts = String(nowSec())) => ({ 'X-Signature-Timestamp': ts, 'X-Signature-Ed25519': crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString('hex') });
    const ping = JSON.stringify({ type: 1, id: 'i1' });
    const p = await deliver(w.id, ping, sign(ping));
    assert.deepStrictEqual(await p.json(), { type: 1 });
    assert.strictEqual((await deliver(w.id, ping, { ...sign(ping), 'X-Signature-Ed25519': '0'.repeat(128) })).status, 401, 'Discord checks that a bad signature is refused');
    assert.strictEqual((await deliver(w.id, ping, sign(ping, String(nowSec() - 600)))).status, 401, 'an old one too');
    const cmd = JSON.stringify({ type: 2, id: 'i2', data: { name: 'deploy' } });
    const c = await deliver(w.id, cmd, sign(cmd));
    const reply = await c.json();
    assert.deepStrictEqual([reply.type, reply.data.flags], [4, 64], 'an ephemeral reply at once');
    let got = [];
    for (let i = 0; i < 50 && !got.length; i++) { got = await runs(w.id); if (!got.length) await new Promise((r) => setTimeout(r, 50)); }
    assert.strictEqual(got.length, 1, 'the check ran right after');
    assert.strictEqual(got[0].trigger, 'webhook');
});

t('a new secret of Watch\'s own replaces a provider\'s, and its forms work again', async () => {
    const rotated = await api('POST', `/api/v1/watches/${stripeWatch.id}/webhook-secret`, { token: ME });
    assert.match(rotated.body.webhook.secret, /^whk_/);
    assert.strictEqual(await svc.webhookSources.providerOf(stripeWatch.id), null);
    const body = JSON.stringify({ type: 'payment_intent.succeeded' });
    assert.strictEqual((await deliver(stripeWatch.id, body, { 'X-Telegram-Bot-Api-Secret-Token': rotated.body.webhook.secret })).status, 200, 'Telegram\'s header');
});

t('stop', async () => { await svc.stop(); });

t.run();
