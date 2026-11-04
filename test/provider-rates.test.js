'use strict';
/**
 * Provider-rate evidence (plan P6): the two official machine-readable price documents parsed without a network,
 * a changed rate raising one Watch change, an unchanged one raising none, a malformed one labelled parse_error and
 * never becoming zero, a person's approval recorded as evidence (never a rate card), and the flag off changing
 * nothing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, request, serviceToken, userToken, newUser, site, suite } = require('./helpers');
const { parse, scaled, PROVIDERS } = require('../server/provider-rates');
const { validate } = require('openvibe-contracts');

const t = suite('provider-rates');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'provider-rates', name), 'utf8'));
const AT = Date.parse('2026-11-04T03:00:00Z');
const deepinfraDoc = fixture('deepinfra-models.json');
const featherlessDoc = fixture('featherless-models.json');
const byKey = (observations, model, cls) => observations.find((o) => o.model === model && o.token_class === cls);

/** A provider definition pointed at a stub; everything else (parser, units, notes) stays the real one. */
const pointed = (provider, url) => ({ ...PROVIDERS[provider], url });

t('DeepInfra /models/list fixture: exact nano-USD per million, integer strings, cache multiplier and discount', () => {
    const out = parse('deepinfra', deepinfraDoc, { fetchedAt: AT });
    assert.strictEqual(out.models, 3, 'the embeddings model is not token-priced and is skipped');
    assert.strictEqual(out.skipped, 1);
    assert.strictEqual(out.observations.length, 8, 'input + output for three models, cached read for the two that state it');
    for (const o of out.observations) {
        assert.strictEqual(typeof o.nano_usd_per_m, 'string');
        assert.match(o.nano_usd_per_m, /^\d+$/, `${o.model} ${o.token_class} is an integer string`);
        assert.strictEqual(o.currency, 'USD');
        assert.strictEqual(o.region, 'global');
        assert.strictEqual(o.effective_date, '2026-11-04');
        assert.strictEqual(o.source_url, PROVIDERS.deepinfra.url);
        assert.strictEqual(o.fetched_at, AT);
    }
    // 0.000007 cents/token = $0.07/M = 70,000,000 nano-USD/M.
    assert.strictEqual(byKey(out.observations, 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'input').nano_usd_per_m, '70000000');
    assert.strictEqual(byKey(out.observations, 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'output').nano_usd_per_m, '260000000');
    // 0.00002 cents/token = $0.20/M, less the active 20% promotion → $0.16/M; output 1.15e-4 → $0.92/M.
    assert.strictEqual(byKey(out.observations, 'stepfun-ai/Step-3.7-Flash', 'input').nano_usd_per_m, '160000000');
    assert.strictEqual(byKey(out.observations, 'stepfun-ai/Step-3.7-Flash', 'output').nano_usd_per_m, '920000000');
    // The cached field is a multiplier (0.2 of the discounted input), not a price: $0.032/M.
    assert.strictEqual(byKey(out.observations, 'stepfun-ai/Step-3.7-Flash', 'cached_read').nano_usd_per_m, '32000000');
    // 0.55 of $0.20/M, no discount.
    assert.strictEqual(byKey(out.observations, 'Qwen/Qwen3-VL-235B-A22B-Instruct', 'cached_read').nano_usd_per_m, '110000000');
});

t('Featherless /v1/models fixture: USD/token strings, gated models kept, exact conversions', () => {
    const out = parse('featherless', featherlessDoc, { fetchedAt: AT });
    assert.strictEqual(out.models, 4);
    assert.strictEqual(out.skipped, 0);
    assert.strictEqual(out.observations.length, 8);
    for (const o of out.observations) {
        assert.match(o.nano_usd_per_m, /^\d+$/);
        assert.strictEqual(o.source_url, PROVIDERS.featherless.url);
    }
    // 0.00000004 USD/token = $0.04/M = 40,000,000 nano-USD/M.
    assert.strictEqual(byKey(out.observations, 'Qwen/Qwen3-0.6B', 'input').nano_usd_per_m, '40000000');
    assert.strictEqual(byKey(out.observations, 'Qwen/Qwen3-0.6B', 'output').nano_usd_per_m, '80000000');
    assert.strictEqual(byKey(out.observations, 'Qwen/Qwen3-14B', 'input').nano_usd_per_m, '120000000');
    assert.strictEqual(byKey(out.observations, 'hexgrad/Kokoro-82M', 'output').nano_usd_per_m, '1200000000');
    // Gated is a gate, not a missing price: the published rate is still evidence for a person to read.
    assert.strictEqual(byKey(out.observations, 'meta-llama/Meta-Llama-3.1-8B-Instruct', 'input').nano_usd_per_m, '50000000');
});

t('the decimal arithmetic is exact and refuses a malformed value (never a zero)', () => {
    assert.strictEqual(scaled(0.000012, 13, 'x').toString(), '120000000');
    assert.strictEqual(scaled('0.00000004', 15, 'x').toString(), '40000000');
    assert.strictEqual(scaled('0.011999999999999997', 9, 'x').toString(), '12000000', 'round half-up at the nano, not float truncation');
    assert.strictEqual(scaled('5e-7', 13, 'x').toString(), '5000000');
    assert.throws(() => scaled('free', 13, 'x'), /not a finite non-negative decimal/);
    assert.throws(() => scaled(-1, 13, 'x'), /not a finite non-negative number/);
    assert.throws(() => scaled(null, 13, 'x'), /not a decimal/);
    // A price the document does not state is never defaulted to zero.
    const missing = deepinfraDoc.map((m) => (m.model_name === 'Qwen/Qwen3-Coder-30B-A3B-Instruct'
        ? { ...m, pricing: { ...m.pricing, cents_per_input_token: null } } : m));
    assert.throws(() => parse('deepinfra', missing, { fetchedAt: AT }), /cents_per_input_token/);
    assert.throws(() => parse('deepinfra', [], { fetchedAt: AT }), /no token-priced model/);
    assert.throws(() => parse('featherless', { data: [] }, { fetchedAt: AT }), /no token-priced model/);
    assert.throws(() => parse('featherless', { data: [{ id: 'x', pricing: { prompt: 'n/a', completion: '1' } }] }, { fetchedAt: AT }), /pricing\.prompt/);
    // An explicit zero is a stated price (a real observation), unlike a missing one.
    const zero = parse('featherless', { data: [{ id: 'free/tier', pricing: { prompt: '0', completion: '0' } }] }, { fetchedAt: AT });
    assert.deepStrictEqual(zero.observations.map((o) => o.nano_usd_per_m), ['0', '0']);
});

// ── The service: a stub provider document, no live fetch ─────────────────────────────────────────
let svc;
let stub;
let deepinfraBody = JSON.parse(JSON.stringify(deepinfraDoc));
let featherlessBody = JSON.parse(JSON.stringify(featherlessDoc));
let deepinfraEtag = null;
const reader = () => serviceToken('services', ['watch.watch.read']);
const admin = () => serviceToken('network', ['watch.*']);
const person = { sub: newUser() };
const personToken = () => userToken(person.sub);

async function booted(flag = '1') {
    stub = await site({
        '/deepinfra': (req) => {
            if (deepinfraEtag && req.headers['if-none-match'] === deepinfraEtag) return { status: 304, headers: { etag: deepinfraEtag } };
            return { headers: { 'content-type': 'application/json', ...(deepinfraEtag ? { etag: deepinfraEtag } : {}) }, body: JSON.stringify(deepinfraBody) };
        },
        '/featherless': () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(featherlessBody) }),
    });
    svc = await boot({
        env: { WATCH_PROVIDER_RATES: flag },
        providerRateProviders: {
            deepinfra: pointed('deepinfra', `${stub.origin}/deepinfra`),
            featherless: pointed('featherless', `${stub.origin}/featherless`),
        },
    });
}

t('boot with the flag on: two sources, disabled until a person enables one, nothing fetched yet', async () => {
    await booted('1');
    const got = await request(svc.base, 'GET', '/api/v1/provider-rates', { token: reader() });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.sources.length, 2);
    assert.ok(got.body.sources.every((s) => s.kind === 'provider-rate' && s.enabled === false));
    assert.strictEqual(got.body.sources[0].health.status, 'disabled');
    assert.strictEqual(got.body.pending_changes, 0);
    assert.deepStrictEqual(stub.hits('/deepinfra'), [], 'no fetch before a person enables it');
    // A refresh of a disabled source is refused, and still fetches nothing.
    const refused = await request(svc.base, 'POST', '/api/v1/provider-rates/sources/deepinfra/refresh', { token: admin() });
    assert.strictEqual(refused.status, 409);
    assert.deepStrictEqual(stub.hits('/deepinfra'), []);
});

t('enable both sources, then parse each fixture into observations (changed=0 on the first reading)', async () => {
    for (const key of ['deepinfra', 'featherless']) {
        const on = await request(svc.base, 'PATCH', `/api/v1/provider-rates/sources/${key}`, { token: admin(), body: { enabled: true } });
        assert.strictEqual(on.status, 200, JSON.stringify(on.body));
        assert.strictEqual(on.body.source.enabled, true);
    }
    const di = await request(svc.base, 'POST', '/api/v1/provider-rates/sources/deepinfra/refresh', { token: admin() });
    assert.strictEqual(di.status, 200, JSON.stringify(di.body));
    assert.deepStrictEqual([di.body.fetch.state, di.body.fetch.stated, di.body.fetch.observations, di.body.fetch.changed], ['ok', 8, 8, 0]);
    assert.strictEqual(di.body.source.health.status, 'healthy');
    const fe = await request(svc.base, 'POST', '/api/v1/provider-rates/sources/featherless/refresh', { token: admin() });
    assert.strictEqual(fe.status, 200, JSON.stringify(fe.body));
    assert.deepStrictEqual([fe.body.fetch.state, fe.body.fetch.stated, fe.body.fetch.observations], ['ok', 8, 8]);
    assert.strictEqual(stub.hits('/deepinfra').length, 1);
    assert.strictEqual(stub.hits('/featherless').length, 1);

    const latest = await request(svc.base, 'GET', '/api/v1/provider-rates/observations?latest=1', { token: reader() });
    assert.strictEqual(latest.status, 200);
    assert.strictEqual(latest.body.observations.length, 16);
    const obs = latest.body.observations.find((o) => o.model === 'Qwen/Qwen3-Coder-30B-A3B-Instruct' && o.token_class === 'input');
    assert.strictEqual(obs.nano_usd_per_m, '70000000');
    assert.strictEqual(obs.source_url, `${stub.origin}/deepinfra`, 'the URL actually fetched is recorded');
    assert.match(obs.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(obs.changed, false);
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/provider-rates/changes', { token: reader() })).body.changes.length, 0);
});

t('an unchanged document raises no change; a 304 records not_modified and no new observation', async () => {
    const again = await request(svc.base, 'POST', '/api/v1/provider-rates/sources/deepinfra/refresh', { token: admin() });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.deepStrictEqual([again.body.fetch.state, again.body.fetch.stated, again.body.fetch.observations, again.body.fetch.changed], ['ok', 8, 0, 0]);
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/provider-rates/changes', { token: reader() })).body.changes.length, 0);

    // With a validator the next read is conditional: 304, no body, no new observation, no change.
    deepinfraEtag = '"v1"';
    const stored = await request(svc.base, 'POST', '/api/v1/provider-rates/sources/deepinfra/refresh', { token: admin() });
    assert.strictEqual(stored.body.fetch.state, 'ok');
    const notModified = await request(svc.base, 'POST', '/api/v1/provider-rates/sources/deepinfra/refresh', { token: admin() });
    assert.deepStrictEqual([notModified.body.fetch.state, notModified.body.fetch.stated, notModified.body.fetch.observations, notModified.body.fetch.changed], ['not_modified', 0, 0, 0]);
    assert.strictEqual(stub.hits('/deepinfra').at(-1).headers['if-none-match'], '"v1"');
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/provider-rates/changes', { token: reader() })).body.changes.length, 0);
});

t('a changed price raises exactly one Watch change with both integer values, and a person approves it', async () => {
    deepinfraEtag = '"v2"';
    deepinfraBody[0].pricing.cents_per_input_token = 0.000009;   // $0.07/M → $0.09/M
    const res = await request(svc.base, 'POST', '/api/v1/provider-rates/sources/deepinfra/refresh', { token: admin() });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual([res.body.fetch.state, res.body.fetch.stated, res.body.fetch.observations, res.body.fetch.changed], ['ok', 8, 1, 1]);

    const pending = await request(svc.base, 'GET', '/api/v1/provider-rates/changes?state=pending', { token: reader() });
    assert.strictEqual(pending.body.changes.length, 1);
    const change = pending.body.changes[0];
    assert.strictEqual(change.model, 'Qwen/Qwen3-Coder-30B-A3B-Instruct');
    assert.strictEqual(change.token_class, 'input');
    assert.strictEqual(change.from_nano_usd_per_m, '70000000');
    assert.strictEqual(change.to_nano_usd_per_m, '90000000');
    assert.strictEqual(change.approval_required, true);
    assert.strictEqual(change.effect, 'evidence');
    assert.strictEqual(change.state, 'pending');

    // The change is a Watch event, not a private table row.
    const events = await svc.db.many("SELECT envelope FROM service_outbox WHERE envelope->>'event_type' = 'watch.rate.changed'");
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].envelope.payload.change_id, change.id);
    assert.strictEqual(events[0].envelope.payload.approval_required, true);
    // The released contract (openvibe-contracts v0.286.0) describes exactly what Watch sends.
    const changedCheck = validate('watch.rate.changed@1', events[0].envelope.payload);
    assert.ok(changedCheck.valid, JSON.stringify(changedCheck.errors));

    // A service may fetch and read, never approve.
    const service = await request(svc.base, 'POST', `/api/v1/provider-rates/changes/${change.id}/approve`, { token: admin() });
    assert.strictEqual(service.status, 403);
    assert.strictEqual(service.body.code, 'watch.rate_person_only');

    const approved = await request(svc.base, 'POST', `/api/v1/provider-rates/changes/${change.id}/approve`, {
        token: personToken(), body: { note: 'Reviewed the provider page; this is the list rate.' },
    });
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    assert.strictEqual(approved.body.applied, false, 'an approval writes no billable rate');
    assert.strictEqual(approved.body.change.state, 'approved');
    assert.strictEqual(approved.body.change.decided_by, person.sub);
    assert.strictEqual(approved.body.change.note, 'Reviewed the provider page; this is the list rate.');
    assert.match(approved.body.change.decided_at, /^\d{4}-\d{2}-\d{2}T/);

    const again = await request(svc.base, 'POST', `/api/v1/provider-rates/changes/${change.id}/approve`, { token: personToken() });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'watch.rate_decided');

    const approvedEvents = await svc.db.many("SELECT envelope FROM service_outbox WHERE envelope->>'event_type' = 'watch.rate.approved'");
    assert.strictEqual(approvedEvents.length, 1);
    assert.strictEqual(approvedEvents[0].envelope.payload.applied, false);
    assert.strictEqual(approvedEvents[0].envelope.payload.decided_by, person.sub);
    const approvedCheck = validate('watch.rate.approved@1', approvedEvents[0].envelope.payload);
    assert.ok(approvedCheck.valid, JSON.stringify(approvedCheck.errors));

    // There is no rate-card table in Watch, and no route wrote a billable price.
    const tables = await svc.db.many("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE '%rate%'");
    assert.deepStrictEqual(tables.map((r) => r.table_name).sort(), ['provider_rate_changes', 'provider_rate_fetches', 'provider_rate_observations', 'provider_rate_sources']);
});

t('a malformed document is parse_error, writes no observation, and never becomes zero', async () => {
    const before = (await request(svc.base, 'GET', '/api/v1/provider-rates/changes', { token: reader() })).body.changes.length;
    deepinfraEtag = '"v3"';
    deepinfraBody[0].pricing.cents_per_input_token = 'n/a';
    const res = await request(svc.base, 'POST', '/api/v1/provider-rates/sources/deepinfra/refresh', { token: admin() });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual([res.body.fetch.state, res.body.fetch.observations, res.body.fetch.changed], ['parse_error', 0, 0]);
    assert.match(res.body.fetch.detail, /not a finite non-negative decimal/);
    assert.strictEqual(res.body.source.health.status, 'failing');
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/provider-rates/changes', { token: reader() })).body.changes.length, before);

    const latest = await request(svc.base, 'GET', '/api/v1/provider-rates/observations?source=deepinfra&latest=1', { token: reader() });
    const obs = latest.body.observations.find((o) => o.model === 'Qwen/Qwen3-Coder-30B-A3B-Instruct' && o.token_class === 'input');
    assert.strictEqual(obs.nano_usd_per_m, '90000000', 'the last good observation is still there');
    assert.ok(latest.body.observations.every((o) => o.nano_usd_per_m !== '0'), 'nothing was defaulted to zero');
});

t('an old success is labelled stale, not a current price', async () => {
    await svc.db.query("UPDATE provider_rate_sources SET last_success_at = $1, last_state = 'ok', consecutive_failures = 0 WHERE key = 'featherless'", [Date.now() - 13 * 3600 * 1000]);
    const got = await request(svc.base, 'GET', '/api/v1/provider-rates/sources/featherless', { token: reader() });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.source.health.status, 'stale');
});

t('with the flag off the routes are absent and nothing is fetched or seeded', async () => {
    await svc.stop();
    await stub.close();
    const off = await boot({ env: {} });
    try {
        assert.strictEqual(off.providerRates, null);
        const got = await request(off.base, 'GET', '/api/v1/provider-rates', { token: reader() });
        assert.strictEqual(got.status, 404);
        assert.strictEqual(got.body.code, 'watch.not_found');
        assert.strictEqual(await off.db.value('SELECT COUNT(*) FROM provider_rate_sources'), 0);
    } finally {
        await off.stop();
    }
});

t.run();
