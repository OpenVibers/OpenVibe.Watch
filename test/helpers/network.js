'use strict';
/**
 * A stand-in for the half of OpenVibe.Network the site's sign-in uses: the authorization-code token
 * endpoint (client `watch`, PKCE S256), revocation, and users with canonical subjects. It signs its
 * session tokens with the same key test/helpers.js already serves as the JWKS, so a token minted
 * here verifies offline exactly as a real one would.
 *
 *   const net = await startNetwork({ privateKey, issuer });
 *   const u = net.addUser('ada');
 *   const challenge = …;           // the S256 challenge the browser sent to /oauth/authorize
 *   const code = net.issueCode(u, challenge);
 *
 * It never touches the internet and knows nothing about watches.
 */
const http = require('http');
const crypto = require('crypto');
const { serviceAuth, ids } = require('openvibe-contracts');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json, res)).catch((err) => json(500, { error: String(err && err.message) }));
            });
        });
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
        }));
    });
}

async function startNetwork({ privateKey, issuer = 'https://openvibe.network', clientId = 'watch', clientSecret = 'watch-secret' } = {}) {
    const st = { users: new Map(), byUsername: new Map(), codes: new Map(), requests: [], tokens: [] };
    let nextId = 1;

    function addUser(username, { role = 'user' } = {}) {
        const u = { id: nextId++, subject: ids.newId('user'), username, display_name: username, role };
        st.users.set(u.id, u); st.byUsername.set(username, u);
        return u;
    }
    function userToken(u, { ttl = 3600 } = {}) {
        const now = Math.floor(Date.now() / 1000);
        const token = serviceAuth.signServiceToken({
            iss: issuer, sub: String(u.id), subject_id: u.subject, username: u.username, display_name: u.display_name,
            role: u.role, aud: ['openvibe.network'], iat: now, exp: now + ttl, jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
        }, privateKey);
        st.tokens.push(token);
        return token;
    }

    const problem = (json, status, error, description) => json(status, { error, error_description: description });

    const srv = await listen(async (req, raw, json, res) => {
        const url = new URL(req.url, 'http://x');
        st.requests.push({ method: req.method, path: url.pathname, query: url.search });
        if (url.pathname === '/oauth/authorize') {
            // A test that wants the browser half can follow this: the Network signs a person in and
            // sends them back with a code bound to the PKCE challenge they sent.
            const user = st.byUsername.get(url.searchParams.get('user') || '') || [...st.users.values()][0];
            const redirect = url.searchParams.get('redirect_uri');
            const challenge = url.searchParams.get('code_challenge') || '';
            if (!user || !redirect || url.searchParams.get('response_type') !== 'code') return problem(json, 400, 'invalid_request', 'nothing to authorize');
            const code = st.issueCode(user, challenge);
            const back = new URL(redirect);
            back.searchParams.set('code', code);
            if (url.searchParams.get('state')) back.searchParams.set('state', url.searchParams.get('state'));
            res.writeHead(302, { Location: back.toString() });
            return res.end();
        }
        if (url.pathname === '/oauth/revoke') return json(200, {});
        if (url.pathname === '/oauth/token' && req.method === 'POST') {
            const body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
            if (body.client_id !== clientId || body.client_secret !== clientSecret) return problem(json, 401, 'invalid_client', 'bad client credentials');
            if (body.grant_type !== 'authorization_code') return problem(json, 400, 'unsupported_grant_type', body.grant_type);
            const c = st.codes.get(body.code);
            if (!c) return problem(json, 400, 'invalid_grant', 'unknown code');
            st.codes.delete(body.code);
            const challenge = b64url(crypto.createHash('sha256').update(String(body.code_verifier || '')).digest());
            if (challenge !== c.challenge) return problem(json, 400, 'invalid_grant', 'PKCE verification failed');
            return json(200, { access_token: userToken(c.user), refresh_token: `rt_${crypto.randomBytes(8).toString('hex')}`, token_type: 'Bearer', expires_in: 3600 });
        }
        return json(404, { error: 'not found' });
    });

    function issueCode(user, challenge) {
        const code = `code_${crypto.randomBytes(8).toString('hex')}`;
        st.codes.set(code, { user, challenge });
        return code;
    }

    return { url: srv.url, issuer, state: st, requests: st.requests, addUser, userToken, issueCode, close: srv.close };
}

module.exports = { startNetwork };
