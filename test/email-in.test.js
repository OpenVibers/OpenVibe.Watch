'use strict';
/**
 * Email in (agent plan A3): a webhook watch can have an email address of its own. Cloudflare Email Routing hands each
 * message for openvibe.watch to the mail Worker (edge/mail-worker.mjs), which posts it to POST /hooks/email signed
 * with WATCH_MAIL_INGRESS_SECRET; the address finds the watch, the message is read (server/mail-parse.js) and the
 * check runs on { from, subject, text, … }. An unknown address is 404 (the Worker bounces the mail); a paused watch 409;
 * a bad or old signature 401. Without the ingress secret there is no email in.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { boot, request, userToken, suite, newUser } = require('./helpers');
const { parseMail, htmlText } = require('../server/mail-parse');
const { mailSigned, MAIL_LOCAL_RE, newMailLocal } = require('../server/webhook-sources');

const t = suite('email-in');
const INGRESS = 'mail-ingress-test-secret-0123456789';
let svc;
let bare;
const me = newUser();
const ME = userToken(me);
const OTHER = userToken(newUser());
const api = (base, method, p, opts = {}) => request(base, method, p, opts);
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
const runs = async (id) => await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid').all(id);
const def = (name) => ({ name, source: { kind: 'webhook', endpoint: '/internal/hooks/x' }, cadence: null, extraction: { kind: 'json', value_path: 'subject' }, condition: { op: 'contains', value: 'invoice' }, action: [{ kind: 'notification' }] });

const CRLF = (s) => s.replace(/\r?\n/g, '\r\n');
const mailRaw = (to, subject = 'Your invoice #42', text = 'Total: 12.00 EUR') => CRLF(`From: "Ann Example" <ann@example.org>
To: ${to}
Subject: ${subject}
Date: Mon, 03 Nov 2026 05:00:00 +0000
Message-ID: <abc123@example.org>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

${text}
`);
const deliver = (base, to, raw, { secret = INGRESS, at = String(nowSec()), from = 'ann@example.org' } = {}) => {
    const body = JSON.stringify({ to, from, raw: Buffer.from(raw).toString('base64'), truncated: false, size: raw.length });
    return fetch(`${base}/hooks/email`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Mail-Signature': `t=${at},v1=${hmac(secret, `${at}.${body}`)}` } });
};
let watch;
let address;

t('the reader: headers, encoded words, multipart, quoted-printable, base64, HTML-only, attachments', () => {
    const plain = parseMail(Buffer.from(mailRaw('in-x@openvibe.watch')));
    assert.strictEqual(plain.from, 'ann@example.org');
    assert.strictEqual(plain.from_name, 'Ann Example');
    assert.strictEqual(plain.subject, 'Your invoice #42');
    assert.strictEqual(plain.date, '2026-11-03T05:00:00.000Z');
    assert.strictEqual(plain.message_id, 'abc123@example.org');
    assert.strictEqual(plain.text, 'Total: 12.00 EUR');
    const multi = parseMail(Buffer.from(CRLF(`From: =?UTF-8?B?w4Ruw6k=?= <ane@example.org>
To: in-x@openvibe.watch
Subject: =?utf-8?Q?Caf=C3=A9_order?= =?utf-8?Q?_shipped?=
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Caf=C3=A9 order #7 has shipped. A long line that was =
wrapped.
--inner
Content-Type: text/html; charset=utf-8

<p>Café order</p>
--inner--
--outer
Content-Type: application/pdf; name="label.pdf"
Content-Disposition: attachment; filename="label.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--outer--
`)));
    assert.strictEqual(multi.from_name, 'Äné');
    assert.strictEqual(multi.subject, 'Café order shipped', 'adjacent encoded words join');
    assert.strictEqual(multi.text, 'Café order #7 has shipped. A long line that was wrapped.');
    assert.strictEqual(multi.attachments, 1);
    const html = parseMail(Buffer.from(CRLF(`From: shop@example.org
Subject: Receipt
Content-Type: text/html; charset=iso-8859-1
Content-Transfer-Encoding: base64

${Buffer.from('<html><head><style>p{}</style></head><body><p>Thanks!</p><p>Total &amp; tax: 5&nbsp;\xa3</p></body></html>', 'latin1').toString('base64')}
`)));
    assert.strictEqual(html.text, 'Thanks!\nTotal & tax: 5 £');
    assert.strictEqual(htmlText('<script>x()</script>a<br>b'), 'a\nb');
    const long = parseMail(Buffer.from(mailRaw('x@y', 's', 'z'.repeat(30000))));
    assert.strictEqual(long.text.length, 20000);
    assert.strictEqual(long.text_truncated, true);
    assert.deepStrictEqual(parseMail(Buffer.from('garbage')).subject, '');
});

t('the signature: t and v1 over "<t>.<body>", within five minutes', () => {
    const body = Buffer.from('{"to":"x"}');
    const ts = String(nowSec());
    assert.strictEqual(mailSigned(INGRESS, body, { 'x-openvibe-mail-signature': `t=${ts},v1=${hmac(INGRESS, `${ts}.${body}`)}` }), true);
    assert.strictEqual(mailSigned(INGRESS, body, { 'x-openvibe-mail-signature': `t=${ts},v1=${hmac('other', `${ts}.${body}`)}` }), false);
    const old = String(nowSec() - 400);
    assert.strictEqual(mailSigned(INGRESS, body, { 'x-openvibe-mail-signature': `t=${old},v1=${hmac(INGRESS, `${old}.${body}`)}` }), false);
    assert.strictEqual(mailSigned(null, body, {}), false);
    assert.match(newMailLocal(), MAIL_LOCAL_RE);
    assert.notStrictEqual(newMailLocal(), newMailLocal());
});

t('boot', async () => {
    svc = await boot({ env: { WATCH_MAIL_INGRESS_SECRET: INGRESS } });
    bare = await boot();
});

t('without the ingress secret there is no email in', async () => {
    const made = await api(bare.base, 'POST', '/api/v1/watches', { token: ME, body: def('no mail') });
    assert.strictEqual(made.status, 201);
    const r = await api(bare.base, 'POST', `/api/v1/watches/${made.body.watch.id}/webhook-secret`, { token: ME, body: { provider: 'email' } });
    assert.strictEqual(r.status, 422);
    assert.match(r.body.detail, /email in is not set up/);
    assert.strictEqual((await deliver(bare.base, 'in-0123456789abcdefghjkmnpqrs@openvibe.watch', mailRaw('x'))).status, 404);
});

t('the owner gives a webhook watch an address; it is shown on the watch\'s page; another person cannot', async () => {
    const made = await api(svc.base, 'POST', '/api/v1/watches', { token: ME, body: def('invoices') });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    watch = made.body.watch;
    assert.strictEqual((await api(svc.base, 'POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: OTHER, body: { provider: 'email' } })).status, 404);
    const r = await api(svc.base, 'POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: ME, body: { provider: 'email' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    address = r.body.webhook.address;
    assert.match(address, /^in-[0-9a-hjkmnp-tv-z]{26}@openvibe\.watch$/);
    assert.strictEqual(r.body.webhook.provider, 'email');
    assert.strictEqual(await svc.webhookSources.addressOf(watch.id), address);
    assert.strictEqual(await svc.webhookSources.providerOf(watch.id), 'email');
});

t('mail to the address runs the check on its subject; the envelope sender is the "from"', async () => {
    const res = await deliver(svc.base, address.toUpperCase(), mailRaw(address), { from: 'bounces+ann@example.org' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { watch_id: watch.id, state: 'condition_met', triggered: true });
    const obs = await svc.db.prepare('SELECT * FROM observations WHERE watch_id = ? ORDER BY rid DESC').get(watch.id);
    assert.ok(obs, 'an observation was recorded');
    assert.match(JSON.stringify(obs), /Your invoice #42/);
    const quiet = await deliver(svc.base, address, mailRaw(address, 'Lunch on Friday?'));
    assert.strictEqual((await quiet.json()).triggered, false, 'a subject without "invoice" does not meet the condition');
    assert.strictEqual((await runs(watch.id)).length, 2);
});

t('refused: a bad or old signature (401), an unknown address or domain (404), a paused watch (409)', async () => {
    assert.strictEqual((await deliver(svc.base, address, mailRaw(address), { secret: 'wrong' })).status, 401);
    assert.strictEqual((await deliver(svc.base, address, mailRaw(address), { at: String(nowSec() - 600) })).status, 401);
    assert.strictEqual((await deliver(svc.base, 'in-0123456789abcdefghjkmnpqrs@openvibe.watch', mailRaw('x'))).status, 404);
    assert.strictEqual((await deliver(svc.base, address.replace('@openvibe.watch', '@elsewhere.example'), mailRaw('x'))).status, 404);
    assert.strictEqual((await deliver(svc.base, 'postmaster@openvibe.watch', mailRaw('x'))).status, 404);
    assert.strictEqual((await deliver(svc.base, watch.id + '@openvibe.watch', mailRaw('x'))).status, 404, 'a watch id is not an address');
    // The webhook address no longer takes Watch's own secret: the email address replaced it.
    const hook = await fetch(`${svc.base}/hooks/${watch.id}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer whk_x' } });
    assert.strictEqual(hook.status, 401);
    await svc.db.prepare("UPDATE watches SET status = 'paused' WHERE id = ?").run(watch.id);
    assert.strictEqual((await deliver(svc.base, address, mailRaw(address))).status, 409);
    await svc.db.prepare("UPDATE watches SET status = 'active' WHERE id = ?").run(watch.id);
});

t('a new address retires the old one; a webhook secret replaces the address', async () => {
    const again = await api(svc.base, 'POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: ME, body: { provider: 'email' } });
    const next = again.body.webhook.address;
    assert.notStrictEqual(next, address);
    assert.strictEqual((await deliver(svc.base, address, mailRaw(address))).status, 404, 'the old address is gone');
    assert.strictEqual((await deliver(svc.base, next, mailRaw(next))).status, 200);
    const own = await api(svc.base, 'POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: ME });
    assert.match(own.body.webhook.secret, /^whk_/);
    assert.strictEqual(await svc.webhookSources.addressOf(watch.id), null);
    assert.strictEqual((await deliver(svc.base, next, mailRaw(next))).status, 404);
});

t('the page offers an address only where email in is set up, and shows it on the watch', async () => {
    const pages = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'pages.js'), 'utf8');
    assert.match(pages, /\$\{mailIn \? html`\n<details class="hook-provider"><summary>Wake it by email\?<\/summary>/);
    assert.match(pages, /<dt>Email address<\/dt><dd><code class="copyable">\$\{hookAddress\}<\/code>/);
    assert.match(pages, /hook\.provider === 'email' \? html`<h1>Your watch has an email address<\/h1>/);
});

t('the Worker posts what Email Routing hands it, signed, and bounces an unknown address', async () => {
    const mod = await import(path.join(__dirname, '..', 'edge', 'mail-worker.mjs'));
    const fresh = await api(svc.base, 'POST', `/api/v1/watches/${watch.id}/webhook-secret`, { token: ME, body: { provider: 'email' } });
    const to = fresh.body.webhook.address;
    const msg = (rcpt) => {
        const raw = Buffer.from(mailRaw(rcpt));
        return { to: rcpt, from: 'ann@example.org', rawSize: raw.length, raw: new Blob([raw]).stream(), rejected: null, setReject(r) { this.rejected = r; } };
    };
    const env = { WATCH_URL: svc.base, INGRESS_SECRET: INGRESS };
    const before = (await runs(watch.id)).length;
    const ok = msg(to);
    await mod.default.email(ok, env);
    assert.strictEqual(ok.rejected, null, 'taken');
    assert.strictEqual((await runs(watch.id)).length, before + 1, 'the check ran');
    const unknown = msg('in-0123456789abcdefghjkmnpqrs@openvibe.watch');
    await mod.default.email(unknown, env);
    assert.strictEqual(unknown.rejected, 'No watch has this address.');
    const down = msg(to);
    await mod.default.email(down, { WATCH_URL: 'http://127.0.0.1:1', INGRESS_SECRET: INGRESS });
    assert.match(down.rejected, /not answering/);
});

t('shutdown', async () => { await svc.stop(); await bare.stop(); });

t.run();
