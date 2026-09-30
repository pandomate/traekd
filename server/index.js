const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fsp = fs.promises;
const yaml = require('js-yaml');
const { ConfigStore, ConfigError, validateConfig, validateLocation } = require('./configStore');
const { createAuth } = require('./auth');
const { SafePathPolicy, PathSecurityError } = require('./safePath');
const { rejectRawWrite } = require('./security');
const { StaticConfigStore } = require('./staticConfigStore');
const { normalizeApiUrl, assertSafeApiTarget, readJsonLimited, candidatesFromConfig, probeTraefikApi } = require('./traefikApi');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const DATA_DIR = process.env.TRAEKD_DATA_DIR || path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const TEMPLATE_PATH = path.join(__dirname, 'template.yml');
const PORT = Number(process.env.SERVER_PORT || 3000);
const HOST = process.env.SERVER_HOST || '127.0.0.1';
const SITE_TITLE = process.env.SITE_TITLE || 'Traekd';

function resolveConfiguredPath(value, fallback) {
    let configured = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    if (configured.startsWith('\\~/')) configured = configured.slice(1);
    const legacyPrefix = '~/traekd/';
    if (configured === '~/traekd') return ROOT;
    if (configured.startsWith(legacyPrefix)) return path.join(ROOT, configured.slice(legacyPrefix.length));
    if (configured.startsWith('~/')) return path.resolve(path.dirname(ROOT), configured.slice(2));
    return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(ROOT, configured);
}

const initialConfigPath = resolveConfiguredPath(process.env.TRAEFIK_CONFIG_PATH, path.join(ROOT, 'config.yml'));
const initialStaticPath = resolveConfiguredPath(process.env.TRAEFIK_YML_FILE, path.join(ROOT, 'traefik.yml'));
const initialStorageMode = process.env.TRAEKD_STORAGE_MODE === 'directory' ? 'directory' : 'file';
const configRoot = resolveConfiguredPath(process.env.TRAEKD_CONFIG_ROOT, initialStorageMode === 'directory' ? initialConfigPath : path.dirname(initialConfigPath));
const staticConfigRoot = resolveConfiguredPath(process.env.TRAEKD_STATIC_CONFIG_ROOT, path.dirname(initialStaticPath));
const configPathPolicy = new SafePathPolicy(configRoot);
const staticPathPolicy = new SafePathPolicy(staticConfigRoot);
const settings = {
    configPath: configPathPolicy.resolve(initialConfigPath, 'Dynamic config path'),
    traefikYmlPath: staticPathPolicy.resolve(initialStaticPath, 'Traefik static config path'),
    storageMode: initialStorageMode,
    traefikVersion: ['v2.11', 'v3.7'].includes(process.env.TRAEKD_TRAEFIK_VERSION) ? process.env.TRAEKD_TRAEFIK_VERSION : 'v3.7',
    traefikApiUrl: process.env.TRAEFIK_API_URL || ''
};
const traefikApiStatus = {
    connected: false,
    source: settings.traefikApiUrl ? 'configured' : 'none',
    version: null,
    checkedAt: null,
    message: settings.traefikApiUrl ? 'Not checked yet' : 'No accessible Traefik API has been detected yet'
};
const staticStore = new StaticConfigStore({
    getPath: () => settings.traefikYmlPath,
    pathPolicy: staticPathPolicy,
    dataDir: DATA_DIR,
    log: writeLog
});

function writeLog(level, message, meta) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), level, message, ...(meta ? { meta } : {}) })}\n`;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
        fs.appendFile(LOG_FILE, line, () => {});
    } catch { /* logging must not block config writes */ }
}

function assertSafePath(value, label, policy = configPathPolicy) {
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new ConfigError('invalid_path', `${label} must be a non-empty single-line path`);
    try { return policy.resolve(value, label); }
    catch (error) {
        if (error instanceof PathSecurityError) throw new ConfigError(error.code, error.message, error.status);
        throw error;
    }
}

function saveEnvironment(updates) {
    let lines = [];
    try { lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const updated = new Set();
    lines = lines.map(line => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (!match || !Object.hasOwn(updates, match[1])) return line;
        updated.add(match[1]);
        return `${match[1]}=${JSON.stringify(String(updates[match[1]]))}`;
    });
    Object.keys(updates).filter(key => !updated.has(key)).forEach(key => lines.push(`${key}=${JSON.stringify(String(updates[key]))}`));
    const content = `${lines.filter((line, index, all) => line || index < all.length - 1).join('\n')}\n`;
    const tempPath = path.join(path.dirname(ENV_FILE), `.${path.basename(ENV_FILE)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
        fs.writeFileSync(tempPath, content, { mode: 0o600 });
        try { fs.renameSync(tempPath, ENV_FILE); }
        catch (error) {
            if (!['EBUSY', 'EXDEV', 'EPERM'].includes(error.code)) throw error;
            fs.writeFileSync(ENV_FILE, content, { mode: 0o600 });
        }
    } finally { try { fs.unlinkSync(tempPath); } catch { /* already renamed or never created */ } }
    Object.assign(process.env, updates);
}

function parseTraefikYml() {
    const output = { entryPoints: [], entryPointConfigs: {}, certResolvers: [], certResolverConfigs: {}, fileProviderDirectory: '', staticRevision: '' };
    try {
        const state = staticStore.read();
        const data = state.config;
        output.staticRevision = state.revision;
        if (data.entryPoints && typeof data.entryPoints === 'object') {
            output.entryPoints = Object.keys(data.entryPoints);
            output.entryPointConfigs = data.entryPoints;
        }
        const resolvers = data.certificatesResolvers || data.certificateResolvers || {};
        if (resolvers && typeof resolvers === 'object') {
            output.certResolvers = Object.keys(resolvers);
            output.certResolverConfigs = resolvers;
        }
        if (typeof data.providers?.file?.directory === 'string') output.fileProviderDirectory = data.providers.file.directory;
    } catch (error) { writeLog('warn', 'Unable to parse Traefik static configuration', { error: error.message }); }
    return output;
}
function publicSettings() {
    const staticConfig = parseTraefikYml();
    const preferredManaged = process.env.TRAEKD_MANAGED_DIRECTORY || staticConfig.fileProviderDirectory || configPathPolicy.root;
    const preferredFile = process.env.TRAEKD_SINGLE_FILE_PATH || (settings.storageMode === 'file' ? settings.configPath : path.join(configPathPolicy.root, 'config.yml'));
    let managedDirectoryDefault = configPathPolicy.root;
    let singleFileDefault = path.join(configPathPolicy.root, 'config.yml');
    try { managedDirectoryDefault = configPathPolicy.resolve(preferredManaged, 'Managed directory'); } catch { /* do not advertise paths outside the jail */ }
    try { singleFileDefault = configPathPolicy.resolve(preferredFile, 'Single-file path'); } catch { /* do not advertise paths outside the jail */ }
    return {
        ...settings,
        configRoot: configPathPolicy.root,
        staticConfigRoot: staticPathPolicy.root,
        managedDirectoryDefault,
        singleFileDefault,
        traefikApiStatus: { ...traefikApiStatus },
        ...staticConfig
    };
}

const store = new ConfigStore({
    getConfigPath: () => settings.configPath,
    getStorageMode: () => settings.storageMode,
    getVersion: () => settings.traefikVersion,
    dataDir: DATA_DIR,
    pathPolicy: configPathPolicy,
    log: writeLog
});

function versionMode(version) {
    const major = Number(String(version || '').replace(/^v/, '').split('.')[0]);
    if (major === 2) return 'v2.11';
    if (major >= 3) return 'v3.7';
    return null;
}

async function discoverTraefikApi({ force = false, persist = true, candidateUrl = '' } = {}) {
    const configured = normalizeApiUrl(settings.traefikApiUrl);
    let candidates = [];
    if (candidateUrl) {
        try { candidates.push({ url: normalizeApiUrl(candidateUrl), source: 'entered URL' }); }
        catch (error) { throw new ConfigError('invalid_api_url', error.message); }
    }
    if (configured) candidates.push({ url: configured, source: 'configured' });
    if (!configured || force) {
        try {
            const state = await store.read();
            candidates.push(...candidatesFromConfig(state.config).map(url => ({ url, source: 'api@internal route' })));
        } catch (error) {
            writeLog('warn', 'Could not inspect dynamic config while detecting the Traefik API', { error: error.message });
        }
        candidates.push(
            { url: 'http://127.0.0.1:8080', source: 'local' },
            { url: 'http://localhost:8080', source: 'local' },
            { url: 'http://traefik:8080', source: 'Docker' },
            { url: 'http://host.docker.internal:8080', source: 'Docker host' }
        );
    }
    const unique = [...new Map(candidates.map(candidate => [candidate.url, candidate])).values()];
    const results = await Promise.all(unique.map(async candidate => {
        try { return { ...await probeTraefikApi(candidate.url), source: candidate.source }; }
        catch { return null; }
    }));
    const found = results.find(Boolean);
    traefikApiStatus.checkedAt = new Date().toISOString();
    if (!found) {
        Object.assign(traefikApiStatus, {
            connected: false,
            source: configured ? 'configured' : 'none',
            version: null,
            message: configured ? 'Configured URL is not currently reachable' : 'No accessible Traefik API was found'
        });
        return { success: false, ...traefikApiStatus };
    }

    settings.traefikApiUrl = found.url;
    const detectedMode = versionMode(found.version);
    if (detectedMode) settings.traefikVersion = detectedMode;
    Object.assign(traefikApiStatus, {
        connected: true,
        source: found.source,
        version: found.version,
        message: found.source === 'configured' ? 'Connected' : `Auto-detected via ${found.source}`
    });
    if (persist) {
        try {
            saveEnvironment({ TRAEFIK_API_URL: settings.traefikApiUrl, TRAEKD_TRAEFIK_VERSION: settings.traefikVersion });
        } catch (error) {
            traefikApiStatus.message += '; active for this session, but could not update .env';
            writeLog('warn', 'Detected Traefik API but could not persist it', { error: error.message });
        }
    }
    writeLog('info', 'Traefik API connected', { url: found.url, version: found.version, source: found.source });
    return { success: true, ...traefikApiStatus, url: found.url };
}
const adminCredentials = store.ensureAdminCredentials({
    username: process.env.TRAEKD_ADMIN_USER,
    passwordHash: process.env.TRAEKD_ADMIN_PASSWORD_HASH,
    sessionSecret: process.env.TRAEKD_SESSION_SECRET
});
const auth = createAuth({
    host: HOST,
    ...adminCredentials,
    cookieSecure: process.env.TRAEKD_COOKIE_SECURE === 'true',
    persistRevocation: (token, expiresAt) => store.revokeSession(token, expiresAt),
    isPersistentlyRevoked: token => store.isSessionRevoked(token),
    persistCredentials: credentials => {
        saveEnvironment({ TRAEKD_ADMIN_PASSWORD_HASH: credentials.passwordHash, TRAEKD_SESSION_SECRET: credentials.sessionSecret });
        store.updateAdminCredentials(credentials);
    }
});
const actor = req => req.auth?.username || req.ip || 'local';
const revision = req => req.get('If-Match') || req.body?.revision || undefined;
const respond = (res, value, status = 200) => { if (value.revision) res.set('ETag', value.revision); return res.status(status).json(value); };
const sectionOf = (config, protocol, section) => config[protocol]?.[section] || {};

function assertSafeData(value, field = 'data', depth = 0, counter = { count: 0 }) {
    counter.count += 1;
    if (counter.count > 20000) throw new ConfigError('invalid_resource', `${field} contains too many values`);
    if (depth > 32) throw new ConfigError('invalid_resource', `${field} exceeds the maximum nesting depth`);
    if (Array.isArray(value)) return value.forEach((item, index) => assertSafeData(item, `${field}[${index}]`, depth + 1, counter));
    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ConfigError('invalid_resource', `${field} contains a reserved key`);
            assertSafeData(child, `${field}.${key}`, depth + 1, counter);
        }
    } else if (typeof value === 'number' && !Number.isFinite(value)) throw new ConfigError('invalid_resource', `${field} contains a non-finite number`);
    else if (typeof value === 'string' && value.length > 65536) throw new ConfigError('invalid_resource', `${field} contains text longer than 64 KiB`);
    else if (value !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value)) throw new ConfigError('invalid_resource', `${field} contains an unsupported value`);
}

function normalizeResourceData(value) {
    if (typeof value === 'string') return value.trim() === '' ? undefined : value;
    if (Array.isArray(value)) {
        const items = value.map(normalizeResourceData).filter(item => item !== undefined);
        return items.length ? items : undefined;
    }
    if (value && typeof value === 'object') {
        const result = Object.create(null);
        for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ConfigError('invalid_resource', 'Configuration contains a reserved key');
            const normalized = normalizeResourceData(child);
            if (normalized !== undefined) result[key] = normalized;
        }
        return result;
    }
    return value;
}

function changedPaths(before, after, prefix = '', output = []) {
    if (output.length >= 200) return output;
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key, output);
    } else if (JSON.stringify(before) !== JSON.stringify(after)) output.push(prefix || '(root)');
    return output;
}

function addResource(next, protocol, section, name, data) {
    validateLocation(protocol, section, name);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError('invalid_resource', 'Resource data must be an object');
    data = normalizeResourceData(data);
    assertSafeData(data);
    next[protocol] ||= {}; next[protocol][section] ||= {};
    if (next[protocol][section][name]) throw new ConfigError('already_exists', `${section.slice(0, -1)} '${name}' already exists`, 409);
    next[protocol][section][name] = data;
}
function setResource(next, protocol, section, name, data) {
    validateLocation(protocol, section, name);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError('invalid_resource', 'Resource data must be an object');
    data = normalizeResourceData(data);
    assertSafeData(data);
    if (!next[protocol]?.[section]?.[name]) throw new ConfigError('not_found', 'Resource not found', 404);
    next[protocol][section][name] = data;
}
function deleteResource(next, protocol, section, name, force = false) {
    validateLocation(protocol, section, name);
    if (!next[protocol]?.[section]?.[name]) throw new ConfigError('not_found', 'Resource not found', 404);
    const references = [];
    if (section === 'services') Object.entries(next[protocol]?.routers || {}).forEach(([router, data]) => data.service === name && references.push(`routers/${router}`));
    if (section === 'middlewares') {
        Object.entries(next[protocol]?.routers || {}).forEach(([router, data]) => (data.middlewares || []).includes(name) && references.push(`routers/${router}`));
        Object.entries(next[protocol]?.middlewares || {}).forEach(([middleware, data]) => Object.values(data || {}).some(value => Array.isArray(value?.middlewares) && value.middlewares.includes(name)) && references.push(`middlewares/${middleware}`));
    }
    if (references.length && !force) throw new ConfigError('resource_in_use', `Resource is still referenced by: ${references.join(', ')}`, 409, references);
    delete next[protocol][section][name];
    if (!Object.keys(next[protocol][section]).length) delete next[protocol][section];
    if (!Object.keys(next[protocol]).length) delete next[protocol];
}
async function createRoute(req, res) {
    const { protocol, name, router, service, middlewares = [] } = req.body || {};
    validateLocation(protocol, 'routers', name);
    const result = await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'create_route', changes: [`${protocol}/routers/${name}`], mutate: next => {
        addResource(next, protocol, 'routers', name, router);
        if (service?.name) addResource(next, protocol, 'services', service.name, service.data || { loadBalancer: service.loadBalancer });
        middlewares.forEach(middleware => addResource(next, protocol, 'middlewares', middleware.name, middleware.data));
    }});
    respond(res, { ...result, name }, 201);
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRAEKD_TRUST_PROXY === 'true');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin'
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', etag: true, maxAge: 0 }));
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/readyz', async (req, res) => { try { const state = await store.read(); res.json({ ok: true, revision: state.revision }); } catch { res.status(503).json({ ok: false }); } });
app.post('/api/v1/auth/login', auth.login);
app.get('/api/v1/auth/me', (req, res) => { const current = auth.session(req); res.json({ authRequired: auth.enabled, authenticated: Boolean(current), user: current?.username, csrf: current?.csrf }); });
app.use('/api', auth.requireAuth);
app.post('/api/v1/auth/logout', auth.logout);
app.put('/api/v1/auth/password', auth.changePassword);
app.post('/api/v1/entry-points/:name', async (req, res, next) => { try {
    const result = await staticStore.mutate({ action: 'create', name: req.params.name, config: req.body?.config, expectedRevision: revision(req), actor: actor(req) });
    res.status(201).json(result);
} catch (error) { next(error); } });
app.put('/api/v1/entry-points/:name', async (req, res, next) => { try {
    res.json(await staticStore.mutate({ action: 'update', name: req.params.name, config: req.body?.config, expectedRevision: revision(req), actor: actor(req) }));
} catch (error) { next(error); } });

app.get('/api/v1/config', async (req, res, next) => { try {
    const state = await store.read();
    res.set('X-Traekd-Storage-Mode', settings.storageMode);
    respond(res, {
        config: state.config,
        revision: state.revision,
        storageMode: settings.storageMode,
        configuredPath: settings.configPath,
        path: state.path
    });
} catch (error) { next(error); } });
app.get('/api/v1/config/:protocol/:section', async (req, res, next) => { try { const { protocol, section } = req.params; validateLocation(protocol, section, 'placeholder'); const state = await store.read(); respond(res, { data: sectionOf(state.config, protocol, section), revision: state.revision }); } catch (error) { next(error); } });
app.get('/api/v1/config/:protocol/:section/:name', async (req, res, next) => { try { const { protocol, section, name } = req.params; validateLocation(protocol, section, name); const state = await store.read(); const data = sectionOf(state.config, protocol, section)[name]; if (!data) throw new ConfigError('not_found', 'Resource not found', 404); respond(res, { name, data, revision: state.revision }); } catch (error) { next(error); } });
app.post('/api/v1/config/:protocol/:section/:name', async (req, res, next) => { try { const { protocol, section, name } = req.params; respond(res, await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'create_resource', changes: [`${protocol}/${section}/${name}`], mutate: next => addResource(next, protocol, section, name, req.body.data) }), 201); } catch (error) { next(error); } });
app.put('/api/v1/config/:protocol/:section/:name', async (req, res, next) => { try { const { protocol, section, name } = req.params; respond(res, await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'update_resource', changes: [`${protocol}/${section}/${name}`], mutate: next => setResource(next, protocol, section, name, req.body.data) })); } catch (error) { next(error); } });
app.delete('/api/v1/config/:protocol/:section/:name', async (req, res, next) => { try { const { protocol, section, name } = req.params; respond(res, await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'delete_resource', changes: [`${protocol}/${section}/${name}`], mutate: next => deleteResource(next, protocol, section, name, req.query.force === 'true') })); } catch (error) { next(error); } });
app.post('/api/v1/routes', (req, res, next) => createRoute(req, res).catch(next));
app.post('/api/v1/plan', (req, res, next) => { try { const result = validateConfig(req.body?.config, settings.traefikVersion); respond(res, { success: !result.errors.length, ...result }); } catch (error) { next(error); } });
app.post('/api/v1/config/yaml/plan', async (req, res, next) => { try {
    const config = store.parseYamlProposal(req.body?.yaml);
    const validation = validateConfig(config, settings.traefikVersion);
    const current = await store.read();
    respond(res, {
        success: !validation.errors.length,
        ...validation,
        normalizedYaml: store.render(config),
        changes: changedPaths(current.config, config),
        revision: current.revision
    }, validation.errors.length ? 422 : 200);
} catch (error) { next(error); } });
app.put('/api/v1/config/yaml', async (req, res, next) => { try {
    const config = store.parseYamlProposal(req.body?.yaml);
    respond(res, await store.replace({ config, expectedRevision: revision(req), actor: actor(req), operation: 'yaml_update', changes: ['yaml-proposal'] }));
} catch (error) { next(error); } });
app.post('/api/v1/transactions', async (req, res, next) => {
    try {
        const operations = req.body?.operations;
        if (!Array.isArray(operations) || !operations.length) throw new ConfigError('invalid_transaction', 'operations must be a non-empty array');
        if (operations.length > 500) throw new ConfigError('invalid_transaction', 'A transaction may contain at most 500 operations', 413);
        respond(res, await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'transaction', changes: operations.map(op => `${op.protocol}/${op.section}/${op.name}`), mutate: next => operations.forEach(op => {
            if (op.action === 'create') addResource(next, op.protocol, op.section, op.name, op.data);
            else if (op.action === 'update') setResource(next, op.protocol, op.section, op.name, op.data);
            else if (op.action === 'delete') deleteResource(next, op.protocol, op.section, op.name, Boolean(op.force));
            else throw new ConfigError('invalid_transaction', `Unsupported action '${op.action}'`);
        }) }));
    } catch (error) { next(error); }
});
app.get('/api/v1/revisions', async (req, res, next) => { try { respond(res, { revisions: await store.listRevisions() }); } catch (error) { next(error); } });
app.post('/api/v1/revisions/:id/restore', async (req, res, next) => { try { respond(res, await store.restore(req.params.id, { expectedRevision: revision(req), actor: actor(req) })); } catch (error) { next(error); } });
app.get('/api/v1/runtime', async (req, res, next) => {
    try {
        if (!settings.traefikApiUrl) return res.json({ configured: false });
        const root = await assertSafeApiTarget(settings.traefikApiUrl); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
        const requestOptions = { signal: controller.signal, headers: { Accept: 'application/json' }, redirect: 'error' };
        const [versionResponse, rawResponse] = await Promise.all([fetch(`${root}/api/version`, requestOptions), fetch(`${root}/api/rawdata`, requestOptions)]); clearTimeout(timer);
        res.json({ configured: true, version: versionResponse.ok ? await readJsonLimited(versionResponse, 64 * 1024) : null, rawdata: rawResponse.ok ? await readJsonLimited(rawResponse) : null });
    } catch (error) { next(new ConfigError('runtime_unavailable', error.message, 502)); }
});

// Backwards-compatible API; UI migration can be incremental.
app.get('/api/config', async (req, res, next) => { try { const state = await store.read(); res.set('ETag', state.revision).json(state.config); } catch (error) { next(error); } });
app.get('/api/config/raw', async (req, res, next) => { try { const state = await store.read(); respond(res, { yaml: state.raw, revision: state.revision }); } catch (error) { next(error); } });
app.put('/api/config/raw', rejectRawWrite);
app.get('/api/config/:section/:name', async (req, res, next) => { try { const protocol = String(req.query.protocol || 'http'); validateLocation(protocol, req.params.section, req.params.name); const state = await store.read(); const data = sectionOf(state.config, protocol, req.params.section)[req.params.name]; if (!data) throw new ConfigError('not_found', 'Resource not found', 404); respond(res, { name: req.params.name, data, revision: state.revision }); } catch (error) { next(error); } });
app.get('/api/config/:section', async (req, res, next) => { try { const protocol = String(req.query.protocol || 'http'); validateLocation(protocol, req.params.section, 'placeholder'); const state = await store.read(); respond(res, sectionOf(state.config, protocol, req.params.section)); } catch (error) { next(error); } });
app.put('/api/config/:section/:name', async (req, res, next) => { try { const { protocol, data } = req.body || {}; const { section, name } = req.params; respond(res, await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'update_resource', changes: [`${protocol}/${section}/${name}`], mutate: next => setResource(next, protocol, section, name, data) })); } catch (error) { next(error); } });
app.delete('/api/config/:section/:name', async (req, res, next) => { try { const protocol = String(req.query.protocol || req.body?.protocol || ''); const { section, name } = req.params; respond(res, await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'delete_resource', changes: [`${protocol}/${section}/${name}`], mutate: next => deleteResource(next, protocol, section, name) })); } catch (error) { next(error); } });
app.post('/api/config/router', async (req, res, next) => { try { const body = req.body || {}; req.body = { protocol: body.protocol, name: body.name, router: body.router, service: body.service?.name ? { name: body.service.name, data: { loadBalancer: body.service.loadBalancer } } : null }; await createRoute(req, res); } catch (error) { next(error); } });
app.post('/api/config/middleware', async (req, res, next) => { try { const { protocol, name, middlewareType, middlewareConfig } = req.body || {}; validateLocation(protocol, 'middlewares', name); if (typeof middlewareType !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(middlewareType) || ['prototype', 'constructor'].includes(middlewareType)) throw new ConfigError('invalid_middleware', 'Middleware type is invalid'); respond(res, await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'create_middleware', changes: [`${protocol}/middlewares/${name}`], mutate: next => addResource(next, protocol, 'middlewares', name, { [middlewareType]: middlewareConfig || {} }) }), 201); } catch (error) { next(error); } });
app.post('/api/config/:section', async (req, res, next) => { try { const { protocol, name, data } = req.body || {}; const section = req.params.section; respond(res, await store.mutate({ expectedRevision: revision(req), actor: actor(req), operation: 'create_resource', changes: [`${protocol}/${section}/${name}`], mutate: next => addResource(next, protocol, section, name, data) }), 201); } catch (error) { next(error); } });

app.get('/api/site-config', (req, res) => res.json({ title: SITE_TITLE, configPath: store.configPath(), authRequired: auth.enabled }));
app.get('/api/settings', (req, res) => res.json(publicSettings()));
app.put('/api/settings', async (req, res, next) => {
    try {
        const next = req.body || {}; const storageMode = next.storageMode ?? settings.storageMode; const traefikVersion = next.traefikVersion ?? settings.traefikVersion;
        const managedDefault = publicSettings().managedDirectoryDefault;
        const shouldSelectManagedDefault = storageMode === 'directory' && settings.storageMode !== 'directory' && (!next.configPath || next.configPath === settings.configPath);
        const configPath = assertSafePath(shouldSelectManagedDefault ? managedDefault : (next.configPath ?? settings.configPath), 'Config path');
        const traefikYmlPath = assertSafePath(next.traefikYmlPath ?? settings.traefikYmlPath, 'Traefik static config path', staticPathPolicy);
        if (!['file', 'directory'].includes(storageMode)) throw new ConfigError('invalid_storage_mode', 'storageMode must be file or directory');
        if (!['v2.11', 'v3.7'].includes(traefikVersion)) throw new ConfigError('invalid_version', 'traefikVersion must be v2.11 or v3.7');
        if (fs.existsSync(configPath)) {
            const pathIsDirectory = fs.statSync(configPath).isDirectory();
            if (storageMode === 'directory' && !pathIsDirectory) throw new ConfigError('config_path_not_directory', 'Managed directory mode requires Dynamic Config Path to be a directory');
            if (storageMode === 'file' && pathIsDirectory) throw new ConfigError('config_path_not_file', 'Single-file mode requires Dynamic Config Path to be a YAML file');
        } else if (storageMode === 'directory') {
            throw new ConfigError('config_path_missing', 'The managed dynamic-config directory does not exist');
        }
        let traefikApiUrl = settings.traefikApiUrl;
        try {
            if (typeof next.traefikApiUrl === 'string') {
                traefikApiUrl = normalizeApiUrl(next.traefikApiUrl);
                if (traefikApiUrl) await assertSafeApiTarget(traefikApiUrl);
            }
        }
        catch (error) { throw new ConfigError('invalid_api_url', error.message); }
        const previous = { ...settings };
        Object.assign(settings, { configPath, traefikYmlPath, storageMode, traefikVersion, traefikApiUrl });
        try {
            // SQLite is the source of truth. A settings change publishes the
            // current database state to the newly selected safe output path;
            // it never imports or displays the target file's existing bytes.
            await store.publish();
            const pathMemories = storageMode === 'directory'
                ? { TRAEKD_MANAGED_DIRECTORY: configPath }
                : { TRAEKD_SINGLE_FILE_PATH: configPath };
            saveEnvironment({ TRAEFIK_CONFIG_PATH: configPath, TRAEFIK_YML_FILE: traefikYmlPath, TRAEKD_STORAGE_MODE: storageMode, TRAEKD_TRAEFIK_VERSION: traefikVersion, TRAEFIK_API_URL: settings.traefikApiUrl, ...pathMemories });
        } catch (error) {
            Object.assign(settings, previous);
            throw error;
        }
        await discoverTraefikApi({ force: !settings.traefikApiUrl, persist: true }).catch(error => writeLog('warn', 'Traefik API detection after settings update failed', { error: error.message }));
        res.json({ success: true, settings: publicSettings() });
    } catch (error) { next(error); }
});
app.post('/api/settings/discover-traefik-api', async (req, res, next) => {
    try {
        const result = await discoverTraefikApi({ force: true, persist: true, candidateUrl: req.body?.url });
        res.status(result.success ? 200 : 404).json({ ...result, settings: publicSettings() });
    } catch (error) { next(error); }
});
app.post('/api/settings/validate-path', (req, res, next) => { try {
    const policy = req.body?.pathKind === 'static' ? staticPathPolicy : configPathPolicy;
    const target = assertSafePath(req.body?.path, 'Path', policy); const exists = fs.existsSync(target);
    const isFile = exists && fs.statSync(target).isFile(); const isDirectory = exists && fs.statSync(target).isDirectory();
    const expectedType = req.body?.expectedType === 'directory' ? 'directory' : 'file';
    res.json({ valid: expectedType === 'directory' ? isDirectory : isFile, exists, isFile, isDirectory, expectedType });
} catch (error) { next(error); } });
app.get('/api/template-schema', async (req, res) => { try { res.json(yaml.load(await fsp.readFile(TEMPLATE_PATH, 'utf8'), { schema: yaml.JSON_SCHEMA }) || {}); } catch (error) { writeLog('error', 'Could not load the template schema', { error: error.message }); res.status(500).json({ error: 'Template schema is unavailable', code: 'template_unavailable' }); } });
app.use((error, req, res, next) => {
    const status = error instanceof ConfigError || Number.isInteger(error.status) ? error.status : 500;
    const code = error.code || 'internal_error';
    const publicMessage = status >= 500 ? 'Internal server error' : (error.message || 'Request failed');
    const payload = { error: publicMessage, code };
    if (status < 500 && error.path) payload.path = error.path;
    writeLog(status >= 500 ? 'error' : 'warn', error.message || publicMessage, { code, method: req.method, route: req.originalUrl?.split('?')[0] });
    res.status(status).json(payload);
});

if (require.main === module) store.publish().then(() => app.listen(PORT, HOST, () => {
    writeLog('info', `Traekd listening on http://${HOST}:${PORT}`, { authRequired: auth.enabled, storageMode: settings.storageMode });
    discoverTraefikApi({ persist: true }).catch(error => writeLog('warn', 'Traefik API detection failed', { error: error.message }));
})).catch(error => { writeLog('error', 'Refusing to start because the managed configuration cannot be published', { error: error.message }); process.exitCode = 1; });
module.exports = { app, store, staticStore, settings, discoverTraefikApi, rejectRawWrite };
