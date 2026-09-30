'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

function normalizeApiUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    let parsed;
    try { parsed = new URL(value.trim()); }
    catch { throw new TypeError('Traefik API URL must be a valid http:// or https:// URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Traefik API URL must use http:// or https://');
    if (parsed.username || parsed.password) throw new TypeError('Traefik API URL must not contain credentials');
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new TypeError('Traefik API URL must contain only an origin, without a path, query, or fragment');
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
}

function isPrivateAddress(address) {
    if (net.isIP(address) === 4) {
        const octets = address.split('.').map(Number);
        return octets[0] === 10
            || octets[0] === 127
            || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] === 192 && octets[1] === 168)
            || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
    }
    if (net.isIP(address) === 6) {
        const normalized = address.toLowerCase();
        if (normalized === '::1') return true;
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
        const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return mapped ? isPrivateAddress(mapped[1]) : false;
    }
    return false;
}

async function assertSafeApiTarget(value, { allowPublic = process.env.TRAEKD_ALLOW_PUBLIC_TRAEFIK_API === 'true', lookup = dns.lookup } = {}) {
    const url = normalizeApiUrl(value);
    if (!url) throw new TypeError('Traefik API URL is empty');
    const parsed = new URL(url);
    const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') ? parsed.hostname.slice(1, -1) : parsed.hostname;
    let addresses;
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new TypeError('Traefik API host could not be resolved'); }
    if (!Array.isArray(addresses) || !addresses.length) throw new TypeError('Traefik API host did not resolve to an address');
    if (!allowPublic && addresses.some(result => !isPrivateAddress(result.address))) {
        throw new TypeError('Traefik API must resolve only to loopback or private-network addresses');
    }
    return url;
}

async function readJsonLimited(response, maximumBytes = 10 * 1024 * 1024) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maximumBytes) throw new Error('Traefik API response is too large');
    if (!response.body) return null;
    const chunks = [];
    let received = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maximumBytes) throw new Error('Traefik API response is too large');
            chunks.push(Buffer.from(value));
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function hostsFromRule(rule) {
    if (typeof rule !== 'string') return [];
    const hosts = [];
    for (const hostCall of rule.matchAll(/\bHost\s*\(([^)]*)\)/g)) {
        for (const literal of hostCall[1].matchAll(/[`'"]([^`'"]+)[`'"]/g)) {
            const host = literal[1].trim();
            if (host && !/[\s\/?#@]/.test(host)) hosts.push(host);
        }
    }
    return hosts;
}

function candidatesFromConfig(config) {
    const candidates = [];
    for (const router of Object.values(config?.http?.routers || {})) {
        if (router?.service !== 'api@internal') continue;
        const scheme = Object.hasOwn(router, 'tls') ? 'https' : 'http';
        for (const host of hostsFromRule(router.rule)) candidates.push(`${scheme}://${host}`);
    }
    return candidates;
}

async function probeTraefikApi(value, timeoutMs = 1800) {
    const url = await assertSafeApiTarget(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${url}/api/version`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
            redirect: 'error'
        });
        if (!response.ok) throw new Error(`Traefik API returned HTTP ${response.status}`);
        const payload = await readJsonLimited(response, 64 * 1024);
        const version = payload?.Version || payload?.version;
        if (typeof version !== 'string' || !version.trim()) throw new Error('The endpoint did not return a Traefik version');
        return { url, version: version.trim(), payload };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { normalizeApiUrl, isPrivateAddress, assertSafeApiTarget, readJsonLimited, hostsFromRule, candidatesFromConfig, probeTraefikApi };
