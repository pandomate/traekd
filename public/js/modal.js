class ConfigModal {
    constructor(viewer) {
        this.viewer = viewer;
        this.currentStep = 0;
        this.protocol = null;
        this.configType = null;
        this.formData = {};
        this.templateSchema = null;
        this.selectedRuleType = null;
        this.readyPromise = this.init();
    }

    async init() {
        await this.loadTemplateSchema();
        this.createModalElement();
        this.bindEvents();
        
        // Initialize handlers
        if (window.MiddlewareHandler) {
            this.middlewareHandler = new window.MiddlewareHandler(this);
        }
        if (window.RouterHandler) {
            this.routerHandler = new window.RouterHandler(this);
        }
        
        this.restoreState();
    }

    // Save modal state to sessionStorage
    saveState() {
        if (this.isOpen()) {
            const state = {
                protocol: this.protocol,
                currentStep: this.currentStep,
                configType: this.configType,
                formData: this.formData,
                selectedRuleType: this.selectedRuleType
            };
            sessionStorage.setItem('modalState', JSON.stringify(state));
        } else {
            sessionStorage.removeItem('modalState');
        }
    }

    // Restore modal state from sessionStorage
    restoreState() {
        const saved = sessionStorage.getItem('modalState');
        if (saved) {
            try {
                const state = JSON.parse(saved);
                
                // Validate state before restoring
                if (!state.protocol || state.currentStep === undefined) {
                    sessionStorage.removeItem('modalState');
                    return;
                }
                
                this.protocol = state.protocol;
                this.currentStep = state.currentStep;
                this.configType = state.configType;
                this.formData = state.formData || {};
                this.selectedRuleType = state.selectedRuleType;
                
                // Re-initialize handlers with restored state
                if (this.configType === 'middleware' && window.MiddlewareHandler) {
                    this.middlewareHandler = new window.MiddlewareHandler(this);
                }
                if (this.configType === 'router' && window.RouterHandler) {
                    this.routerHandler = new window.RouterHandler(this);
                }
                
                document.getElementById('config-modal')?.classList.add('open');
                document.body.classList.add('config-modal-open');
                this.renderStep();
            } catch {
                sessionStorage.removeItem('modalState');
                this.reset();
            }
        }
    }

    async loadTemplateSchema() {
        try {
            const res = await fetch('/api/template-schema');
            if (res.ok) {
                this.templateSchema = await res.json();
                this.parseSchemaStructure();
            }
        } catch {
            this.templateSchema = this.getFallbackSchema();
        }
    }

    // Parse template to extract field structure
    parseSchemaStructure() {
        this.schemaFields = {
            http: { routers: {}, middlewares: {}, services: {} },
            tcp: { routers: {}, middlewares: {}, services: {} },
            udp: { routers: {}, services: {} }
        };

        ['http', 'tcp', 'udp'].forEach(protocol => {
            const protoConfig = this.templateSchema?.[protocol];
            if (!protoConfig) return;

            // Parse routers
            if (protoConfig.routers) {
                const sample = Object.values(protoConfig.routers)[0];
                if (sample) {
                    this.schemaFields[protocol].routers = this.extractFieldSchema(sample);
                }
            }

            // Parse middlewares
            if (protoConfig.middlewares) {
                this.schemaFields[protocol].middlewareTypes = {};
                Object.entries(protoConfig.middlewares).forEach(([name, config]) => {
                    const mwType = Object.keys(config)[0];
                    if (mwType && !this.schemaFields[protocol].middlewareTypes[mwType]) {
                        this.schemaFields[protocol].middlewareTypes[mwType] = this.extractFieldSchema(config[mwType]);
                    }
                });
            }

            // Parse services
            if (protoConfig.services) {
                this.schemaFields[protocol].serviceTypes = {};
                Object.entries(protoConfig.services).forEach(([name, config]) => {
                    const svcType = Object.keys(config)[0];
                    if (svcType && !this.schemaFields[protocol].serviceTypes[svcType]) {
                        this.schemaFields[protocol].serviceTypes[svcType] = this.extractFieldSchema(config[svcType]);
                    }
                });
            }
        });
    }

    // Extract field types from sample data
    extractFieldSchema(obj, prefix = '') {
        const fields = {};
        
        if (!obj || typeof obj !== 'object') return fields;

        Object.entries(obj).forEach(([key, value]) => {
            const fieldPath = prefix ? `${prefix}.${key}` : key;
            
            if (value === null || value === undefined) {
                fields[key] = { type: 'string', key };
            } else if (Array.isArray(value)) {
                if (value.length > 0 && typeof value[0] === 'object') {
                    fields[key] = { 
                        type: 'objectArray', 
                        key,
                        itemSchema: this.extractFieldSchema(value[0])
                    };
                } else {
                    fields[key] = { type: 'array', key };
                }
            } else if (typeof value === 'object') {
                fields[key] = { 
                    type: 'object', 
                    key,
                    children: this.extractFieldSchema(value)
                };
            } else if (typeof value === 'boolean') {
                fields[key] = { type: 'boolean', key };
            } else if (typeof value === 'number') {
                fields[key] = { type: 'number', key };
            } else if (typeof value === 'string' && value.endsWith('s') && /^\d+s$/.test(value)) {
                fields[key] = { type: 'duration', key };
            } else {
                fields[key] = { type: 'string', key };
            }
        });

        return fields;
    }

    getFallbackSchema() {
        return {
            http: {
                routers: {},
                middlewares: {},
                services: {}
            },
            tcp: {
                routers: {},
                middlewares: {},
                services: {}
            },
            udp: {
                routers: {},
                services: {}
            }
        };
    }

    createModalElement() {
        // Create modal container if it doesn't exist
        if (document.getElementById('config-modal')) return;

        const modalHtml = `
            <div id="config-modal" class="config-modal">
                <div class="config-modal-backdrop"></div>
                <div class="config-modal-container">
                    <div class="config-modal-header">
                        <div class="modal-header-content">
                            <div class="modal-step-indicator" id="modal-step-indicator"></div>
                            <h2 id="modal-title">Add New Configuration</h2>
                        </div>
                        <button type="button" class="modal-close-btn" id="modal-close-btn" aria-label="Close">×</button>
                    </div>
                    <div class="config-modal-body" id="modal-body">
                        <!-- Dynamic content -->
                    </div>
                    <div class="config-modal-footer" id="modal-footer">
                        <button type="button" class="modal-btn modal-btn-secondary" id="modal-back-btn">Back</button>
                        <button type="button" class="modal-btn modal-btn-primary" id="modal-next-btn">Next</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
    }

    bindEvents() {
        document.getElementById('modal-close-btn')?.addEventListener('click', () => this.close());
        document.getElementById('modal-back-btn')?.addEventListener('click', () => this.goBack());
        document.getElementById('modal-next-btn')?.addEventListener('click', () => this.goNext());

        window.addEventListener('beforeunload', () => this.saveState());
    }

    isOpen() {
        return document.getElementById('config-modal')?.classList.contains('open');
    }

    async open(protocol) {
        await this.readyPromise;
        if (!document.getElementById('config-modal')) {
            this.createModalElement();
            this.bindEvents();
        }
        this.protocol = protocol;
        this.currentStep = 0;
        this.configType = null;
        this.formData = { protocol };
        document.getElementById('config-modal')?.classList.add('open');
        document.body.classList.add('config-modal-open');
        this.renderStep();
        this.saveState();
    }

    close() {
        document.getElementById('config-modal')?.classList.remove('open');
        document.querySelector('.config-modal-container')?.classList.remove('modal-wide');
        document.body.classList.remove('config-modal-open');
        this.reset();
        sessionStorage.removeItem('modalState');
    }

    reset() {
        this.currentStep = 0;
        this.configType = null;
        this.formData = {};
    }

    resetToInitialStep() {
        const footer = document.getElementById('modal-footer');
        const protocol = this.protocol;
        if (footer) footer.hidden = false;
        this.currentStep = 0;
        this.configType = null;
        this.formData = protocol ? { protocol } : {};
        this.selectedRuleType = null;
        const nextBtn = document.getElementById('modal-next-btn');
        if (nextBtn) {
            nextBtn.disabled = false;
            nextBtn.textContent = 'Next';
        }
        const backBtn = document.getElementById('modal-back-btn');
        if (backBtn) backBtn.disabled = false;
        this.renderStep();
        this.saveState();
    }

    goBack() {
        if (this.currentStep > 0) {
            this.saveCurrentStepData();
            // Check if we came from router to create middleware
            if (this.configType === 'middleware' && this.formData.returnFromMiddleware) {
                // Go back to router middlewares step
                const savedStep = this.formData.savedRouterStep || 2;
                const routerDraft = this.formData.routerDraft || { protocol: this.protocol };
                this.configType = 'router';
                this.currentStep = savedStep;
                this.formData = routerDraft;
                this.renderStep();
                this.saveState();
                return;
            }
            
            this.currentStep--;
            this.renderStep();
            this.saveState();
        }
    }

    goNext() {
        if (this.validateCurrentStep()) {
            this.saveCurrentStepData();
            
            if (this.isLastStep()) {
                this.submit();
            } else {
                this.currentStep++;
                this.renderStep();
                this.saveState();
            }
        }
    }

    isLastStep() {
        if (this.configType === 'middleware' && this.middlewareHandler) {
            return this.middlewareHandler.isLastStep();
        } else if (this.configType === 'router' && this.routerHandler) {
            return this.routerHandler.isLastStep();
        }
        return false;
    }

    validateCurrentStep() {
        const body = document.getElementById('modal-body');
        let valid = true;

        // Step 0: Must select router or middleware
        if (this.currentStep === 0) {
            const selected = body.querySelector('.type-option.selected');
            if (!selected) {
                valid = false;
            }
            return valid;
        }

        // Delegate to handlers for other steps
        if (this.configType === 'middleware' && this.middlewareHandler) {
            return this.middlewareHandler.validateStep(this.currentStep, body);
        } else if (this.configType === 'router' && this.routerHandler) {
            return this.routerHandler.validateStep(this.currentStep, body);
        }

        return valid;
    }

    saveCurrentStepData() {
        const body = document.getElementById('modal-body');
        
        if (this.currentStep === 0) {
            const selected = body.querySelector('.type-option.selected');
            const newConfigType = selected?.dataset.type;
            
            // Always reset data when moving forward from Type panel
            if (newConfigType === 'router' && this.routerHandler) {
                this.routerHandler.resetRouterData();
            } else if (newConfigType === 'middleware' && this.middlewareHandler) {
                this.middlewareHandler.resetMiddlewareData();
            }
            
            this.configType = newConfigType;
            this.formData.configType = this.configType;
        }
        
        // Save all form inputs
        body.querySelectorAll('input, select, textarea').forEach(field => {
            if (field.name) {
                if (field.type === 'checkbox') {
                    if (field.name.includes('[]')) {
                        const baseName = field.name.replace('[]', '');
                        if (!this.formData[baseName]) this.formData[baseName] = [];
                        if (field.checked && !this.formData[baseName].includes(field.value)) {
                            this.formData[baseName].push(field.value);
                        }
                    } else {
                        this.formData[field.name] = field.checked;
                    }
                } else if (field.type === 'radio') {
                    if (field.checked) {
                        this.formData[field.name] = field.value;
                    }
                } else {
                    if (field.tagName === 'SELECT' && field.multiple) {
                        this.formData[field.name] = Array.from(field.selectedOptions).map(option => option.value).filter(Boolean);
                    } else if (field.tagName === 'SELECT') {
                        if (field.value && !field.selectedOptions[0]?.disabled) {
                            this.formData[field.name] = field.value;
                        }
                    } else {
                        this.formData[field.name] = field.value;
                    }
                }
            }
        });

        // Save array items
        body.querySelectorAll('.array-input-container').forEach(container => {
            const name = container.dataset.name;
            const values = Array.from(container.querySelectorAll('.array-item')).map(item => item.dataset.value);
            this.formData[name] = values;
        });
    }

    renderStep() {
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        if (!title || !body) return;
        const backBtn = document.getElementById('modal-back-btn');
        const nextBtn = document.getElementById('modal-next-btn');
        const footer = document.getElementById('modal-footer');

        // Clear previous errors
        body.querySelector('.error-message')?.remove();

        this.renderStepIndicator();
        backBtn.hidden = this.currentStep === 0;
        footer.hidden = false;

        if (this.currentStep === 0) {
            this.renderTypeSelection(title, body, nextBtn);
        } else if (this.configType === 'middleware' && this.middlewareHandler) {
            this.middlewareHandler.renderStep(this.currentStep, title, body, nextBtn);
        } else if (this.configType === 'router' && this.routerHandler) {
            this.routerHandler.renderStep(this.currentStep, title, body, nextBtn);
        }
    }

    renderStepIndicator() {
        const indicator = document.getElementById('modal-step-indicator');
        if (!indicator) return;
        
        // Hide indicator on type selection step (step 0)
        if (this.currentStep === 0) {
            indicator.innerHTML = '';
            return;
        }
        
        let steps = ['Type', '...', '...'];
        
        if (this.configType === 'middleware' && this.middlewareHandler) {
            steps = this.middlewareHandler.getSteps();
        } else if (this.configType === 'router' && this.routerHandler) {
            steps = this.routerHandler.getSteps();
        }

        indicator.innerHTML = steps.map((step, i) => `
            <div class="step-dot ${i === this.currentStep ? 'active' : ''} ${i < this.currentStep ? 'completed' : ''}">
                <span class="step-number">${i + 1}</span>
                <span class="step-label">${step}</span>
            </div>
            ${i < steps.length - 1 ? '<div class="step-line"></div>' : ''}
        `).join('');
    }

    renderTypeSelection(title, body, nextBtn) {
        title.textContent = `Add New ${this.protocol.toUpperCase()} Configuration`;
        nextBtn.textContent = 'Next';

        const hasMiddlewares = this.protocol !== 'udp';

        body.innerHTML = `
            <div class="type-selection">
                <p class="modal-description">What would you like to create?</p>
                <div class="type-options">
                    <button type="button" class="type-option" data-type="router">
                        <div class="type-icon"><span class="dot router"></span></div>
                        <div class="type-info">
                            <h3>Router</h3>
                            <p>Route incoming ${this.protocol.toUpperCase()} requests to backend services based on matching rules</p>
                        </div>
                    </button>
                    ${hasMiddlewares ? `
                    <button type="button" class="type-option" data-type="middleware">
                        <div class="type-icon"><span class="dot middleware"></span></div>
                        <div class="type-info">
                            <h3>Middleware</h3>
                            <p>Transform and modify requests before they reach your backend services</p>
                        </div>
                    </button>
                    ` : ''}
                </div>
            </div>
        `;

        body.querySelectorAll('.type-option').forEach(option => {
            option.addEventListener('click', () => {
                body.querySelectorAll('.type-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
            });
        });
    }

    bindFormEvents(body) {
        // Array input handling
        body.querySelectorAll('.array-input').forEach(input => {
            const container = input.closest('.array-input-container');
            const isRequired = container?.classList.contains('required-field');
            
            // Check initial state for required arrays
            if (isRequired) {
                const items = container.querySelectorAll('.array-item');
                if (items.length === 0) {
                    input.classList.add('input-error');
                }
            }
            
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const value = input.value.trim();
                    if (value) {
                        const itemsDiv = container.querySelector('.array-items');
                        const item = document.createElement('span');
                        item.className = 'array-item';
                        item.dataset.value = value;
                        item.innerHTML = `${this.viewer.escapeHtml(value)} <button type="button" class="remove-item">×</button>`;
                        itemsDiv.appendChild(item);
                        input.value = '';

                        item.querySelector('.remove-item').addEventListener('click', () => {
                            item.remove();
                            // Re-check if required array is now empty
                            if (isRequired) {
                                const remainingItems = container.querySelectorAll('.array-item');
                                if (remainingItems.length === 0) {
                                    input.classList.add('input-error');
                                }
                            }
                        });
                        
                        // Remove error since we now have an item
                        if (isRequired) {
                            input.classList.remove('input-error');
                        }
                    }
                }
            });
        });

        // Bind remove for existing items with validation
        body.querySelectorAll('.array-item .remove-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const container = btn.closest('.array-input-container');
                const isRequired = container?.classList.contains('required-field');
                const input = container?.querySelector('.array-input');
                
                btn.parentElement.remove();
                
                // Re-check if required array is now empty
                if (isRequired && input) {
                    const remainingItems = container.querySelectorAll('.array-item');
                    if (remainingItems.length === 0) {
                        input.classList.add('input-error');
                    }
                }
            });
        });

        // Live validation for required text inputs
        body.querySelectorAll('input.required-field[type="text"], input.required-field[type="number"]').forEach(input => {
            // Skip array inputs - they're handled separately
            if (input.classList.contains('array-input')) return;
            
            // Check initial state
            if (!input.value.trim()) {
                input.classList.add('input-error');
            }
            
            input.addEventListener('input', () => {
                if (input.value.trim()) {
                    input.classList.remove('input-error');
                } else {
                    input.classList.add('input-error');
                }
            });
        });

        // Live validation for required selects
        body.querySelectorAll('select.required-field, select[required]').forEach(select => {
            // Check initial state
            if (!select.value || select.selectedOptions[0]?.disabled) {
                select.classList.add('input-error');
            }
            
            select.addEventListener('change', () => {
                if (select.value && !select.selectedOptions[0]?.disabled) {
                    select.classList.remove('input-error');
                } else {
                    select.classList.add('input-error');
                }
            });
        });
    }

    async submit() {
        this.saveCurrentStepData();

        const nextBtn = document.getElementById('modal-next-btn');
        const backBtn = document.getElementById('modal-back-btn');

        if (nextBtn) {
            nextBtn.disabled = true;
            nextBtn.textContent = 'Creating...';
        }
        if (backBtn) backBtn.disabled = true;

        try {
            if (this.configType === 'middleware' && this.middlewareHandler) {
                const success = await this.middlewareHandler.submitMiddleware();
                if (!success) {
                    if (nextBtn) {
                        nextBtn.disabled = false;
                        nextBtn.textContent = 'Create Middleware';
                    }
                    if (backBtn) backBtn.disabled = false;
                }
                return;
            }
            if (this.configType === 'router' && this.routerHandler) {
                const result = await this.routerHandler.submitRouter();
                if (result.success) {
                    this.showRouterSuccess(result.name);
                    await this.viewer.loadConfig();
                    this.viewer.render();
                    setTimeout(() => this.resetToInitialStep(), 1200);
                } else {
                    this.showError(result.error || 'Failed to create router');
                    if (nextBtn) {
                        nextBtn.disabled = false;
                        nextBtn.textContent = 'Create Router';
                    }
                    if (backBtn) backBtn.disabled = false;
                }
                return;
            }
            this.showError('Unsupported configuration step');
            if (nextBtn) {
                nextBtn.disabled = false;
                nextBtn.textContent = 'Next';
            }
            if (backBtn) backBtn.disabled = false;
        } catch (e) {
            this.showError('An unexpected error occurred: ' + e.message);
            if (nextBtn) {
                nextBtn.disabled = false;
                nextBtn.textContent = this.configType === 'router' ? 'Create Router' : 'Create Middleware';
            }
            if (backBtn) backBtn.disabled = false;
        }
    }

    showRouterSuccess(name) {
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');
        
        const serviceName = this.formData.serviceType === 'new' ? this.formData.serviceName : this.formData.existingService;
        
        body.innerHTML = `
            <div class="success-message">
                <div class="success-icon">✓</div>
                <h3>Router Created Successfully!</h3>
                <p>Your router <strong>"${this.viewer.escapeHtml(name)}"</strong> has been added.</p>
                ${this.formData.serviceType === 'new' ? `
                <p class="success-detail">Service <strong>"${this.viewer.escapeHtml(serviceName)}"</strong> was also created.</p>
                ` : `
                <p class="success-detail">Connected to service <strong>"${this.viewer.escapeHtml(serviceName)}"</strong>.</p>
                `}
            </div>
        `;
        footer.hidden = true;
    }

    showSuccess() {
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');
        
        body.innerHTML = `
            <div class="success-message">
                <div class="success-icon">✓</div>
                <h3>Configuration Created!</h3>
                <p>Your ${this.viewer.escapeHtml(this.configType)} "${this.viewer.escapeHtml(this.formData.name || '')}" has been added successfully.</p>
            </div>
        `;
        footer.hidden = true;
    }

    showError(message) {
        const body = document.getElementById('modal-body');
        
        // Remove existing error
        body.querySelector('.error-message')?.remove();
        
        const error = document.createElement('div');
        error.className = 'error-message';
        error.textContent = message;
        body.insertBefore(error, body.firstChild);
    }
}

window.ConfigModal = ConfigModal;
