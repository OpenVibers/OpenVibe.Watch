'use strict';
/**
 * The registry: validation against the released contracts, due selection, arming and re-arming on
 * the cadence, soft delete, owner scoping, the keyset page, and the view (which the service
 * validates with openvibe-contracts' own validator).
 */
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, suite, newUser, newAgent } = require('./helpers');

const t = suite('registry');
let svc;
const me = { sub: newUser() };
const someoneElse = { sub: newUser() };

const def = (overrides = {}) => ({
    name: 'a watch',
    source: { kind: 'http', url: 'https://example.org/page', format: null },
    cadence: { every_sec: 900 },
    extraction: { kind: 'text' },
    condition: { op: 'changed' },
    action: [{ kind: 'notification' }],
    ...overrides,
});
const invalid = async (body, re, create = true) => {
    await assert.rejects(
        () => (create ? svc.registry.create(body, me) : svc.registry.patch('wch_01J0000000000000000000000', body, me)),
        (err) => {
            assert.strictEqual(err.code, 'watch.invalid', err.message);
            assert.match(err.message, re);
            return true;
        },
    );
};

t('boot (worker off)', async () => { svc = await boot(); });

t('create: what a watch requires, enforced in code over the released schema', async () => {
    for (const field of ['source', 'extraction', 'condition', 'action']) {
        const body = def();
        delete body[field];
        await assert.rejects(() => svc.registry.create(body, me), (err) => {
            assert.strictEqual(err.code, 'watch.invalid');
            assert.match(err.message, new RegExp(`requires ${field}`));
            return true;
        });
    }
    // the schema itself refuses what the contract refuses
    await invalid(def({ source: { kind: 'http' } }), /watch.watch-request@1/);
    await invalid(def({ source: { kind: 'ftp', url: 'ftp://example.org/x' } }), /watch.watch-request@1/);
    await invalid(def({ source: { kind: 'http', url: 'https://example.org/x', nope: 1 } }), /watch.watch-request@1/);
    await invalid(def({ cadence: { every_sec: 5 } }), /watch.watch-request@1/, true);
    await invalid(def({ summary: 'not a field' }), /watch.watch-request@1/);
    await invalid(def({ action: [] }), /watch.watch-request@1/);
    await invalid({ ...def(), owner: 'usr_01J0000000000000000000000' }, /watch.watch-request@1/);
    // and the rules a schema cannot carry
    await invalid(def({ cadence: null }), /needs a cadence/);
    await invalid(def({ cadence: {} }), /every_sec/);
    await invalid(def({ source: { kind: 'event', pattern: 'release.published' }, cadence: { every_sec: 60 } }), /never polls/);
    await invalid(def({ source: { kind: 'webhook', endpoint: '/internal/hooks/x' }, cadence: { every_sec: 60 } }), /never polls/);
    await invalid(def({ source: { kind: 'http', url: 'https://example.org/x', headers: { Host: 'evil.example' } } }), /Host/);
    await invalid(def({ source: { kind: 'http', url: 'https://example.org/x', headers: { 'if-none-match': 'x' } } }), /if-none-match/);
    await invalid(def({ source: { kind: 'http', url: 'https://example.org/x', auth: { mode: 'header', env: 'SOMETHING_ELSE' } } }), /watch.watch-request@1/);
    // a HEAD source states no body, so only a record extraction can read one
    await invalid(def({ source: { kind: 'http', url: 'https://example.org/x', method: 'HEAD' } }), /HEAD source states no body/);
    const head = await svc.registry.create(def({ source: { kind: 'http', url: 'https://example.org/x', method: 'HEAD' }, extraction: { kind: 'json', value_path: 'status' } }), me);
    assert.strictEqual(head.source.method, 'HEAD');
});

t('create: the 15-minute cadence floor is enforced here, not only in the form', async () => {
    await invalid(def({ cadence: { every_sec: 60 } }), /15 minutes/);
    await invalid(def({ cadence: { every_sec: 899 } }), /at least 900/);
    const ok = await svc.registry.create(def({ cadence: { every_sec: 900 } }), me);
    assert.strictEqual(ok.cadence.every_sec, 900);
});

t('create: a user regex is validated when the watch is saved, not when it runs', async () => {
    // a nested quantifier would backtrack for minutes over a 64 KiB body; it never reaches the worker
    await invalid(def({ extraction: { kind: 'regex', selector: '(a+)+$' } }), /extraction\/selector/);
    await invalid(def({ condition: { op: 'matches', value: '(a+)+$' } }), /condition\/value/);
    // an invalid or oversized pattern too
    await invalid(def({ extraction: { kind: 'regex', selector: '(' } }), /extraction\/selector/);
    await invalid(def({ condition: { op: 'matches', value: 'x'.repeat(600) } }), /condition\/value/);
    // a normal pattern is accepted
    const w = await svc.registry.create(def({ extraction: { kind: 'regex', selector: '(\\d+\\.\\d+) EUR' } }), me);
    assert.strictEqual(w.extraction.selector, '(\\d+\\.\\d+) EUR');
    const m = await svc.registry.create(def({ condition: { op: 'matches', value: '^v\\d+\\.\\d+' } }), me);
    assert.strictEqual(m.condition.value, '^v\\d+\\.\\d+');
});

t('create: an id, an owner, a name, the arm and the event', async () => {
    const before = Date.now();
    const row = await svc.registry.create(def({ name: undefined }), me);
    assert.match(row.id, /^wch_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(row.owner_sub, me.sub);
    assert.strictEqual(row.status, 'active');
    assert.strictEqual(row.name, 'example.org/page', 'a watch without a name is named after its source');
    assert.ok(row.next_due_at >= before && row.next_due_at <= before + 1000, 'a new watch is due on the next tick (its first reading)');
    assert.strictEqual(row.updated_by, me.sub);
    const events = (await svc.outbox.all()).filter(e => e.subject.id === row.id);
    assert.deepStrictEqual(events.map(e => e.event_type), ['watch.watch.created']);
    assert.strictEqual(events[0].payload.owner, me.sub);
    const agentOwned = await svc.registry.create(def(), { sub: newAgent() });
    assert.match(agentOwned.owner_sub, /^agt_/);
});

t('the view is validated against watch.watch@1, and the health tells the runtime truthfully', async () => {
    const row = await svc.registry.create(def(), me);
    const view = svc.registry.view(row);
    assert.ok(validate('watch.watch@1', view).valid);
    assert.deepStrictEqual(Object.keys(view).sort(), [
        'action', 'budget', 'cadence', 'comparison', 'condition', 'created_at', 'extraction', 'health', 'id',
        'labels', 'name', 'owner', 'project_id', 'retention', 'source', 'status', 'updated_at',
    ]);
    assert.deepStrictEqual(view.health.status, 'never_checked');
    assert.strictEqual(view.health.next_due_at != null, true);
    assert.match(view.created_at, /^\d{4}-\d{2}-\d{2}T/);
    // a paused watch is paused, and an event watch waits (it is never due)
    const paused = svc.registry.view(await svc.registry.patch(row.id, { status: 'paused' }, me));
    assert.strictEqual(paused.health.status, 'paused');
    assert.strictEqual(paused.health.next_due_at, null);
    const pushed = await svc.registry.create(def({ source: { kind: 'event', pattern: 'release.published' }, cadence: null, extraction: { kind: 'json', value_path: 'version' } }), me);
    assert.strictEqual(svc.registry.view(pushed).health.status, 'waiting');
    assert.strictEqual(svc.registry.view(pushed).cadence, null);
});

t('due() selects active, armed watches oldest first, and nothing else', async () => {
    const a = await svc.registry.create(def(), me);
    const b = await svc.registry.create(def(), me);
    const paused = await svc.registry.create(def(), me);
    const eventish = await svc.registry.create(def({ source: { kind: 'event', pattern: 'a.b' }, cadence: null }), me);
    await svc.registry.patch(paused.id, { status: 'paused' }, me);
    await svc.db.prepare('UPDATE watches SET next_due_at = 2000 WHERE id = ?').run(a.id);
    await svc.db.prepare('UPDATE watches SET next_due_at = 1000 WHERE id = ?').run(b.id);
    await svc.db.prepare('UPDATE watches SET next_due_at = 1 WHERE id = ?').run(paused.id);
    await svc.db.prepare('UPDATE watches SET next_due_at = 1 WHERE id = ?').run(eventish.id);
    const due = (await svc.registry.due(50)).map(d => d.id);
    assert.deepStrictEqual(due.slice(0, 2), [b.id, a.id], 'oldest due first');
    assert.ok(!due.includes(paused.id), 'a paused watch is not due');
    assert.ok(!due.includes(eventish.id), 'a watch without a cadence is never due');
    // not_before holds a watch back even when its turn has come
    await svc.db.prepare('UPDATE watches SET not_before = ? WHERE id = ?').run(Date.now() + 3600_000, b.id);
    assert.ok(!(await svc.registry.due(50)).map(d => d.id).includes(b.id));
});

t('patch re-arms the cadence, and pause/resume through status', async () => {
    const w = await svc.registry.create(def(), me);
    const before = Date.now();
    const slowed = await svc.registry.patch(w.id, { cadence: { every_sec: 3600 } }, me);
    assert.ok(slowed.next_due_at >= before + 3600_000, 're-armed on the new cadence');
    assert.strictEqual(slowed.updated_by, me.sub);
    const paused = await svc.registry.patch(w.id, { status: 'paused' }, me);
    assert.strictEqual(paused.status, 'paused');
    assert.strictEqual(paused.next_due_at, 0);
    const resumed = await svc.registry.patch(w.id, { status: 'active' }, me);
    assert.strictEqual(resumed.status, 'active');
    assert.ok(resumed.next_due_at >= Date.now() + 3600_000 - 1000);
    // only the named fields change
    const renamed = await svc.registry.patch(w.id, { name: 'renamed' }, me);
    assert.strictEqual(renamed.name, 'renamed');
    assert.deepStrictEqual(renamed.source, w.source, 'jsonb rows come back parsed');
    // a patch that would break a rule is refused, and the row is untouched
    await assert.rejects(() => svc.registry.patch(w.id, { cadence: null }, me), (err) => err.code === 'watch.invalid');
    const after = await svc.registry.get(w.id);
    assert.deepStrictEqual(after.cadence, { every_sec: 3600 });
    const events = (await svc.outbox.all()).filter(e => e.subject.id === w.id).map(e => e.event_type);
    assert.deepStrictEqual(events, ['watch.watch.created', 'watch.watch.updated', 'watch.watch.paused', 'watch.watch.updated', 'watch.watch.updated']);
});

t('soft delete: gone from every read, still resolvable for its observations', async () => {
    const w = await svc.registry.create(def(), me);
    await svc.db.prepare('INSERT INTO observations (id, watch_id, check_run_id, observed_at, value, value_hash, changed, condition_met) VALUES (?,?,?,?,?,?,0,0)')
        .run('wco_01J0000000000000000000000', w.id, 'ckr_01J0000000000000000000000', Date.now(), '"x"', 'a'.repeat(64));
    const out = await svc.registry.remove(w.id, me);
    assert.deepStrictEqual(out, { id: w.id, deleted: true });
    assert.strictEqual(await svc.registry.get(w.id), null);
    assert.ok(!(await svc.registry.all(me)).some(r => r.id === w.id));
    assert.ok(!(await svc.registry.due(200)).some(d => d.id === w.id));
    const raw = await svc.db.prepare('SELECT * FROM watches WHERE id = ?').get(w.id);
    assert.ok(raw.deleted_at > 0, 'the row stays, with its observations');
    assert.strictEqual((await svc.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE watch_id = ?').get(w.id)).n, 1);
    // a second delete is not found
    assert.strictEqual(await svc.registry.remove(w.id, me), null);
});

t('owner scoping: another subject sees nothing, and every write is scoped too', async () => {
    const w = await svc.registry.create(def(), me);
    assert.strictEqual(await svc.registry.get(w.id, someoneElse), null, '404 for another owner, never 403');
    assert.ok(!(await svc.registry.all(someoneElse)).some(r => r.id === w.id));
    assert.strictEqual(await svc.registry.patch(w.id, { name: 'stolen' }, someoneElse), null);
    assert.strictEqual(await svc.registry.remove(w.id, someoneElse), null);
    assert.strictEqual((await svc.registry.get(w.id, me)).name, 'a watch');
    // a service acting for a person is scoped to that person
    const acted = await svc.registry.create(def(), { sub: 'svc:site', subject: me.sub });
    assert.strictEqual(acted.owner_sub, me.sub);
    assert.ok((await svc.registry.all(me)).some(r => r.id === acted.id));
    assert.ok(!(await svc.registry.all({ sub: 'svc:site' })).some(r => r.id === acted.id));
});

t('all(): the keyset page is id order (a wch_ ULID is creation order)', async () => {
    const other = { sub: newUser() };
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await svc.registry.create(def(), other)).id);
    const page1 = await svc.registry.all(other, { limit: 2 });
    assert.deepStrictEqual(page1.map(r => r.id), [ids[4], ids[3]]);
    const page2 = await svc.registry.all(other, { limit: 2, before: page1[1].id });
    assert.deepStrictEqual(page2.map(r => r.id), [ids[2], ids[1]]);
    const page3 = await svc.registry.all(other, { limit: 2, before: page2[1].id });
    assert.deepStrictEqual(page3.map(r => r.id), [ids[0]]);
    assert.strictEqual((await svc.registry.all(other, { limit: 10 })).length, 5);
    // status filters
    await svc.registry.patch(ids[0], { status: 'paused' }, other);
    assert.deepStrictEqual((await svc.registry.all(other, { status: 'paused' })).map(r => r.id), [ids[0]]);
    assert.strictEqual((await svc.registry.all(other, { status: 'active' })).length, 4);
});

t('create: one owner holds at most WATCH_MAX_PER_OWNER watches, per owner', async () => {
    const capped = await boot({ env: { WATCH_MAX_PER_OWNER: '2' } });
    try {
        const owner = { sub: newUser() };
        await capped.registry.create(def(), owner);
        await capped.registry.create(def(), owner);
        await assert.rejects(() => capped.registry.create(def(), owner), (err) => {
            assert.strictEqual(err.code, 'watch.invalid');
            assert.match(err.message, /at most 2 watches/);
            return true;
        });
        // the cap is per owner: another subject still creates
        await capped.registry.create(def(), { sub: newUser() });
    } finally { await capped.stop(); }
});

t('done', async () => { await svc.stop(); });

t.run();
