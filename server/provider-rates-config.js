'use strict';
/**
 * The `watch.provider_rates` configuration namespace (D11 owner settings): the one switch the owner changes from
 * openvibe.network's AI tab. WATCH_PROVIDER_RATES stays the pin: while it is set it wins, is read-only in the
 * summary and a write answers 409 config.pinned_in_env.
 *
 * /internal/config is openvibe-shared/config's adminRoutes, guarded by watch.config.manage (Network's service
 * token only). actor is the owner Network names in X-OV-Subject; X-OV-Fresh: 1 gates a secret or x-danger write
 * (this namespace has neither). Every activation writes one audit line with the actor and the keys, never a value.
 */
const express = require('express');
const shared = require('openvibe-shared/config');
const { capabilities, http, ids } = require('openvibe-contracts');

const SERVICE = 'watch';
const NAMESPACE = 'watch.provider_rates';
const CAPABILITY = 'watch.config.manage';
const GROUP = 'Provider-rate evidence';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Provider-rate evidence',
    description: 'Read DeepInfra\'s and Featherless\' published price documents and record what they stated, with the change a person approves.',
    type: 'object',
    additionalProperties: false,
    required: ['enabled'],
    properties: {
        enabled: {
            type: 'boolean', title: 'Provider-rate evidence', 'x-group': GROUP, 'x-env': 'WATCH_PROVIDER_RATES',
            description: 'Offer /api/v1/provider-rates and run the observation worker. A source still starts disabled until a person enables it after reading its terms.',
        },
    },
};
const DEFAULTS = Object.freeze({ enabled: false });

function bearer(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function capabilityGuard({ auth, log }) {
    return async function guard(req, res, next) {
        try {
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a Network service token is required', ctx: req.ov });
            const r = await auth.verifyService(token);
            if (!r.ok) return http.sendProblem(res, r.code === 'token.unavailable' ? 503 : 401, r.code || 'token.invalid', { detail: r.reason || 'the token does not verify', ctx: req.ov });
            const sub = String((r.claims && r.claims.sub) || '');
            if (!sub.startsWith('svc:')) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party; an app may not change Watch configuration`, ctx: req.ov });
            const decision = capabilities.check(r.claims, CAPABILITY);
            if (!decision.allowed) return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || `${CAPABILITY} not granted`, ctx: req.ov });
            req.configClaims = r.claims;
            return next();
        } catch (err) {
            log.error(`[config] watch.provider_rates guard failed: ${(err && err.message) || err}`);
            return http.sendProblem(res, 500, 'internal.error', { detail: 'the configuration request failed', ctx: req.ov });
        }
    };
}

function actor(req) {
    const named = String((req.headers && req.headers['x-ov-subject']) || '').trim();
    return ids.isSubjectId('user', named) ? { type: 'user', id: named } : null;
}

const requireFresh = (req) => String((req.headers && req.headers['x-ov-fresh']) || '') === '1';

async function create({ db, auth, config, env = process.env, log = console, onActivate = null }) {
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env, log,
        onActivate: async (values) => { if (onActivate) await onActivate(values); },
        onChange: ({ namespace, keys, actor: who, revision }) => {
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${keys.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    const router = shared.adminRoutes([store], {
        basePath: '/internal/config', requireAdmin: capabilityGuard({ auth, log }), actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) { app.use('/internal/config', express.json({ limit: '128kb' })); router.mount(app); },
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY };
