'use strict';
/** Watch's first-party authority resource index (ADR-048, plan T13 step 8). */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, request, serviceToken, userToken, newUser, newAgent, watchDef, suite } = require('./helpers');

const t = suite('resource-index');
let svc;
const owner = newUser();
const agent = newAgent();
const projectA = contracts.ids.newId('project');
const projectB = contracts.ids.newId('project');
const token = serviceToken('services', ['watch.resource.read']);
const api = (path, bearer = token) => request(svc.base, 'GET', path, { token: bearer });
const pathOf = (name) => `/api/v1/resources/${encodeURIComponent(name)}`;
let rows;

t('boot and create watches with both project and person ownership', async () => {
    svc = await boot();
    const create = async (project_id, owner_sub, name) => {
        const row = await svc.registry.create(watchDef({ name }), { sub: owner_sub === 'svc:site' ? owner : owner_sub });
        if (project_id) {
            await svc.db.prepare('UPDATE watches SET project_id = ? WHERE id = ?').run(project_id, row.id);
            row.project_id = project_id;
        }
        if (owner_sub === 'svc:site') {
            await svc.db.prepare('UPDATE watches SET owner_sub = ? WHERE id = ?').run(owner_sub, row.id);
            row.owner_sub = owner_sub;
        }
        return row;
    };
    rows = [
        await create(projectA, owner, 'project A'),
        await create(projectB, agent, 'project B'),
        await create(null, owner, 'personal'),
        await create(projectA, 'svc:site', 'service owned'),
    ];
    const deleted = await create(projectA, owner, 'deleted');
    await svc.registry.remove(deleted.id, { sub: owner });
    rows.deleted = deleted;
});

t('only a service token carrying watch.resource.read can list or read', async () => {
    const missing = await api('/api/v1/resources', null);
    assert.strictEqual(missing.status, 401);
    assert.strictEqual(missing.body.code, 'token.missing');
    const denied = await api('/api/v1/resources', serviceToken('services', ['watch.watch.read']));
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.body.code, 'capability.denied');
    const person = await api('/api/v1/resources', userToken(owner));
    assert.strictEqual(person.status, 403);
    assert.strictEqual(person.body.code, 'capability.denied');
    assert.strictEqual((await api('/api/v1/resources', serviceToken('services', ['watch.resource.read'], { aud: 'openvibe.blog' }))).status, 401);
    assert.strictEqual((await api(pathOf(`ovrn:watch:${projectA}:watch/${rows[0].id}`), null)).status, 401);
});

t('the complete page validates and carries only safe summary fields', async () => {
    const page = await api('/api/v1/resources');
    assert.strictEqual(page.status, 200, page.text);
    assert.ok(contracts.validate('common.resource-list-result@1', page.body).valid,
        JSON.stringify(contracts.validate('common.resource-list-result@1', page.body).errors));
    assert.deepStrictEqual(page.body.resources.map(r => r.id), rows.map(r => r.id).sort());
    assert.strictEqual(page.body.next_cursor, null);
    const allowed = new Set(['created_at', 'id', 'kind', 'name', 'owner', 'ovrn', 'project_id', 'service', 'state', 'updated_at']);
    for (const summary of page.body.resources) {
        assert.ok(Object.keys(summary).every(key => allowed.has(key)));
        assert.strictEqual(summary.kind, 'watch.watch');
        assert.strictEqual(summary.service, 'watch');
    }
    assert.strictEqual(page.body.resources.find(r => r.id === rows[0].id).owner.id, owner);
    assert.strictEqual(page.body.resources.find(r => r.id === rows[1].id).owner, undefined);
    assert.strictEqual(page.body.resources.find(r => r.id === rows[2].id).ovrn, undefined);
    assert.strictEqual(page.body.resources.find(r => r.id === rows[3].id).owner, undefined);
});

t('the id keyset cursor walks each row once', async () => {
    const seen = [];
    let cursor = null;
    do {
        const page = await api(`/api/v1/resources?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.strictEqual(page.status, 200, page.text);
        assert.ok(contracts.validate('common.resource-list-result@1', page.body).valid);
        seen.push(...page.body.resources.map(r => r.id));
        cursor = page.body.next_cursor;
    } while (cursor);
    assert.deepStrictEqual(seen, rows.map(r => r.id).sort());
    assert.strictEqual(new Set(seen).size, rows.length);
});

t('project and kind filters, and bad project or cursor', async () => {
    const project = await api(`/api/v1/resources?project=${projectA}`);
    assert.deepStrictEqual(project.body.resources.map(r => r.id), [rows[0].id, rows[3].id]);
    assert.deepStrictEqual((await api('/api/v1/resources?kind=watch.watch')).body.resources.map(r => r.id), rows.map(r => r.id).sort());
    assert.deepStrictEqual((await api('/api/v1/resources?kind=watch.unknown')).body, { resources: [], next_cursor: null });
    const bad = await api('/api/v1/resources?project=bad');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.code, 'resources.bad_query');
    assert.strictEqual((await api('/api/v1/resources?cursor=bad')).status, 400);
});

t('OVRN reads require a computed name and exclude deleted watches', async () => {
    for (const row of [rows[0], rows[1], rows[3]]) {
        const name = `ovrn:watch:${row.project_id}:watch/${row.id}`;
        const one = await api(pathOf(name));
        assert.strictEqual(one.status, 200, one.text);
        assert.strictEqual(one.body.ovrn, name);
        assert.ok(contracts.validate('common.resource-summary@1', one.body).valid);
    }
    const personal = await api(pathOf(`ovrn:watch:${projectA}:watch/${rows[2].id}`));
    assert.strictEqual(personal.status, 404);
    assert.strictEqual(personal.body.code, 'resources.unknown_resource');
    assert.strictEqual((await api(pathOf(`ovrn:watch:${projectB}:watch/${rows[0].id}`))).status, 404);
    assert.strictEqual((await api(pathOf(`ovrn:watch:${projectA}:watch/${rows.deleted.id}`))).status, 404);
});

t('done', async () => { await svc.stop(); });
t.run();
