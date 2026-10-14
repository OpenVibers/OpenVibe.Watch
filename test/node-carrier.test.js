'use strict';
/**
 * The node carrier (plan T18 step 7, contracts 0.167.0): a watch checks something on its owner's own network from
 * their machine, through OpenVibe.Bot's probe. The source is checked when it is saved (a dev_ machine, an
 * http(s)/tcp target, nothing else); the probe goes to Bot as the owner; an http answer's body is extracted like a page,
 * a tcp answer's { open, ms } is a JSON document; Bot's refusal and the machine's are recorded failures; an agent-owned
 * watch is never probed.
 */
const assert = require('assert');
const { boot, suite, newUser } = require('./helpers');

const t = suite('node-carrier');
const MACHINE = 'dev_01M4XTHNFFAWWZQHB4XTMSN1YB';
const PERSON = { sub: newUser() };
const calls = [];
let reply = null;
const machines = {
    probe: async (args) => {
        calls.push(args);
        if (reply instanceof Error) throw reply;
        return reply;
    },
};
let svc;

const create = async (source, extraction = { kind: 'json', value_path: 'up' }, owner = PERSON) => (await svc.registry.create({
    name: 'nas', source, cadence: { every_sec: 900 }, extraction, condition: { op: 'eq', value: 'never-matches' }, action: [{ kind: 'notification' }],
}, owner)).id;
const lastRun = async (id) => (await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid DESC').get(id));
const lastValue = async (id) => {
    const o = await svc.db.prepare('SELECT * FROM observations WHERE watch_id = ? ORDER BY rid DESC').get(id);
    return o ? (typeof o.value === 'string' ? JSON.parse(o.value) : o.value) : undefined;
};

t('boot with a stand-in for Bot\'s machine API', async () => {
    svc = await boot({ machines });
});

t('the source is checked when it is saved', async () => {
    const bad = async (source, re) => {
        await assert.rejects(create(source), (e) => re.test(e.message));
    };
    await bad({ kind: 'node', node_id: 'nod_01J0000000000000000000000', probe: { target: 'http://192.168.1.20/' } }, /node_id/);
    await bad({ kind: 'node', node_id: MACHINE, probe: { target: 'ftp://192.168.1.20/' } }, /target/);
    await bad({ kind: 'node', node_id: MACHINE, probe: { target: 'http://192.168.1.20/', method: 'POST' } }, /method is not known/);
    await bad({ kind: 'node', node_id: MACHINE, probe: { target: 'tcp://192.168.1.20:22', timeout_s: 99 } }, /timeout_s/);
});

t('an http probe goes to Bot as the owner and its body is extracted like a page', async () => {
    reply = { result: 'ack', data: { status: 200, content_type: 'application/json', etag: '"v1"', body: '{"up": true}', ms: 4 } };
    const id = await create({ kind: 'node', node_id: MACHINE, probe: { target: 'http://192.168.1.20/status', timeout_s: 5 } });
    await svc.check.run(id, { trigger: 'manual' });
    assert.deepStrictEqual(calls.at(-1), { subjectId: PERSON.sub, machineId: MACHINE, probe: { target: 'http://192.168.1.20/status', timeout_s: 5 } });
    const run = await lastRun(id);
    assert.deepStrictEqual([run.carrier, run.http_status], ['node', 200]);
    assert.strictEqual(await lastValue(id), true);
    reply = { result: 'ack', data: { status: 503, body: 'busy', ms: 3 } };
    await svc.check.run(id, { trigger: 'manual' });
    const failed = await lastRun(id);
    assert.deepStrictEqual([failed.state, failed.error_code], ['http_error', 'http_503']);
});

t('a tcp probe states { open, ms } as a JSON document', async () => {
    reply = { result: 'ack', data: { open: false, ms: 2001, error: 'timed out' } };
    const id = await create({ kind: 'node', node_id: MACHINE, probe: { target: 'tcp://192.168.1.5:22' } }, { kind: 'json', value_path: 'open' });
    await svc.check.run(id, { trigger: 'manual' });
    assert.strictEqual((await lastRun(id)).state !== 'http_error', true);
    assert.strictEqual(await lastValue(id), false);
});

t('Bot\'s refusal and the machine\'s are recorded failures with their reasons', async () => {
    const id = await create({ kind: 'node', node_id: MACHINE, probe: { target: 'http://192.168.1.20/' } });
    reply = Object.assign(new Error('the owner has not let their watches check things from this computer'), { code: 'bot.agent_not_allowed', status: 403 });
    await svc.check.run(id, { trigger: 'manual' });
    let run = await lastRun(id);
    assert.deepStrictEqual([run.state, run.error_code], ['http_error', 'bot.agent_not_allowed']);
    assert.match(run.detail, /watches/);
    reply = { result: 'nack', reason: 'a probe reaches this machine\'s own network only' };
    await svc.check.run(id, { trigger: 'manual' });
    run = await lastRun(id);
    assert.deepStrictEqual([run.state, run.error_code], ['http_error', 'node_nack']);
    reply = Object.assign(new Error('the machine is offline'), { code: 'bot.device_offline', status: 409 });
    await svc.check.run(id, { trigger: 'manual' });
    assert.strictEqual((await lastRun(id)).state, 'timeout');
});

t('a watch owned by an agent is never probed', async () => {
    const before = calls.length;
    const id = await create({ kind: 'node', node_id: MACHINE, probe: { target: 'http://192.168.1.20/' } }, undefined, { sub: 'agt_01M4XTHNFFAWWZQHB4XTMSN1YB' });
    await svc.check.run(id, { trigger: 'manual' });
    const run = await lastRun(id);
    assert.deepStrictEqual([run.state, run.error_code], ['disabled', 'node_person_only']);
    assert.strictEqual(calls.length, before);
});

t('done', async () => { await svc.stop(); });

t.run();
