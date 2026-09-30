const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yaml = require('js-yaml');
const { ConfigError, revisionFor } = require('./configStore');

const ENTRY_POINT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENTRY_POINT_FIELDS = new Set([
    'address', 'asDefault', 'reusePort', 'transport', 'proxyProtocol',
    'forwardedHeaders', 'http', 'http2', 'http3', 'udp', 'observability'
]);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function validateEntryPointName(name) {
    if (typeof name !== 'string' || !ENTRY_POINT_NAME.test(name) || RESERVED.has(name)) {
        throw new ConfigError('invalid_entrypoint_name', 'Entry point names may contain letters, numbers, dashes, and underscores only');
    }
}

function validateAddress(address) {
    if (typeof address !== 'string' || /[\r\n\0]/.test(address) || address.length > 255) throw new ConfigError('invalid_entrypoint', 'A valid listen address is required');
    const match = address.trim().match(/^((?:\[[0-9a-f:.]+\])|(?:[a-z0-9_.-]+))?:(\d{1,5})(?:\/(tcp|udp))?$/i);
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65535) throw new ConfigError('invalid_entrypoint', 'Address must use host:port, :port, or :port/tcp|udp with a port from 1 to 65535');
    return address.trim();
}

function sanitizeValue(value, depth = 0, counter = { count: 0 }) {
    counter.count += 1;
    if (counter.count > 2000 || depth > 16) throw new ConfigError('invalid_entrypoint', 'Entry point configuration is too complex');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new ConfigError('invalid_entrypoint', 'Entry point configuration contains a non-finite number');
        return value;
    }
    if (typeof value === 'string') {
        if (/\0|\r|\n/.test(value) || value.length > 4096) throw new ConfigError('invalid_entrypoint', 'Entry point text values must be single-line and at most 4096 characters');
        return value;
    }
    if (Array.isArray(value)) return value.map(item => sanitizeValue(item, depth + 1, counter));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const output = {};
        for (const [key, child] of Object.entries(value)) {
            if (RESERVED.has(key) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new ConfigError('invalid_entrypoint', `Unsupported entry point key '${key}'`);
            output[key] = sanitizeValue(child, depth + 1, counter);
        }
        return output;
    }
    throw new ConfigError('invalid_entrypoint', 'Entry point configuration contains an unsupported value');
}

function sanitizeEntryPoint(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ConfigError('invalid_entrypoint', 'Entry point configuration must be an object');
    const output = {};
    for (const [key, value] of Object.entries(config)) {
        if (!ENTRY_POINT_FIELDS.has(key)) throw new ConfigError('invalid_entrypoint', `Unsupported entry point field '${key}'`);
        output[key] = sanitizeValue(value);
    }
    output.address = validateAddress(output.address);
    if (output.asDefault !== undefined && typeof output.asDefault !== 'boolean') throw new ConfigError('invalid_entrypoint', 'asDefault must be true or false');
    if (output.reusePort !== undefined && typeof output.reusePort !== 'boolean') throw new ConfigError('invalid_entrypoint', 'reusePort must be true or false');
    for (const field of ['transport', 'proxyProtocol', 'forwardedHeaders', 'http', 'http2', 'http3', 'udp', 'observability']) {
        if (output[field] !== undefined && (!output[field] || typeof output[field] !== 'object' || Array.isArray(output[field]))) {
            throw new ConfigError('invalid_entrypoint', `${field} must be a mapping`);
        }
    }
    const redirect = output.http?.redirections?.entryPoint;
    if (redirect !== undefined) {
        if (!redirect || typeof redirect !== 'object' || Array.isArray(redirect)) throw new ConfigError('invalid_entrypoint', 'HTTP entry point redirect must be a mapping');
        validateEntryPointName(redirect.to);
        if (redirect.scheme !== undefined && !['http', 'https'].includes(redirect.scheme)) throw new ConfigError('invalid_entrypoint', 'Redirect scheme must be http or https');
        if (redirect.permanent !== undefined && typeof redirect.permanent !== 'boolean') throw new ConfigError('invalid_entrypoint', 'Redirect permanent must be true or false');
    }
    return output;
}

function validateStaticDocument(value, depth = 0, state = { nodes: 0, seen: new WeakSet() }) {
    state.nodes += 1;
    if (state.nodes > 50000 || depth > 32) throw new ConfigError('invalid_static_config', 'Static configuration is too complex', 422);
    if (Array.isArray(value)) return value.forEach(item => validateStaticDocument(item, depth + 1, state));
    if (value && typeof value === 'object') {
        if (state.seen.has(value)) throw new ConfigError('invalid_static_config', 'Static configuration aliases are not supported', 422);
        state.seen.add(value);
        for (const [key, child] of Object.entries(value)) {
            if (RESERVED.has(key) || key === '<<') throw new ConfigError('invalid_static_config', `Static configuration key '${key}' is reserved`, 422);
            validateStaticDocument(child, depth + 1, state);
        }
    } else if (typeof value === 'string' && value.length > 1024 * 1024) throw new ConfigError('invalid_static_config', 'Static configuration contains an oversized value', 422);
    else if (typeof value === 'number' && !Number.isFinite(value)) throw new ConfigError('invalid_static_config', 'Static configuration contains a non-finite number', 422);
    else if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new ConfigError('invalid_static_config', 'Static configuration contains an unsupported value', 422);
}

class StaticConfigStore {
    constructor({ getPath, pathPolicy, dataDir, log = () => {} }) {
        this.getPath = getPath;
        this.pathPolicy = pathPolicy;
        this.dataDir = dataDir;
        this.log = log;
        this.queue = Promise.resolve();
    }

    path() {
        return this.pathPolicy.resolve(this.getPath(), 'Traefik static config path');
    }

    read() {
        const target = this.path();
        let raw = '';
        try {
            if (fs.statSync(target).size > 10 * 1024 * 1024) throw new ConfigError('invalid_static_config', 'Static configuration exceeds 10 MiB', 413);
            raw = fs.readFileSync(target, 'utf8');
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        let config = {};
        try { config = raw.trim() ? yaml.load(raw, { schema: yaml.JSON_SCHEMA }) : {}; }
        catch (error) { throw new ConfigError('invalid_static_yaml', error.message, 422); }
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ConfigError('invalid_static_config', 'Static Traefik configuration must be a mapping', 422);
        validateStaticDocument(config);
        return { config, raw, revision: revisionFor(raw), path: target };
    }

    async snapshot(raw, revision) {
        if (!raw) return;
        const directory = path.join(this.dataDir, 'static-revisions');
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${revision.slice(0, 12)}.yml`;
        await fsp.writeFile(path.join(directory, name), raw, { mode: 0o600 });
        const snapshots = (await fsp.readdir(directory)).filter(item => item.endsWith('.yml')).sort().reverse();
        await Promise.all(snapshots.slice(50).map(item => fsp.unlink(path.join(directory, item)).catch(() => {})));
    }

    async appendAudit(entry) {
        await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        const auditPath = path.join(this.dataDir, 'static-audit.jsonl');
        const stat = await fsp.stat(auditPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat?.size > 5 * 1024 * 1024) await fsp.rename(auditPath, `${auditPath}.1`);
        await fsp.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    }

    async openExistingTarget(target) {
        this.pathPolicy.resolve(target, 'Traefik static config path');
        const flags = fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
        return fsp.open(target, flags);
    }

    async atomicWrite(target, raw) {
        target = this.pathPolicy.resolve(target, 'Traefik static config path');
        const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
        await fsp.writeFile(temporary, raw, { mode: 0o640, flag: 'wx' });
        try {
            const verified = await fsp.readFile(temporary, 'utf8');
            if (verified !== raw) throw new ConfigError('write_verification_failed', 'Static configuration verification failed', 500);
            yaml.load(verified, { schema: yaml.JSON_SCHEMA });
            try { await fsp.rename(temporary, target); }
            catch (error) {
                if (!['EBUSY', 'EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
                const previous = await fsp.readFile(target, 'utf8');
                try {
                    const handle = await this.openExistingTarget(target);
                    try { await handle.writeFile(verified, 'utf8'); await handle.sync(); }
                    finally { await handle.close(); }
                    this.pathPolicy.resolve(target, 'Traefik static config path');
                    if (await fsp.readFile(target, 'utf8') !== verified) throw new Error('Mounted static configuration verification failed');
                    this.log('warn', 'Atomic rename unavailable; used bind-mount-safe static config replacement', { path: target, code: error.code });
                } catch (writeError) {
                    try {
                        const recovery = await this.openExistingTarget(target);
                        try { await recovery.writeFile(previous, 'utf8'); await recovery.sync(); }
                        finally { await recovery.close(); }
                    } catch { /* the snapshot remains available for manual recovery */ }
                    throw writeError;
                }
            }
        } finally { await fsp.unlink(temporary).catch(() => {}); }
    }

    mutate({ action, name, config, expectedRevision, actor = 'local' }) {
        const run = async () => {
            if (!['create', 'update'].includes(action)) throw new ConfigError('invalid_action', 'Unsupported entry point action');
            validateEntryPointName(name);
            const before = this.read();
            if (expectedRevision && expectedRevision !== before.revision) throw new ConfigError('stale_revision', 'Static configuration changed; reload and retry', 409);
            before.config.entryPoints ||= {};
            if (!before.config.entryPoints || typeof before.config.entryPoints !== 'object' || Array.isArray(before.config.entryPoints)) throw new ConfigError('invalid_static_config', 'entryPoints must be a mapping', 422);
            if (action === 'create' && Object.hasOwn(before.config.entryPoints, name)) throw new ConfigError('already_exists', `Entry point '${name}' already exists`, 409);
            if (action === 'update' && !Object.hasOwn(before.config.entryPoints, name)) throw new ConfigError('not_found', 'Entry point not found', 404);
            before.config.entryPoints[name] = sanitizeEntryPoint(config);
            const raw = yaml.dump(before.config, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false, quotingType: '"' });
            await this.snapshot(before.raw, before.revision);
            await this.atomicWrite(before.path, raw);
            const revision = revisionFor(raw);
            await this.appendAudit({ actor, operation: `${action}_entry_point`, name, fromRevision: before.revision, revision });
            return { success: true, revision, entryPoints: before.config.entryPoints };
        };
        const pending = this.queue.then(run, run);
        this.queue = pending.catch(() => {});
        return pending;
    }
}

module.exports = { StaticConfigStore, sanitizeEntryPoint, validateEntryPointName, validateAddress };
