const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yaml = require('js-yaml');
const { DatabaseSync } = require('node:sqlite');

const PROTOCOLS = new Set(['http', 'tcp', 'udp']);
const SECTIONS = {
    http: new Set(['routers', 'middlewares', 'services', 'serversTransports']),
    tcp: new Set(['routers', 'middlewares', 'services', 'serversTransports']),
    udp: new Set(['routers', 'services'])
};
const RESOURCE_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__section__']);

class ConfigError extends Error {
    constructor(code, message, status = 400, path = undefined) {
        super(message);
        this.code = code;
        this.status = status;
        this.path = path;
    }
}

function revisionFor(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPort(port) {
    const number = Number(port);
    return Number.isInteger(number) && number >= 1 && number <= 65535;
}

function validateAddress(address, protocol) {
    if (typeof address !== 'string' || !address.trim()) {
        return 'A backend address is required';
    }
    const value = address.trim();
    if (protocol === 'http') {
        try {
            const parsed = new URL(value);
            if (!['http:', 'https:', 'h2c:'].includes(parsed.protocol) || !parsed.hostname) {
                return 'Use an http, https, or h2c backend URL';
            }
            if (parsed.port && !validPort(parsed.port)) return 'Backend port must be between 1 and 65535';
        } catch {
            return 'Use a valid backend URL, such as http://app:8080 or http://[fd00::10]:8080';
        }
        return null;
    }

    const ipv6 = /^\[[^\]]+\]:(\d+)$/;
    const hostname = /^[^:\s]+:(\d+)$/;
    const match = value.match(ipv6) || value.match(hostname);
    if (!match) return 'Use host:port or [ipv6]:port';
    return validPort(match[1]) ? null : 'Backend port must be between 1 and 65535';
}

function isReference(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(name);
}

function validateResourceName(name) {
    if (typeof name !== 'string' || !RESOURCE_NAME.test(name) || RESERVED_KEYS.has(name)) {
        throw new ConfigError('invalid_name', 'Names may contain letters, numbers, dashes, and underscores only');
    }
}

function validateLocation(protocol, section, name, { allowReference = false } = {}) {
    if (!PROTOCOLS.has(protocol)) throw new ConfigError('invalid_protocol', 'Protocol must be http, tcp, or udp');
    if (!SECTIONS[protocol].has(section)) throw new ConfigError('invalid_section', `Section '${section}' is not valid for ${protocol}`);
    if (allowReference && isReference(name)) return;
    validateResourceName(name);
}

function validateConfig(config, version = 'v3.7') {
    const errors = [];
    const warnings = [];
    if (!isObject(config)) return { errors: [{ code: 'invalid_config', path: '', message: 'The document root must be a YAML mapping' }], warnings };

    for (const protocol of Object.keys(config)) {
        if (!PROTOCOLS.has(protocol) && protocol !== 'tls') {
            warnings.push({ code: 'unknown_top_level', path: protocol, message: `Preserving unknown top-level key '${protocol}'` });
            continue;
        }
        if (protocol === 'tls') continue;
        if (!isObject(config[protocol])) {
            errors.push({ code: 'invalid_protocol_block', path: protocol, message: `${protocol} must be a mapping` });
            continue;
        }
        for (const [section, items] of Object.entries(config[protocol])) {
            if (!SECTIONS[protocol].has(section)) {
                warnings.push({ code: 'unknown_section', path: `${protocol}.${section}`, message: `Preserving unknown ${protocol} section '${section}'` });
                continue;
            }
            if (!isObject(items)) {
                errors.push({ code: 'invalid_section', path: `${protocol}.${section}`, message: 'Section must be a mapping' });
                continue;
            }
            for (const [name, item] of Object.entries(items)) {
                if (!RESOURCE_NAME.test(name) || RESERVED_KEYS.has(name)) errors.push({ code: 'invalid_name', path: `${protocol}.${section}.${name}`, message: 'Resource name contains unsupported or reserved characters' });
                if (!isObject(item)) errors.push({ code: 'invalid_resource', path: `${protocol}.${section}.${name}`, message: 'Resource must be a mapping' });
            }
        }

        const routers = config[protocol].routers || {};
        const services = config[protocol].services || {};
        for (const [name, router] of Object.entries(routers)) {
            const base = `${protocol}.routers.${name}`;
            if (!isObject(router)) continue;
            if (protocol !== 'udp' && (!router.rule || typeof router.rule !== 'string')) {
                errors.push({ code: 'missing_rule', path: `${base}.rule`, message: 'HTTP and TCP routers require a rule' });
            }
            if (!router.service || typeof router.service !== 'string') {
                errors.push({ code: 'missing_service', path: `${base}.service`, message: 'Router requires a service' });
            } else if (!services[router.service] && !isReference(router.service)) {
                errors.push({ code: 'missing_reference', path: `${base}.service`, message: `Service '${router.service}' does not exist in ${protocol}` });
            }
            if (router.entryPoints !== undefined && (!Array.isArray(router.entryPoints) || router.entryPoints.some(entry => typeof entry !== 'string' || !entry))) {
                errors.push({ code: 'invalid_entrypoints', path: `${base}.entryPoints`, message: 'entryPoints must be a non-empty string array when supplied' });
            }
            if (router.middlewares && protocol === 'udp') errors.push({ code: 'invalid_middlewares', path: `${base}.middlewares`, message: 'UDP routers do not support middlewares' });
            if (version === 'v3.7' && typeof router.rule === 'string' && /\bHeaders\s*\(/.test(router.rule)) {
                warnings.push({ code: 'deprecated_rule', path: `${base}.rule`, message: 'Use Header() rather than the v2 Headers() matcher in Traefik v3' });
            }
        }

        for (const [name, service] of Object.entries(services)) {
            const base = `${protocol}.services.${name}`;
            if (!isObject(service)) continue;
            if (service.loadBalancer) {
                const servers = service.loadBalancer.servers;
                if (!Array.isArray(servers) || !servers.length) errors.push({ code: 'missing_servers', path: `${base}.loadBalancer.servers`, message: 'Load balancer requires at least one server' });
                else servers.forEach((server, index) => {
                    const field = protocol === 'http' ? 'url' : 'address';
                    const error = validateAddress(server && server[field], protocol);
                    if (error) errors.push({ code: 'invalid_backend', path: `${base}.loadBalancer.servers.${index}.${field}`, message: error });
                });
            }
        }
    }
    return { errors, warnings };
}

class ConfigStore {
    constructor({ getConfigPath, getStorageMode, dataDir, getVersion, log = () => {}, renameFile, pathPolicy }) {
        this.getConfigPath = getConfigPath;
        this.getStorageMode = getStorageMode || (() => 'file');
        this.dataDir = dataDir;
        this.getVersion = getVersion || (() => 'v3.7');
        this.log = log;
        this.renameFile = renameFile || ((source, target) => fsp.rename(source, target));
        this.pathPolicy = pathPolicy;
        this.queue = Promise.resolve();
        fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        this.databasePath = path.join(this.dataDir, 'traekd.sqlite');
        this.db = new DatabaseSync(this.databasePath);
        fs.chmodSync(this.databasePath, 0o600);
        this.db.exec(`
            PRAGMA journal_mode = DELETE;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS routers (
                protocol TEXT NOT NULL, name TEXT NOT NULL, rule TEXT, service TEXT,
                entry_points_json TEXT, middlewares_json TEXT, tls_json TEXT, document_json TEXT NOT NULL,
                PRIMARY KEY (protocol, name)
            );
            CREATE TABLE IF NOT EXISTS services (
                protocol TEXT NOT NULL, name TEXT NOT NULL, kind TEXT, servers_json TEXT,
                document_json TEXT NOT NULL, PRIMARY KEY (protocol, name)
            );
            CREATE TABLE IF NOT EXISTS middlewares (
                protocol TEXT NOT NULL, name TEXT NOT NULL, middleware_type TEXT,
                document_json TEXT NOT NULL, PRIMARY KEY (protocol, name)
            );
            CREATE TABLE IF NOT EXISTS resources (
                protocol TEXT NOT NULL, section TEXT NOT NULL, name TEXT NOT NULL,
                document_json TEXT NOT NULL, PRIMARY KEY (protocol, section, name)
            );
            CREATE TABLE IF NOT EXISTS top_level (
                name TEXT PRIMARY KEY, document_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS admin_credentials (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                username TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                session_secret TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS revoked_sessions (
                token_hash TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL
            );
        `);
        this.initializeDatabase();
    }

    configPath() {
        const configured = this.getConfigPath();
        if (!configured) throw new ConfigError('config_path_missing', 'Configuration path is not configured', 500);
        const safeConfigured = this.pathPolicy ? this.pathPolicy.resolve(configured, 'Dynamic config path') : path.resolve(configured);
        if (this.getStorageMode() !== 'directory') return safeConfigured;
        try {
            if (fs.existsSync(safeConfigured) && !fs.statSync(safeConfigured).isDirectory()) {
                throw new ConfigError('config_path_not_directory', `Managed directory mode requires a directory, but '${safeConfigured}' is a file`, 400);
            }
        } catch (error) {
            if (error instanceof ConfigError) throw error;
            throw new ConfigError('config_path_unavailable', `Cannot inspect managed directory '${safeConfigured}': ${error.message}`, 500);
        }
        const output = path.join(safeConfigured, 'traekd.yml');
        return this.pathPolicy ? this.pathPolicy.resolve(output, 'Dynamic config output') : output;
    }

    initializeDatabase() {
        if (this.db.prepare("SELECT value FROM metadata WHERE key = 'initialized'").get()) return;
        const configPath = this.configPath();
        let config = {};
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf8');
            try { config = this.parseYamlProposal(raw); }
            catch (error) { throw new ConfigError('invalid_yaml', `Cannot import initial configuration: ${error.message}`, 422); }
        }
        if (!isObject(config)) throw new ConfigError('invalid_config', 'The initial document root must be a YAML mapping', 422);
        this.replaceDatabase(config);
        this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('initialized', ?)").run(new Date().toISOString());
    }

    replaceDatabase(config) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const table of ['routers', 'services', 'middlewares', 'resources', 'top_level']) this.db.exec(`DELETE FROM ${table}`);
            const routerInsert = this.db.prepare('INSERT INTO routers(protocol,name,rule,service,entry_points_json,middlewares_json,tls_json,document_json) VALUES (?,?,?,?,?,?,?,?)');
            const serviceInsert = this.db.prepare('INSERT INTO services(protocol,name,kind,servers_json,document_json) VALUES (?,?,?,?,?)');
            const middlewareInsert = this.db.prepare('INSERT INTO middlewares(protocol,name,middleware_type,document_json) VALUES (?,?,?,?)');
            const resourceInsert = this.db.prepare('INSERT INTO resources(protocol,section,name,document_json) VALUES (?,?,?,?)');
            const topInsert = this.db.prepare('INSERT INTO top_level(name,document_json) VALUES (?,?)');
            for (const [topName, topValue] of Object.entries(config)) {
                if (RESERVED_KEYS.has(topName)) throw new ConfigError('invalid_config', `Top-level key '${topName}' is reserved`, 422);
                if (!PROTOCOLS.has(topName) || !isObject(topValue)) {
                    topInsert.run(topName, JSON.stringify(topValue));
                    continue;
                }
                if (!Object.keys(topValue).length) {
                    topInsert.run(topName, JSON.stringify(topValue));
                    continue;
                }
                for (const [section, items] of Object.entries(topValue)) {
                    if (RESERVED_KEYS.has(section)) throw new ConfigError('invalid_config', `Section key '${section}' is reserved`, 422);
                    if (!isObject(items)) {
                        resourceInsert.run(topName, section, '__section__', JSON.stringify(items));
                        continue;
                    }
                    if (!Object.keys(items).length) {
                        resourceInsert.run(topName, section, '__section__', JSON.stringify(items));
                        continue;
                    }
                    for (const [name, document] of Object.entries(items)) {
                        if (RESERVED_KEYS.has(name)) throw new ConfigError('invalid_config', `Resource name '${name}' is reserved`, 422);
                        const encoded = JSON.stringify(document);
                        if (section === 'routers') {
                            routerInsert.run(topName, name, document?.rule ?? null, document?.service ?? null, JSON.stringify(document?.entryPoints ?? null), JSON.stringify(document?.middlewares ?? null), JSON.stringify(document?.tls ?? null), encoded);
                        } else if (section === 'services') {
                            const kind = isObject(document) ? Object.keys(document)[0] || null : null;
                            serviceInsert.run(topName, name, kind, JSON.stringify(document?.loadBalancer?.servers ?? null), encoded);
                        } else if (section === 'middlewares') {
                            const type = isObject(document) ? Object.keys(document)[0] || null : null;
                            middlewareInsert.run(topName, name, type, encoded);
                        } else resourceInsert.run(topName, section, name, encoded);
                    }
                }
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    databaseConfig() {
        const config = {};
        const assign = (protocol, section, name, value) => {
            config[protocol] ||= {};
            if (name === '__section__') config[protocol][section] = value;
            else { config[protocol][section] ||= {}; config[protocol][section][name] = value; }
        };
        for (const row of this.db.prepare('SELECT name, document_json FROM top_level ORDER BY rowid').all()) config[row.name] = JSON.parse(row.document_json);
        for (const [table, section] of [['routers', 'routers'], ['middlewares', 'middlewares'], ['services', 'services']]) {
            for (const row of this.db.prepare(`SELECT protocol, name, document_json FROM ${table} ORDER BY rowid`).all()) assign(row.protocol, section, row.name, JSON.parse(row.document_json));
        }
        for (const row of this.db.prepare('SELECT protocol, section, name, document_json FROM resources ORDER BY rowid').all()) assign(row.protocol, row.section, row.name, JSON.parse(row.document_json));
        return config;
    }

    render(config) {
        return yaml.dump(config, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false, quotingType: '"' });
    }

    parseYamlProposal(raw) {
        if (typeof raw !== 'string') throw new ConfigError('invalid_yaml', 'YAML payload is required');
        if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new ConfigError('yaml_too_large', 'YAML payload exceeds 1 MiB', 413);
        let config;
        try { config = raw.trim() ? yaml.load(raw, { schema: yaml.JSON_SCHEMA }) : {}; }
        catch (error) { throw new ConfigError('invalid_yaml', error.message, 422); }
        if (!isObject(config)) throw new ConfigError('invalid_config', 'The YAML document root must be a mapping', 422);
        let nodes = 0;
        const seen = new WeakSet();
        const inspect = (value, depth = 0) => {
            nodes += 1;
            if (nodes > 20000) throw new ConfigError('yaml_too_complex', 'YAML contains too many values', 422);
            if (depth > 32) throw new ConfigError('yaml_too_complex', 'YAML nesting exceeds 32 levels', 422);
            if (value && typeof value === 'object') {
                if (seen.has(value)) throw new ConfigError('unsupported_yaml_feature', 'YAML anchors and aliases are not supported', 422);
                seen.add(value);
            }
            if (Array.isArray(value)) return value.forEach(item => inspect(item, depth + 1));
            if (isObject(value)) {
                const prototype = Object.getPrototypeOf(value);
                if (prototype !== Object.prototype && prototype !== null) throw new ConfigError('invalid_config', 'YAML contains an unsupported object type', 422);
                return Object.entries(value).forEach(([key, child]) => {
                    if (RESERVED_KEYS.has(key) || key === '<<') throw new ConfigError('invalid_config', `YAML key '${key}' is reserved`, 422);
                    inspect(child, depth + 1);
                });
            }
            if (typeof value === 'string' && value.length > 65536) throw new ConfigError('yaml_too_complex', 'A YAML scalar exceeds 64 KiB', 422);
            if (typeof value === 'number' && !Number.isFinite(value)) throw new ConfigError('invalid_config', 'YAML contains a non-finite number', 422);
            if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new ConfigError('invalid_config', 'YAML contains an unsupported value type', 422);
        };
        inspect(config);
        for (const [topLevel, value] of Object.entries(config)) {
            if (topLevel === 'tls') continue;
            if (!PROTOCOLS.has(topLevel)) throw new ConfigError('invalid_config', `Unsupported top-level YAML key '${topLevel}'`, 422);
            if (!isObject(value)) continue;
            for (const section of Object.keys(value)) {
                if (!SECTIONS[topLevel].has(section)) throw new ConfigError('invalid_config', `Unsupported ${topLevel} section '${section}'`, 422);
            }
        }
        return config;
    }

    ensureAdminCredentials({ username, passwordHash, sessionSecret }) {
        let row = this.db.prepare('SELECT username, password_hash, session_secret FROM admin_credentials WHERE id = 1').get();
        if (!row && username && passwordHash && sessionSecret) {
            this.db.prepare('INSERT INTO admin_credentials(id, username, password_hash, session_secret, updated_at) VALUES (1, ?, ?, ?, ?)')
                .run(username, passwordHash, sessionSecret, new Date().toISOString());
            row = { username, password_hash: passwordHash, session_secret: sessionSecret };
        }
        return row ? { username: row.username, passwordHash: row.password_hash, sessionSecret: row.session_secret } : { username, passwordHash, sessionSecret };
    }

    updateAdminCredentials({ username, passwordHash, sessionSecret }) {
        this.db.prepare(`INSERT INTO admin_credentials(id, username, password_hash, session_secret, updated_at)
            VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET username=excluded.username, password_hash=excluded.password_hash,
                session_secret=excluded.session_secret, updated_at=excluded.updated_at`)
            .run(username, passwordHash, sessionSecret, new Date().toISOString());
        this.db.exec('DELETE FROM revoked_sessions');
    }

    revokeSession(token, expiresAt) {
        const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
        this.db.prepare('INSERT OR REPLACE INTO revoked_sessions(token_hash, expires_at) VALUES (?, ?)').run(tokenHash, Number(expiresAt));
        this.db.prepare('DELETE FROM revoked_sessions WHERE expires_at <= ?').run(Date.now());
    }

    isSessionRevoked(token) {
        const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const row = this.db.prepare('SELECT expires_at FROM revoked_sessions WHERE token_hash = ?').get(tokenHash);
        if (!row) return false;
        if (row.expires_at > Date.now()) return true;
        this.db.prepare('DELETE FROM revoked_sessions WHERE token_hash = ?').run(tokenHash);
        return false;
    }

    async read() {
        const config = this.databaseConfig();
        const raw = this.render(config);
        return { raw, config, revision: revisionFor(raw), path: this.configPath() };
    }

    async listRevisions() {
        const revisionDir = path.join(this.dataDir, 'revisions');
        try {
            const names = await fsp.readdir(revisionDir);
            return (await Promise.all(names.filter(name => name.endsWith('.yml')).map(async name => {
                const stat = await fsp.stat(path.join(revisionDir, name));
                return { id: name.slice(0, -4), createdAt: stat.mtime.toISOString(), size: stat.size };
            }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }

    async snapshot(raw, revision) {
        if (!raw) return null;
        const revisionDir = path.join(this.dataDir, 'revisions');
        await fsp.mkdir(revisionDir, { recursive: true, mode: 0o700 });
        const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${revision.slice(0, 12)}`;
        await fsp.writeFile(path.join(revisionDir, `${id}.yml`), raw, { mode: 0o600 });
        const revisions = await this.listRevisions();
        await Promise.all(revisions.slice(50).map(item => fsp.unlink(path.join(revisionDir, `${item.id}.yml`)).catch(() => {})));
        return id;
    }

    async appendAudit(entry) {
        const auditPath = path.join(this.dataDir, 'audit.jsonl');
        await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        const stat = await fsp.stat(auditPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat?.size > 5 * 1024 * 1024) await fsp.rename(auditPath, `${auditPath}.1`);
        await fsp.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    }

    async atomicWrite(configPath, raw) {
        configPath = this.pathPolicy ? this.pathPolicy.resolve(configPath, 'Dynamic config output') : configPath;
        await fsp.mkdir(path.dirname(configPath), { recursive: true });
        if (this.pathPolicy) configPath = this.pathPolicy.resolve(configPath, 'Dynamic config output');
        const tempPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
        let handle;
        try {
            handle = await fsp.open(tempPath, 'w', 0o640);
            await handle.writeFile(raw, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            // Verify the exact bytes that will be published before replacing the
            // active file. This makes a failed/short write leave the old config
            // untouched instead of asking Traefik to consume partial YAML.
            const persisted = await fsp.readFile(tempPath, 'utf8');
            if (persisted !== raw) throw new ConfigError('write_verification_failed', 'Temporary configuration did not match the requested content', 500);
            try { yaml.load(persisted, { schema: yaml.JSON_SCHEMA }); }
            catch (error) { throw new ConfigError('write_verification_failed', `Temporary configuration is not valid YAML: ${error.message}`, 500); }
            try {
                if (this.pathPolicy) this.pathPolicy.resolve(configPath, 'Dynamic config output');
                await this.renameFile(tempPath, configPath);
            } catch (error) {
                // Docker/Podman cannot rename over a file that is itself a bind
                // mount. The bytes have already been flushed and verified, so
                // fall back to an in-place, fsynced replacement while retaining
                // the pre-write revision snapshot for recovery.
                if (!['EBUSY', 'EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
                const previous = await fsp.readFile(configPath, 'utf8').catch(readError => {
                    if (readError.code === 'ENOENT') return '';
                    throw readError;
                });
                try {
                    if (this.pathPolicy) this.pathPolicy.resolve(configPath, 'Dynamic config output');
                    const targetFlags = fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
                    const target = await fsp.open(configPath, targetFlags);
                    try {
                        await target.writeFile(persisted, 'utf8');
                        await target.sync();
                    } finally { await target.close(); }
                    const verified = await fsp.readFile(configPath, 'utf8');
                    if (verified !== persisted) throw new Error('Mounted configuration verification failed');
                    this.log('warn', 'Atomic rename unavailable; used bind-mount-safe replacement', { path: configPath, code: error.code });
                } catch (writeError) {
                    try {
                        if (this.pathPolicy) this.pathPolicy.resolve(configPath, 'Dynamic config output');
                        const recoveryFlags = fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
                        const recovery = await fsp.open(configPath, recoveryFlags);
                        try { await recovery.writeFile(previous, 'utf8'); await recovery.sync(); }
                        finally { await recovery.close(); }
                    } catch { /* the snapshot remains available for manual recovery */ }
                    throw writeError;
                }
            }
        } finally {
            if (handle) await handle.close().catch(() => {});
            await fsp.unlink(tempPath).catch(() => {});
        }
    }

    async persistAndPublish(next, before) {
        this.replaceDatabase(next);
        // Render from fresh SELECTs, not from the request object. This keeps
        // SQLite authoritative and makes the YAML exactly the sum of rows in
        // the typed resource tables.
        const raw = this.render(this.databaseConfig());
        try {
            await this.atomicWrite(before.path, raw);
            return raw;
        } catch (error) {
            this.replaceDatabase(before.config);
            throw error;
        }
    }

    async mutate({ expectedRevision, actor = 'local', operation, changes = [], mutate }) {
        const run = async () => {
            const before = await this.read();
            if (expectedRevision && expectedRevision !== before.revision) {
                throw new ConfigError('stale_revision', 'Configuration changed on disk; reload and retry', 409);
            }
            const next = deepClone(before.config);
            await mutate(next);
            const validation = validateConfig(next, this.getVersion());
            if (validation.errors.length) throw new ConfigError('validation_failed', 'Configuration validation failed', 422, validation.errors);
            const snapshot = await this.snapshot(before.raw, before.revision);
            const raw = await this.persistAndPublish(next, before);
            const revision = revisionFor(raw);
            await this.appendAudit({ actor, operation, changes, fromRevision: before.revision, revision, snapshot });
            return { success: true, revision, warnings: validation.warnings, snapshot };
        };
        const pending = this.queue.then(run, run);
        this.queue = pending.catch(() => {});
        return pending;
    }

    async replace({ config, expectedRevision, actor = 'local', operation = 'replace_config', changes = ['config'] }) {
        if (!isObject(config)) throw new ConfigError('invalid_config', 'Configuration must be an object');
        const run = async () => {
            const before = await this.read();
            if (expectedRevision && expectedRevision !== before.revision) throw new ConfigError('stale_revision', 'Configuration changed on disk; reload and retry', 409);
            const next = deepClone(config);
            const validation = validateConfig(next, this.getVersion());
            if (validation.errors.length) throw new ConfigError('validation_failed', 'Configuration validation failed', 422, validation.errors);
            const snapshot = await this.snapshot(before.raw, before.revision);
            const normalized = await this.persistAndPublish(next, before);
            const revision = revisionFor(normalized);
            await this.appendAudit({ actor, operation, changes, fromRevision: before.revision, revision, snapshot });
            return { success: true, revision, warnings: validation.warnings, snapshot };
        };
        const pending = this.queue.then(run, run);
        this.queue = pending.catch(() => {});
        return pending;
    }

    async restore(id, options = {}) {
        if (!/^[A-Za-z0-9-]+$/.test(id)) throw new ConfigError('invalid_revision', 'Invalid revision id');
        const raw = await fsp.readFile(path.join(this.dataDir, 'revisions', `${id}.yml`), 'utf8');
        let config;
        try { config = this.parseYamlProposal(raw); }
        catch (error) { throw new ConfigError('invalid_revision', `Revision is not valid YAML: ${error.message}`, 422); }
        return this.replace({ config, expectedRevision: options.expectedRevision, actor: options.actor || 'local', operation: 'restore_revision', changes: [`revision/${id}`] });
    }

    async publish() {
        const state = await this.read();
        await this.atomicWrite(state.path, state.raw);
        return state;
    }
}

module.exports = { ConfigStore, ConfigError, PROTOCOLS, SECTIONS, validateConfig, validateAddress, validateLocation, validateResourceName, isReference, revisionFor };
