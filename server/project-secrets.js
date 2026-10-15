'use strict';
/**
 * Project secrets (ADR-056) through OpenVibe.Network's POST /internal/secrets/use, with Watch's own service token
 * (network.secret.use, audience openvibe.network). The project's grant of each secret to watch decides:
 *
 *   reveal({ project_id, environment, name, origin }) → { value, version }   a source credential, for the source's origin
 *   sign({ project_id, environment, name, message })  → { signature, version } a webhook action's delivery signature
 *
 * Network answers 404 for a secret that does not exist, or is not granted to watch for that purpose (and origin): that
 * is SecretRefused, final for this attempt. Anything else (Network unreachable) is thrown as it is and retried.
 * A revealed value is used for the one request it is for and never kept.
 */
class SecretRefused extends Error {}

function createProjectSecrets(client, { networkUrl }) {
    async function use(body) {
        try {
            return await client.json({
                service: 'network', baseUrl: networkUrl, audience: 'openvibe.network', method: 'POST', path: '/internal/secrets/use',
                json: body, retries: 0, idempotencyKey: false,
            });
        } catch (err) {
            if (err && err.status === 404) throw new SecretRefused(`project secret ${body.name} (${body.environment}) does not exist or is not granted to watch for ${body.purpose}${body.origin ? ` to ${body.origin}` : ''}`);
            throw err;
        }
    }
    return {
        async reveal({ project_id, environment, name, origin }) {
            const out = await use({ project_id, environment, name, purpose: 'reveal', origin });
            if (!out || typeof out.value !== 'string' || !out.value) throw new Error('Network answered no value');
            return { value: out.value, version: out.version };
        },
        async sign({ project_id, environment, name, message }) {
            const out = await use({ project_id, environment, name, purpose: 'sign', message });
            if (!out || !/^[0-9a-f]{64}$/.test(String(out.signature || ''))) throw new Error('Network answered no signature');
            return { signature: out.signature, version: out.version };
        },
    };
}

module.exports = { createProjectSecrets, SecretRefused };
