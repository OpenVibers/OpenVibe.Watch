/**
 * OpenVibe.Watch email in (agent plan A3): the Cloudflare Email Worker behind openvibe.watch's catch-all rule.
 *
 * Email Routing receives every message for the domain (its MX), checks SPF, DKIM and DMARC, and hands it here. The
 * Worker posts it to Watch, signed, and refuses the mail when Watch knows no watch at that address, so the sender gets
 * a bounce instead of silence.
 *
 *   POST ${WATCH_URL}/hooks/email
 *   X-OpenVibe-Mail-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(INGRESS_SECRET, t + "." + body)>
 *   { "to", "from", "raw": <the message, base64, at most 180 KB>, "truncated": <bool>, "size": <bytes> }
 *
 * Bindings: WATCH_URL (plain text, https://openvibe.watch) and INGRESS_SECRET (secret; Watch's
 * WATCH_MAIL_INGRESS_SECRET). No dependencies. Deployed by deploy/mail-worker.sh.
 */

const MAX_RAW = 180 * 1024;   // base64 makes it 4/3 bigger, and Watch takes 256 KB a delivery

async function readRaw(stream, limit) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    let truncated = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > limit) {
            chunks.push(value.subarray(0, limit - size));
            size = limit;
            truncated = true;
            await reader.cancel();
            break;
        }
        chunks.push(value);
        size += value.length;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return { bytes: out, truncated };
}

function base64(bytes) {
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return btoa(s);
}

async function sign(secret, data) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
    return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
    async email(message, env) {
        const { bytes, truncated } = await readRaw(message.raw, MAX_RAW);
        const body = JSON.stringify({ to: message.to, from: message.from, raw: base64(bytes), truncated, size: message.rawSize });
        const url = `${String(env.WATCH_URL || 'https://openvibe.watch').replace(/\/+$/, '')}/hooks/email`;
        const post = async () => {
            const t = String(Math.floor(Date.now() / 1000));
            const signature = `t=${t},v1=${await sign(env.INGRESS_SECRET, `${t}.${body}`)}`;
            return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Mail-Signature': signature, 'User-Agent': 'OpenVibe.Watch mail-worker' }, body });
        };
        let res;
        try {
            res = await post();
            // The watch's previous check is still running: once more, a moment later.
            if (res.status === 503) { await new Promise((r) => setTimeout(r, 1500)); res = await post(); }
        } catch {
            // Watch unreachable: Email Routing has no "try later", so the mail is refused with a reason the sender sees.
            message.setReject('OpenVibe.Watch is not answering right now; please send it again later.');
            return;
        }
        if (res.status === 404) message.setReject('No watch has this address.');
        else if (res.status === 409) message.setReject('This watch is paused.');
        else if (res.status === 413) message.setReject('The message is too large.');
        // 200, 429 (over the hour's budget), 503 twice (busy), 5xx: taken; Watch logged what happened.
    },
};
