'use strict';
/**
 * The parts of an email a watch reads (agent plan A3, email in): who sent it, to whom, the subject, the date, the
 * message id and the text. Enough MIME for the mail people actually send: folded headers, RFC 2047 encoded words,
 * multipart (nested, up to four deep), base64 and quoted-printable bodies, and the common charsets. The first
 * text/plain part is the text; a message with only HTML gets its HTML as plain text. Attachments are counted, not kept.
 *
 *   parseMail(raw: Buffer, { maxText }) → { from, to, subject, date, message_id, text, text_truncated, attachments }
 */

const MAX_DEPTH = 4;

function decoderFor(charset) {
    const label = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
    try { return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label); } catch { return new TextDecoder('utf-8'); }
}

/** Split a raw part into its header block and body (at the first empty line, CRLF or LF). */
function splitPart(buf) {
    const s = buf.toString('latin1');
    const m = /\r?\n\r?\n/.exec(s);
    if (!m) return { head: s, body: Buffer.alloc(0) };
    return { head: s.slice(0, m.index), body: buf.subarray(m.index + m[0].length) };
}

/** Header block → Map of lower-case name → raw value (first one wins), with folded lines unfolded. */
function headersOf(head) {
    const out = new Map();
    for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const name = line.slice(0, i).trim().toLowerCase();
        if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
    }
    return out;
}

/** RFC 2047: =?charset?B|Q?text?= words, decoded; the whitespace between two encoded words goes. */
function decodeWords(value) {
    const raw = Buffer.from(String(value || ''), 'latin1').toString('latin1');
    return raw.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, '$1')
        .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (_, charset, enc, text) => {
            try {
                const bytes = enc.toUpperCase() === 'B'
                    ? Buffer.from(text, 'base64')
                    : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
                return decoderFor(charset.split('*')[0]).decode(bytes);
            } catch { return text; }
        });
}

/** A header's text: raw 8-bit bytes read as UTF-8 when they are UTF-8 (what most senders mean), then encoded words. */
function headerText(value) {
    let s = String(value || '');
    if (/[\x80-\xff]/.test(s)) {
        const u = Buffer.from(s, 'latin1').toString('utf8');
        if (!u.includes('\ufffd')) s = u;
    }
    return decodeWords(s);
}

/** `type/subtype; a=b; c="d"` → { type, params } */
function contentType(value) {
    const [type, ...rest] = String(value || 'text/plain').split(';');
    const params = {};
    for (const p of rest) {
        const i = p.indexOf('=');
        if (i > 0) params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
    return { type: type.trim().toLowerCase() || 'text/plain', params };
}

function decodeBody(body, encoding) {
    const enc = String(encoding || '').trim().toLowerCase();
    if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    if (enc === 'quoted-printable') {
        const s = body.toString('latin1').replace(/=\r?\n/g, '');
        return Buffer.from(s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    }
    return body;
}

/** HTML as plain text: scripts and styles dropped, breaks kept, tags gone, the common entities read. */
function htmlText(html) {
    return String(html)
        .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d{1,6});/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
        .replace(/&amp;/gi, '&')
        .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Walk a part (and its children): the first text/plain, else the first text/html, and how many attachments. */
function walk(buf, depth, found) {
    const { head, body } = splitPart(buf);
    const h = headersOf(head);
    const ct = contentType(h.get('content-type'));
    const disposition = String(h.get('content-disposition') || '').toLowerCase();
    if (ct.type.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
        const marker = `--${ct.params.boundary}`;
        const s = body.toString('latin1');
        const pieces = s.split(marker).slice(1);
        for (const piece of pieces) {
            if (piece.startsWith('--')) break;   // the closing boundary
            walk(Buffer.from(piece.replace(/^\r?\n/, ''), 'latin1'), depth + 1, found);
        }
        return;
    }
    if (disposition.startsWith('attachment') || (!ct.type.startsWith('text/') && !ct.type.startsWith('multipart/'))) { found.attachments++; return; }
    if (ct.type === 'text/plain' && found.plain == null) found.plain = decoderFor(ct.params.charset).decode(decodeBody(body, h.get('content-transfer-encoding')));
    else if (ct.type === 'text/html' && found.html == null) found.html = decoderFor(ct.params.charset).decode(decodeBody(body, h.get('content-transfer-encoding')));
}

/** "Ann <ann@x.org>" or "ann@x.org" → "ann@x.org" (lower-cased domain kept as written). */
function addressOf(value) {
    const s = headerText(value);
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s) || /([^\s<>",;]+@[^\s<>",;]+)/.exec(s);
    return m ? m[1] : '';
}

function parseMail(raw, { maxText = 20000 } = {}) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
    const { head } = splitPart(buf);
    const h = headersOf(head);
    const found = { plain: null, html: null, attachments: 0 };
    walk(buf, 0, found);
    let text = found.plain != null ? found.plain : (found.html != null ? htmlText(found.html) : '');
    text = text.replace(/\r\n/g, '\n').trim();
    const truncated = text.length > maxText;
    if (truncated) text = text.slice(0, maxText);
    const date = h.get('date') ? new Date(h.get('date')) : null;
    return {
        from: addressOf(h.get('from')),
        from_name: headerText(h.get('from') || '').replace(/<[^>]*>/, '').trim().replace(/^"|"$/g, '').trim().slice(0, 200),
        to: addressOf(h.get('to')),
        subject: headerText(h.get('subject') || '').slice(0, 500),
        date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
        message_id: String(h.get('message-id') || '').replace(/^<|>$/g, '').slice(0, 300),
        text,
        text_truncated: truncated,
        attachments: found.attachments,
    };
}

module.exports = { parseMail, htmlText, decodeWords };
