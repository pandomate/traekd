const express = require('express');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const ConfigWriter = require('./configWriter');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.SERVER_PORT || 3000;
const HOST = process.env.SERVER_HOST || '0.0.0.0';
const SITE_TITLE = process.env.SITE_TITLE || 'Traefik Config Manager';
const TEMPLATE_PATH = path.join(__dirname, 'template.yml');

const ENV_FILE = path.join(__dirname, '..', '.env');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');

function writeLog(level, message) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        fs.promises.appendFile(LOG_FILE, line).catch(() => {});
    } catch {
        // swallow logging errors
    }
}

const defaultSettings = {
    configPath: process.env.TRAEFIK_CONFIG_PATH || '/etc/traefik/config.yml',
    traefikYmlPath: process.env.TRAEFIK_YML_FILE || path.join(__dirname, '..', 'traefik.yml'),
    certResolvers: [],
    entryPoints: [],
    certResolverConfigs: {},
    entryPointConfigs: {}
};

const envKeyMap = {
    configPath: 'TRAEFIK_CONFIG_PATH',
    traefikYmlPath: 'TRAEFIK_YML_FILE'
};

function parseListEnv(value, fallback = []) {
    if (!value) return [...fallback];
    return value.split(',').map(v => v.trim()).filter(Boolean);
}

function loadEnvFile() {
    if (!fs.existsSync(ENV_FILE)) return [];
    return fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
}

function writeEnvFile(lines, updates) {
    const updatedKeys = new Set();
    const result = lines.map(line => {
        const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
        if (!match) return line;
        const key = match[1];
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
            updatedKeys.add(key);
            return `${key}=${updates[key]}`;
        }
        return line;
    });
    Object.entries(updates).forEach(([key, value]) => {
        if (!updatedKeys.has(key)) {
            result.push(`${key}=${value}`);
        }
    });
    const cleaned = result.filter((line, idx, arr) => line.trim() !== '' || (idx < arr.length - 1 && arr[idx + 1].trim() !== ''));
    fs.writeFileSync(ENV_FILE, `${cleaned.join('\n')}\n`, 'utf8');
}

function parseTraefikYml(filePath = process.env.TRAEFIK_YML_FILE) {
    const result = { entryPoints: [], entryPointConfigs: {}, certResolvers: [], certResolverConfigs: {} };
    const candidates = [];
    if (filePath) {
        candidates.push(path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath));
    }
    const fallback = path.join(__dirname, '..', 'traefik.yml');
    if (!candidates.includes(fallback)) candidates.push(fallback);
    for (const candidate of candidates) {
        try {
            const content = fs.readFileSync(candidate, 'utf8');
            const data = yaml.load(content) || {};
            if (data.entryPoints && typeof data.entryPoints === 'object') {
                result.entryPoints = Object.keys(data.entryPoints);
                result.entryPointConfigs = data.entryPoints;
            }
            const resolverSource = data.certificatesResolvers || data.certificateResolvers || data.certificatesresolvers || {};
            if (resolverSource && typeof resolverSource === 'object') {
                result.certResolvers = Object.keys(resolverSource);
                result.certResolverConfigs = resolverSource;
            }
            return result;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                writeLog('ERROR', `Error parsing Traefik YML (${candidate}): ${error.message}`);
                break;
            }
        }
    }
    return result;
}

function mergeDerivedSettings(base) {
    const merged = { ...base };
    const derived = parseTraefikYml(merged.traefikYmlPath);
    merged.entryPoints = derived.entryPoints || [];
    merged.certResolvers = derived.certResolvers || [];
    merged.entryPointConfigs = derived.entryPointConfigs || {};
    merged.certResolverConfigs = derived.certResolverConfigs || {};
    return merged;
}

function loadSettings() {
    const base = {
        configPath: process.env.TRAEFIK_CONFIG_PATH || defaultSettings.configPath,
        traefikYmlPath: process.env.TRAEFIK_YML_FILE || defaultSettings.traefikYmlPath,
        certResolvers: [],
        entryPoints: [],
        certResolverConfigs: {},
        entryPointConfigs: {}
    };
    return mergeDerivedSettings(base);
}

function saveSettings(settings) {
    try {
        const envLines = loadEnvFile();
        const updates = {
            [envKeyMap.configPath]: settings.configPath || '',
            [envKeyMap.traefikYmlPath]: settings.traefikYmlPath || ''
        };
        writeEnvFile(envLines, updates);
        Object.entries(updates).forEach(([key, value]) => {
            process.env[key] = value;
        });
        currentSettings = mergeDerivedSettings({ ...currentSettings, ...settings });
        return true;
    } catch (e) {
        writeLog('ERROR', `Error saving settings: ${e.message}`);
        return false;
    }
}

let currentSettings = loadSettings();

// Helper to get config path
function getConfigPath() {
    if (!currentSettings?.configPath) {
        currentSettings = loadSettings();
    }
    return currentSettings.configPath || process.env.TRAEFIK_CONFIG_PATH || defaultSettings.configPath;
}

// Helper to create ConfigWriter instance
function createConfigWriter() {
    const configPath = getConfigPath();
    if (!configPath) {
        throw new Error('Config path is not configured');
    }
    return new ConfigWriter(configPath, TEMPLATE_PATH);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/site-config', (req, res) => {
    res.json({ 
        title: SITE_TITLE, 
        configPath: getConfigPath() 
    });
});

// Settings endpoints
app.get('/api/settings', (req, res) => {
    currentSettings = mergeDerivedSettings(currentSettings);
    res.json(currentSettings);
});

app.put('/api/settings', (req, res) => {
    try {
        const { configPath, traefikYmlPath } = req.body;
        if (typeof configPath === 'string') currentSettings.configPath = configPath.trim();
        if (typeof traefikYmlPath === 'string') currentSettings.traefikYmlPath = traefikYmlPath.trim();
        
        if (saveSettings(currentSettings)) {
            res.json({ success: true, settings: currentSettings });
        } else {
            res.status(500).json({ error: 'Failed to save settings' });
        }
    } catch (error) {
        writeLog('ERROR', `Failed to update settings: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Validate path exists
app.post('/api/settings/validate-path', (req, res) => {
    try {
        const { path: filePath } = req.body;
        if (!filePath) {
            return res.json({ valid: false, error: 'Path is required' });
        }
        
        const exists = fs.existsSync(filePath);
        const isFile = exists && fs.statSync(filePath).isFile();
        const isDirectory = exists && fs.statSync(filePath).isDirectory();
        
        res.json({ 
            valid: exists, 
            exists,
            isFile,
            isDirectory,
            error: exists ? null : 'Path does not exist'
        });
    } catch (error) {
        writeLog('ERROR', `Path validation error: ${error.message}`);
        res.json({ valid: false, error: error.message });
    }
});

app.get('/api/config', (req, res) => {
    try {
        const CONFIG_PATH = getConfigPath();
        if (!fs.existsSync(CONFIG_PATH)) {
            return res.json({ http: { routers: {}, middlewares: {}, services: {} } });
        }
        const content = fs.readFileSync(CONFIG_PATH, 'utf8');
        const config = yaml.load(content) || { http: { routers: {}, middlewares: {}, services: {} } };
        res.json(config);
    } catch (error) {
        writeLog('ERROR', `Error reading config: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Raw YAML endpoints - MUST be before parameterized routes
app.get('/api/config/raw', (req, res) => {
    try {
        const CONFIG_PATH = getConfigPath();
        if (!fs.existsSync(CONFIG_PATH)) {
            return res.json({ yaml: '' });
        }
        const content = fs.readFileSync(CONFIG_PATH, 'utf8');
        
        // Parse, clean empty objects, and re-serialize with proper quoting
        try {
            let config = yaml.load(content) || {};
            config = removeEmptyObjects(config) || {};
            const cleanedYaml = yaml.dump(config, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                sortKeys: false,
                quotingType: '"',
                forceQuotes: false
            });
            const processedYaml = postProcessYaml(cleanedYaml);
            res.json({ yaml: processedYaml });
        } catch (parseError) {
            // If parsing fails, return raw content
            res.json({ yaml: content });
        }
    } catch (error) {
        writeLog('ERROR', `Error reading raw config: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/config/raw', (req, res) => {
    try {
        const { yaml: rawYaml } = req.body || {};
        if (typeof rawYaml !== 'string') {
            return res.status(400).json({ error: 'YAML payload is required' });
        }

        // Parse and validate
        let parsedConfig;
        try {
            parsedConfig = yaml.load(rawYaml || '');
        } catch (parseError) {
            return res.status(400).json({ error: `Invalid YAML: ${parseError.message}` });
        }

        // Clean empty objects and re-serialize with proper quoting
        parsedConfig = removeEmptyObjects(parsedConfig) || {};
        const cleanedYaml = yaml.dump(parsedConfig, {
            indent: 2,
            lineWidth: -1,
            noRefs: true,
            sortKeys: false,
            quotingType: '"',
            forceQuotes: false
        });
        const processedYaml = postProcessYaml(cleanedYaml);

        const CONFIG_PATH = getConfigPath();
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(CONFIG_PATH, processedYaml.endsWith('\n') ? processedYaml : `${processedYaml}\n`, 'utf8');
        writeLog('INFO', 'Raw YAML config updated via editor');
        res.json({ success: true });
    } catch (error) {
        writeLog('ERROR', `Error saving raw config: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Parameterized routes - AFTER specific routes
app.get('/api/config/:section', (req, res) => {
    try {
        const { section } = req.params;
        const CONFIG_PATH = getConfigPath();
        if (!fs.existsSync(CONFIG_PATH)) return res.json({});
        const content = fs.readFileSync(CONFIG_PATH, 'utf8');
        const config = yaml.load(content) || {};
        res.json(config.http?.[section] || {});
    } catch (error) {
        writeLog('ERROR', `Error reading section '${req.params.section}': ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/config/:section/:name', (req, res) => {
    try {
        const { section, name } = req.params;
        const CONFIG_PATH = getConfigPath();
        if (!fs.existsSync(CONFIG_PATH)) return res.status(404).json({ error: 'Not found' });
        const content = fs.readFileSync(CONFIG_PATH, 'utf8');
        const config = yaml.load(content) || {};
        const item = config.http?.[section]?.[name];
        if (!item) return res.status(404).json({ error: 'Not found' });
        res.json({ name, data: item });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/config/:section/:name', (req, res) => {
    try {
        const { section, name } = req.params;
        const { data, protocol: rawProtocol } = req.body;
        const protocol = ['http', 'tcp', 'udp'].includes(rawProtocol) ? rawProtocol : 'http';

        const CONFIG_PATH = getConfigPath();
        if (!fs.existsSync(CONFIG_PATH)) return res.status(404).json({ error: 'Not found' });
        const content = fs.readFileSync(CONFIG_PATH, 'utf8');
        const config = yaml.load(content) || { http: {}, tcp: {}, udp: {} };

        if (!config[protocol]) config[protocol] = {};
        if (!config[protocol][section]) config[protocol][section] = {};

        const existingItem = config[protocol][section][name];
        const referenceOrder = existingItem
            ? Object.keys(existingItem)
            : getTemplateFieldOrder(protocol, section);
        const orderedData = reorderObjectByOrder(data, referenceOrder);

        config[protocol][section][name] = orderedData;

        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(
            CONFIG_PATH,
            yaml.dump(config, { lineWidth: -1, noRefs: true, quotingType: '"' }),
            'utf8'
        );
        res.json({ success: true, message: `Updated ${name}` });
    } catch (error) {
        writeLog('ERROR', `Error updating ${req.params.section}/${req.params.name}: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/config/:section/:name', async (req, res) => {
    try {
        const { section, name } = req.params;
        const rawProtocol = (req.query.protocol || req.body?.protocol || 'http').toString().toLowerCase();
        const protocol = ['http', 'tcp', 'udp'].includes(rawProtocol) ? rawProtocol : 'http';
        const configPath = getConfigPath();

        writeLog('INFO', `Delete request: section=${section}, name=${name}, protocol=${protocol}, configPath=${configPath}`);

        // Check if file exists first
        if (!fs.existsSync(configPath)) {
            writeLog('ERROR', `Config file not found at: ${configPath}`);
            return res.status(404).json({ error: `Config file not found: ${configPath}` });
        }

        // Read and parse config
        const content = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(content) || {};

        // Check if the item exists
        if (!config[protocol]?.[section]?.[name]) {
            writeLog('ERROR', `Item not found: ${protocol}/${section}/${name}`);
            return res.status(404).json({ error: `${section}/${name} not found in ${protocol}` });
        }

        // Delete the item
        delete config[protocol][section][name];
        writeLog('INFO', `Deleted ${protocol}/${section}/${name}`);

        // Clean up empty sections
        if (config[protocol][section] && Object.keys(config[protocol][section]).length === 0) {
            delete config[protocol][section];
            writeLog('DEBUG', `Cleaned up empty section: ${protocol}/${section}`);
        }
        if (config[protocol] && Object.keys(config[protocol]).length === 0) {
            delete config[protocol];
            writeLog('DEBUG', `Cleaned up empty protocol: ${protocol}`);
        }

        // Clean empty objects recursively
        const cleanedConfig = removeEmptyObjects(config) || {};

        // Write back to file
        const yamlContent = yaml.dump(cleanedConfig, { 
            lineWidth: -1, 
            noRefs: true, 
            quotingType: '"',
            indent: 2,
            sortKeys: false
        });
        const processedYaml = postProcessYaml(yamlContent);
        
        fs.writeFileSync(configPath, processedYaml.endsWith('\n') ? processedYaml : `${processedYaml}\n`, 'utf8');
        
        writeLog('INFO', `Successfully deleted ${section}/${name} from ${protocol}`);
        res.json({ success: true, message: `Deleted ${name}`, protocol });
    } catch (error) {
        writeLog('ERROR', `Error deleting ${req.params.section}/${req.params.name}: ${error.message}`);
        writeLog('ERROR', `Stack: ${error.stack}`);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/config/:section', async (req, res) => {
    try {
        const section = req.params.section;
        if (section === 'router') {
            const { protocol, name, router, service } = req.body || {};
            if (!protocol || !name || !router) {
                return res.status(400).json({ error: 'Invalid router payload' });
            }
            const result = await createConfigWriter().addRouter(protocol, name, router, service);
            writeLog('INFO', `Router created: protocol=${protocol}, name=${name}`);
            return res.json(result);
        }
        if (section === 'middleware') {
            const { protocol, name, middlewareType, middlewareConfig } = req.body || {};
            if (!protocol || !name || !middlewareType) {
                return res.status(400).json({ error: 'Invalid middleware payload' });
            }
            const result = await createConfigWriter().addMiddleware(protocol, name, middlewareType, middlewareConfig);
            writeLog('INFO', `Middleware created: protocol=${protocol}, name=${name}, type=${middlewareType}`);
            return res.json(result);
        }

        const allowedSections = ['routers', 'middlewares', 'services', 'serversTransports'];
        if (!allowedSections.includes(section)) {
            return res.status(400).json({ error: `Unsupported section: ${section}` });
        }

        const { name, data } = req.body || {};
        if (!name || typeof data !== 'object') {
            return res.status(400).json({ error: 'Invalid payload' });
        }
        const CONFIG_PATH = getConfigPath();
        
        let config = { http: { routers: {}, middlewares: {}, services: {} } };
        if (fs.existsSync(CONFIG_PATH)) {
            const content = fs.readFileSync(CONFIG_PATH, 'utf8');
            config = yaml.load(content) || config;
        }
        
        if (!config.http) config.http = {};
        if (!config.http[section]) config.http[section] = {};
        if (config.http[section][name]) {
            return res.status(400).json({ error: 'Already exists' });
        }
        config.http[section][name] = data;
        
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: -1, noRefs: true }), 'utf8');
        writeLog('INFO', `Created ${section}/${name}`);
        res.json({ success: true, message: `Created ${name}` });
    } catch (error) {
        writeLog('ERROR', `Error creating ${req.params.section}: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

let templateSchemaCache = null;
function getTemplateSchema() {
    if (!templateSchemaCache) {
        try {
            templateSchemaCache = yaml.load(fs.readFileSync(TEMPLATE_PATH, 'utf8')) || {};
        } catch {
            templateSchemaCache = {};
        }
    }
    return templateSchemaCache;
}

function getTemplateFieldOrder(protocol, section) {
    const schema = getTemplateSchema();
    const block = schema?.[protocol]?.[section];
    if (!block) return null;
    const firstKey = Object.keys(block)[0];
    if (!firstKey) return null;
    const sample = block[firstKey];
    return sample && typeof sample === 'object' ? Object.keys(sample) : null;
}

function reorderObjectByOrder(obj, order) {
    if (!order || !obj || typeof obj !== 'object') return obj;
    const ordered = {};
    order.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            ordered[key] = obj[key];
        }
    });
    Object.keys(obj).forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
            ordered[key] = obj[key];
        }
    });
    return ordered;
}

app.get('/api/template-schema', async (req, res) => {
    try {
        const content = await fs.promises.readFile(TEMPLATE_PATH, 'utf8');
        const template = yaml.load(content) || {};
        res.json(template);
    } catch (e) {
        writeLog('ERROR', `Template read error: ${e.message}`);
        res.json({
            http: { routers: {}, middlewares: {}, services: {} },
            tcp: { routers: {}, middlewares: {}, services: {} },
            udp: { routers: {}, services: {} }
        });
    }
});

// Move these helper functions BEFORE they are used (before app.listen)
// Helper to remove empty objects/arrays recursively
function removeEmptyObjects(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (Array.isArray(obj)) {
        const cleaned = obj
            .map(item => typeof item === 'object' ? removeEmptyObjects(item) : item)
            .filter(item => item !== undefined && item !== null);
        return cleaned.length > 0 ? cleaned : undefined;
    }
    if (typeof obj === 'object') {
        const cleaned = {};
        for (const [key, value] of Object.entries(obj)) {
            if (value === null || value === undefined || value === '') continue;
            if (typeof value === 'object') {
                const cleanedValue = removeEmptyObjects(value);
                if (cleanedValue !== undefined && 
                    !(typeof cleanedValue === 'object' && !Array.isArray(cleanedValue) && Object.keys(cleanedValue).length === 0)) {
                    cleaned[key] = cleanedValue;
                }
            } else {
                cleaned[key] = value;
            }
        }
        return Object.keys(cleaned).length > 0 ? cleaned : undefined;
    }
    return obj;
}

// Post-process YAML to quote values that need quoting
function postProcessYaml(yamlContent) {
    const lines = yamlContent.split('\n');
    const processedLines = lines.map(line => {
        // Match lines with key: value pattern (not already quoted)
        const match = line.match(/^(\s*-?\s*)(\w+):\s*(.+)$/);
        if (match) {
            const [, prefix, key, value] = match;
            if (value && !value.startsWith('"') && !value.startsWith("'")) {
                if (value.includes('*') || value.includes('`') || value.includes(':') || 
                    value.startsWith('@') || value.startsWith('!') || value.startsWith('&') ||
                    value.startsWith('{') || value.startsWith('[')) {
                    return `${prefix}${key}: "${value}"`;
                }
            }
        }
        // Match array items that need quoting: - value
        const arrayMatch = line.match(/^(\s*-\s*)([^"'].+)$/);
        if (arrayMatch) {
            const [, prefix, value] = arrayMatch;
            if (value.includes('*') || value.includes('`') || value.includes(':') ||
                value.startsWith('@') || value.startsWith('!') || value.startsWith('&')) {
                return `${prefix}"${value}"`;
            }
        }
        return line;
    });
    return processedLines.join('\n');
}

app.listen(PORT, HOST, () => {
    writeLog('INFO', `Traefik Config Manager listening at http://${HOST}:${PORT}`);
    writeLog('INFO', `Config path: ${getConfigPath()}`);
    writeLog('INFO', `Traefik yml: ${currentSettings.traefikYmlPath}`);
});
