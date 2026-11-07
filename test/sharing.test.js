'use strict';
/**
 * Sharing a watch (design 2026-11-06, visibility step 6): the one Share sheet (openvibe-sdk/share) and the one
 * check, canView, on the watch's page and its API.
 *
 *   - a watch is Only me; its page and the list carry the Share button for its owner;
 *   - Anyone with the link reads the page, which shows the watch and what it observed, never its actions or secrets;
 *   - Specific people shows the gate, never the watch's name, to somebody not on the list; the API answers 404;
 *   - the person's default for new watches, and "apply to all", work;
 *   - a watch is never on a gathered page: not the sitemap, not llms.txt.
 */
const assert = require('assert');
const { boot, request, site, suite, watchDef } = require('./helpers');
const sharing = require('../server/sharing');
const { watchesRouter } = require('../server/api/watches');
const { createPageRoutes } = require('../server/http/pages');
const layout = require('../server/render/layout');

const t = suite('sharing');

t('the sharing wiring loads: watches are never Everyone', async () => {
    assert.strictEqual(sharing.SERVICE, 'watch');
    assert.strictEqual(sharing.KIND, 'watch');
    assert.deepStrictEqual(sharing.OFFERED, ['private', 'link', 'people']);
    assert.strictEqual(sharing.shareViewer({ kind: 'anonymous' }), null);
    assert.deepStrictEqual(sharing.shareViewer({ kind: 'user', subject: 'usr_x' }), { subject: { type: 'user', id: 'usr_x' }, staff: false });
    assert.strictEqual(typeof watchesRouter, 'function');
    assert.strictEqual(typeof createPageRoutes, 'function');
    assert.strictEqual(typeof layout.renderPage, 'function');
});

let svc;
let web;
const call = (p, o = {}) => {
    const { headers, ...rest } = o;
    return svc.get(p, { ...rest, headers: { 'x-requested-with': 'ov-share', ...(headers || {}) } });
};
const share = (id, o = {}) => call(`/api/v1/watch/${encodeURIComponent(id)}/share`, o);
const setShare = async (id, body, as) => {
    const first = await share(id, { as });
    assert.strictEqual(first.status, 200, first.text);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    return await share(id, { as, method: 'PUT', json: body, headers: { 'if-match': etag } });
};
const audienceRow = async (id) => await svc.db.maybe(
    'SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['watch', 'watch', id]);

t('boot', async () => {
    web = await site({ '/page': () => ({ body: 'value 1' }) });
    svc = await boot();
});

let kim; let bo; let cy; let id;

t('a new watch is Only me; its owner sees the Share button', async () => {
    kim = svc.network.addUser('kim');
    bo = svc.network.addUser('bo');
    cy = svc.network.addUser('cy');
    const row = await svc.registry.create(watchDef({ name: 'Stub watch' }), { sub: kim.subject });
    id = row.id;
    assert.strictEqual(await audienceRow(id), null, 'no row until its owner opens it');
    const own = await svc.get(`/watches/${id}`, { as: kim });
    assert.strictEqual(own.status, 200, own.text);
    assert.deepStrictEqual(await audienceRow(id), { audience: 'private' });
    assert.ok(own.text.includes('data-ov-share-sheet') && own.text.includes('data-kind="watch"'));
    assert.ok(own.text.includes('ov-share.js'));
    const list = await svc.get('/watches', { as: kim });
    assert.strictEqual(list.status, 200, list.text);
    assert.ok(list.text.includes('Who can open a new watch'));
    assert.ok(list.text.includes('data-kind="watch"'));
    const other = await svc.get(`/watches/${id}`, { as: bo });
    assert.strictEqual(other.status, 404);
    assert.ok(!other.text.includes('Stub watch'), 'the watch is never named to somebody else');
    assert.strictEqual((await svc.get(`/api/v1/watches/${id}`, { bearer: svc.network.userToken(bo) })).status, 404);
});

t('Anyone with the link reads the page, without the watch\'s actions or secrets', async () => {
    const saved = await setShare(id, { audience: 'link' }, kim);
    assert.strictEqual(saved.status, 200, saved.text);
    assert.strictEqual(saved.json().audience, 'link');
    const guest = await svc.get(`/watches/${id}`);
    assert.strictEqual(guest.status, 200, guest.text);
    assert.ok(guest.text.includes('Stub watch'));
    assert.ok(guest.text.includes('Anyone with the link'));
    assert.ok(!guest.text.includes('data-ov-share-sheet'), 'a reader gets no Share sheet');
    assert.ok(!guest.text.includes('/pause') && !guest.text.includes('/edit'), 'a reader gets no controls');
    assert.ok(!guest.text.includes('What it did when it fired'), 'actions are not shown');
});

t('Specific people: a viewer reads on the page and through the API; a stranger gets the gate', async () => {
    const saved = await setShare(id, { audience: 'people', members: [{ name: 'bo', role: 'viewer' }] }, kim);
    assert.strictEqual(saved.status, 200, saved.text);
    const viewer = await svc.get(`/watches/${id}`, { as: bo });
    assert.strictEqual(viewer.status, 200, viewer.text);
    assert.ok(viewer.text.includes('Stub watch'));
    assert.ok(viewer.text.includes('Specific people'));
    const api = await svc.get(`/api/v1/watches/${id}`, { bearer: svc.network.userToken(bo) });
    assert.strictEqual(api.status, 200, api.text);
    assert.strictEqual(api.json().watch.id, id);
    const stranger = svc.network.addUser('di');
    const gate = await svc.get(`/watches/${id}`, { as: stranger });
    assert.strictEqual(gate.status, 404);
    assert.ok(gate.text.includes('shared with specific people'));
    assert.ok(!gate.text.includes('Stub watch'), 'the gate never shows the name');
    assert.ok(gate.text.includes('data-ov-share-gate'));
    assert.strictEqual((await svc.get(`/api/v1/watches/${id}`, { bearer: svc.network.userToken(stranger) })).status, 404);
});

t('the default applies to the next watch, and "apply to all" moves the existing one', async () => {
    const saved = await svc.get('/watches/defaults', { as: kim, form: { audience: 'link', apply_all: '1' } });
    assert.strictEqual(saved.status, 303, saved.text);
    assert.deepStrictEqual(await audienceRow(id), { audience: 'link' });
    const next = await svc.registry.create(watchDef({ name: 'Second watch' }), { sub: kim.subject });
    await svc.get(`/watches/${next.id}`, { as: kim });
    assert.deepStrictEqual(await audienceRow(next.id), { audience: 'link' });
});

t('a watch is never on a gathered page: not the sitemap, not llms.txt', async () => {
    assert.ok(!(await svc.get('/sitemap.xml')).text.includes(id));
    assert.ok(!(await svc.get('/llms.txt')).text.includes(id));
});

t('stop', async () => { await svc.stop(); await web.close(); });

t.run();
