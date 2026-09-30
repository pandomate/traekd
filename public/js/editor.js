class EditorModal {
    constructor(viewer) {
        this.viewer = viewer;
        this.context = null;
        this.originalData = null;
        this.state = null;
        this.currentStep = 0;
        this.saving = false;
        this.formInvalid = false;
        this.templateSchema = null;
        this.templateLoadPromise = null;
        this.schemaSample = null;
        this.close = this.close.bind(this);
        this.handlePrimary = this.handlePrimary.bind(this);
        this.handleOverlayClick = this.handleOverlayClick.bind(this);
        this.handleKeydown = this.handleKeydown.bind(this);
        this.buildModal();
        this.bindGlobalEvents();
    }

    buildModal() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'editor-overlay hidden';
        this.overlay.innerHTML = `
            <div class="editor-modal" role="dialog" aria-modal="true">
                <div class="editor-modal-header">
                    <div>
                        <p class="editor-modal-eyebrow" id="editor-eyebrow"></p>
                        <h2 id="editor-title">Edit Item</h2>
                    </div>
                    <button type="button" class="editor-close" data-editor-close>&times;</button>
                </div>
                <div class="editor-steps" id="editor-steps"></div>
                <div class="editor-step-container" id="editor-step-container"></div>
                <div class="editor-modal-footer">
                    <span class="editor-status" id="editor-status"></span>
                    <div class="editor-actions">
                        <button type="button" class="editor-reset" data-editor-cancel>Cancel</button>
                        <button type="button" class="editor-back" data-editor-back>Back</button>
                        <button type="button" class="editor-next" data-editor-next>Review Changes</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(this.overlay);
        this.stepIndicatorEl = this.overlay.querySelector('#editor-steps');
        this.stepContainer = this.overlay.querySelector('#editor-step-container');
        this.statusEl = this.overlay.querySelector('#editor-status');
        this.closeBtn = this.overlay.querySelector('[data-editor-close]');
        this.cancelBtn = this.overlay.querySelector('[data-editor-cancel]');
        this.backBtn = this.overlay.querySelector('[data-editor-back]');
        this.nextBtn = this.overlay.querySelector('[data-editor-next]');
        this.closeBtn.addEventListener('click', this.close);
        this.cancelBtn.addEventListener('click', this.close);
        this.backBtn.addEventListener('click', () => this.goToStep(this.currentStep - 1));
        this.nextBtn.addEventListener('click', this.handlePrimary);
        this.overlay.addEventListener('click', this.handleOverlayClick);
    }

    bindGlobalEvents() {
        document.addEventListener('keydown', this.handleKeydown);
    }

    handleOverlayClick(e) {
        if (e.target === this.overlay) this.close();
    }

    handleKeydown(e) {
        if (this.overlay.classList.contains('hidden')) return;
        if (e.key === 'Escape') this.close();
    }

    open(context) {
        this.context = context;
        this.originalData = this.clone(context.data);
        this.state = this.clone(context.data);
        this.currentStep = 0;
        this.saving = false;
        this.formInvalid = false;
        document.getElementById('editor-eyebrow').textContent = `${context.protocol.toUpperCase()} ${context.section.slice(0, -1)}`;
        document.getElementById('editor-title').textContent = context.name;
        this.status('');
        this.overlay.classList.remove('hidden');
        this.stepIndicatorEl.innerHTML = '';
        this.stepContainer.innerHTML = '<div class="editor-loading">Preparing editor…</div>';

        this.ensureTemplateSchema()
            .then(() => {
                this.schemaSample = this.extractSchemaSample();
                this.renderStep();
            })
            .catch(() => {
                this.schemaSample = null;
                this.renderStep();
            });
    }

    ensureTemplateSchema() {
        if (!this.templateLoadPromise) {
            this.templateLoadPromise = fetch('/api/template-schema')
                .then(res => (res.ok ? res.json() : {}))
                .catch(() => ({}))
                .then(schema => {
                    this.templateSchema = schema || {};
                    return this.templateSchema;
                });
        }
        return this.templateLoadPromise;
    }

    extractSchemaSample() {
        if (!this.templateSchema || !this.context) return null;
        const protoBlock = this.templateSchema[this.context.protocol];
        if (!protoBlock) return null;
        const sectionBlock = protoBlock[this.context.section];
        if (!sectionBlock || typeof sectionBlock !== 'object') return null;
        const firstKey = Object.keys(sectionBlock)[0];
        return firstKey ? sectionBlock[firstKey] : null;
    }

    shouldUseSchemaDefaults() {
        return !!this.schemaSample && ['routers', 'services'].includes(this.context?.section);
    }

    getSchemaNode(pathParts = []) {
        if (!this.shouldUseSchemaDefaults()) return null;
        let node = this.schemaSample;
        for (const part of pathParts) {
            if (!node || typeof node !== 'object') return null;
            node = node[part];
        }
        return node;
    }

    createDefaultValue(sampleValue) {
        if (Array.isArray(sampleValue)) return [];
        if (sampleValue && typeof sampleValue === 'object') return {};
        if (typeof sampleValue === 'boolean') return false;
        return '';
    }

    orderEntries(entries, schemaNode) {
        if (!schemaNode || typeof schemaNode !== 'object' || Array.isArray(schemaNode)) return entries;
        const schemaKeys = Object.keys(schemaNode);
        return entries.sort((a, b) => {
            const ia = schemaKeys.indexOf(a[0]);
            const ib = schemaKeys.indexOf(b[0]);
            if (ia === -1 && ib === -1) return a[0].localeCompare(b[0]);
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
        });
    }

    getRenderableEntries(obj, pathParts = []) {
        const schemaNode = this.getSchemaNode(pathParts);
        const base = {};
        if (schemaNode && typeof schemaNode === 'object' && !Array.isArray(schemaNode)) {
            Object.keys(schemaNode).forEach(key => {
                base[key] = this.createDefaultValue(schemaNode[key]);
            });
        }
        Object.entries(obj || {}).forEach(([key, value]) => {
            base[key] = value;
        });
        return this.orderEntries(Object.entries(base), schemaNode);
    }

    formatLabel(key) {
        if (key === undefined || key === null) return '';
        return String(key)
            .replace(/([A-Z])/g, ' $1')
            .replace(/[_\-]+/g, ' ')
            .replace(/^\w/, c => c.toUpperCase())
            .trim();
    }

    renderStep() {
        if (!this.state) return;
        this.renderStepIndicator();
        if (this.currentStep === 0) {
            this.renderFieldsStep();
            this.backBtn.disabled = true;
            this.nextBtn.textContent = 'Review Changes';
            this.nextBtn.disabled = this.formInvalid;
        } else {
            this.renderReviewStep();
            this.backBtn.disabled = this.saving;
            this.nextBtn.textContent = this.saving ? 'Saving…' : 'Save Changes';
            this.nextBtn.disabled = this.saving || this.formInvalid;
        }
    }

    renderStepIndicator() {
        const steps = ['Edit Fields', 'Review & Save'];
        this.stepIndicatorEl.innerHTML = steps.map((label, index) => `
            <div class="editor-step ${index === this.currentStep ? 'active' : ''}" data-step="${index + 1}">
                ${label}
            </div>
        `).join('');
    }

    renderFieldsStep() {
        this.stepContainer.innerHTML = `
            <div class="editor-step-grid">
                <div class="editor-form-panel">
                    ${this.renderObjectFields(this.state || {}, [])}
                </div>
                <div class="editor-preview-panel">
                    <div class="editor-preview-header">
                        <h4>Live YAML</h4>
                        <p class="form-hint">${this.context.protocol.toUpperCase()} ${this.context.section.slice(0, -1)}</p>
                    </div>
                    <pre class="editor-yaml-preview"></pre>
                </div>
            </div>
        `;
        this.yamlPreviewEl = this.stepContainer.querySelector('.editor-yaml-preview');
        this.updateYamlPreview();
        this.bindFieldEvents();
    }

    renderReviewStep() {
        const changes = this.getChanges(this.originalData, this.state);
        const changeList = changes.length
            ? `<ul>${changes.map(change => `<li>${this.escape(change)}</li>`).join('')}</ul>`
            : '<p>No fields were modified.</p>';
        this.stepContainer.innerHTML = `
            <div class="editor-step-grid">
                <div class="editor-review-card">
                    <h4>Change Summary</h4>
                    ${changeList}
                </div>
                <div class="editor-preview-panel">
                    <div class="editor-preview-header">
                        <h4>Updated YAML</h4>
                    </div>
                    <pre class="editor-yaml-preview"></pre>
                </div>
            </div>
        `;
        this.yamlPreviewEl = this.stepContainer.querySelector('.editor-yaml-preview');
        this.updateYamlPreview();
    }

    bindFieldEvents() {
        this.stepContainer.querySelectorAll('.editor-input').forEach((input) => {
            input.addEventListener('input', (e) => {
                const path = e.currentTarget.dataset.path;
                const type = e.currentTarget.dataset.type;
                let value = e.currentTarget.value;
                if (type === 'number') {
                    value = value === '' ? '' : Number(value);
                }
                this.setValue(path, value);
                this.updateYamlPreview();
            });
        });

        this.stepContainer.querySelectorAll('.editor-select').forEach((select) => {
            select.addEventListener('change', (e) => {
                this.setValue(e.currentTarget.dataset.path, e.currentTarget.value);
                this.updateYamlPreview();
            });
        });

        this.stepContainer.querySelectorAll('.editor-checkbox').forEach((checkbox) => {
            checkbox.addEventListener('change', (e) => {
                this.setValue(e.currentTarget.dataset.path, e.currentTarget.checked);
                this.updateYamlPreview();
            });
        });

        this.stepContainer.querySelectorAll('.editor-json').forEach((textarea) => {
            textarea.addEventListener('input', (e) => {
                const path = e.currentTarget.dataset.path;
                try {
                    const parsed = e.currentTarget.value.trim()
                        ? JSON.parse(e.currentTarget.value)
                        : null;
                    this.setValue(path, parsed);
                    e.currentTarget.classList.remove('input-error');
                    this.formInvalid = false;
                    this.status('');
                    this.updateYamlPreview();
                } catch (err) {
                    e.currentTarget.classList.add('input-error');
                    this.formInvalid = true;
                    this.status(`Invalid JSON for "${path}"`, 'error');
                }
                this.updatePrimaryState();
            });
        });

        this.initPillFields();
        this.initListFields();
        this.initDomainFields();
        this.initServerFields();
        this.initEntryPointFields();
        this.initMiddlewareFields();
    }

    renderObjectFields(obj = {}, pathParts = []) {
        const entries = this.getRenderableEntries(obj, pathParts);
        if (!entries.length) return '<p class="form-hint">No fields detected for this item.</p>';
        return entries.map(([key, value]) => this.renderField(key, value, [...pathParts, key])).join('');
    }

    renderField(key, value, pathParts) {
        const path = pathParts.join('.');
        const label = this.escape(this.formatLabel(key));
        if (Array.isArray(value)) {
            return this.renderArrayField(label, value, path);
        }
        if (value && typeof value === 'object') {
            return `
                <div class="editor-fieldset">
                    <div class="editor-fieldset-title">${label}</div>
                    ${this.renderObjectFields(value, pathParts)}
                </div>
            `;
        }
        if (typeof value === 'boolean') {
            return `
                <div class="editor-field">
                    <label class="checkbox-label">
                        <input type="checkbox" class="editor-checkbox" data-path="${this.escape(path)}" ${value ? 'checked' : ''}>
                        <span>${label}</span>
                    </label>
                </div>
            `;
        }
        const selectOptions = this.getSelectOptions(path);
        if (selectOptions && selectOptions.length) {
            return `
                <div class="editor-field">
                    <label>${label}</label>
                    <select class="editor-select" data-path="${this.escape(path)}">
                        ${selectOptions.map(opt => `<option value="${this.escape(opt)}" ${opt === value ? 'selected' : ''}>${this.escape(opt)}</option>`).join('')}
                    </select>
                </div>
            `;
        }
        const typeAttr = typeof value === 'number' ? 'number' : 'text';
        const datalist = this.getDatalist(path);
        const datalistAttr = datalist ? `list="${datalist.id}"` : '';
        return `
            <div class="editor-field">
                <label>${label}</label>
                <input class="editor-input" data-path="${this.escape(path)}" data-type="${typeAttr}" type="${typeAttr}" value="${this.escape(value ?? '')}" ${datalistAttr}>
                ${datalist ? datalist.html : ''}
            </div>
        `;
    }

    renderArrayField(label, value = [], path) {
        if (path.endsWith('loadBalancer.servers')) {
            return this.renderServersField(label, value, path);
        }
        if (path.endsWith('middlewares')) {
            return this.renderMiddlewaresField(label, value, path);
        }
        if (path.endsWith('entryPoints')) {
            return this.renderEntryPointField(label, value, path);
        }
        if (path.endsWith('parentRefs')) {
            return this.renderParentRefsField(label, value, path);
        }
        if (path.endsWith('tls.domains')) {
            return this.renderDomainsField(label, value, path);
        }
        const primitive = value.every(entry => entry === null || ['string', 'number'].includes(typeof entry));
        if (!primitive) {
            return `
                <div class="editor-field">
                    <label>${label}</label>
                    <textarea class="editor-json" data-path="${this.escape(path)}">${this.escape(JSON.stringify(value, null, 2))}</textarea>
                    <p class="editor-field-hint">Edit as JSON array</p>
                </div>
            `;
        }
        const options = this.getArrayOptions(path);
        const datalist = options ? this.getDatalist(path, options) : null;
        const datalistAttr = datalist ? `list="${datalist.id}"` : '';
        return `
            <div class="editor-field editor-pill-field" data-path="${this.escape(path)}">
                <label>${label}</label>
                <div class="editor-pill-container">
                    ${value.map((entry, index) => `
                        <span class="editor-pill">
                            ${this.escape(String(entry))}
                            <button type="button" class="pill-remove" data-index="${index}">&times;</button>
                        </span>
                    `).join('')}
                    <input type="text" class="pill-input" placeholder="Add value" ${datalistAttr}>
                </div>
                ${datalist ? datalist.html : ''}
            </div>
        `;
    }

    renderMiddlewaresField(label, value = [], path) {
        const protocol = this.context?.protocol || 'http';
        const allMiddlewares = Object.keys(this.viewer?.getSection(protocol, 'middlewares') || {});
        const selected = Array.isArray(value) ? value : [];
        const available = allMiddlewares.filter(mw => !selected.includes(mw));

        return `
            <div class="editor-field editor-middlewares-field" data-path="${this.escape(path)}">
                <label>${label}</label>
                <div class="editor-middleware-manager">
                    <div class="editor-middleware-available">
                        <div class="editor-middleware-section-label">Available</div>
                        <div class="editor-middleware-available-list" id="editor-middleware-available">
                            ${available.map(mw => `
                                <button type="button" class="editor-middleware-available-item" data-mw="${this.escapeHtml(mw)}">
                                    <span>${this.escapeHtml(mw)}</span>
                                    <span class="editor-middleware-add-icon">+</span>
                                </button>
                            `).join('') || '<p class="editor-middleware-empty">No available middlewares</p>'}
                        </div>
                    </div>
                    <div class="editor-middleware-selected">
                        <div class="editor-middleware-section-label">Selected (drag to reorder)</div>
                        <div class="editor-middleware-order-list" id="editor-middleware-order">
                            ${selected.length === 0 ? '<p class="editor-middleware-empty">Click middlewares to add</p>' : ''}
                            ${selected.map((mw, i) => `
                                <div class="editor-middleware-order-item" data-mw="${this.escapeHtml(mw)}" draggable="true">
                                    <span class="editor-middleware-order-number">${i + 1}</span>
                                    <span class="editor-middleware-order-name">${this.escapeHtml(mw)}</span>
                                    <button type="button" class="editor-middleware-remove" data-mw="${this.escapeHtml(mw)}">×</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    initMiddlewareFields() {
        const containers = this.stepContainer?.querySelectorAll('.editor-middlewares-field') || [];
        containers.forEach(container => {
            const path = container.dataset.path;
            const availableList = container.querySelector('#editor-middleware-available');
            const orderList = container.querySelector('#editor-middleware-order');
            
            if (!availableList || !orderList) return;

            let draggedItem = null;

            const updateMiddlewareOrder = () => {
                const items = orderList.querySelectorAll('.editor-middleware-order-item');
                const order = Array.from(items).map(item => item.dataset.mw);
                this.setValue(path, order.length > 0 ? order : undefined);
                
                items.forEach((item, i) => {
                    const numEl = item.querySelector('.editor-middleware-order-number');
                    if (numEl) numEl.textContent = i + 1;
                });
                
                const emptyHint = orderList.querySelector('.editor-middleware-empty');
                if (items.length === 0 && !emptyHint) {
                    orderList.innerHTML = '<p class="editor-middleware-empty">Click middlewares to add</p>';
                } else if (items.length > 0 && emptyHint) {
                    emptyHint.remove();
                }
            };

            const createOrderItem = (mwName, index) => {
                const item = document.createElement('div');
                item.className = 'editor-middleware-order-item';
                item.dataset.mw = mwName;
                item.draggable = true;
                item.innerHTML = `
                    <span class="editor-middleware-order-number">${index + 1}</span>
                    <span class="editor-middleware-order-name">${this.escapeHtml(mwName)}</span>
                    <button type="button" class="editor-middleware-remove" data-mw="${this.escapeHtml(mwName)}">×</button>
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
                    orderList.querySelectorAll('.editor-middleware-order-item').forEach(el => el.classList.remove('drag-over'));
                    updateMiddlewareOrder();
                });

                item.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    if (!draggedItem || draggedItem === item) return;
                    
                    const rect = item.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    
                    orderList.querySelectorAll('.editor-middleware-order-item').forEach(el => el.classList.remove('drag-over'));
                    item.classList.add('drag-over');
                    
                    if (e.clientY < midY) {
                        orderList.insertBefore(draggedItem, item);
                    } else {
                        orderList.insertBefore(draggedItem, item.nextSibling);
                    }
                });

                const removeBtn = item.querySelector('.editor-middleware-remove');
                if (removeBtn) {
                    removeBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        const mwName = item.dataset.mw;
                        item.remove();
                        
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'editor-middleware-available-item';
                        btn.dataset.mw = mwName;
                        btn.innerHTML = `<span>${this.escapeHtml(mwName)}</span><span class="editor-middleware-add-icon">+</span>`;
                        availableList.appendChild(btn);
                        btn.addEventListener('click', () => addToOrder(mwName));
                        
                        updateMiddlewareOrder();
                    });
                }
            };

            const addToOrder = (mwName) => {
                const emptyHint = orderList.querySelector('.editor-middleware-empty');
                if (emptyHint) emptyHint.remove();
                
                const index = orderList.querySelectorAll('.editor-middleware-order-item').length;
                const item = createOrderItem(mwName, index);
                orderList.appendChild(item);
                
                const availableItem = [...availableList.querySelectorAll('[data-mw]')].find(item => item.dataset.mw === mwName);
                if (availableItem) availableItem.remove();
                
                bindItemEvents(item);
                updateMiddlewareOrder();
            };

            availableList.querySelectorAll('.editor-middleware-available-item').forEach(item => {
                item.addEventListener('click', () => addToOrder(item.dataset.mw));
            });

            orderList.querySelectorAll('.editor-middleware-order-item').forEach(item => {
                bindItemEvents(item);
            });
        });
    }

    escapeHtml(text) {
        if (typeof text !== 'string') text = String(text ?? '');
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    renderEntryPointField(label, value = [], path) {
        const options = this.getEntryPointOptions();
        const current = Array.isArray(value) ? value[0] : (typeof value === 'string' ? value : '');
        const hasCurrent = current && !options.includes(current);
        const renderOption = (ep, selected) => `<option value="${this.escape(ep)}" ${selected ? 'selected' : ''}>${this.escape(ep)}</option>`;
        return `
            <div class="editor-field">
                <label>${label}</label>
                ${options.length
                    ? `
                        <select class="editor-select editor-entrypoint-select" data-path="${this.escape(path)}">
                            <option value="">Select an entry point</option>
                            ${options.map(ep => renderOption(ep, ep === current)).join('')}
                            ${hasCurrent ? renderOption(current, true) : ''}
                        </select>
                    `
                    : '<div class="editor-list-empty">No entry points configured. Add one in AUX → Entry Points.</div>'}
            </div>
        `;
    }

    renderParentRefsField(label, value = [], path) {
        const escape = (text) => (this.viewer?.escapeHtml ? this.viewer.escapeHtml(String(text ?? '')) : String(text ?? ''));
        const items = Array.isArray(value) ? value : [];
        return `
            <div class="editor-field">
                <label>${label}</label>
                <div class="array-input-container" data-name="${this.escape(path)}">
                    <input type="text" class="form-input array-input" placeholder="Enter parent ref and press Enter">
                    <div class="array-items">
                        ${items.map(item => `
                            <span class="array-item" data-value="${escape(item)}">
                                ${escape(item)}
                                <button type="button" class="remove-item">×</button>
                            </span>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
    }

    getEntryPointOptions() {
        const list = this.viewer?.getEntryPointNames?.() || this.viewer?.getEntryPoints?.() || [];
        return [...new Set(list)].filter(Boolean);
    }

    initEntryPointFields() {
        const selects = this.stepContainer?.querySelectorAll('.editor-entrypoint-select') || [];
        selects.forEach(select => {
            select.addEventListener('change', () => {
                const path = select.dataset.path;
                const value = select.value;
                this.setValue(path, value ? [value] : undefined);
            });
        });
    }

    renderServersField(label, value = [], path) {
        return `
            <div class="editor-field editor-servers-field" data-path="${this.escape(path)}">
                <label>${label}</label>
                <div class="editor-servers-list">
                    ${value.length
                        ? value.map((server, index) => this.renderServerCard(server || {}, path, index)).join('')
                        : '<p class="editor-list-empty">No servers configured.</p>'}
                </div>
                <button type="button" class="editor-server-add">+ Add Server</button>
            </div>
        `;
    }

    renderServerCard(server, path, index) {
        const template = this.getDefaultServerTemplate(path);
        const merged = { ...template, ...(server || {}) };
        const keys = [...new Set([...Object.keys(template), ...Object.keys(server || {})])];
        return `
            <div class="editor-server-card" data-index="${index}">
                <div class="editor-server-header">
                    <span>Server ${index + 1}</span>
                    <button type="button" class="editor-server-remove" data-index="${index}">×</button>
                </div>
                <div class="editor-server-fields">
                    ${keys.map((field) => this.renderServerFieldInput(field, merged[field], `${path}.${index}`)).join('')}
                </div>
            </div>
        `;
    }

    renderServerFieldInput(field, value, basePath) {
        const path = `${basePath}.${field}`;
        const label = this.escape(this.formatLabel(field));
        if (typeof value === 'boolean') {
            return `
                <div class="editor-field editor-inline-field">
                    <label class="checkbox-label">
                        <input type="checkbox" class="editor-checkbox" data-path="${this.escape(path)}" ${value ? 'checked' : ''}>
                        <span>${label}</span>
                    </label>
                </div>
            `;
        }
        if (typeof value === 'number') {
            return `
                <div class="editor-field">
                    <label>${label}</label>
                    <input class="editor-input" data-path="${this.escape(path)}" data-type="number" type="number" value="${value}">
                </div>
            `;
        }
        if (value && typeof value === 'object') {
            return `
                <div class="editor-field">
                    <label>${label}</label>
                    <textarea class="editor-json" data-path="${this.escape(path)}">${this.escape(JSON.stringify(value, null, 2))}</textarea>
                </div>
            `;
        }
        return `
            <div class="editor-field">
                <label>${label}</label>
                <input class="editor-input" data-path="${this.escape(path)}" type="text" value="${this.escape(value ?? '')}">
            </div>
        `;
    }

    getDefaultServerTemplate(path) {
        const isHttp = this.context?.protocol === 'http' || path.includes('http');
        return isHttp ? { url: '', weight: '' } : { address: '', weight: '' };
    }

    initServerFields() {
        this.stepContainer.querySelectorAll('.editor-servers-field').forEach((container) => {
            const path = container.dataset.path;
            container.querySelector('.editor-server-add')?.addEventListener('click', () => {
                const servers = this.clone(this.getValue(path) || []);
                servers.push(this.clone(this.getDefaultServerTemplate(path)));
                this.setValue(path, servers);
                this.renderFieldsStep();
            });
            container.querySelectorAll('.editor-server-remove').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const index = Number(btn.dataset.index);
                    const servers = this.clone(this.getValue(path) || []);
                    servers.splice(index, 1);
                    this.setValue(path, servers);
                    this.renderFieldsStep();
                });
            });
        });
    }

    renderMiddlewareListField(label, value, path) {
        const options = this.getArrayOptions(path) || [];
        const datalist = this.getDatalist(path, options);
        return `
            <div class="editor-field editor-list-field" data-path="${this.escape(path)}">
                <label>${label}</label>
                <div class="editor-list-items">
                    ${value.length ? value.map((item, index) => `
                        <div class="editor-list-item" data-index="${index}">
                            <span>${this.escape(String(item))}</span>
                            <div class="editor-list-actions">
                                <button type="button" data-action="up">↑</button>
                                <button type="button" data-action="down">↓</button>
                                <button type="button" data-action="remove">×</button>
                            </div>
                        </div>
                    `).join('') : '<p class="editor-list-empty">No middlewares selected.</p>'}
                </div>
                <div class="editor-list-controls">
                    <input type="text" class="editor-list-input" placeholder="Add middleware" ${datalist ? `list="${datalist.id}"` : ''}>
                    <button type="button" class="editor-list-add">Add</button>
                </div>
                ${datalist ? datalist.html : ''}
            </div>
        `;
    }

    renderDomainsField(label, value, path) {
        return `
            <div class="editor-field editor-domains-field" data-path="${this.escape(path)}">
                <label>${label}</label>
                <div class="editor-domains-list">
                    ${value.length ? value.map((domain, index) => this.renderDomainCard(domain || {}, path, index)).join('') : '<p class="editor-list-empty">No domains configured.</p>'}
                </div>
                <button type="button" class="editor-domain-add">+ Add Domain</button>
            </div>
        `;
    }

    renderDomainCard(domain, path, index) {
        const main = domain.main || '';
        const sans = Array.isArray(domain.sans) ? domain.sans : [];
        const sansPath = `${path}.${index}.sans`;
        return `
            <div class="editor-domain-card" data-index="${index}">
                <div class="editor-domain-header">
                    <span>Domain ${index + 1}</span>
                    <button type="button" class="editor-domain-remove">×</button>
                </div>
                <div class="editor-field">
                    <label>Main</label>
                    <input type="text" class="editor-input" data-path="${this.escape(`${path}.${index}.main`)}" value="${this.escape(main)}">
                </div>
                <div class="editor-field editor-pill-field" data-path="${sansPath}">
                    <label>SANs</label>
                    <div class="editor-pill-container">
                        ${sans.map((entry, i) => `
                            <span class="editor-pill">
                                ${this.escape(String(entry))}
                                <button type="button" class="pill-remove" data-index="${i}">&times;</button>
                            </span>
                        `).join('')}
                        <input type="text" class="pill-input" placeholder="Add SAN">
                    </div>
                </div>
            </div>
        `;
    }

    initPillFields() {
        this.stepContainer.querySelectorAll('.editor-pill-field').forEach((container) => {
            const path = container.dataset.path;
            const input = container.querySelector('.pill-input');
            input?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const value = input.value.trim();
                    if (value) {
                        this.addArrayValue(path, value);
                        input.value = '';
                    }
                }
            });
            container.querySelectorAll('.pill-remove').forEach((btn) => {
                btn.addEventListener('click', () => {
                    this.removeArrayValue(path, Number(btn.dataset.index));
                });
            });
        });
    }

    initListFields() {
        this.stepContainer.querySelectorAll('.editor-list-field').forEach((container) => {
            const path = container.dataset.path;
            const addBtn = container.querySelector('.editor-list-add');
            const input = container.querySelector('.editor-list-input');
            const items = container.querySelector('.editor-list-items');

            const refresh = () => {
                const nextState = this.getValue(path) || [];
                this.setValue(path, nextState);
                this.renderFieldsStep();
            };

            addBtn?.addEventListener('click', () => {
                const value = input.value.trim();
                if (value) {
                    this.addArrayValue(path, value);
                    input.value = '';
                }
            });

            items?.addEventListener('click', (event) => {
                const target = event.target.closest('button[data-action]');
                if (!target) return;
                const action = target.dataset.action;
                const itemEl = target.closest('.editor-list-item');
                if (!itemEl) return;
                const index = Number(itemEl.dataset.index);
                const arr = [...(this.getValue(path) || [])];
                if (action === 'remove') {
                    arr.splice(index, 1);
                } else if (action === 'up' && index > 0) {
                    [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
                } else if (action === 'down' && index < arr.length - 1) {
                    [arr[index + 1], arr[index]] = [arr[index], arr[index + 1]];
                }
                this.setValue(path, arr);
                refresh();
            });
        });
    }

    initDomainFields() {
        this.stepContainer.querySelectorAll('.editor-domains-field').forEach((container) => {
            const path = container.dataset.path;
            container.querySelector('.editor-domain-add')?.addEventListener('click', () => {
                const domains = [...(this.getValue(path) || [])];
                domains.push({ main: '', sans: [] });
                this.setValue(path, domains);
                this.renderFieldsStep();
            });
            container.querySelectorAll('.editor-domain-card').forEach((card) => {
                const index = Number(card.dataset.index);
                card.querySelector('.editor-domain-remove')?.addEventListener('click', () => {
                    const domains = [...(this.getValue(path) || [])];
                    domains.splice(index, 1);
                    this.setValue(path, domains);
                    this.renderFieldsStep();
                });
            });
        });
    }

    addArrayValue(path, value) {
        if (!value) return;
        const arr = this.getValue(path) || [];
        if (!Array.isArray(arr)) return;
        const next = [...arr, value];
        this.setValue(path, next);
        this.renderFieldsStep();
    }

    removeArrayValue(path, index) {
        const arr = this.getValue(path) || [];
        if (!Array.isArray(arr)) return;
        const next = arr.filter((_, i) => i !== index);
        this.setValue(path, next);
        this.renderFieldsStep();
    }

    handlePrimary() {
        if (this.currentStep === 0) {
            if (this.formInvalid) return;
            this.goToStep(1);
            return;
        }
        if (this.saving || this.formInvalid) return;
        this.saveChanges();
    }

    goToStep(stepIndex) {
        if (stepIndex < 0 || stepIndex > 1) return;
        this.currentStep = stepIndex;
        this.renderStep();
    }

    updatePrimaryState() {
        if (this.currentStep === 0) {
            this.nextBtn.disabled = this.formInvalid;
        } else {
            this.nextBtn.disabled = this.formInvalid || this.saving;
        }
    }

    async saveChanges() {
        try {
            this.saving = true;
            this.updatePrimaryState();
            this.status('Saving changes…', 'info');
            const response = await fetch(`/api/v1/config/${encodeURIComponent(this.context.protocol)}/${encodeURIComponent(this.context.section)}/${encodeURIComponent(this.context.name)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'If-Match': this.viewer.revision || '' },
                body: JSON.stringify({ data: this.state, protocol: this.context.protocol, revision: this.viewer.revision })
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || 'Failed to save changes');
            }
            await this.viewer.loadConfig();
            this.viewer.render();
            this.viewer.closeDrawer();
            this.status('Saved successfully.', 'success');
            this.close();
        } catch (error) {
            this.status(error.message, 'error');
        } finally {
            this.saving = false;
            this.updatePrimaryState();
        }
    }

    getArrayOptions(path) {
        if (path.endsWith('entryPoints')) {
            return this.viewer.getEntryPoints();
        }
        if (path.endsWith('middlewares')) {
            return Object.keys(this.viewer.getSection(this.context.protocol, 'middlewares') || {});
        }
        return null;
    }

    getSelectOptions(path) {
        if (this.context.section === 'routers' && path === 'service') {
            return Object.keys(this.viewer.getSection(this.context.protocol, 'services') || {});
        }
        if (path.endsWith('certResolver') || path.endsWith('certResolverAdv')) {
            return this.viewer.getCertResolvers();
        }
        return null;
    }

    getDatalist(path, options) {
        const opts = options || this.getArrayOptions(path);
        if (!opts || !opts.length) return null;
        const safePath = path.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
        const pathHash = Array.from(path).reduce((hash, char) => ((hash * 33) ^ char.charCodeAt(0)) >>> 0, 5381).toString(16);
        const id = `editor-list-${safePath}-${pathHash}`;
        const html = `<datalist id="${id}">${opts.map((opt) => `<option value="${this.escape(opt)}"></option>`).join('')}</datalist>`;
        return { id, html };
    }

    getChanges(original, updated, prefix = '') {
        const changes = [];
        const keys = new Set([...Object.keys(original || {}), ...Object.keys(updated || {})]);
        keys.forEach((key) => {
            const path = prefix ? `${prefix}.${key}` : key;
            const oldValue = original ? original[key] : undefined;
            const newValue = updated ? updated[key] : undefined;
            if (this.isObject(oldValue) && this.isObject(newValue)) {
                changes.push(...this.getChanges(oldValue, newValue, path));
            } else if (!this.deepEqual(oldValue, newValue)) {
                changes.push(path);
            }
        });
        return changes;
    }

    updateYamlPreview() {
        if (!this.yamlPreviewEl) return;
        try {
            const yaml = typeof this.viewer.toYaml === 'function'
                ? this.viewer.toYaml(this.state)
                : JSON.stringify(this.state, null, 2);
            this.yamlPreviewEl.textContent = yaml.trim() || '(empty)';
        } catch (error) {
            this.yamlPreviewEl.textContent = '(preview unavailable)';
        }
    }

    status(message, variant = 'info') {
        this.statusEl.textContent = message || '';
        this.statusEl.dataset.variant = message ? variant : '';
    }

    setValue(path, value) {
        const keys = path.split('.');
        let cursor = this.state;
        for (let i = 0; i < keys.length - 1; i += 1) {
            const segment = keys[i];
            if (cursor[segment] === undefined || typeof cursor[segment] !== 'object') {
                cursor[segment] = {};
            }
            cursor = cursor[segment];
        }
        const lastKey = keys[keys.length - 1];
        if (this.shouldRemoveValue(value)) {
            if (Array.isArray(cursor) && this.isNumericKey(lastKey)) {
                cursor.splice(Number(lastKey), 1);
            } else {
                delete cursor[lastKey];
            }
        } else {
            cursor[lastKey] = value;
        }
        this.pruneEmptyAncestors(keys.slice(0, -1));
    }

    getValue(path) {
        if (!path) return undefined;
        return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), this.state);
    }

    shouldRemoveValue(value) {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string') return value.trim() === '';
        if (Array.isArray(value)) return value.length === 0;
        if (typeof value === 'object') return Object.keys(value).length === 0;
        return false;
    }

    pruneEmptyAncestors(pathParts) {
        let current = this.state;
        const stack = [];
        pathParts.forEach((part) => {
            if (!current || typeof current !== 'object') return;
            stack.push({ parent: current, key: part });
            current = current[part];
        });
        for (let i = stack.length - 1; i >= 0; i -= 1) {
            const { parent, key } = stack[i];
            if (Array.isArray(parent)) continue;
            if (this.shouldRemoveValue(parent[key])) {
                delete parent[key];
            }
        }
    }

    isNumericKey(key) {
        return /^\d+$/.test(key);
    }

    deepEqual(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    isObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value);
    }

    clone(payload) {
        return JSON.parse(JSON.stringify(payload));
    }

    escape(value) {
        const div = document.createElement('div');
        div.textContent = value;
        return div.innerHTML;
    }

    close() {
        this.overlay.classList.add('hidden');
        this.context = null;
        this.originalData = null;
        this.state = null;
        this.status('');
    }
}

window.EditorModal = EditorModal;
