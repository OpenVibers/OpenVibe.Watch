'use strict';
// openvibe-sdk/site (0.174.0) is the one implementation every site shares (the consolidation of 2026-11-16).
// The Network's signing key; this file stays for one release so nothing that requires it changes.
// A hand merge: Watch's config names the JWKS address itself (OV_NETWORK_JWKS_URL, config.jwksUrl) where the SDK takes
// the Network's base, and its store had stop(); both are kept here.
const site = require('openvibe-sdk/site');

const JWKS = /\/api\/\.well-known\/jwks\/?$/;
const withBase = (config = {}) => (config && config.jwksUrl && JWKS.test(config.jwksUrl)
    ? { ...config, networkInternalUrl: String(config.jwksUrl).replace(JWKS, '') } : config);

function createKeyStore(o = {}) {
    const store = site.createKeyStore({ name: 'OpenVibe.Watch', ...o, config: withBase(o.config) });
    return { ...store, stop: () => store.client.stop() };
}

module.exports = { createKeyStore, jwksUrl: (config) => site.jwksUrl(withBase(config)) };
