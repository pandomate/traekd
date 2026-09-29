const fs = require('fs').promises;
const fsSync = require('fs');
const yaml = require('js-yaml');

class ConfigWriter {
    constructor(configPath, templatePath) {
        this.configPath = configPath;
        this.templatePath = templatePath;
        this.templateSchema = null;
        
        // Validate paths on construction
        if (!this.configPath) {
            throw new Error('ConfigWriter: configPath is required');
        }
    }

    async loadTemplate() {
        if (this.templateSchema) return this.templateSchema;
        try {
            const content = await fs.readFile(this.templatePath, 'utf8');
            this.templateSchema = yaml.load(content) || {};
            return this.templateSchema;
        } catch (e) {
            return {};
        }
    }

    async loadConfig() {
        try {
            // Check if file exists first
            if (!fsSync.existsSync(this.configPath)) {
                console.log(`ConfigWriter: Config file does not exist at ${this.configPath}, returning empty config`);
                return {};
            }
            
            const content = await fs.readFile(this.configPath, 'utf8');
            const config = yaml.load(content) || {};
            
            // Clean up any stray 'middleware' keys (should be 'middlewares')
            ['http', 'tcp', 'udp'].forEach(protocol => {
                if (config[protocol]?.middleware) {
                    delete config[protocol].middleware;
                }
            });
            return config;
        } catch (e) {
            if (e.code === 'ENOENT') {
                console.log(`ConfigWriter: File not found at ${this.configPath}`);
                return {};
            }
            console.error(`ConfigWriter: Error loading config: ${e.message}`);
            throw e;
        }
    }

    // Get field order from template for a specific type
    getTemplateFieldOrder(protocol, type) {
        const template = this.templateSchema;
        if (!template?.[protocol]?.[type]) return null;
        
        const items = template[protocol][type];
        const firstKey = Object.keys(items)[0];
        if (!firstKey) return null;
        
        return Object.keys(items[firstKey]);
    }

    // Get field order from existing config items
    getExistingFieldOrder(config, protocol, type) {
        const items = config?.[protocol]?.[type];
        if (!items || Object.keys(items).length === 0) return null;
        
        // Get field order from the first existing item
        const firstKey = Object.keys(items)[0];
        return Object.keys(items[firstKey]);
    }

    // Reorder object keys based on reference order
    reorderFields(obj, referenceOrder) {
        if (!referenceOrder || !obj || typeof obj !== 'object') return obj;
        
        const ordered = {};
        
        // First add fields in reference order
        referenceOrder.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                ordered[key] = obj[key];
            }
        });
        
        // Then add any remaining fields not in reference
        Object.keys(obj).forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
                ordered[key] = obj[key];
            }
        });
        
        return ordered;
    }

    async saveConfig(config) {
        // Ensure directory exists
        const dir = require('path').dirname(this.configPath);
        if (!fsSync.existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true });
        }

        // Clean empty sections
        ['http', 'tcp', 'udp'].forEach(protocol => {
            if (config[protocol]) {
                if (config[protocol].middleware) delete config[protocol].middleware;
                ['routers', 'middlewares', 'services', 'serversTransports'].forEach(section => {
                    if (config[protocol][section] && Object.keys(config[protocol][section]).length === 0) {
                        delete config[protocol][section];
                    }
                });
                if (Object.keys(config[protocol]).length === 0) delete config[protocol];
            }
        });

        // Remove empty nested objects recursively before dumping
        config = this.removeEmptyObjects(config) || {};
        
        const yamlContent = yaml.dump(config, {
            indent: 2,
            lineWidth: -1,
            noRefs: true,
            sortKeys: false,
            quotingType: '"',
            forceQuotes: false
        });
        
        // Post-process to quote values that need it
        const processedYaml = this.postProcessYaml(yamlContent);
        
        await fs.writeFile(this.configPath, processedYaml, 'utf8');
        console.log(`ConfigWriter: Saved config to ${this.configPath}`);
    }

    // Remove empty objects/arrays recursively
    removeEmptyObjects(obj) {
        if (obj === null || obj === undefined) return undefined;
        if (Array.isArray(obj)) {
            const cleaned = obj
                .map(item => typeof item === 'object' ? this.removeEmptyObjects(item) : item)
                .filter(item => item !== undefined && item !== null);
            return cleaned.length > 0 ? cleaned : undefined;
        }
        if (typeof obj === 'object') {
            const cleaned = {};
            for (const [key, value] of Object.entries(obj)) {
                if (value === null || value === undefined || value === '') continue;
                if (typeof value === 'object') {
                    const cleanedValue = this.removeEmptyObjects(value);
                    if (cleanedValue !== undefined && 
                        !(typeof cleanedValue === 'object' && Object.keys(cleanedValue).length === 0)) {
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
    postProcessYaml(yamlContent) {
        const lines = yamlContent.split('\n');
        const processedLines = lines.map(line => {
            // Match lines with key: value pattern
            const match = line.match(/^(\s*-?\s*)(\w+):\s*(.+)$/);
            if (match) {
                const [, prefix, key, value] = match;
                // Check if value needs quoting (contains *, backticks, or starts with special chars)
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

    cleanConfig(obj) {
        if (obj === null || obj === undefined) return undefined;
        if (Array.isArray(obj)) {
            const cleaned = obj
                .filter(item => item !== null && item !== undefined && item !== '')
                .map(item => typeof item === 'object' ? this.cleanConfig(item) : item)
                .filter(item => item !== undefined);
            return cleaned.length > 0 ? cleaned : undefined;
        }
        if (typeof obj === 'object') {
            const cleaned = {};
            for (const [key, value] of Object.entries(obj)) {
                if (value === null || value === undefined || value === '') continue;
                if (Array.isArray(value)) {
                    const cleanedArray = this.cleanConfig(value);
                    if (cleanedArray && cleanedArray.length > 0) cleaned[key] = cleanedArray;
                } else if (typeof value === 'object') {
                    const cleanedObj = this.cleanConfig(value);
                    if (cleanedObj !== undefined) cleaned[key] = cleanedObj;
                } else if (typeof value === 'boolean' || typeof value === 'number') {
                    cleaned[key] = value;
                } else if (typeof value === 'string' && value.trim() !== '') {
                    cleaned[key] = value;
                }
            }
            return Object.keys(cleaned).length > 0 ? cleaned : undefined;
        }
        return obj;
    }

    async addMiddleware(protocol, name, middlewareType, middlewareConfig) {
        if (!['http', 'tcp'].includes(protocol)) {
            throw new Error(`Invalid protocol: ${protocol}`);
        }
        if (!middlewareType || !name) {
            throw new Error('Middleware type and name are required');
        }

        await this.loadTemplate();
        const config = await this.loadConfig();
        
        if (!config[protocol]) config[protocol] = {};
        if (!config[protocol].middlewares) config[protocol].middlewares = {};
        if (config[protocol].middlewares[name]) {
            throw new Error(`Middleware '${name}' already exists`);
        }

        const cleanedConfig = this.cleanConfig(middlewareConfig) || {};
        config[protocol].middlewares[name] = { [middlewareType]: cleanedConfig };
        await this.saveConfig(config);

        const verify = await this.loadConfig();
        return { success: !!verify[protocol]?.middlewares?.[name], name, protocol, type: 'middleware' };
    }

    async addRouter(protocol, name, routerConfig, serviceConfig = null) {
        if (!['http', 'tcp', 'udp'].includes(protocol)) {
            throw new Error(`Invalid protocol: ${protocol}`);
        }
        if (!name) {
            throw new Error('Router name is required');
        }

        await this.loadTemplate();
        const config = await this.loadConfig();
        
        // Ensure protocol section exists
        if (!config[protocol]) config[protocol] = {};
        
        // Ensure routers section exists
        if (!config[protocol].routers) config[protocol].routers = {};
        
        // Check for duplicate router name
        if (config[protocol].routers[name]) {
            throw new Error(`Router '${name}' already exists in ${protocol}`);
        }

        // Clean router config
        let cleanedRouter = this.cleanConfig(routerConfig);
        if (!cleanedRouter) {
            throw new Error('Router configuration is empty');
        }

        // Get field order - prefer existing config order, fall back to template
        const existingOrder = this.getExistingFieldOrder(config, protocol, 'routers');
        const templateOrder = this.getTemplateFieldOrder(protocol, 'routers');
        const fieldOrder = existingOrder || templateOrder;

        // Reorder fields to match existing structure
        if (fieldOrder) {
            cleanedRouter = this.reorderFields(cleanedRouter, fieldOrder);
        }
        
        // Add router
        config[protocol].routers[name] = cleanedRouter;

        // Add service if provided
        if (serviceConfig && serviceConfig.name) {
            if (!config[protocol].services) config[protocol].services = {};
            
            const serviceName = serviceConfig.name;
            
            if (config[protocol].services[serviceName]) {
                throw new Error(`Service '${serviceName}' already exists in ${protocol}`);
            }
            
            // Extract just the loadBalancer part for the service config
            const serviceData = {
                loadBalancer: serviceConfig.loadBalancer
            };
            
            let cleanedService = this.cleanConfig(serviceData);
            
            // Get service field order
            const existingServiceOrder = this.getExistingFieldOrder(config, protocol, 'services');
            const templateServiceOrder = this.getTemplateFieldOrder(protocol, 'services');
            const serviceFieldOrder = existingServiceOrder || templateServiceOrder;
            
            if (serviceFieldOrder && cleanedService) {
                cleanedService = this.reorderFields(cleanedService, serviceFieldOrder);
            }
            
            if (cleanedService) {
                config[protocol].services[serviceName] = cleanedService;
            }
        }

        await this.saveConfig(config);
        
        const verify = await this.loadConfig();
        const routerSaved = !!verify[protocol]?.routers?.[name];
        const serviceSaved = !serviceConfig?.name || !!verify[protocol]?.services?.[serviceConfig.name];
        
        return { 
            success: routerSaved && serviceSaved, 
            name, 
            protocol, 
            type: 'router',
            serviceName: serviceConfig?.name 
        };
    }

    async deleteMiddleware(protocol, name) {
        console.log(`ConfigWriter.deleteMiddleware: protocol=${protocol}, name=${name}, configPath=${this.configPath}`);
        
        const config = await this.loadConfig();
        
        if (!config[protocol]?.middlewares?.[name]) {
            throw new Error(`Middleware '${name}' not found in ${protocol}`);
        }
        
        delete config[protocol].middlewares[name];
        
        // Clean up empty sections
        if (config[protocol].middlewares && Object.keys(config[protocol].middlewares).length === 0) {
            delete config[protocol].middlewares;
        }
        if (config[protocol] && Object.keys(config[protocol]).length === 0) {
            delete config[protocol];
        }
        
        await this.saveConfig(config);
        console.log(`ConfigWriter: Successfully deleted middleware ${name}`);
        return { success: true };
    }

    async deleteRouter(protocol, name) {
        console.log(`ConfigWriter.deleteRouter: protocol=${protocol}, name=${name}, configPath=${this.configPath}`);
        
        const config = await this.loadConfig();
        
        if (!config[protocol]?.routers?.[name]) {
            throw new Error(`Router '${name}' not found in ${protocol}`);
        }
        
        delete config[protocol].routers[name];
        
        // Clean up empty sections
        if (config[protocol].routers && Object.keys(config[protocol].routers).length === 0) {
            delete config[protocol].routers;
        }
        if (config[protocol] && Object.keys(config[protocol]).length === 0) {
            delete config[protocol];
        }
        
        await this.saveConfig(config);
        console.log(`ConfigWriter: Successfully deleted router ${name}`);
        return { success: true };
    }

    async deleteService(protocol, name) {
        console.log(`ConfigWriter.deleteService: protocol=${protocol}, name=${name}, configPath=${this.configPath}`);
        
        const config = await this.loadConfig();
        
        if (!config[protocol]?.services?.[name]) {
            throw new Error(`Service '${name}' not found in ${protocol}`);
        }
        
        delete config[protocol].services[name];
        
        // Clean up empty sections
        if (config[protocol].services && Object.keys(config[protocol].services).length === 0) {
            delete config[protocol].services;
        }
        if (config[protocol] && Object.keys(config[protocol]).length === 0) {
            delete config[protocol];
        }
        
        await this.saveConfig(config);
        console.log(`ConfigWriter: Successfully deleted service ${name}`);
        return { success: true };
    }
}

module.exports = ConfigWriter;
