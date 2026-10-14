'use strict';
/**
 * Watch's control API (ADR-048, plan T13 step 10): OpenVibe.Services suspends, resumes and deletes a person's watch by
 * its OVRN. Only a first-party service holding watch.resource.control, only for the watch's owner and inside the OVRN's
 * project; other actions refused; dry runs apply nothing; a repeat returns the first answer, the same key with another
 * request is a conflict; every answer is a common.resource-control-result@1.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, request, serviceToken, userToken, newUser, watchDef, suite } = require('./helpers');

const t = suite('resource-control');
let svc;
const owner = newUser();
const stranger = newUser();
const project = contracts.ids.newId('project');
const otherProject = contracts.ids.newId('project');
const token = serviceToken('services', ['watch.resource.control']);
let watch;
let n = 0;
const key = () => `ctl-test-${++n}-${Date.now()}`;
const control = async (body, bearer = token) => request(svc.base, 'POST', '/api/v1/resources/control', { token: bearer, body });
const ovrn = (w, prj = project) => contracts.resources.format({ service: 'watch', project_id: prj, type: 'watch', id: w.id });
const ask = (action, extra = {}) => ({ action, resource: ovrn(watch), project_id: project, idempotency_key: key(), on_behalf_of: { type: 'user', id: owner }, ...extra });
const valid = (body) => {
    const v = contracts.validate('common.resource-control-result@1', body);
    assert.ok(v.valid, JSON.stringify(v.errors));
    return body;
};
const statusOf = async () => (await svc.db.prepare('SELECT status, deleted_at FROM watches WHERE id = ?').get(watch.id));

t('boot with a person\'s watch in a project', async () => {
    svc = await boot();
    watch = await svc.registry.create(watchDef({ name: 'controlled' }), { sub: owner });
    await svc.db.prepare('UPDATE watches SET project_id = ? WHERE id = ?').run(project, watch.id);
});

t('only a first-party service with the capability may call it', async () => {
    assert.strictEqual((await control(ask('suspend'), serviceToken('services', ['watch.resource.read']))).status, 403);
    assert.strictEqual((await control(ask('suspend'), userToken(owner))).status, 403);
    assert.strictEqual((await control({ action: 'suspend' })).status, 400, 'not a control request');
});

t('suspend, a dry run first, then a repeat answered from the log', async () => {
    const dry = valid((await control(ask('suspend', { dry_run: true }))).body);
    assert.deepStrictEqual([dry.state, dry.result.dry_run], ['done', true]);
    assert.strictEqual((await statusOf()).status, 'active', 'a dry run applies nothing');
    const body = ask('suspend');
    const r = await control(body);
    assert.strictEqual(r.status, 200);
    valid(r.body);
    assert.deepStrictEqual([r.body.state, r.body.result.status], ['done', 'paused']);
    assert.strictEqual((await statusOf()).status, 'paused');
    const again = await control(body);
    assert.deepStrictEqual(again.body, r.body, 'the first answer, again');
    const conflict = await control({ ...body, action: 'resume' });
    assert.strictEqual(conflict.status, 409);
});

t('resume; unsupported actions, another person and another project are refused', async () => {
    const r = valid((await control(ask('resume'))).body);
    assert.deepStrictEqual([r.state, r.result.status], ['done', 'active']);
    const resize = valid((await control(ask('resize'))).body);
    assert.deepStrictEqual([resize.state, resize.problem.code], ['refused', 'control.unsupported_action']);
    const theirs = valid((await control(ask('suspend', { on_behalf_of: { type: 'user', id: stranger } }))).body);
    assert.deepStrictEqual([theirs.state, theirs.problem.code], ['refused', 'resources.unknown_resource']);
    const elsewhere = valid((await control({ ...ask('suspend'), resource: ovrn(watch, otherProject), project_id: otherProject })).body);
    assert.deepStrictEqual([elsewhere.state, elsewhere.problem.code], ['refused', 'resources.unknown_resource']);
    const nobody = valid((await control(ask('suspend', { on_behalf_of: undefined }))).body);
    assert.deepStrictEqual([nobody.state, nobody.problem.code], ['refused', 'control.no_person']);
    assert.strictEqual((await statusOf()).status, 'active');
});

t('delete removes it as DELETE /api/v1/watches/:id does', async () => {
    const r = valid((await control(ask('delete'))).body);
    assert.deepStrictEqual([r.state, r.result.deleted], ['done', true]);
    assert.ok((await statusOf()).deleted_at);
    const gone = valid((await control(ask('resume'))).body);
    assert.strictEqual(gone.problem.code, 'resources.unknown_resource');
});

t('done', async () => { await svc.stop(); });

t.run();
