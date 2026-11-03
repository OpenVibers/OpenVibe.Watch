#!/usr/bin/env node
'use strict';
/**
 * Deploy Watch's email in (agent plan A3) on Cloudflare: the mail Worker (edge/mail-worker.mjs) with its bindings,
 * Email Routing on the zone, and the catch-all rule that hands every message to the Worker.
 *
 *   ssh host "sudo sed -n 's/^WATCH_MAIL_INGRESS_SECRET=//p' /etc/openvibe/watch.env" \
 *     | node deploy/mail-worker.js --secret-stdin [--zone openvibe.watch] [--watch-url https://openvibe.watch]
 *
 * The Cloudflare token comes from CF_API_TOKEN_FILE (default ~/.config/cloudflare-token-watch-mail): Workers Scripts
 * Write and Account Settings Read on the account; Email Routing Rules Write, DNS Write, Zone Settings Write and Zone
 * Read on the zone. The ingress secret is read from stdin (Watch's WATCH_MAIL_INGRESS_SECRET) and never printed.
 * Without --secret-stdin the Worker's code is updated and its secret left as it is. Prints only what it did.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const ZONE = opt('zone', 'openvibe.watch');
const WATCH_URL = opt('watch-url', 'https://openvibe.watch');
const SCRIPT = opt('name', 'openvibe-watch-mail');
const TOKEN = fs.readFileSync(process.env.CF_API_TOKEN_FILE || path.join(os.homedir(), '.config', 'cloudflare-token-watch-mail'), 'utf8').trim();
const API = 'https://api.cloudflare.com/client/v4';

async function cf(method, p, body, { form = false } = {}) {
    const res = await fetch(`${API}${p}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? (form ? body : JSON.stringify(body)) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!out.success) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(out.errors || out).slice(0, 400)}`);
    return out.result;
}

async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
}

(async () => {
    const secret = args.includes('--secret-stdin') ? await readStdin() : null;
    if (secret !== null && secret.length < 32) throw new Error('the ingress secret is missing or shorter than 32 characters');

    const zone = (await cf('GET', `/zones?name=${encodeURIComponent(ZONE)}`))[0];
    if (!zone) throw new Error(`no zone ${ZONE}`);
    const account = zone.account.id;

    // 1. The Worker: its code and WATCH_URL; the secret binding is kept unless a new one is given.
    const code = fs.readFileSync(path.join(__dirname, '..', 'edge', 'mail-worker.mjs'));
    const bindings = [{ type: 'plain_text', name: 'WATCH_URL', text: WATCH_URL }];
    if (secret) bindings.push({ type: 'secret_text', name: 'INGRESS_SECRET', text: secret });
    else bindings.push({ type: 'inherit', name: 'INGRESS_SECRET' });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ main_module: 'mail-worker.mjs', compatibility_date: '2026-10-01', bindings })], { type: 'application/json' }));
    form.append('mail-worker.mjs', new Blob([code], { type: 'application/javascript+module' }), 'mail-worker.mjs');
    await cf('PUT', `/accounts/${account}/workers/scripts/${SCRIPT}`, form, { form: true });
    console.log(`worker ${SCRIPT}: uploaded (${code.length} bytes)${secret ? ', ingress secret set' : ', ingress secret kept'}`);

    // 2. Email Routing on the zone (its MX and SPF records), once.
    const routing = await cf('GET', `/zones/${zone.id}/email/routing`);
    if (!routing.enabled) {
        await cf('POST', `/zones/${zone.id}/email/routing/enable`, {});
        console.log(`email routing: enabled on ${ZONE}`);
    } else console.log(`email routing: already on (${routing.status || 'ready'})`);

    // 3. Every address of the zone goes to the Worker; Watch says which ones are a watch's.
    await cf('PUT', `/zones/${zone.id}/email/routing/rules/catch_all`, {
        name: 'OpenVibe.Watch email in', enabled: true,
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [SCRIPT] }],
    });
    console.log(`catch-all: every address at ${ZONE} → worker ${SCRIPT}`);
    const dns = await cf('GET', `/zones/${zone.id}/email/routing/dns`).catch(() => null);
    if (Array.isArray(dns)) console.log(`email routing records: ${dns.map((r) => `${r.type} ${r.name}`).join(', ')}`);
})().catch((err) => { console.error(`mail-worker deploy failed: ${err.message}`); process.exit(1); });
