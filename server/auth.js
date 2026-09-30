const crypto = require('crypto');

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LIMIT = 8;

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function unbase64url(value) {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function parseCookies(header = '') {
    if (typeof header !== 'string' || header.length > 16384) return {};
    return Object.fromEntries(header.split(';').slice(0, 64).map(part => part.trim()).filter(Boolean).map(part => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        const raw = part.slice(index + 1);
        try { return [part.slice(0, index), decodeURIComponent(raw)]; }
        catch { return [part.slice(0, index), '']; }
    }));
}

function timingSafeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function scrypt(password, salt, cost, blockSize, parallelization) {
    return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: cost, r: blockSize, p: parallelization, maxmem: 256 * 1024 * 1024 }, (error, derived) => error ? reject(error) : resolve(derived)));
}

async function verifyPassword(password, encoded) {
    // scrypt$N$r$p$salt$hash; intentionally explicit so operators can create hashes offline.
    const parts = String(encoded || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [_, cost, blockSize, parallelization, salt, expected] = parts;
    try {
        const actual = await scrypt(password, Buffer.from(salt, 'base64url'), Number(cost), Number(blockSize), Number(parallelization));
        return timingSafeEqual(actual.toString('base64url'), expected);
    } catch { return false; }
}

async function passwordHash(password) {
    if (typeof password !== 'string' || password.length < 12) throw new Error('Password must be at least 12 characters');
    if (password.length > 1024) throw new Error('Password must be at most 1024 characters');
    const cost = 16384;
    const blockSize = 8;
    const parallelization = 1;
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, cost, blockSize, parallelization);
    return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function isLoopback(host) {
    return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase());
}

function createAuth({ host, username, passwordHash: initialHash, sessionSecret: initialSecret, cookieSecure = false, persistCredentials = () => {}, persistRevocation = () => {}, isPersistentlyRevoked = () => false }) {
    const mode = String(process.env.TRAEKD_AUTH_MODE || 'required').toLowerCase();
    // Authentication is secure-by-default even on loopback. Operators may
    // explicitly disable it only for a loopback-bound development instance.
    const enabled = !(mode === 'disabled' && isLoopback(host));
    let configuredHash = initialHash;
    let sessionSecret = initialSecret;
    const isConfigured = () => Boolean(username && configuredHash && sessionSecret && String(sessionSecret).length >= 32);
    const attempts = new Map();
    const revokedSessions = new Map();

    function sign(payload) {
        return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    }

    function issue(usernameValue) {
        const payload = base64url(JSON.stringify({ username: usernameValue, exp: Date.now() + SESSION_MAX_AGE_MS, csrf: crypto.randomBytes(24).toString('base64url') }));
        return `${payload}.${sign(payload)}`;
    }

    function session(req) {
        if (!isConfigured()) return null;
        const token = parseCookies(req.headers.cookie).traekd_session;
        if (!token || token.length > 4096 || !token.includes('.')) return null;
        if (isPersistentlyRevoked(token)) return null;
        const revokedUntil = revokedSessions.get(token);
        if (revokedUntil) {
            if (revokedUntil > Date.now()) return null;
            revokedSessions.delete(token);
        }
        const [payload, signature] = token.split('.', 2);
        if (!timingSafeEqual(sign(payload), signature)) return null;
        try {
            const parsed = JSON.parse(unbase64url(payload));
            return parsed.exp > Date.now() && parsed.username === username ? parsed : null;
        } catch { return null; }
    }

    function requireAuth(req, res, next) {
        if (!enabled) return next();
        if (!isConfigured()) return res.status(503).json({ error: 'Authentication is required but the admin credentials or a 32-character session secret are missing' });
        const current = session(req);
        if (!current) return res.status(401).json({ error: 'Authentication required' });
        req.auth = current;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            if (!timingSafeEqual(req.get('X-CSRF-Token') || '', current.csrf)) return res.status(403).json({ error: 'Invalid CSRF token' });
        }
        return next();
    }

    async function login(req, res) {
        if (!enabled) return res.json({ success: true, authRequired: false });
        if (!isConfigured()) return res.status(503).json({ error: 'Authentication has not been configured' });
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        if (attempts.size > 10000) {
            const now = Date.now();
            for (const [attemptKey, attempt] of attempts) if (now - attempt.started > LOGIN_WINDOW_MS) attempts.delete(attemptKey);
            if (attempts.size > 10000) attempts.clear();
        }
        const state = attempts.get(key) || { count: 0, started: Date.now() };
        if (Date.now() - state.started > LOGIN_WINDOW_MS) Object.assign(state, { count: 0, started: Date.now() });
        if (state.count >= LOGIN_LIMIT) return res.status(429).json({ error: 'Too many login attempts; retry later' });
        const body = req.body || {};
        const suppliedUsername = typeof body.username === 'string' && body.username.length <= 128 ? body.username : '';
        const suppliedPassword = typeof body.password === 'string' && body.password.length <= 1024 ? body.password : '';
        const passwordValid = await verifyPassword(suppliedPassword, configuredHash);
        const valid = timingSafeEqual(suppliedUsername, username) && passwordValid;
        if (!valid) {
            state.count += 1;
            attempts.set(key, state);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        attempts.delete(key);
        const token = issue(username);
        res.cookie('traekd_session', token, { httpOnly: true, sameSite: 'strict', secure: cookieSecure || Boolean(req.secure), maxAge: SESSION_MAX_AGE_MS, path: '/' });
        return res.json({ success: true, csrf: session({ headers: { cookie: `traekd_session=${token}` } }).csrf, user: username });
    }

    async function changePassword(req, res) {
        if (!isConfigured()) return res.status(503).json({ error: 'Authentication has not been configured' });
        const { currentPassword, newPassword } = req.body || {};
        if (typeof currentPassword !== 'string' || currentPassword.length > 1024 || typeof newPassword !== 'string' || newPassword.length > 1024) return res.status(400).json({ error: 'Password input is invalid' });
        if (!await verifyPassword(currentPassword || '', configuredHash)) return res.status(401).json({ error: 'Current password is incorrect' });
        let nextHash;
        try { nextHash = await passwordHash(newPassword); }
        catch (error) { return res.status(400).json({ error: error.message }); }
        if (await verifyPassword(newPassword, configuredHash)) return res.status(400).json({ error: 'New password must be different from the current password' });
        const nextSecret = crypto.randomBytes(48).toString('base64url');
        try { await persistCredentials({ username, passwordHash: nextHash, sessionSecret: nextSecret }); }
        catch { return res.status(500).json({ error: 'Could not persist the new password' }); }
        configuredHash = nextHash;
        sessionSecret = nextSecret;
        revokedSessions.clear();
        const token = issue(username);
        res.cookie('traekd_session', token, { httpOnly: true, sameSite: 'strict', secure: cookieSecure || Boolean(req.secure), maxAge: SESSION_MAX_AGE_MS, path: '/' });
        return res.json({ success: true, csrf: session({ headers: { cookie: `traekd_session=${token}` } }).csrf, user: username });
    }

    function logout(req, res) {
        const token = parseCookies(req.headers.cookie).traekd_session;
        const current = session(req);
        if (token && current) {
            persistRevocation(token, current.exp);
            revokedSessions.set(token, current.exp);
        }
        res.clearCookie('traekd_session', { httpOnly: true, sameSite: 'strict', secure: cookieSecure || Boolean(req.secure), path: '/' });
        return res.json({ success: true });
    }

    return { enabled, get configured() { return isConfigured(); }, requireAuth, login, logout, changePassword, session, passwordHash };
}

module.exports = { createAuth, passwordHash };
