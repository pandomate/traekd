class RouterHandler {
    constructor(modal) {
        this.modal = modal;
        this.certResolvers = [];
        this.entryPointOptions = [];
        this.existingRouters = [];
        this.existingServices = [];
    }

    // Load settings from viewer
    loadSettingsFromViewer() {
        const settings = this.modal.viewer.getSettings();
        this.certResolvers = Array.isArray(settings.certResolvers) ? settings.certResolvers : [];
        this.entryPointOptions = Array.isArray(settings.entryPoints) ? settings.entryPoints : [];
    }

    getSteps() {
        if (this.modal.protocol === 'udp') {
            return ['Type', 'Basic', 'Service'];
        }
        return ['Type', 'Basic', 'Middlewares', 'Service'];
    }

    isLastStep() {
        if (this.modal.protocol === 'udp') {
            return this.modal.currentStep === 2;
        }
        return this.modal.currentStep === 3;
    }

    // Load existing names for duplicate checking
    loadExistingNames() {
        this.existingRouters = Object.keys(this.modal.viewer.getSection(this.modal.protocol, 'routers'));
        this.existingServices = Object.keys(this.modal.viewer.getSection(this.modal.protocol, 'services'));
    }

    // Reset all router-specific form data
    resetRouterData() {
        const keysToRemove = [
            'name', 'rule', 'ruleType', 'ruleValue1', 'ruleValue2',
            'entryPoint', 'priority', 'tlsMode', 
            'tls.certResolver', 'tls.certResolverAdv', 
            'tls.mainPrefix', 'tls.mainDomain', 'tls.passthrough',
            'sans', 'middlewares', 'serviceType', 
            'existingService', 'serviceName', 'servers'
        ];
        keysToRemove.forEach(key => {
            delete this.modal.formData[key];
        });
        this.modal.selectedRuleType = null;
    }

    // Check if router name is duplicate
    isRouterNameDuplicate(name) {
        return this.existingRouters.includes(name);
    }

    // Check if service name is duplicate
    isServiceNameDuplicate(name) {
        return this.existingServices.includes(name);
    }

    // Validate server URL format
    isValidServerUrl(url, protocol) {
        if (!url) return false;
        
        if (protocol === 'http') {
            // HTTP services: must be http(s)://ip-address or http(s)://ip-address:port
            const httpPattern = /^https?:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/;
            if (!httpPattern.test(url)) return false;
            
            // Validate IP octets
            const ipMatch = url.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
            if (ipMatch) {
                for (let i = 1; i <= 4; i++) {
                    const octet = parseInt(ipMatch[i], 10);
                    if (octet < 0 || octet > 255) return false;
                }
            }
            return true;
        } else {
            // TCP/UDP services: ip-address:port
            const tcpPattern = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/;
            if (!tcpPattern.test(url)) return false;
            
            // Validate IP octets
            const ipMatch = url.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
            if (ipMatch) {
                for (let i = 1; i <= 4; i++) {
                    const octet = parseInt(ipMatch[i], 10);
                    if (octet < 0 || octet > 255) return false;
                }
            }
            return true;
        }
    }

    validateStep(step, body) {
        if (step === 1) {
            let valid = true;
            
            // Validate router name with regex
            const nameInput = body.querySelector('#router-name');
            const nameValue = nameInput?.value?.trim() || '';
            const nameRegex = /^[a-zA-Z0-9_-]+$/;
            
            if (!nameValue || !nameRegex.test(nameValue)) {
                nameInput?.classList.add('input-error');
                valid = false;
            } else if (this.isRouterNameDuplicate(nameValue)) {
                nameInput?.classList.add('input-error');
                valid = false;
            } else {
                nameInput?.classList.remove('input-error');
            }
            
            // Validate entry point selection
            const entryPointSelect = body.querySelector('#entry-point-select');
            if (!entryPointSelect?.value || entryPointSelect.selectedOptions[0?.disabled]) {
                entryPointSelect?.classList.add('input-error');
                valid = false;
            } else {
                entryPointSelect?.classList.remove('input-error');
            }
            
            // Validate rule (for non-UDP)
            if (this.modal.protocol !== 'udp') {
                const ruleValue = document.getElementById('rule-value-1')?.value;
                if (!ruleValue?.trim()) {
                    document.getElementById('rule-value-1')?.classList.add('input-error');
                    valid = false;
                } else {
                    document.getElementById('rule-value-1')?.classList.remove('input-error');
                }
            }

            // Validate all required dropdowns dynamically
            body.querySelectorAll('select.required-field, select[required]').forEach(select => {
                if (!select.value || select.selectedOptions[0?.disabled]) {
                    select.classList.add('input-error');
                    valid = false;
                } else {
                    select.classList.remove('input-error');
                }
            });

            // Validate all required text inputs (non-array)
            body.querySelectorAll('input.required-field[type="text"]:not(.array-input), input.required-field[type="number"]').forEach(input => {
                if (!input.value?.trim()) {
                    input.classList.add('input-error');
                    valid = false;
                } else {
                    input.classList.remove('input-error');
                }
            });

            // Validate required array inputs
            body.querySelectorAll('.array-input-container.required-field').forEach(container => {
                const items = container.querySelectorAll('.array-item');
                const arrayInput = container.querySelector('.array-input');
                if (items.length === 0) {
                    arrayInput?.classList.add('input-error');
                    valid = false;
                } else {
                    arrayInput?.classList.remove('input-error');
                }
            });
            
            return valid;
        }
        
        if (step === 3) {
            let valid = true;
            const serviceType = this.modal.formData.serviceType || 'existing';
            
            if (serviceType === 'existing') {
                const existingServiceSelect = body.querySelector('#existing-service');
                if (existingServiceSelect && (!existingServiceSelect.value || existingServiceSelect.selectedOptions[0?.disabled])) {
                    existingServiceSelect.classList.add('input-error');
                    valid = false;
                } else if (existingServiceSelect) {
                    existingServiceSelect.classList.remove('input-error');
                }
            } else if (serviceType === 'new') {
                // Validate service name
                const serviceNameInput = body.querySelector('#service-name');
                const serviceNameValue = serviceNameInput?.value?.trim() || '';
                
                if (!serviceNameValue) {
                    serviceNameInput?.classList.add('input-error');
                    valid = false;
                } else if (this.isServiceNameDuplicate(serviceNameValue)) {
                    serviceNameInput?.classList.add('input-error');
                    valid = false;
                } else {
                    serviceNameInput?.classList.remove('input-error');
                }
                
                // Validate server URLs
                const serverInputs = body.querySelectorAll('.server-input');
                let hasValidServer = false;
                
                serverInputs.forEach((input, index) => {
                    const value = input.value.trim();
                    const errorHint = input.parentElement?.querySelector('.server-error-hint');
                    
                    if (index === 0 && !value) {
                        // First server is required
                        input.classList.add('input-error');
                        if (errorHint) {
                            errorHint.textContent = 'At least one server is required';
                            errorHint.classList.remove('hidden');
                        }
                        valid = false;
                    } else if (value && !this.isValidServerUrl(value, this.modal.protocol)) {
                        input.classList.add('input-error');
                        if (errorHint) {
                            if (this.modal.protocol === 'http') {
                                errorHint.textContent = 'Invalid format. Use http(s)://IP:port (e.g., http://192.168.1.10:8080)';
                            } else {
                                errorHint.textContent = 'Invalid format. Use IP:port (e.g., 192.168.1.10:8080)';
                            }
                            errorHint.classList.remove('hidden');
                        }
                        valid = false;
                    } else if (value) {
                        input.classList.remove('input-error');
                        if (errorHint) errorHint.classList.add('hidden');
                        hasValidServer = true;
                    } else {
                        input.classList.remove('input-error');
                        if (errorHint) errorHint.classList.add('hidden');
                    }
                });
                
                if (!hasValidServer) {
                    valid = false;
                }
            }
            
            return valid;
        }
        
        return true;
    }

    renderStep(step, title, body, nextBtn) {
        this.loadExistingNames();
        this.loadSettingsFromViewer();
        
        if (step === 1) {
            this.renderBasicConfig(title, body, nextBtn);
        } else if (step === 2) {
            if (this.modal.protocol === 'udp') {
                this.renderServiceConfig(title, body, nextBtn);
            } else {
                this.renderMiddlewaresConfig(title, body, nextBtn);
            }
        } else if (step === 3) {
            this.renderServiceConfig(title, body, nextBtn);
        }
    }

    getHttpRuleTypes() {
        return [
            { key: 'Host', label: 'Host', placeholder: 'example.com', desc: 'Match by domain name' },
            { key: 'HostRegexp', label: 'Host Regexp', placeholder: '.*\\.example\\.com', desc: 'Match host by regex' },
            { key: 'Path', label: 'Path', placeholder: '/api/v1', desc: 'Match exact path' },
            { key: 'PathPrefix', label: 'Path Prefix', placeholder: '/api', desc: 'Match path prefix' },
            { key: 'PathRegexp', label: 'Path Regexp', placeholder: '/api/.*', desc: 'Match path by regex' },
            { key: 'Method', label: 'Method', placeholder: 'GET', desc: 'Match HTTP method' },
            { key: 'Header', label: 'Header', placeholder: 'X-Custom-Header, value', desc: 'Match header key=value' },
            { key: 'HeaderRegexp', label: 'Header Regexp', placeholder: 'X-Custom-Header, .*', desc: 'Match header by regex' },
            { key: 'Query', label: 'Query', placeholder: 'key, value', desc: 'Match query parameter' },
            { key: 'QueryRegexp', label: 'Query Regexp', placeholder: 'key, .*', desc: 'Match query by regex' },
            { key: 'ClientIP', label: 'Client IP', placeholder: '192.168.1.0/24', desc: 'Match client IP/CIDR' }
        ];
    }

    getTcpRuleTypes() {
        return [
            { key: 'HostSNI', label: 'Host SNI', placeholder: 'example.com', desc: 'Match by SNI' },
            { key: 'HostSNIRegexp', label: 'Host SNI Regexp', placeholder: '.*\\.example\\.com', desc: 'Match SNI by regex' },
            { key: 'ClientIP', label: 'Client IP', placeholder: '192.168.1.0/24', desc: 'Match client IP/CIDR' },
            { key: 'ALPN', label: 'ALPN', placeholder: 'h2', desc: 'Match ALPN protocol' }
        ];
    }

    getTlsOptions() {
        // Extract TLS options from template schema if available
        const schema = this.modal.templateSchema;
        if (schema?.tls?.options) {
            return Object.keys(schema.tls.options);
        }
        return [];
    }

    renderBasicConfig(title, body, nextBtn) {
        title.textContent = `Configure ${this.modal.protocol.toUpperCase()} Router`;
        nextBtn.textContent = this.modal.protocol === 'udp' ? 'Next: Service' : 'Next: Middlewares';

        const ruleTypes = this.modal.protocol === 'http' ? this.getHttpRuleTypes() : 
                         this.modal.protocol === 'tcp' ? this.getTcpRuleTypes() : [];
        
        const defaultRuleType = this.modal.protocol === 'http' ? 'Host' : 
                               this.modal.protocol === 'tcp' ? 'HostSNI' : null;
        
        this.modal.selectedRuleType = this.modal.formData.ruleType || defaultRuleType;
        
        const currentTlsMode = this.modal.formData.tlsMode || 'none';
        const tlsOptions = this.getTlsOptions();

        body.innerHTML = `
            <div class="config-form">
                <div class="form-group">
                    <label for="router-name">Router Name <span class="required">*</span></label>
                    <input type="text" id="router-name" name="name" class="form-input required-field" required 
                           placeholder="my-router" value="${this.modal.formData.name || ''}">
                    <span class="form-hint" id="router-name-hint">Letters, numbers, dashes and underscores only</span>
                    <span class="form-error-hint hidden" id="router-name-error">Router name already exists</span>
                </div>
                
                ${this.modal.protocol !== 'udp' ? `
                <div class="form-group">
                    <label>Rule Type <span class="required">*</span></label>
                    <div class="rule-builder">
                        <div class="rule-type-select" id="rule-type-select">
                            ${ruleTypes.map(rt => `
                                <button type="button" class="rule-type-btn ${this.modal.selectedRuleType === rt.key ? 'active' : ''}" 
                                        data-type="${rt.key}" title="${rt.desc}">
                                    ${rt.label}
                                </button>
                            `).join('')}
                        </div>
                        <div class="rule-input-group" id="rule-input-group">
                            ${this.renderRuleInput()}
                        </div>
                        <div class="rule-preview-label">Generated Rule:</div>
                        <div class="rule-preview" id="rule-preview">${this.modal.formData.rule || this.generateRulePreview()}</div>
                    </div>
                    <input type="hidden" name="rule" id="rule-hidden" value="${this.modal.formData.rule || ''}">
                </div>
                ` : ''}
                
                <div class="form-group">
                    <label for="entry-point-select">Entry Point <span class="required">*</span></label>
                    <select id="entry-point-select" name="entryPoint" class="form-select required-field" required>
                        <option value="" disabled ${!this.modal.formData.entryPoint ? 'selected' : ''}>Select an option</option>
                        ${this.entryPointOptions.map(ep => `
                            <option value="${ep}" ${this.modal.formData.entryPoint === ep ? 'selected' : ''}>${ep}</option>
                        `).join('')}
                    </select>
                    <span class="form-hint">web = HTTP:80, websecure = HTTPS:443</span>
                </div>
                
                ${this.modal.protocol !== 'udp' ? `
                <div class="form-group">
                    <label for="router-priority">Priority</label>
                    <input type="number" id="router-priority" name="priority" class="form-input" 
                           placeholder="Auto-calculated if empty" value="${this.modal.formData.priority || ''}">
                    <span class="form-hint">Higher values = higher priority</span>
                </div>
                
                <div class="form-divider"></div>
                <h4 class="form-section-title">TLS Configuration</h4>
                
                <div class="form-group">
                    <div class="tls-options-group">
                        <label class="radio-inline">
                            <input type="radio" name="tlsMode" value="none" ${currentTlsMode === 'none' ? 'checked' : ''}>
                            <span>No TLS</span>
                        </label>
                        <label class="radio-inline">
                            <input type="radio" name="tlsMode" value="simple" ${currentTlsMode === 'simple' ? 'checked' : ''}>
                            <span>Enable TLS</span>
                        </label>
                        <label class="radio-inline">
                            <input type="radio" name="tlsMode" value="advanced" ${currentTlsMode === 'advanced' ? 'checked' : ''}>
                            <span>Advanced TLS</span>
                        </label>
                    </div>
                </div>
                
                <div id="tls-simple-options" class="${currentTlsMode === 'simple' ? '' : 'hidden'}">
                    <div class="form-group">
                        <label for="cert-resolver">Certificate Resolver <span class="required">*</span></label>
                        <select id="cert-resolver" name="tls.certResolver" class="form-select">
                            <option value="" disabled ${!this.modal.formData['tls.certResolver'] ? 'selected' : ''}>Select an option</option>
                            ${this.certResolvers.map(cr => `
                                <option value="${cr}" ${this.modal.formData['tls.certResolver'] === cr ? 'selected' : ''}>${cr}</option>
                            `).join('')}
                        </select>
                    </div>
                </div>
                
                <div id="tls-advanced-options" class="${currentTlsMode === 'advanced' ? '' : 'hidden'}">
                    ${this.modal.protocol === 'tcp' ? `
                    <div class="form-group">
                        <label class="checkbox-label">
                            <input type="checkbox" name="tls.passthrough" ${this.modal.formData['tls.passthrough'] ? 'checked' : ''}>
                            <span>TLS Passthrough (forward encrypted traffic to backend)</span>
                        </label>
                        <span class="form-hint">When enabled, TLS termination happens at the backend, not Traefik</span>
                    </div>
                    ` : ''}
                    
                    <div class="form-group">
                        <label for="cert-resolver-adv">Certificate Resolver</label>
                        <select id="cert-resolver-adv" name="tls.certResolverAdv" class="form-select">
                            <option value="">None</option>
                            ${this.certResolvers.map(cr => `
                                <option value="${cr}" ${this.modal.formData['tls.certResolverAdv'] === cr ? 'selected' : ''}>${cr}</option>
                            `).join('')}
                        </select>
                    </div>
                    
                    <div class="form-group">
                        <label for="tls-options">TLS Options</label>
                        <select id="tls-options" name="tls.options" class="form-select">
                            <option value="">Default</option>
                            ${tlsOptions.map(opt => `
                                <option value="${opt}" ${this.modal.formData['tls.options'] === opt ? 'selected' : ''}>${opt}</option>
                            `).join('')}
                        </select>
                        <span class="form-hint">TLS options defined in your Traefik configuration</span>
                    </div>

                    <div class="form-group">
                        <label>Domains</label>
                        <div class="tls-domains-list" id="tls-domains-list">
                            ${this.renderTlsDomainCards()}
                        </div>
                        <button type="button" class="add-domain-btn" id="add-tls-domain-btn">+ Add Domain</button>
                        <span class="form-hint">Configure domains for certificate generation</span>
                    </div>
                </div>
                ` : ''}
            </div>
        `;

        // Bind router name duplicate check
        const routerNameInput = document.getElementById('router-name');
        const routerNameError = document.getElementById('router-name-error');
        const routerNameHint = document.getElementById('router-name-hint');
        
        routerNameInput?.addEventListener('input', () => {
            const value = routerNameInput.value.trim();
            const nameRegex = /^[a-zA-Z0-9_-]+$/;
            
            if (value && this.isRouterNameDuplicate(value)) {
                routerNameInput.classList.add('input-error');
                routerNameError?.classList.remove('hidden');
                routerNameHint?.classList.add('hidden');
            } else if (value && !nameRegex.test(value)) {
                routerNameInput.classList.add('input-error');
                routerNameError?.classList.add('hidden');
                routerNameHint?.classList.remove('hidden');
            } else if (value) {
                routerNameInput.classList.remove('input-error');
                routerNameError?.classList.add('hidden');
                routerNameHint?.classList.remove('hidden');
            }
        });

        // Bind rule type selection
        if (this.modal.protocol !== 'udp') {
            document.querySelectorAll('.rule-type-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.rule-type-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.modal.selectedRuleType = btn.dataset.type;
                    this.modal.formData.ruleType = this.modal.selectedRuleType;
                    document.getElementById('rule-input-group').innerHTML = this.renderRuleInput();
                    this.updateRulePreview();
                    this.bindRuleInputEvents();
                });
            });
            
            this.bindRuleInputEvents();
        }

        // Bind TLS mode toggle
        document.querySelectorAll('input[name="tlsMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.modal.formData.tlsMode = e.target.value;
                document.getElementById('tls-simple-options')?.classList.toggle('hidden', e.target.value !== 'simple');
                document.getElementById('tls-advanced-options')?.classList.toggle('hidden', e.target.value !== 'advanced');
            });
        });

        this.bindTlsDomainEvents();
        this.modal.bindFormEvents(body);
    }

    renderTlsDomainCards() {
        const domains = this.modal.formData.tlsDomains || [];
        if (!domains.length) {
            return '<p class="tls-domains-empty">No domains configured. Add a domain to enable certificate generation.</p>';
        }
        return domains.map((domain, index) => {
            const main = domain.main || '';
            const sans = domain.sans || [];
            return `
                <div class="tls-domain-card" data-index="${index}">
                    <div class="tls-domain-header">
                        <span class="tls-domain-title">Domain ${index + 1}</span>
                        <button type="button" class="tls-domain-remove" data-index="${index}">×</button>
                    </div>
                    <div class="form-group">
                        <label>Main Domain</label>
                        <input type="text" class="form-input tls-domain-main" data-index="${index}" 
                               placeholder="example.com or *.example.com" value="${main}">
                        <span class="form-hint">Use * for wildcard (e.g., *.example.com)</span>
                    </div>
                    <div class="form-group">
                        <label>SANs (Subject Alternative Names)</label>
                        <div class="tls-sans-container" data-index="${index}">
                            ${sans.map((san, sanIndex) => `
                                <div class="tls-san-item">
                                    <input type="text" class="form-input tls-san-input" 
                                           data-domain-index="${index}" data-san-index="${sanIndex}" 
                                           value="${san}" placeholder="sub.example.com">
                                    <button type="button" class="tls-san-remove" 
                                            data-domain-index="${index}" data-san-index="${sanIndex}">×</button>
                                </div>
                            `).join('')}
                        </div>
                        <button type="button" class="tls-add-san-btn" data-index="${index}">+ Add SAN</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    bindTlsDomainEvents() {
        // Add domain button
        document.getElementById('add-tls-domain-btn')?.addEventListener('click', () => {
            if (!this.modal.formData.tlsDomains) {
                this.modal.formData.tlsDomains = [];
            }
            this.modal.formData.tlsDomains.push({ main: '', sans: [] });
            this.refreshTlsDomains();
        });

        // Bind existing domain events
        this.bindTlsDomainCardEvents();
    }

    bindTlsDomainCardEvents() {
        // Remove domain
        document.querySelectorAll('.tls-domain-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = Number(btn.dataset.index);
                if (this.modal.formData.tlsDomains) {
                    this.modal.formData.tlsDomains.splice(index, 1);
                    this.refreshTlsDomains();
                }
            });
        });

        // Main domain input
        document.querySelectorAll('.tls-domain-main').forEach(input => {
            input.addEventListener('input', () => {
                const index = Number(input.dataset.index);
                if (this.modal.formData.tlsDomains && this.modal.formData.tlsDomains[index]) {
                    this.modal.formData.tlsDomains[index].main = input.value.trim();
                }
            });
        });

        // Add SAN button
        document.querySelectorAll('.tls-add-san-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = Number(btn.dataset.index);
                if (this.modal.formData.tlsDomains && this.modal.formData.tlsDomains[index]) {
                    if (!this.modal.formData.tlsDomains[index].sans) {
                        this.modal.formData.tlsDomains[index].sans = [];
                    }
                    this.modal.formData.tlsDomains[index].sans.push('');
                    this.refreshTlsDomains();
                }
            });
        });

        // SAN input
        document.querySelectorAll('.tls-san-input').forEach(input => {
            input.addEventListener('input', () => {
                const domainIndex = Number(input.dataset.domainIndex);
                const sanIndex = Number(input.dataset.sanIndex);
                if (this.modal.formData.tlsDomains && 
                    this.modal.formData.tlsDomains[domainIndex] && 
                    this.modal.formData.tlsDomains[domainIndex].sans) {
                    this.modal.formData.tlsDomains[domainIndex].sans[sanIndex] = input.value.trim();
                }
            });
        });

        // Remove SAN
        document.querySelectorAll('.tls-san-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const domainIndex = Number(btn.dataset.domainIndex);
                const sanIndex = Number(btn.dataset.sanIndex);
                if (this.modal.formData.tlsDomains && 
                    this.modal.formData.tlsDomains[domainIndex] && 
                    this.modal.formData.tlsDomains[domainIndex].sans) {
                    this.modal.formData.tlsDomains[domainIndex].sans.splice(sanIndex, 1);
                    this.refreshTlsDomains();
                }
            });
        });
    }

    refreshTlsDomains() {
        const container = document.getElementById('tls-domains-list');
        if (container) {
            container.innerHTML = this.renderTlsDomainCards();
            this.bindTlsDomainCardEvents();
        }
   }

    // ...existing code...

    getFieldOrder(section) {
        const existing = this.modal.viewer.getSection(this.modal.protocol, section);
        const existingKeys = Object.keys(existing || {});
        if (existingKeys.length) {
            const sample = existing[existingKeys[0]];
            if (sample && typeof sample === 'object') {
                return Object.keys(sample);
            }
        }
        const templateSection = this.modal.templateSchema?.[this.modal.protocol]?.[section];
        if (templateSection) {
            const templateKey = Object.keys(templateSection)[0];
            if (templateKey && typeof templateSection[templateKey] === 'object') {
                return Object.keys(templateSection[templateKey]);
            }
        }
        return null;
    }

    reorderByOrder(obj, order) {
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

    buildConfig() {
        const routerConfig = {};
        
        // Rule (required for HTTP/TCP, not UDP)
        if (this.modal.protocol !== 'udp' && this.modal.formData.rule) {
            routerConfig.rule = this.modal.formData.rule;
        }
        
        // Entry points
        if (this.modal.formData.entryPoint) {
            routerConfig.entryPoints = [this.modal.formData.entryPoint];
        }
        
        // Service - set BEFORE ordering
        let serviceConfig = null;
        if (this.modal.formData.serviceType === 'new') {
            routerConfig.service = this.modal.formData.serviceName;
            serviceConfig = {
                name: this.modal.formData.serviceName,
                loadBalancer: {
                    servers: this.collectServers()
                }
            };
        } else {
            routerConfig.service = this.modal.formData.existingService;
        }
        
        // TLS configuration
        const tlsMode = this.modal.formData.tlsMode;
        if (tlsMode === 'none') {
            // No TLS - don't add tls key at all
        } else if (tlsMode === 'simple') {
            routerConfig.tls = {};
            if (this.modal.formData['tls.certResolver']) {
                routerConfig.tls.certResolver = this.modal.formData['tls.certResolver'];
            }
        } else if (tlsMode === 'advanced') {
            routerConfig.tls = {};
            
            // TCP passthrough
            if (this.modal.protocol === 'tcp' && this.modal.formData['tls.passthrough']) {
                routerConfig.tls.passthrough = true;
            }
            
            // Cert resolver
            if (this.modal.formData['tls.certResolverAdv']) {
                routerConfig.tls.certResolver = this.modal.formData['tls.certResolverAdv'];
            }
            
            // TLS options
            if (this.modal.formData['tls.options']) {
                routerConfig.tls.options = this.modal.formData['tls.options'];
            }
            
            // Domains - use the new structure
            const tlsDomains = this.modal.formData.tlsDomains || [];
            if (tlsDomains.length > 0) {
                routerConfig.tls.domains = tlsDomains
                    .filter(d => d.main && d.main.trim())
                    .map(d => {
                        const domain = { main: d.main.trim() };
                        const validSans = (d.sans || []).filter(s => s && s.trim());
                        if (validSans.length > 0) {
                            domain.sans = validSans.map(s => s.trim());
                        }
                        return domain;
                    });
            }
        }
        
        // Middlewares (not for UDP)
        if (this.modal.protocol !== 'udp') {
            const middlewares = this.modal.formData.middlewares || [];
            if (middlewares.length > 0) {
                routerConfig.middlewares = middlewares;
            }
        }
        
        // Priority (optional)
        if (this.modal.formData.priority) {
            routerConfig.priority = parseInt(this.modal.formData.priority);
        }
        
        // Order the router config AFTER all fields are set
        const routerOrder = this.getFieldOrder('routers');
        const orderedRouterConfig = this.reorderByOrder(routerConfig, routerOrder);

        // Order service config if created
        if (serviceConfig) {
            const serviceOrder = this.getFieldOrder('services');
            serviceConfig = this.reorderByOrder(serviceConfig, serviceOrder);
        }

        return {
            protocol: this.modal.protocol,
            type: 'router',
            name: this.modal.formData.name,
            router: orderedRouterConfig,
            service: serviceConfig
        };
    }

    async submitRouter() {
        const config = this.buildConfig();
        if (!config) {
            return { success: false, error: 'Invalid router configuration' };
        }

        try {
            const res = await fetch('/api/config/router', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const result = await res.json();

            if (res.ok && result.success) {
                return { success: true, name: config.name };
            }
            return { success: false, error: result.error || 'Failed to save router' };
        } catch (e) {
            return { success: false, error: 'Network error: ' + e.message };
        }
    }

    bindDomainInputEvents() {
        const cleanDomainPrefix = (input, domainSelect) => {
            let value = input.value.trim();
            const selectedDomain = domainSelect.value;
            if (value.endsWith('.' + selectedDomain)) {
                value = value.replace('.' + selectedDomain, '');
            } else if (value.endsWith(selectedDomain)) {
                value = value.replace(selectedDomain, '');
            }
            value = value.replace(/\.+$/, '');
            input.value = value;
        };

        document.querySelectorAll('.domain-prefix-input').forEach(input => {
            const domainSelect = input.closest('.domain-input-group')?.querySelector('.domain-select');
            if (domainSelect) {
                input.addEventListener('blur', () => cleanDomainPrefix(input, domainSelect));
            }
        });
    }

    addSanRow() {
        const sansList = document.getElementById('sans-list');
        const index = sansList?.children.length || 0;
        const row = document.createElement('div');
        row.className = 'san-input-row';
        row.dataset.index = index;
        row.innerHTML = `
            <div class="domain-input-group">
                <input type="text" class="form-input domain-prefix-input san-prefix" 
                       placeholder="@ or * or subdomain" value="">
                <span class="domain-separator">.</span>
                <select class="form-select domain-select san-domain">
                    <option value="" disabled selected>Select an option</option>
                    ${this.availableDomains.map(d => `<option value="${d}">${d}</option>`).join('')}
                </select>
            </div>
            <button type="button" class="remove-san-btn">×</button>
        `;
        sansList?.appendChild(row);
        this.bindSanRemoveEvents();
        this.bindDomainInputEvents();
    }

    bindSanRemoveEvents() {
        document.querySelectorAll('.remove-san-btn').forEach(btn => {
            btn.onclick = () => btn.closest('.san-input-row')?.remove();
        });
    }

    renderRuleInput() {
        const ruleTypes = this.modal.protocol === 'http' ? this.getHttpRuleTypes() : this.getTcpRuleTypes();
        const currentType = ruleTypes.find(rt => rt.key === this.modal.selectedRuleType);
        if (!currentType) return '';

        const needsTwoInputs = ['Header', 'HeaderRegexp', 'Query', 'QueryRegexp'].includes(this.modal.selectedRuleType);
        
        if (needsTwoInputs) {
            return `
                <input type="text" class="form-input rule-value-input required-field" id="rule-value-1" 
                       placeholder="Key (e.g., X-Custom-Header)" value="${this.modal.formData.ruleValue1 || ''}" required>
                <input type="text" class="form-input rule-value-input required-field" id="rule-value-2" 
                       placeholder="Value" value="${this.modal.formData.ruleValue2 || ''}" required>
            `;
        }
        
        return `
            <input type="text" class="form-input rule-value-input required-field" id="rule-value-1" 
                   placeholder="${currentType.placeholder}" value="${this.modal.formData.ruleValue1 || ''}" required>
        `;
    }

    bindRuleInputEvents() {
        document.querySelectorAll('.rule-value-input').forEach(input => {
            input.addEventListener('input', () => this.updateRulePreview());
        });
    }

    updateRulePreview() {
        const value1 = document.getElementById('rule-value-1')?.value || '';
        const value2 = document.getElementById('rule-value-2')?.value || '';
        
        this.modal.formData.ruleValue1 = value1;
        this.modal.formData.ruleValue2 = value2;
        
        const preview = this.generateRulePreview();
        document.getElementById('rule-preview').textContent = preview || '(enter a value to see the rule)';
        document.getElementById('rule-hidden').value = preview;
        this.modal.formData.rule = preview;
    }

    generateRulePreview() {
        const value1 = this.modal.formData.ruleValue1 || '';
        const value2 = this.modal.formData.ruleValue2 || '';
        
        if (!value1) return '';
        
        const needsTwoInputs = ['Header', 'HeaderRegexp', 'Query', 'QueryRegexp'].includes(this.modal.selectedRuleType);
        
        if (needsTwoInputs) {
            return `${this.modal.selectedRuleType}(\`${value1}\`, \`${value2}\`)`;
        }
        
        return `${this.modal.selectedRuleType}(\`${value1}\`)`;
    }

    renderMiddlewaresConfig(title, body, nextBtn) {
        title.textContent = 'Select Middlewares';
        nextBtn.textContent = 'Next: Service';

        const existingMiddlewares = Object.keys(this.modal.viewer.getSection(this.modal.protocol, 'middlewares'));
        const selectedMws = this.modal.formData.middlewares || [];

        body.innerHTML = `
            <div class="config-form">
                <p class="modal-description">Select middlewares to apply to this router (optional):</p>
                
                ${existingMiddlewares.length > 0 ? `
                <div class="middleware-selection-container">
                    <div class="middleware-available">
                        <div class="middleware-section-title">Available Middlewares</div>
                        <div class="middleware-available-list" id="middleware-available-list">
                            ${existingMiddlewares.filter(mw => !selectedMws.includes(mw)).map(mw => `
                                <button type="button" class="middleware-available-item" data-mw="${mw}">
                                    <span>${mw}</span>
                                    <span class="middleware-add-icon">+</span>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    <div class="middleware-selected">
                        <div class="middleware-section-title">Selected (drag to reorder)</div>
                        <div class="middleware-order-list" id="middleware-order-list">
                            ${selectedMws.length === 0 ? '<p class="middleware-empty-hint">Click middlewares to add them</p>' : ''}
                            ${selectedMws.map((mw, i) => `
                                <div class="middleware-order-item" data-mw="${mw}" draggable="true">
                                    <span class="middleware-order-number">${i + 1}</span>
                                    <span class="middleware-order-name">${mw}</span>
                                    <button type="button" class="middleware-remove-btn" title="Remove">×</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
                ` : `
                <div class="empty-middlewares">
                    <p>No middlewares configured yet for ${this.modal.protocol.toUpperCase()}.</p>
                </div>
                `}
                
                <button type="button" class="add-new-middleware-btn" id="add-new-mw-btn">
                    + Create New Middleware First
                </button>
            </div>
        `;

        document.getElementById('add-new-mw-btn')?.addEventListener('click', () => {
            this.modal.saveCurrentStepData();
            this.modal.formData.returnFromMiddleware = true;
            this.modal.formData.savedRouterStep = this.modal.currentStep;
            this.modal.configType = 'middleware';
            this.modal.currentStep = 1;
            this.modal.renderStep();
        });

        this.initMiddlewareSelector(body);
        this.modal.bindFormEvents(body);
    }

    initMiddlewareSelector(body) {
        const availableList = body.querySelector('#middleware-available-list');
        const orderList = body.querySelector('#middleware-order-list');
        
        if (!availableList || !orderList) return;
        
        if (!this.modal.formData.middlewares) {
            this.modal.formData.middlewares = [];
        }

        const self = this;
        let draggedItem = null;

        const updateMiddlewareOrder = () => {
            const items = orderList.querySelectorAll('.middleware-order-item');
            const order = Array.from(items).map(item => item.dataset.mw);
            self.modal.formData.middlewares = order;
            
            items.forEach((item, i) => {
                const numEl = item.querySelector('.middleware-order-number');
                if (numEl) numEl.textContent = i + 1;
            });
            
            const emptyHint = orderList.querySelector('.middleware-empty-hint');
            if (items.length === 0 && !emptyHint) {
                orderList.innerHTML = '<p class="middleware-empty-hint">Click middlewares to add them</p>';
            } else if (items.length > 0 && emptyHint) {
                emptyHint.remove();
            }
        };

        const createOrderItem = (mwName, index) => {
            const item = document.createElement('div');
            item.className = 'middleware-order-item';
            item.dataset.mw = mwName;
            item.draggable = true;
            item.innerHTML = `
                <span class="middleware-order-number">${index + 1}</span>
                <span class="middleware-order-name">${mwName}</span>
                <button type="button" class="middleware-remove-btn" title="Remove">×</button>
            `;
            return item;
        };

        const bindItemEvents = (item) => {
            item.addEventListener('dragstart', (e) => {
                draggedItem = item;
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                draggedItem = null;
                orderList.querySelectorAll('.middleware-order-item').forEach(el => el.classList.remove('drag-over'));
                updateMiddlewareOrder();
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!draggedItem || draggedItem === item) return;
                
                const rect = item.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                
                orderList.querySelectorAll('.middleware-order-item').forEach(el => el.classList.remove('drag-over'));
                item.classList.add('drag-over');
                
                if (e.clientY < midY) {
                    orderList.insertBefore(draggedItem, item);
                } else {
                    orderList.insertBefore(draggedItem, item.nextSibling);
                }
            });

            const removeBtn = item.querySelector('.middleware-remove-btn');
            if (removeBtn) {
                removeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const mwName = item.dataset.mw;
                    item.remove();
                    
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'middleware-available-item';
                    btn.dataset.mw = mwName;
                    btn.innerHTML = `<span>${mwName}</span><span class="middleware-add-icon">+</span>`;
                    availableList.appendChild(btn);
                    btn.addEventListener('click', () => addToSelection(mwName));
                    
                    updateMiddlewareOrder();
                });
            }
        };

        const addToSelection = (mwName) => {
            const emptyHint = orderList.querySelector('.middleware-empty-hint');
            if (emptyHint) emptyHint.remove();
            
            const index = orderList.querySelectorAll('.middleware-order-item').length;
            const item = createOrderItem(mwName, index);
            orderList.appendChild(item);
            
            const availableItem = availableList.querySelector(`[data-mw="${mwName}"]`);
            if (availableItem) availableItem.remove();
            
            bindItemEvents(item);
            updateMiddlewareOrder();
        };

        availableList.querySelectorAll('.middleware-available-item').forEach(item => {
            item.addEventListener('click', () => addToSelection(item.dataset.mw));
        });

        orderList.querySelectorAll('.middleware-order-item').forEach(item => {
            bindItemEvents(item);
        });
    }

    renderServiceConfig(title, body, nextBtn) {
        title.textContent = 'Configure Service';
        nextBtn.textContent = 'Create Router';

        const existingServices = Object.keys(this.modal.viewer.getSection(this.modal.protocol, 'services'));
        const currentServiceType = this.modal.formData.serviceType || (existingServices.length > 0 ? 'existing' : 'new');

        const serverPlaceholder = this.modal.protocol === 'http' 
            ? 'http://192.168.1.10:8080' 
            : '192.168.1.10:8080';
        
        const serverHint = this.modal.protocol === 'http'
            ? 'Format: http(s)://IP-ADDRESS:PORT (e.g., http://192.168.1.10:8080)'
            : 'Format: IP-ADDRESS:PORT (e.g., 192.168.1.10:8080)';

        body.innerHTML = `
            <div class="config-form">
                <p class="modal-description">Configure the backend service for this router:</p>
                
                <div class="form-group">
                    <label>Service Option <span class="required">*</span></label>
                    <div class="radio-group-vertical">
                        <label class="radio-card ${currentServiceType === 'existing' ? 'selected' : ''}">
                            <input type="radio" name="serviceType" value="existing" 
                                   ${currentServiceType === 'existing' ? 'checked' : ''}>
                            <div class="radio-card-content">
                                <strong>Use Existing Service</strong>
                                <span>Select from ${existingServices.length} available service${existingServices.length !== 1 ? 's' : ''}</span>
                            </div>
                        </label>
                        <label class="radio-card ${currentServiceType === 'new' ? 'selected' : ''}">
                            <input type="radio" name="serviceType" value="new"
                                   ${currentServiceType === 'new' ? 'checked' : ''}>
                            <div class="radio-card-content">
                                <strong>Create New Service</strong>
                                <span>Define a new load balancer service</span>
                            </div>
                        </label>
                    </div>
                </div>
                
                <div id="existing-service-section" class="${currentServiceType === 'new' ? 'hidden' : ''}">
                    ${existingServices.length > 0 ? `
                    <div class="form-group">
                        <label for="existing-service">Select Service <span class="required">*</span></label>
                        <select id="existing-service" name="existingService" class="form-select required-field" required>
                            <option value="" disabled ${!this.modal.formData.existingService ? 'selected' : ''}>Select an option</option>
                            ${existingServices.map(svc => `
                                <option value="${svc}" ${this.modal.formData.existingService === svc ? 'selected' : ''}>${svc}</option>
                            `).join('')}
                        </select>
                    </div>
                    ` : `
                    <div class="empty-middlewares">
                        <p>No existing services available. Create a new one.</p>
                    </div>
                    `}
                </div>
                
                <div id="new-service-section" class="${currentServiceType !== 'new' ? 'hidden' : ''}">
                    <div class="form-group">
                        <label for="service-name">Service Name <span class="required">*</span></label>
                        <input type="text" id="service-name" name="serviceName" class="form-input required-field" required
                               placeholder="my-service" value="${this.modal.formData.serviceName || ''}">
                        <span class="form-hint" id="service-name-hint">Letters, numbers, dashes and underscores only</span>
                        <span class="form-error-hint hidden" id="service-name-error">Service name already exists</span>
                    </div>
                    
                    <div class="form-group">
                        <label>Backend Servers <span class="required">*</span></label>
                        <div id="servers-list" class="servers-list">
                            ${(this.modal.formData.servers && this.modal.formData.servers.length > 0 ? this.modal.formData.servers : ['']).map((server, i) => `
                                <div class="server-input-row">
                                    <input type="text" name="server-${i}" class="form-input server-input ${i === 0 ? 'required-field' : ''}" 
                                           placeholder="${serverPlaceholder}"
                                           value="${server}" ${i === 0 ? 'required' : ''}>
                                    <button type="button" class="remove-server-btn" ${i === 0 ? 'disabled' : ''}>×</button>
                                </div>
                                <span class="form-error-hint server-error-hint hidden"></span>
                            `).join('')}
                        </div>
                        <button type="button" class="add-server-btn" id="add-server-btn">+ Add Server</button>
                        <span class="form-hint">${serverHint}</span>
                    </div>
                </div>
            </div>
        `;

        const serviceNameInput = document.getElementById('service-name');
        const serviceNameError = document.getElementById('service-name-error');
        const serviceNameHint = document.getElementById('service-name-hint');
        
        serviceNameInput?.addEventListener('input', () => {
            const value = serviceNameInput.value.trim();
            const nameRegex = /^[a-zA-Z0-9_-]+$/;
            
            if (value && this.isServiceNameDuplicate(value)) {
                serviceNameInput.classList.add('input-error');
                serviceNameError?.classList.remove('hidden');
                serviceNameHint?.classList.add('hidden');
            } else if (value && !nameRegex.test(value)) {
                serviceNameInput.classList.add('input-error');
                serviceNameError?.classList.add('hidden');
                serviceNameHint?.classList.remove('hidden');
            } else if (value) {
                serviceNameInput.classList.remove('input-error');
                serviceNameError?.classList.add('hidden');
                serviceNameHint?.classList.remove('hidden');
            }
        });

        this.bindServerValidation(body);

        body.querySelectorAll('input[name="serviceType"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.getElementById('existing-service-section').classList.toggle('hidden', e.target.value === 'new');
                document.getElementById('new-service-section').classList.toggle('hidden', e.target.value !== 'new');
                body.querySelectorAll('.radio-card').forEach(card => card.classList.remove('selected'));
                e.target.closest('.radio-card')?.classList.add('selected');
                this.modal.formData.serviceType = e.target.value;
            });
        });

        document.getElementById('add-server-btn')?.addEventListener('click', () => {
            const list = document.getElementById('servers-list');
            const index = list.querySelectorAll('.server-input-row').length;
            
            const rowHtml = `
                <div class="server-input-row">
                    <input type="text" name="server-${index}" class="form-input server-input" 
                           placeholder="${serverPlaceholder}">
                    <button type="button" class="remove-server-btn">×</button>
                </div>
                <span class="form-error-hint server-error-hint hidden"></span>
            `;
            list.insertAdjacentHTML('beforeend', rowHtml);
            
            this.bindRemoveServerEvents(list);
            this.bindServerValidation(body);
        });

        this.bindRemoveServerEvents(document.getElementById('servers-list'));
        this.modal.bindFormEvents(body);
    }

    bindServerValidation(body) {
        body.querySelectorAll('.server-input').forEach(input => {
            input.addEventListener('blur', () => {
                const value = input.value.trim();
                const errorHint = input.parentElement?.nextElementSibling;
                
                if (value && !this.isValidServerUrl(value, this.modal.protocol)) {
                    input.classList.add('input-error');
                    if (errorHint && errorHint.classList.contains('server-error-hint')) {
                        if (this.modal.protocol === 'http') {
                            errorHint.textContent = 'Invalid format. Use http(s)://IP:port';
                        } else {
                            errorHint.textContent = 'Invalid format. Use IP:port';
                        }
                        errorHint.classList.remove('hidden');
                    }
                } else if (value) {
                    input.classList.remove('input-error');
                    if (errorHint && errorHint.classList.contains('server-error-hint')) {
                        errorHint.classList.add('hidden');
                    }
                }
            });
            
            input.addEventListener('input', () => {
                const errorHint = input.parentElement?.nextElementSibling;
                if (errorHint && errorHint.classList.contains('server-error-hint')) {
                    errorHint.classList.add('hidden');
                }
                input.classList.remove('input-error');
            });
        });
    }

    bindRemoveServerEvents(container) {
        if (!container) return;
        
        container.querySelectorAll('.remove-server-btn').forEach(btn => {
            btn.onclick = () => {
                if (container.children.length > 1 && !btn.disabled) {
                    const row = btn.parentElement;
                    const nextSibling = row.nextElementSibling;
                    if (nextSibling && nextSibling.classList.contains('server-error-hint')) {
                        nextSibling.remove();
                    }
                    row.remove();
                }
            };
        });
    }

    collectServers() {
        const servers = [];
        document.querySelectorAll('.server-input').forEach(input => {
            if (input.value.trim()) {
                if (this.modal.protocol === 'http') {
                    servers.push({ url: input.value.trim() });
                } else {
                    servers.push({ address: input.value.trim() });
                }
            }
        });
        return servers;
    }

    // ...existing code...
}

window.RouterHandler = RouterHandler;
