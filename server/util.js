'use strict';
/**
 * Helpers the carriers and the extractor share, modelled on OpenVibe.Sources/server/adapters/util.js:
 * a fetched body becomes a value and nothing else. A field the source did not state stays null —
 * never guessed, defaulted or invented.
 */
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

class ParseError extends Error {
    constructor(detail) { super(detail); this.code = 'parse_error'; }
}

/** Body hash: SHA-256 hex, over the bytes as received. */
function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Stable JSON of a value: object keys sorted, so equal values have one hash. */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

/** SHA-256 hex of the canonical value (observation.value_hash). */
function hashValue(value) {
    return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

/** Decode a body: charset from Content-Type, else the XML declaration / meta tag, else UTF-8. */
function decodeBody(buf, contentType) {
    let charset = /charset=["']?([\w-]+)/i.exec(String(contentType || ''))?.[1];
    if (!charset) {
        const head = buf.subarray(0, 1024).toString('latin1');
        charset = /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
    }
    let label = String(charset || 'utf-8').toLowerCase();
    if (label === 'iso-8859-1' || label === 'latin1') label = 'windows-1252';
    try {
        return new TextDecoder(label, { fatal: false }).decode(buf).replace(/^﻿/, '');
    } catch {
        return new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
    }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** HTML or text → plain text, whitespace collapsed, capped. Scripts and styles are dropped whole. */
function toText(value, max = 1000) {
    if (value == null) return null;
    // Bounded input: only a short value survives anyway, and the regexes below stay linear.
    let s = String(typeof value === 'object' ? (value['#text'] ?? value.__cdata ?? '') : value).slice(0, 100000);
    s = decodeEntities(String(s))
        .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, ' ')
        .replace(/<[^>]*>/g, ' ');
    s = decodeEntities(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** RFC 822 / RFC 3339 / ISO dates → ISO string; anything unparseable → null (never "now"). */
function toIsoDate(value) {
    if (value == null) return null;
    const s = decodeEntities(String(typeof value === 'object' ? value['#text'] ?? '' : value)).trim();
    if (!s || s.length > 64) return null;
    // Refuse bare numbers: ambiguous epoch units are guesses.
    if (/^\d+$/.test(s)) return null;
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    const year = new Date(t).getUTCFullYear();
    if (year < 1990 || year > 2200) return null;
    return new Date(t).toISOString();
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok)$/i;

/** http(s) URL → canonical form (lowercase host, no fragment, no tracking params, no default port); else null. */
function canonicalUrl(value, base) {
    if (value == null) return null;
    const raw = decodeEntities(String(value)).trim();
    if (!raw || raw.length > 2048) return null;
    let url;
    try { url = base ? new URL(raw, base) : new URL(raw); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
    return url.toString();
}

/** A plain identifier string (guid, id…) or null. */
function toId(value, max = 512) {
    if (value == null) return null;
    const s = decodeEntities(String(typeof value === 'object' ? value['#text'] ?? '' : value)).trim();
    return s && s.length <= max ? s : null;
}

function asArray(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

/**
 * Parse XML safely: a DOCTYPE with entity declarations is refused (entity expansion is how XML
 * bombs work) and the parser expands no entities at all — the helpers above decode the predefined
 * and numeric ones per value.
 */
function parseXml(text) {
    if (/<!DOCTYPE[^>]*\[/i.test(text) || /<!ENTITY/i.test(text)) throw new ParseError('XML with entity declarations is refused');
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: false,
        processEntities: false,
        trimValues: true,
        parseTagValue: false,
        parseAttributeValue: false,
        cdataPropName: '__cdata',
    });
    try {
        return parser.parse(text, true);
    } catch (err) {
        throw new ParseError(`not well-formed XML: ${String(err.message).split('\n')[0].slice(0, 200)}`);
    }
}

/** First non-empty text value of the given keys on an XML node. */
function pick(node, ...keys) {
    for (const k of keys) {
        const v = node && node[k];
        if (v == null) continue;
        const first = Array.isArray(v) ? v[0] : v;
        if (first == null) continue;
        if (typeof first === 'object') {
            const t = first['#text'] ?? first.__cdata;
            if (t != null && String(t).trim()) return t;
            if (first['@_href']) return first;
            continue;
        }
        if (String(first).trim()) return first;
    }
    return null;
}

module.exports = {
    ParseError, sha256, canonicalJson, hashValue, decodeBody, decodeEntities, toText, toIsoDate, canonicalUrl,
    toId, asArray, parseXml, pick,
};
