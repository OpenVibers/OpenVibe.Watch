'use strict';
/**
 * Outbound address policy (roadmap anti-goal 13: no fetcher may reach internal addresses).
 *
 * A URL is fetchable only when it is http(s), on an allowed port, and every address its host
 * resolves to is public unicast. The check runs at connect time through the socket's `lookup`
 * (so a DNS answer cannot change between check and connect) and up front for IP literals (which
 * never go through lookup). SOURCES_ALLOW_PRIVATE_HOSTS lists exact hostnames/IPs exempted —
 * for tests and deliberate on-host sources only.
 */
const dns = require('dns');
const net = require('net');
const sharedEgress = require('openvibe-shared/egress');

const blocked = new net.BlockList();
for (const [addr, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
    ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['2001::', 32], ['fc00::', 7],
    ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, prefix, 'ipv6');

class GuardError extends Error {
    constructor(code, detail) { super(detail); this.code = code; }
}

/** IPv4 embedded in IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) or 6to4 (2002::/16). */
function embeddedV4(ip) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return mapped[1];
    const full = expandV6(lower);
    if (!full) return null;
    const hex = (i) => parseInt(full[i], 16);
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (full.slice(0, 5).every(h => h === '0000') && full[5] === 'ffff') return v4(hex(6), hex(7));
    if (full[0] === '0064' && full[1] === 'ff9b' && full.slice(2, 6).every(h => h === '0000')) return v4(hex(6), hex(7));
    if (full[0] === '2002') return v4(hex(1), hex(2));
    return null;
}

function expandV6(ip) {
    if (!net.isIPv6(ip)) return null;
    let s = ip;
    const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (v4tail) {
        const p = v4tail[1].split('.').map(Number);
        s = s.slice(0, -v4tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
    }
    const [head, tail] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
    const parts = [...h, ...fill, ...t];
    if (parts.length !== 8) return null;
    return parts.map(x => x.padStart(4, '0'));
}

/**
 * Is this IP address public unicast? It must pass this file's list AND the platform's rule
 * (openvibe-shared/egress, which Live, Events, Chat and Tools use): the list here had drifted and
 * let IPv4-compatible IPv6 (::127.0.0.1, ::7f00:1) and the local-use NAT64 prefix (64:ff9b:1::/48)
 * through. test/security-ssrf.test.js holds the two rules equal.
 */
function isPublicAddress(ip) {
    const family = net.isIP(ip);
    let ok = false;
    if (family === 4) ok = !blocked.check(ip, 'ipv4');
    else if (family === 6) {
        const v4 = embeddedV4(ip);
        ok = v4 ? !blocked.check(v4, 'ipv4') : !blocked.check(ip, 'ipv6');
    }
    return ok && sharedEgress.isPublicAddress(ip);
}

function createGuard({ allowPrivateHosts = [], allowedPorts = [80, 443], lookupImpl = dns.lookup } = {}) {
    const exempt = new Set(allowPrivateHosts.map(h => h.toLowerCase().replace(/^\[|\]$/g, '')));

    /** Synchronous URL checks: scheme, credentials, port, IP literal. Throws GuardError. */
    function checkUrl(input) {
        let url;
        try { url = new URL(input); } catch { throw new GuardError('bad_url', 'not a URL'); }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GuardError('bad_url', `scheme ${url.protocol} is not fetched`);
        if (url.username || url.password) throw new GuardError('bad_url', 'credentials in URLs are not allowed');
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
        if (!exempt.has(host) && !allowedPorts.includes(port)) throw new GuardError('port_refused', `port ${port} is not allowed`);
        if (net.isIP(host) && !exempt.has(host) && !isPublicAddress(host)) throw new GuardError('address_refused', `${host} is not a public address`);
        return url;
    }

    /** dns.lookup replacement for http(s).request: refuses non-public answers at connect time. */
    function lookup(hostname, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
        const host = String(hostname).toLowerCase();
        lookupImpl(hostname, { ...opts, all: true }, (err, addresses) => {
            if (err) return callback(err);
            const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
            if (!list.length) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }));
            if (!exempt.has(host)) {
                const bad = list.find(a => !isPublicAddress(a.address));
                if (bad) {
                    const e = new GuardError('address_refused', `${hostname} resolves to a non-public address`);
                    e.errno = 'EADDRREFUSED';
                    return callback(e);
                }
            }
            if (opts.all) return callback(null, list);
            return callback(null, list[0].address, list[0].family);
        });
    }

    return { checkUrl, lookup, isPublicAddress };
}

module.exports = { createGuard, isPublicAddress, GuardError, embeddedV4 };
