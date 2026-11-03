'use strict';
/**
 * A webhook watch that follows a YouTube channel (agent plan A5) through YouTube's WebSub hub: the watch subscribes,
 * the hub checks the callback with a GET (only this watch's own topic is echoed), each notification is signed with
 * the secret Watch gave the hub (X-Hub-Signature) and becomes JSON for the check, a bad signature is acknowledged and
 * ignored, leases are renewed before they end, and leaving YouTube tells the hub. The hub here is a local fake.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { boot, request, userToken, suite, newUser } = require('./helpers');
const { parseYoutubeFeed, websubVerified } = require('../server/webhook-sources');

const t = suite('youtube-websub');
let svc, hub, watch;
const me = newUser();
const ME = userToken(me);
const OTHER = userToken(newUser());
const CHANNEL = 'UC' + 'AbCdEfGhIjKlMnOpQrStUv';
const TOPIC = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CHANNEL}`;
const api = (method, p, opts = {}) => request(svc.base, method, p, opts);
const runs = async (id) => await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid').all(id);
const sign = (secret, body, algo = 'sha1') => `${algo}=${crypto.createHmac(algo, secret).update(body).digest('hex')}`;
const feed = (title) => `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <link rel="hub" href="https://pubsubhubbub.appspot.com"/>
 <title>YouTube video feed</title>
 <entry>
  <id>yt:video:VIDEO_ID_01</id>
  <yt:videoId>VIDEO_ID_01</yt:videoId>
  <yt:channelId>${CHANNEL}</yt:channelId>
  <title>${title}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=VIDEO_ID_01"/>
  <author><name>Channel &amp; Friends</name><uri>https://www.youtube.com/channel/${CHANNEL}</uri></author>
  <published>2026-11-03T08:00:00+00:00</published>
  <updated>2026-11-03T08:00:05+00:00</updated>
 </entry>
</feed>`;

function startHub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { calls.push(Object.fromEntries(new URLSearchParams(body))); res.writeHead(202); res.end(); });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ calls, url: `http://127.0.0.1:${server.address().port}/subscribe`, close: () => new Promise((r) => server.close(r)) })));
}

t('boot', async () => {
    hub = await startHub();
    svc = await boot({ env: { WATCH_YOUTUBE_HUB: hub.url } });
});

t('the feed: videos with their fields, entities decoded, deleted entries; the signature in every WebSub algorithm', () => {
    const f = parseYoutubeFeed(feed('Going LIVE &lt;now&gt;'));
    assert.deepStrictEqual(f.videos, [{ id: 'VIDEO_ID_01', channel_id: CHANNEL, title: 'Going LIVE <now>', url: 'https://www.youtube.com/watch?v=VIDEO_ID_01', author: 'Channel & Friends', published: '2026-11-03T08:00:00+00:00', updated: '2026-11-03T08:00:05+00:00' }]);
    assert.strictEqual(f.channel_id, CHANNEL);
    const gone = parseYoutubeFeed(`<feed xmlns:at="http://purl.org/atompub/tombstones/1.0"><at:deleted-entry ref="yt:video:OLD_VIDEO_1" when="2026-11-03T09:00:00+00:00"><link href="https://www.youtube.com/watch?v=OLD_VIDEO_1"/></at:deleted-entry></feed>`);
    assert.deepStrictEqual([gone.videos, gone.deleted], [[], [{ id: 'OLD_VIDEO_1', when: '2026-11-03T09:00:00+00:00' }]]);
    assert.deepStrictEqual(parseYoutubeFeed('not xml at all'), { provider: 'youtube', channel_id: null, videos: [], deleted: [] });
    const body = Buffer.from('x');
    for (const algo of ['sha1', 'sha256', 'sha512']) assert.strictEqual(websubVerified('whk_s', body, { 'x-hub-signature': sign('whk_s', body, algo) }), true, algo);
    assert.strictEqual(websubVerified('whk_s', body, { 'x-hub-signature': sign('whk_t', body) }), false);
    assert.strictEqual(websubVerified('whk_s', body, {}), false);
});

t('the owner points a webhook watch at a channel: Watch subscribes at the hub with its callback, topic and a secret', async () => {
    const made = await api('POST', '/api/v1/watches', { token: ME, body: { name: 'channel goes live', source: { kind: 'webhook', endpoint: '/internal/hooks/x' }, cadence: null, extraction: { kind: 'json', value_path: 'videos.0.title' }, condition: { op: 'contains', value: 'LIVE' }, action: [{ kind: 'notification' }] } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    watch = made.body.watch;
    assert.strictEqual((await api('POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: ME, body: { provider: 'youtube', channel_id: 'not-a-channel' } })).status, 422);
    assert.strictEqual((await api('POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: OTHER, body: { provider: 'youtube', channel_id: CHANNEL } })).status, 404);
    const set = await api('POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: ME, body: { provider: 'youtube', channel_id: CHANNEL } });
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    assert.deepStrictEqual([set.body.webhook.provider, set.body.webhook.channel_id, set.body.webhook.subscribed], ['youtube', CHANNEL, true]);
    assert.ok(!('secret' in set.body.webhook), 'the hub\'s secret is never shown');
    const asked = hub.calls[hub.calls.length - 1];
    assert.deepStrictEqual([asked['hub.mode'], asked['hub.topic'], asked['hub.callback'], asked['hub.verify'], asked['hub.lease_seconds']], ['subscribe', TOPIC, `${svc.config.baseUrl}/hooks/${watch.id}`, 'async', '864000']);
    const kept = await svc.db.prepare('SELECT secret, provider, topic, lease_until FROM webhook_secrets WHERE watch_id = ?').get(watch.id);
    assert.deepStrictEqual([kept.secret, kept.provider, kept.topic, kept.lease_until], [asked['hub.secret'], 'youtube', TOPIC, null]);
    assert.match(kept.secret, /^whk_/);
});

t('the hub checks the callback: its challenge comes back only for this watch\'s topic, and the lease is kept', async () => {
    const verify = (q) => fetch(`${svc.base}/hooks/${watch.id}?${new URLSearchParams(q)}`);
    const wrong = await verify({ 'hub.mode': 'subscribe', 'hub.topic': TOPIC.replace(CHANNEL, 'UC' + 'z'.repeat(22)), 'hub.challenge': 'c1', 'hub.lease_seconds': '864000' });
    assert.strictEqual(wrong.status, 404, 'another channel is not confirmed');
    const unsub = await verify({ 'hub.mode': 'unsubscribe', 'hub.topic': TOPIC, 'hub.challenge': 'c2' });
    assert.strictEqual(unsub.status, 404, 'an unsubscribe of the topic it still follows is refused');
    const ok = await verify({ 'hub.mode': 'subscribe', 'hub.topic': TOPIC, 'hub.challenge': 'abc123XYZ', 'hub.lease_seconds': '864000' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await ok.text(), 'abc123XYZ');
    const lease = Number((await svc.db.prepare('SELECT lease_until FROM webhook_secrets WHERE watch_id = ?').get(watch.id)).lease_until);
    assert.ok(Math.abs(lease - (Date.now() + 864000 * 1000)) < 60_000, 'the lease ends ten days from now');
    assert.strictEqual((await fetch(`${svc.base}/hooks/wch_00000000000000000000000000?hub.mode=subscribe&hub.topic=x&hub.challenge=y`)).status, 404);
    const page = await svc.get(`/watches/${watch.id}`, { as: { subject: me, username: 'yt-owner' } });
    assert.ok(page.text.includes(`youtube.com/channel/${CHANNEL}`) && page.text.includes('confirmed it until'), 'the watch\'s page shows the channel and the lease');
});

t('a signed notification runs the check with the feed as JSON; a badly signed one is acknowledged and ignored', async () => {
    const secret = (await svc.db.prepare('SELECT secret FROM webhook_secrets WHERE watch_id = ?').get(watch.id)).secret;
    const before = (await runs(watch.id)).length;
    const bad = await fetch(`${svc.base}/hooks/${watch.id}`, { method: 'POST', body: feed('Going LIVE'), headers: { 'Content-Type': 'application/atom+xml', 'X-Hub-Signature': sign('whk_wrong', feed('Going LIVE')) } });
    assert.strictEqual(bad.status, 202, 'WebSub: acknowledged, so the hub does not resend it');
    assert.strictEqual((await bad.json()).ignored, true);
    assert.strictEqual((await runs(watch.id)).length, before, 'and nothing ran');
    const body = feed('Going LIVE: the big build');
    const r = await fetch(`${svc.base}/hooks/${watch.id}`, { method: 'POST', body, headers: { 'Content-Type': 'application/atom+xml', 'X-Hub-Signature': sign(secret, body) } });
    assert.strictEqual(r.status, 200);
    const out = await r.json();
    assert.strictEqual(out.triggered, true, JSON.stringify(out));
    const quiet = feed('A cooking video');
    const r2 = await fetch(`${svc.base}/hooks/${watch.id}`, { method: 'POST', body: quiet, headers: { 'Content-Type': 'application/atom+xml', 'X-Hub-Signature': sign(secret, quiet) } });
    assert.strictEqual((await r2.json()).triggered, false, 'a title without LIVE does not meet the condition');
});

t('leases ending within two days are renewed; leaving YouTube tells the hub, which may then confirm the unsubscribe', async () => {
    await svc.db.prepare('UPDATE webhook_secrets SET lease_until = ? WHERE watch_id = ?').run(Date.now() + 86400 * 1000, watch.id);
    const n = hub.calls.length;
    assert.strictEqual(await svc.webhookSources.renewLeases(), 1);
    assert.deepStrictEqual([hub.calls.length, hub.calls[n]['hub.mode'], hub.calls[n]['hub.topic']], [n + 1, 'subscribe', TOPIC]);
    assert.strictEqual(await svc.webhookSources.renewLeases(), 1, 'until the hub confirms again, it is still due');
    await svc.db.prepare('UPDATE webhook_secrets SET lease_until = ? WHERE watch_id = ?').run(Date.now() + 9 * 86400 * 1000, watch.id);
    assert.strictEqual(await svc.webhookSources.renewLeases(), 0, 'a lease with days left is left alone');
    const back = await api('POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: ME, body: {} });
    assert.strictEqual(back.status, 200);
    const last = hub.calls[hub.calls.length - 1];
    assert.deepStrictEqual([last['hub.mode'], last['hub.topic'], last['hub.secret']], ['unsubscribe', TOPIC, undefined]);
    const kept = await svc.db.prepare('SELECT provider, topic, lease_until FROM webhook_secrets WHERE watch_id = ?').get(watch.id);
    assert.deepStrictEqual([kept.provider, kept.topic, kept.lease_until], [null, null, null]);
    const confirm = await fetch(`${svc.base}/hooks/${watch.id}?${new URLSearchParams({ 'hub.mode': 'unsubscribe', 'hub.topic': TOPIC, 'hub.challenge': 'bye' })}`);
    assert.deepStrictEqual([confirm.status, await confirm.text()], [200, 'bye']);
});

t('stop', async () => { await svc.stop(); await hub.close(); });

t.run();
