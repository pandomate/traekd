class MiddlewareHandler {
    constructor(modal) {
        this.modal = modal;
    }

    getSteps() {
        return ['Type', 'Middleware', 'Configure'];
    }

    isLastStep() {
        return this.modal.currentStep === 2;
    }

    // Reset all middleware-specific form data
    resetMiddlewareData() {
        const keysToRemove = ['name', 'middlewareType', 'chainOrder'];
        // Remove all keys that start with a middleware type prefix
        const allKeys = Object.keys(this.modal.formData);
        allKeys.forEach(key => {
            if (key.includes('.') || keysToRemove.includes(key)) {
                delete this.modal.formData[key];
            }
        });
    }

    validateStep(step, body) {
        if (step === 1) {
            const selected = body.querySelector('.middleware-type-option.selected');
            return !!selected;
        }

        if (step === 2) {
            const mwType = this.modal.formData.middlewareType;
            const fields = this.getMiddlewareFields(mwType);
            let valid = true;

            // Validate name field with regex check
            const nameInput = body.querySelector('#mw-name');
            const nameValue = nameInput?.value?.trim() || '';
            const nameRegex = /^[a-zA-Z0-9_-]+$/;
            
            if (!nameValue || !nameRegex.test(nameValue)) {
                nameInput?.classList.add('input-error');
                valid = false;
            } else {
                nameInput?.classList.remove('input-error');
            }

            // Validate required fields based on field definitions
            fields.forEach(field => {
                if (!field.required) return;
                const fieldName = `${mwType}.${field.key}`;
                
                if (field.type === 'array') {
                    const container = body.querySelector(`.array-input-container[data-name="${fieldName}"]`);
                    const items = container?.querySelectorAll('.array-item');
                    const arrayInput = container?.querySelector('.array-input');
                    if (!items || items.length === 0) {
                        arrayInput?.classList.add('input-error');
                        valid = false;
                    } else {
                        arrayInput?.classList.remove('input-error');
                    }
                } else if (field.type === 'number' || field.type === 'string' || field.type === 'duration') {
                    const input = body.querySelector(`input[name="${fieldName}"]`);
                    if (!input?.value?.trim()) {
                        input?.classList.add('input-error');
                        valid = false;
                    } else {
                        input?.classList.remove('input-error');
                    }
                } else if (field.type === 'middlewareSelect') {
                    const chainItems = body.querySelectorAll('.chain-order-item');
                    if (chainItems.length === 0) valid = false;
                }
            });

            return valid;
        }
        return true;
    }

    renderStep(step, title, body, nextBtn) {
        if (step === 1) {
            this.renderTypeSelection(title, body, nextBtn);
        } else if (step === 2) {
            this.renderConfig(title, body, nextBtn);
        }
    }

    renderTypeSelection(title, body, nextBtn) {
        title.textContent = 'Select Middleware Type';
        nextBtn.textContent = 'Configure';

        // Clear previously selected middleware type when landing on this pane
        delete this.modal.formData.middlewareType;

        const middlewareTypes = this.getMiddlewareTypesForProtocol();

        body.innerHTML = `
            <div class="middleware-type-selection">
                <p class="modal-description">Choose the type of middleware to create:</p>
                <div class="search-box modal-search">
                    <span class="search-icon">⌕</span>
                    <input type="text" class="search-input" id="mw-type-search" placeholder="Search middleware types..." autocomplete="off">
                </div>
                <div class="middleware-type-grid" id="mw-type-grid">
                    ${middlewareTypes.map(mw => `
                        <button class="middleware-type-option" data-type="${mw.key}">
                            <span class="mw-type-name">${this.formatMiddlewareKey(mw.key)}</span>
                            <span class="mw-type-desc">${mw.description}</span>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;

        document.getElementById('mw-type-search')?.addEventListener('input', (e) => {
            const search = e.target.value.toLowerCase();
            document.querySelectorAll('.middleware-type-option').forEach(opt => {
                const name = opt.dataset.type.toLowerCase();
                const displayName = opt.querySelector('.mw-type-name')?.textContent.toLowerCase() || '';
                opt.style.display = (name.includes(search) || displayName.includes(search)) ? '' : 'none';
            });
        });

        body.querySelectorAll('.middleware-type-option').forEach(option => {
            option.addEventListener('click', () => {
                body.querySelectorAll('.middleware-type-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                this.modal.formData.middlewareType = option.dataset.type;
            });
        });
    }

    renderConfig(title, body, nextBtn) {
        const mwType = this.modal.formData.middlewareType;
        title.textContent = `Configure ${this.formatMiddlewareKey(mwType)}`;
        nextBtn.textContent = 'Create Middleware';

        const fields = this.getMiddlewareFields(mwType);
        
        const modalContainer = document.querySelector('.config-modal-container');
        if (mwType === 'chain') {
            modalContainer?.classList.add('modal-wide');
        } else {
            modalContainer?.classList.remove('modal-wide');
        }

        body.innerHTML = `
            <div class="config-form">
                <div class="form-group">
                    <label for="mw-name">Middleware Name <span class="required">*</span></label>
                    <input type="text" id="mw-name" name="name" class="form-input required-field" required 
                           placeholder="my-${mwType.toLowerCase()}" value="">
                    <span class="form-hint">Letters, numbers, dashes and underscores only</span>
                </div>
                
                <div class="form-divider"></div>
                <h4 class="form-section-title">${this.formatMiddlewareKey(mwType)} Options</h4>
                
                ${fields.length > 0 ? fields.map(field => this.renderField(mwType, field)).join('') 
                    : '<p class="form-hint">This middleware type has no configurable options.</p>'}
            </div>
        `;

        this.modal.bindFormEvents(body);
        
        if (mwType === 'chain') {
            setTimeout(() => this.initChainBuilder(body), 0);
        }
        
        fields.forEach(field => {
            if (field.type === 'boolean' && field.defaultValue !== undefined) {
                const checkbox = body.querySelector(`input[name="${mwType}.${field.key}"]`);
                if (checkbox) checkbox.checked = field.defaultValue;
            }
        });
    }

    renderField(mwType, field) {
        const fieldId = `${mwType}-${field.key}`;
        const fieldName = `${mwType}.${field.key}`;
        const required = field.required ? '<span class="required">*</span>' : '';
        const requiredClass = field.required ? 'required-field' : '';

        switch (field.type) {
            case 'boolean':
                return `
                    <div class="form-group">
                        <label class="checkbox-label">
                            <input type="checkbox" name="${fieldName}">
                            <span>${field.label} ${required}</span>
                        </label>
                    </div>
                `;
            case 'number':
                return `
                    <div class="form-group">
                        <label for="${fieldId}">${field.label} ${required}</label>
                        <input type="number" id="${fieldId}" name="${fieldName}" class="form-input ${requiredClass}" 
                               placeholder="${field.placeholder || ''}">
                    </div>
                `;
            case 'duration':
                return `
                    <div class="form-group">
                        <label for="${fieldId}">${field.label} ${required}</label>
                        <input type="text" id="${fieldId}" name="${fieldName}" class="form-input ${requiredClass}" 
                               placeholder="${field.placeholder || 'e.g., 30s, 5m'}">
                        <span class="form-hint">Duration format: 100ms, 30s, 5m, 1h</span>
                    </div>
                `;
            case 'array':
                return `
                    <div class="form-group">
                        <label>${field.label} ${required}</label>
                        <div class="array-input-container ${requiredClass}" data-name="${fieldName}">
                            <input type="text" class="form-input array-input" 
                                   placeholder="${field.placeholder || 'Add item and press Enter'}">
                            <div class="array-items"></div>
                        </div>
                        <span class="form-hint">Press Enter to add each item</span>
                    </div>
                `;
            case 'middlewareSelect':
                return this.renderChainBuilder(fieldName, field, required);
            default:
                return `
                    <div class="form-group">
                        <label for="${fieldId}">${field.label} ${required}</label>
                        <input type="text" id="${fieldId}" name="${fieldName}" class="form-input ${requiredClass}" 
                               placeholder="${field.placeholder || ''}">
                    </div>
                `;
        }
    }

    renderChainBuilder(fieldName, field, required) {
        const existingMws = Object.keys(this.modal.viewer.getSection(this.modal.protocol, 'middlewares'));
        const selectedMws = Array.isArray(this.modal.formData.chainOrder) ? this.modal.formData.chainOrder : [];
        
        return `
            <div class="form-group">
                <label>${field.label} ${required}</label>
                ${existingMws.length > 0 ? `
                <div class="chain-builder">
                    <div class="chain-available">
                        <div class="chain-section-title">Available Middlewares</div>
                        <div class="chain-available-list" id="chain-available-list">
                            ${existingMws.filter(mw => !selectedMws.includes(mw)).map(mw => `
                                <button type="button" class="chain-available-item" data-mw="${mw}">
                                    <span>${mw}</span>
                                    <span class="chain-add-icon">+</span>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    <div class="chain-selected">
                        <div class="chain-section-title">Chain Order (drag to reorder)</div>
                        <div class="chain-order-list" id="chain-order-list">
                            ${selectedMws.length === 0 ? '<p class="chain-empty-hint">Click middlewares to add them to the chain</p>' : ''}
                            ${selectedMws.map((mw, i) => `
                                <div class="chain-order-item" data-mw="${mw}" draggable="true">
                                    <span class="chain-order-number">${i + 1}</span>
                                    <span class="chain-order-name">${mw}</span>
                                    <button type="button" class="chain-remove-btn" title="Remove">×</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
                ` : '<p class="form-hint">No middlewares available to chain. Create some first.</p>'}
            </div>
        `;
    }

    initChainBuilder(body) {
        const availableList = body.querySelector('#chain-available-list');
        const orderList = body.querySelector('#chain-order-list');
        
        if (!availableList || !orderList) return;
        
        if (!this.modal.formData.chainOrder) {
            this.modal.formData.chainOrder = [];
        }

        const self = this;
        let draggedItem = null;

        const updateChainOrder = () => {
            const items = orderList.querySelectorAll('.chain-order-item');
            const order = Array.from(items).map(item => item.dataset.mw);
            self.modal.formData.chainOrder = order;
            
            items.forEach((item, i) => {
                const numEl = item.querySelector('.chain-order-number');
                if (numEl) numEl.textContent = i + 1;
            });
            
            const emptyHint = orderList.querySelector('.chain-empty-hint');
            if (items.length === 0 && !emptyHint) {
                orderList.innerHTML = '<p class="chain-empty-hint">Click middlewares to add them to the chain</p>';
            } else if (items.length > 0 && emptyHint) {
                emptyHint.remove();
            }
        };

        const createOrderItem = (mwName, index) => {
            const item = document.createElement('div');
            item.className = 'chain-order-item';
            item.dataset.mw = mwName;
            item.draggable = true;
            item.innerHTML = `
                <span class="chain-order-number">${index + 1}</span>
                <span class="chain-order-name">${mwName}</span>
                <button type="button" class="chain-remove-btn" title="Remove">×</button>
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
                orderList.querySelectorAll('.chain-order-item').forEach(el => el.classList.remove('drag-over'));
                updateChainOrder();
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!draggedItem || draggedItem === item) return;
                
                const rect = item.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                
                orderList.querySelectorAll('.chain-order-item').forEach(el => el.classList.remove('drag-over'));
                item.classList.add('drag-over');
                
                if (e.clientY < midY) {
                    orderList.insertBefore(draggedItem, item);
                } else {
                    orderList.insertBefore(draggedItem, item.nextSibling);
                }
            });

            const removeBtn = item.querySelector('.chain-remove-btn');
            if (removeBtn) {
                removeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const mwName = item.dataset.mw;
                    item.remove();
                    
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'chain-available-item';
                    btn.dataset.mw = mwName;
                    btn.innerHTML = `<span>${mwName}</span><span class="chain-add-icon">+</span>`;
                    availableList.appendChild(btn);
                    btn.addEventListener('click', () => addToChain(mwName));
                    
                    updateChainOrder();
                });
            }
        };

        const addToChain = (mwName) => {
            const emptyHint = orderList.querySelector('.chain-empty-hint');
            if (emptyHint) emptyHint.remove();
            
            const index = orderList.querySelectorAll('.chain-order-item').length;
            const item = createOrderItem(mwName, index);
            orderList.appendChild(item);
            
            const availableItem = availableList.querySelector(`[data-mw="${mwName}"]`);
            if (availableItem) availableItem.remove();
            
            bindItemEvents(item);
            updateChainOrder();
        };

        availableList.querySelectorAll('.chain-available-item').forEach(item => {
            item.addEventListener('click', () => addToChain(item.dataset.mw));
        });

        orderList.querySelectorAll('.chain-order-item').forEach(item => {
            bindItemEvents(item);
        });
    }

    formatMiddlewareKey(key) {
        const specialCases = {
            'passTLSClientCert': 'Pass TLS Client Cert',
            'grpcWeb': 'gRPC Web',
            'ipAllowList': 'IP Allow List',
            'ipWhiteList': 'IP White List',
            'inFlightReq': 'In Flight Req',
            'inFlightConn': 'In Flight Conn'
        };
        
        if (specialCases[key]) return specialCases[key];
        
        return key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim();
    }

    getMiddlewareTypesForProtocol() {
        if (this.modal.protocol === 'tcp') {
            return [
                { key: 'ipAllowList', description: 'Allow only specific IP addresses' },
                { key: 'ipWhiteList', description: 'Legacy IP whitelist (deprecated)' },
                { key: 'inFlightConn', description: 'Limit concurrent connections' }
            ];
        }
        
        return [
            { key: 'addPrefix', description: 'Add a path prefix to requests' },
            { key: 'basicAuth', description: 'HTTP Basic Authentication' },
            { key: 'buffering', description: 'Buffer requests and responses' },
            { key: 'chain', description: 'Combine multiple middlewares' },
            { key: 'circuitBreaker', description: 'Prevent cascading failures' },
            { key: 'compress', description: 'Compress responses' },
            { key: 'contentType', description: 'Auto-detect content type' },
            { key: 'digestAuth', description: 'HTTP Digest Authentication' },
            { key: 'errors', description: 'Custom error pages' },
            { key: 'forwardAuth', description: 'External authentication service' },
            { key: 'grpcWeb', description: 'gRPC-Web protocol support' },
            { key: 'headers', description: 'Modify request/response headers' },
            { key: 'ipAllowList', description: 'Allow only specific IPs' },
            { key: 'ipWhiteList', description: 'Legacy IP whitelist (deprecated)' },
            { key: 'inFlightReq', description: 'Limit concurrent requests' },
            { key: 'passTLSClientCert', description: 'Pass TLS client certificate' },
            { key: 'rateLimit', description: 'Limit request rate' },
            { key: 'redirectRegex', description: 'Redirect using regex' },
            { key: 'redirectScheme', description: 'Redirect HTTP to HTTPS' },
            { key: 'replacePath', description: 'Replace the request path' },
            { key: 'replacePathRegex', description: 'Replace path using regex' },
            { key: 'retry', description: 'Automatic request retry' },
            { key: 'stripPrefix', description: 'Remove path prefix' },
            { key: 'stripPrefixRegex', description: 'Remove prefix using regex' }
        ];
    }

    getMiddlewareFields(mwType) {
        const fieldDefinitions = {
            addPrefix: [
                { key: 'prefix', type: 'string', label: 'Prefix', required: true, placeholder: '/api' }
            ],
            basicAuth: [
                { key: 'users', type: 'array', label: 'Users', required: true, placeholder: 'user:$apr1$...' },
                { key: 'usersFile', type: 'string', label: 'Users File', placeholder: '/path/to/htpasswd' },
                { key: 'realm', type: 'string', label: 'Realm', placeholder: 'Restricted' },
                { key: 'removeHeader', type: 'boolean', label: 'Remove Authorization Header' },
                { key: 'headerField', type: 'string', label: 'Header Field', placeholder: 'X-WebAuth-User' }
            ],
            buffering: [
                { key: 'maxRequestBodyBytes', type: 'number', label: 'Max Request Body Bytes', required: true, placeholder: '2000000' },
                { key: 'memRequestBodyBytes', type: 'number', label: 'Memory Request Body Bytes', placeholder: '1048576' },
                { key: 'maxResponseBodyBytes', type: 'number', label: 'Max Response Body Bytes', placeholder: '2000000' },
                { key: 'memResponseBodyBytes', type: 'number', label: 'Memory Response Body Bytes', placeholder: '1048576' },
                { key: 'retryExpression', type: 'string', label: 'Retry Expression', placeholder: 'IsNetworkError() && Attempts() < 2' }
            ],
            chain: [
                { key: 'middlewares', type: 'middlewareSelect', label: 'Middlewares', required: true }
            ],
            circuitBreaker: [
                { key: 'expression', type: 'string', label: 'Expression', required: true, placeholder: 'ResponseCodeRatio(500, 600, 0, 600) > 0.25' }
            ],
            compress: [
                { key: 'minResponseBodyBytes', type: 'number', label: 'Min Response Body Bytes', placeholder: '1024' },
                { key: 'excludedContentTypes', type: 'array', label: 'Excluded Content Types', placeholder: 'text/event-stream' }
            ],
            contentType: [
                { key: 'autoDetect', type: 'boolean', label: 'Auto Detect Content Type', defaultValue: true }
            ],
            digestAuth: [
                { key: 'users', type: 'array', label: 'Users', required: true, placeholder: 'user:realm:hash' },
                { key: 'removeHeader', type: 'boolean', label: 'Remove Authorization Header' },
                { key: 'realm', type: 'string', label: 'Realm', placeholder: 'traefik' }
            ],
            errors: [
                { key: 'status', type: 'array', label: 'Status Codes', required: true, placeholder: '500-599' },
                { key: 'service', type: 'string', label: 'Error Service', required: true, placeholder: 'error-service' },
                { key: 'query', type: 'string', label: 'Query Template', placeholder: '/{status}.html' }
            ],
            forwardAuth: [
                { key: 'address', type: 'string', label: 'Auth Service URL', required: true, placeholder: 'http://auth-service/verify' },
                { key: 'trustForwardHeader', type: 'boolean', label: 'Trust Forward Header' },
                { key: 'authResponseHeaders', type: 'array', label: 'Auth Response Headers', placeholder: 'X-Auth-User' }
            ],
            grpcWeb: [
                { key: 'allowOrigins', type: 'array', label: 'Allow Origins', required: true, placeholder: '*' }
            ],
            headers: [
                { key: 'accessControlAllowMethods', type: 'array', label: 'Access Control Allow Methods', placeholder: 'GET, POST' },
                { key: 'accessControlAllowOriginList', type: 'array', label: 'Access Control Allow Origin List', placeholder: '*' },
                { key: 'accessControlMaxAge', type: 'number', label: 'Access Control Max Age', placeholder: '86400' },
                { key: 'stsSeconds', type: 'number', label: 'HSTS Seconds', placeholder: '31536000' },
                { key: 'stsIncludeSubdomains', type: 'boolean', label: 'HSTS Include Subdomains' },
                { key: 'stsPreload', type: 'boolean', label: 'HSTS Preload' },
                { key: 'frameDeny', type: 'boolean', label: 'Frame Deny' },
                { key: 'contentTypeNosniff', type: 'boolean', label: 'Content Type Nosniff' },
                { key: 'browserXssFilter', type: 'boolean', label: 'Browser XSS Filter' },
                { key: 'referrerPolicy', type: 'string', label: 'Referrer Policy', placeholder: 'strict-origin-when-cross-origin' }
            ],
            ipAllowList: [
                { key: 'sourceRange', type: 'array', label: 'Source Range', required: true, placeholder: '192.168.1.0/24' }
            ],
            ipWhiteList: [
                { key: 'sourceRange', type: 'array', label: 'Source Range', required: true, placeholder: '192.168.1.0/24' }
            ],
            inFlightReq: [
                { key: 'amount', type: 'number', label: 'Max Connections', required: true, placeholder: '10' }
            ],
            inFlightConn: [
                { key: 'amount', type: 'number', label: 'Max Connections', required: true, placeholder: '10' }
            ],
            passTLSClientCert: [
                { key: 'pem', type: 'boolean', label: 'Pass PEM', defaultValue: true }
            ],
            rateLimit: [
                { key: 'average', type: 'number', label: 'Average Rate', required: true, placeholder: '100' },
                { key: 'burst', type: 'number', label: 'Burst', placeholder: '200' },
                { key: 'period', type: 'duration', label: 'Period', placeholder: '1s' }
            ],
            redirectRegex: [
                { key: 'regex', type: 'string', label: 'Regex Pattern', required: true, placeholder: '^http://(.*)' },
                { key: 'replacement', type: 'string', label: 'Replacement', required: true, placeholder: 'https://${1}' },
                { key: 'permanent', type: 'boolean', label: 'Permanent Redirect (301)' }
            ],
            redirectScheme: [
                { key: 'scheme', type: 'string', label: 'Scheme', required: true, placeholder: 'https' },
                { key: 'port', type: 'string', label: 'Port', placeholder: '443' },
                { key: 'permanent', type: 'boolean', label: 'Permanent Redirect (301)' }
            ],
            replacePath: [
                { key: 'path', type: 'string', label: 'New Path', required: true, placeholder: '/newpath' }
            ],
            replacePathRegex: [
                { key: 'regex', type: 'string', label: 'Regex Pattern', required: true, placeholder: '^/old/(.*)' },
                { key: 'replacement', type: 'string', label: 'Replacement', required: true, placeholder: '/new/${1}' }
            ],
            retry: [
                { key: 'attempts', type: 'number', label: 'Retry Attempts', required: true, placeholder: '4' },
                { key: 'initialInterval', type: 'duration', label: 'Initial Interval', placeholder: '100ms' }
            ],
            stripPrefix: [
                { key: 'prefixes', type: 'array', label: 'Prefixes to Strip', required: true, placeholder: '/api' }
            ],
            stripPrefixRegex: [
                { key: 'regex', type: 'array', label: 'Regex Patterns', required: true, placeholder: '^/api/v[0-9]+' }
            ]
        };
        return fieldDefinitions[mwType] || [];
    }

    // Collect middleware config from DOM
    collectMiddlewareConfig(mwType) {
        const config = {};
        const fields = this.getMiddlewareFields(mwType);
        const body = document.getElementById('modal-body');
        
        fields.forEach(field => {
            const fieldName = `${mwType}.${field.key}`;
            
            if (field.type === 'array') {
                const container = body.querySelector(`.array-input-container[data-name="${fieldName}"]`);
                if (container) {
                    const items = Array.from(container.querySelectorAll('.array-item')).map(item => item.dataset.value);
                    if (items.length > 0) {
                        config[field.key] = items;
                    }
                }
            } else if (field.type === 'middlewareSelect') {
                const chainItems = body.querySelectorAll('.chain-order-item');
                if (chainItems.length > 0) {
                    config[field.key] = Array.from(chainItems).map(item => item.dataset.mw);
                }
            } else if (field.type === 'boolean') {
                const checkbox = body.querySelector(`input[name="${fieldName}"]`);
                if (checkbox?.checked) {
                    config[field.key] = true;
                }
            } else if (field.type === 'number') {
                const input = body.querySelector(`input[name="${fieldName}"]`);
                const value = input?.value?.trim();
                if (value) {
                    config[field.key] = parseInt(value, 10);
                }
            } else {
                const input = body.querySelector(`input[name="${fieldName}"]`);
                const value = input?.value?.trim();
                if (value) {
                    config[field.key] = value;
                }
            }
        });
        
        return config;
    }

    buildConfig() {
        const nameInput = document.getElementById('mw-name');
        const name = nameInput?.value?.trim();
        const mwType = this.modal.formData.middlewareType;
        
        if (!name || !mwType) {
            console.error('Missing name or middleware type');
            return null;
        }
        
        const mwConfig = this.collectMiddlewareConfig(mwType);
        
        return {
            protocol: this.modal.protocol,
            type: 'middleware',
            name: name,
            middlewareType: mwType,
            middlewareConfig: mwConfig
        };
    }

    async submitMiddleware() {
        const config = this.buildConfig();
        if (!config) {
            this.showMiddlewareError('Failed to build configuration');
            return false;
        }

        try {
            const res = await fetch('/api/config/middleware', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const result = await res.json();

            if (res.ok && result.success) {
                this.showMiddlewareSuccess(config.name);

                await this.modal.viewer.loadConfig();
                this.modal.viewer.render();

                setTimeout(() => {
                    const footer = document.getElementById('modal-footer');
                    const nextBtn = document.getElementById('modal-next-btn');
                    const backBtn = document.getElementById('modal-back-btn');
                    if (nextBtn) {
                        nextBtn.disabled = false;
                        nextBtn.textContent = 'Next';
                    }
                    if (backBtn) backBtn.disabled = false;
                    if (footer) footer.style.display = 'flex';

                    if (this.modal.formData.returnFromMiddleware) {
                        this.modal.configType = 'router';
                        this.modal.currentStep = this.modal.formData.savedRouterStep || 2;
                        delete this.modal.formData.returnFromMiddleware;
                        delete this.modal.formData.savedRouterStep;
                        this.resetMiddlewareData();
                        this.modal.renderStep();
                    } else {
                        this.modal.currentStep = 1;
                        this.resetMiddlewareData();
                        this.modal.renderStep();
                    }
                    this.modal.saveState();
                }, 1200);

                return true;
            }

            this.showMiddlewareError(result.error || 'Failed to save middleware');
            return false;
        } catch (e) {
            this.showMiddlewareError('Network error: ' + e.message);
            return false;
        }
    }

    showMiddlewareSuccess(name) {
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');
        
        body.innerHTML = `
            <div class="success-message">
                <div class="success-icon">✓</div>
                <h3>Middleware Created!</h3>
                <p>Your middleware "${name}" has been added successfully.</p>
            </div>
        `;
        footer.style.display = 'none';
    }

    showMiddlewareError(message) {
        const body = document.getElementById('modal-body');
        body.querySelector('.error-message')?.remove();
        
        const error = document.createElement('div');
        error.className = 'error-message';
        error.textContent = message;
        body.insertBefore(error, body.firstChild);
    }
}

window.MiddlewareHandler = MiddlewareHandler;
