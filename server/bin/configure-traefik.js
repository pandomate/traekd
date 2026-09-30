#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function prepareStaticConfig(input, dynamicDirectory) {
    const config = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    config.api = config.api && typeof config.api === 'object' ? config.api : {};
    // The API is reachable only from the local machine. Dashboard rendering is
    // an independent option and is intentionally left at the operator's value.
    if (config.api.dashboard === undefined) config.api.dashboard = false;
    config.api.insecure = true;
    config.entryPoints ||= {};
    config.entryPoints.traefik = { ...(config.entryPoints.traefik || {}), address: '127.0.0.1:8080' };
    config.providers ||= {};
    config.providers.file = { ...(config.providers.file || {}), directory: dynamicDirectory, watch: true };
    delete config.providers.file.filename;

    // Convert paths used by the repository's old container example into
    // conventional native-install paths.
    for (const section of ['log', 'accessLog']) {
        const value = config[section]?.filePath;
        if (typeof value === 'string' && value.startsWith('/logs/')) {
            config[section].filePath = path.join('/var/log/traefik', path.basename(value));
        }
    }
    return config;
}

function configureFile(staticPath, dynamicDirectory) {
    const original = fs.readFileSync(staticPath, 'utf8');
    const metadata = fs.statSync(staticPath);
    const parsed = yaml.load(original) || {};
    const prepared = prepareStaticConfig(parsed, dynamicDirectory);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${staticPath}.traekd-backup-${stamp}`;
    const temporary = `${staticPath}.${process.pid}.tmp`;
    fs.copyFileSync(staticPath, backup, fs.constants.COPYFILE_EXCL);
    try {
        fs.writeFileSync(temporary, yaml.dump(prepared, { noRefs: false, lineWidth: 120 }), { mode: 0o640 });
        fs.chownSync(temporary, metadata.uid, metadata.gid);
        fs.chmodSync(temporary, metadata.mode & 0o777);
        yaml.load(fs.readFileSync(temporary, 'utf8'));
        fs.renameSync(temporary, staticPath);
    } finally {
        try { fs.unlinkSync(temporary); } catch { /* renamed or never written */ }
    }
    return backup;
}

if (require.main === module) {
    const [, , staticPath, dynamicDirectory] = process.argv;
    if (!staticPath || !dynamicDirectory || !path.isAbsolute(dynamicDirectory)) {
        console.error('Usage: configure-traefik.js <static-config.yml> <absolute-dynamic-directory>');
        process.exit(2);
    }
    try { console.log(configureFile(staticPath, dynamicDirectory)); }
    catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { prepareStaticConfig, configureFile };
