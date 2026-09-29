class TraefikViewer {
    constructor() {
        this.config = {};
        this.originalOrder = {}; // Store original config order
        this.currentView = this.loadState('currentView') || 'overview';
        this.searches = this.loadState('searches') || { http: '', tcp: '', udp: '' };
        this.sorts = this.loadState('sorts') || { http: null, tcp: null, udp: null };
        this.sectionSearches = this.loadState('sectionSearches') || {};
        this.sectionSorts = this.loadState('sectionSorts') || {};
        this.currentDrawerContext = null;
        this.settingsManager = null;
        this.rawYaml = '';
        this.rawYamlLoaded = false;
        this.yamlDirty = false;
        this.deleteManager = window.DeleteManager ? new window.DeleteManager(this) : null;
        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.init();
        document.addEventListener('click', this.handleDocumentClick);
    }

    // State persistence methods
    loadState(key) {
        try {
            const value = localStorage.getItem(`traefik-${key}`);
            return value ? JSON.parse(value) : null;
        } catch {
            return null;
        }
    }

    saveState(key, value) {
        try {
            localStorage.setItem(`traefik-${key}`, JSON.stringify(value));
        } catch {
            // Ignore storage errors
        }
    }

    // Sanitization methods
    sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        return input
            .slice(0, 50)
            .replace(/[<>\"\'&\\]/g, '')
            .replace(/[\x00-\x1F\x7F]/g, '')
            .trim();
    }

    sanitizeSearchQuery(query) {
        if (typeof query !== 'string') return '';
        // Only allow alphanumeric, dash, underscore, dot, @ for search
        return query
            .slice(0, 50)
            .replace(/[^a-zA-Z0-9_\-@.\s]/g, '')
            .toLowerCase()
            .trim();
    }

    escapeHtml(text) {
        if (typeof text !== 'string') text = String(text ?? '');
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    validateProtocol(protocol) {
        const valid = ['http', 'tcp', 'udp'];
        return valid.includes(protocol) ? protocol : null;
    }

    validateSection(section) {
        const valid = ['routers', 'middlewares', 'services'];
        return valid.includes(section) ? section : null;
    }

    validateName(name) {
        if (typeof name !== 'string') return null;
        const sanitized = name.replace(/[^a-zA-Z0-9_\-@.]/g, '').slice(0, 50);
        return sanitized || null;
    }

    async init() {
        await this.loadConfig();
        await this.prefetchRawYaml();
        this.bindEvents();
        this.restoreState();
        this.render();
    }

    async prefetchRawYaml() {
        try {
            await this.fetchRawYaml();
        } catch (error) {
            console.warn('Raw YAML preload failed:', error.message);
        }
    }

    storeOriginalOrder() {
        ['http', 'tcp', 'udp'].forEach(protocol => {
            this.originalOrder[protocol] = {};
            ['routers', 'middlewares', 'services'].forEach(type => {
                const items = this.config[protocol]?.[type];
                if (items) {
                    this.originalOrder[protocol][type] = Object.keys(items);
                }
            });
        });
    }

    restoreState() {
        // Restore current view
        if (this.currentView) {
            this.switchView(this.currentView, false);
        }

        // Restore overview sort button states
        ['http', 'tcp', 'udp'].forEach(protocol => {
            const sort = this.sorts[protocol];
            document.querySelectorAll(`.filter-btn[data-protocol="${protocol}"]:not(.section-filter)`).forEach(btn => {
                btn.classList.toggle('active', sort && btn.dataset.sort === sort);
            });

            // Restore search input values
            const search = this.searches[protocol];
            if (search) {
                const input = document.getElementById(`${protocol}-search`);
                if (input) {
                    input.value = search;
                    this.updateSearchBoxState(input);
                }
            }
        });

        // Restore section filter states
        Object.entries(this.sectionSorts).forEach(([key, sort]) => {
            const [protocol, type] = key.split('-');
            document.querySelectorAll(`.section-filter[data-protocol="${protocol}"][data-type="${type}"]`).forEach(btn => {
                btn.classList.toggle('active', sort && btn.dataset.sort === sort);
            });
        });

        // Restore section search values
        Object.entries(this.sectionSearches).forEach(([key, value]) => {
            if (value) {
                const [protocol, type] = key.split('-');
                const input = document.querySelector(`.section-search[data-protocol="${protocol}"][data-type="${type}"]`);
                if (input) {
                    input.value = value;
                    this.updateSearchBoxState(input);
                }
            }
        });
    }

    async loadConfig() {
        try {
            const [configRes, siteRes, settingsRes] = await Promise.all([
                fetch('/api/config'),
                fetch('/api/site-config'),
                fetch('/api/settings')
            ]);
            
            if (!configRes.ok || !siteRes.ok) {
                throw new Error('Failed to fetch config');
            }
            
            this.config = await configRes.json();
            // Store original order
            this.storeOriginalOrder();
            
            const site = await siteRes.json();
            
            const titleEl = document.getElementById('site-title');
            const pathEl = document.getElementById('config-path');
            
            if (titleEl) titleEl.textContent = this.sanitizeInput(site.title?.split(' ')[0] || 'Traefik');
            if (pathEl) pathEl.textContent = this.sanitizeInput(site.configPath || '');
            document.title = this.sanitizeInput(site.title || 'Traefik Config Manager');

            // Load settings if available
            if (settingsRes.ok) {
                this.updateSettingsCache(await settingsRes.json());
            }
        } catch (e) { 
            console.error('Load failed:', e); 
        }
    }

    getSection(protocol, type) {
        const p = this.validateProtocol(protocol);
        const t = this.validateSection(type);
        if (!p || !t) return {};
        return this.config[p]?.[t] || {};
    }

    countItems(protocol) {
        const p = this.validateProtocol(protocol);
        if (!p) return 0;
        const s = this.config[p] || {};
        return (s.routers ? Object.keys(s.routers).length : 0) +
               (s.middlewares ? Object.keys(s.middlewares).length : 0) +
               (s.services ? Object.keys(s.services).length : 0);
    }

    bindEvents() {
        const mobileToggle = document.getElementById('mobile-menu-toggle');
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('overlay');
        const drawerClose = document.getElementById('drawer-close');
        const drawerDelete = document.getElementById('drawer-delete');

        // Mobile menu toggle
        if (mobileToggle) {
            mobileToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMobileMenu();
            });
        }

        // Nav item clicks
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                this.switchView(item.dataset.view, true);
                // Always close menu on navigation for tablet/mobile
                if (window.innerWidth <= 1024) {
                    this.closeMobileMenu();
                }
            });
        });

        // Drawer close button
        if (drawerClose) {
            drawerClose.addEventListener('click', () => this.closeDrawer());
        }
        if (drawerDelete) {
            drawerDelete.addEventListener('click', () => {
                if (this.currentDrawerContext) {
                    this.deleteManager?.open({ ...this.currentDrawerContext });
                }
            });
        }

        // Overlay click - handles both menu and drawer
        if (overlay) {
            overlay.addEventListener('click', () => {
                const drawer = document.getElementById('drawer');
                if (drawer?.classList.contains('open')) {
                    this.closeDrawer();
                } else if (sidebar?.classList.contains('open') && window.innerWidth > 768) {
                    // Only close on overlay click for tablet, not mobile (full screen)
                    this.closeMobileMenu();
                }
            });
        }

        // Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const drawer = document.getElementById('drawer');
                if (drawer?.classList.contains('open')) {
                    this.closeDrawer();
                } else if (sidebar?.classList.contains('open')) {
                    this.closeMobileMenu();
                }
            }
        });

        // Handle window resize - close menu if resizing to large screen
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (window.innerWidth > 1024) {
                    this.closeMobileMenu();
                }
            }, 100);
        });

        // Overview filter button handlers (toggle behavior)
        document.querySelectorAll('.filter-btn:not(.section-filter)').forEach(btn => {
            btn.addEventListener('click', () => {
                const protocol = this.validateProtocol(btn.dataset.protocol);
                const sort = btn.dataset.sort;
                if (!protocol || !sort) return;
                
                const isActive = btn.classList.contains('active');
                
                // Deselect all in this protocol
                document.querySelectorAll(`.filter-btn[data-protocol="${protocol}"]:not(.section-filter)`).forEach(b => {
                    b.classList.remove('active');
                });
                
                // Toggle: if was active, set to null (original order), else set new sort
                if (isActive) {
                    this.sorts[protocol] = null;
                } else {
                    btn.classList.add('active');
                    this.sorts[protocol] = sort;
                }
                
                this.saveState('sorts', this.sorts);
                this.renderFlowDiagram(protocol, `${protocol}-flow-diagram`);
            });
        });

        // Section filter button handlers (toggle behavior)
        document.querySelectorAll('.section-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                const protocol = this.validateProtocol(btn.dataset.protocol);
                const type = this.validateSection(btn.dataset.type);
                const sort = btn.dataset.sort;
                if (!protocol || !type || !sort) return;
                
                const key = `${protocol}-${type}`;
                const isActive = btn.classList.contains('active');
                
                // Deselect all in this section
                document.querySelectorAll(`.section-filter[data-protocol="${protocol}"][data-type="${type}"]`).forEach(b => {
                    b.classList.remove('active');
                });
                
                // Toggle
                if (isActive) {
                    this.sectionSorts[key] = null;
                } else {
                    btn.classList.add('active');
                    this.sectionSorts[key] = sort;
                }
                
                this.saveState('sectionSorts', this.sectionSorts);
                this.renderSectionItems(protocol, type);
            });
        });

        // Overview search handlers
        ['http', 'tcp', 'udp'].forEach(protocol => {
            const input = document.getElementById(`${protocol}-search`);
            if (input) {
                input.addEventListener('input', (e) => {
                    const sanitized = this.sanitizeSearchQuery(e.target.value);
                    this.searches[protocol] = sanitized;
                    this.saveState('searches', this.searches);
                    this.updateSearchBoxState(input);
                    this.renderFlowDiagram(protocol, `${protocol}-flow-diagram`);
                });

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        input.value = '';
                        this.searches[protocol] = '';
                        this.saveState('searches', this.searches);
                        this.updateSearchBoxState(input);
                        this.renderFlowDiagram(protocol, `${protocol}-flow-diagram`);
                        input.blur();
                    }
                });

                const clearBtn = input.parentElement?.querySelector('.search-clear');
                if (clearBtn) {
                    clearBtn.addEventListener('click', () => {
                        input.value = '';
                        this.searches[protocol] = '';
                        this.saveState('searches', this.searches);
                        this.updateSearchBoxState(input);
                        this.renderFlowDiagram(protocol, `${protocol}-flow-diagram`);
                        input.focus();
                    });
                }
            }
        });

        // Section search handlers
        document.querySelectorAll('.section-search').forEach(input => {
            input.addEventListener('input', (e) => {
                const protocol = this.validateProtocol(input.dataset.protocol);
                const type = this.validateSection(input.dataset.type);
                if (!protocol || !type) return;
                
                const sanitized = this.sanitizeSearchQuery(e.target.value);
                const key = `${protocol}-${type}`;
                this.sectionSearches[key] = sanitized;
                this.saveState('sectionSearches', this.sectionSearches);
                this.updateSearchBoxState(input);
                this.renderSectionItems(protocol, type);
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    const protocol = this.validateProtocol(input.dataset.protocol);
                    const type = this.validateSection(input.dataset.type);
                    if (!protocol || !type) return;
                    
                    input.value = '';
                    const key = `${protocol}-${type}`;
                    this.sectionSearches[key] = '';
                    this.saveState('sectionSearches', this.sectionSearches);
                    this.updateSearchBoxState(input);
                    this.renderSectionItems(protocol, type);
                    input.blur();
                }
            });

            const clearBtn = input.parentElement?.querySelector('.search-clear');
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    const protocol = this.validateProtocol(input.dataset.protocol);
                    const type = this.validateSection(input.dataset.type);
                    if (!protocol || !type) return;
                    
                    input.value = '';
                    const key = `${protocol}-${type}`;
                    this.sectionSearches[key] = '';
                    this.saveState('sectionSearches', this.sectionSearches);
                    this.updateSearchBoxState(input);
                    this.renderSectionItems(protocol, type);
                    input.focus();
                });
            }
        });

        // Nav add buttons - open modal
        document.querySelectorAll('.nav-add-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const protocol = this.validateProtocol(btn.dataset.protocol);
                if (protocol && window.configModal) {
                    window.configModal.open(protocol);
                }
            });
        });

        const drawerEdit = document.getElementById('drawer-edit');
        if (drawerEdit) {
            drawerEdit.addEventListener('click', () => {
                if (!this.currentDrawerContext || !window.editorModal) return;
                window.editorModal.open({ ...this.currentDrawerContext });
            });
        }

        this.bindYamlEditorEvents();
    }

    bindYamlEditorEvents() {
        const editor = document.getElementById('yaml-editor');
        if (editor && !editor.dataset.bound) {
            editor.dataset.bound = 'true';
            editor.addEventListener('input', () => this.setYamlDirty(true));
        }

        const saveBtn = document.getElementById('yaml-save-btn');
        if (saveBtn && !saveBtn.dataset.bound) {
            saveBtn.dataset.bound = 'true';
            saveBtn.addEventListener('click', () => this.saveRawYaml());
        }

        const resetBtn = document.getElementById('yaml-reset-btn');
        if (resetBtn && !resetBtn.dataset.bound) {
            resetBtn.dataset.bound = 'true';
            resetBtn.addEventListener('click', () => this.resetYamlEditor());
        }
    }

    async fetchRawYaml() {
        const res = await fetch('/api/config/raw');
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Failed to load YAML');
        }
        const { yaml } = await res.json();
        this.rawYaml = typeof yaml === 'string' ? yaml : '';
        this.rawYamlLoaded = true;
    }

    setYamlDirty(isDirty) {
        this.yamlDirty = !!isDirty;
        const saveBtn = document.getElementById('yaml-save-btn');
        if (saveBtn) saveBtn.disabled = !this.yamlDirty;
        if (!isDirty) this.bindYamlEditorEvents();
    }

    setYamlStatus(message, variant = 'muted') {
        const statusEl = document.getElementById('yaml-status');
        if (statusEl) {
            statusEl.textContent = message || '';
            statusEl.dataset.variant = variant;
        }
    }

    async renderYaml() {
        const editor = document.getElementById('yaml-editor');
        if (!editor) return;

        const fallbackYaml = this.toYaml(this.config) || '';
        editor.value = this.rawYamlLoaded && this.rawYaml ? this.rawYaml : fallbackYaml;
        editor.scrollTop = 0;
        this.setYamlDirty(false);
        this.setYamlStatus('Loading…', 'muted');

        try {
            await this.fetchRawYaml();
            editor.value = this.rawYaml || fallbackYaml;
            editor.scrollTop = 0;
            this.setYamlDirty(false);
            this.setYamlStatus('');
        } catch (error) {
            if (!editor.value) {
                editor.value = fallbackYaml;
                editor.scrollTop = 0;
            }
            this.setYamlStatus(error.message, 'error');
        }
    }

    async saveRawYaml() {
        const editor = document.getElementById('yaml-editor');
        if (!editor) return;
        const payload = editor.value ?? '';
        this.setYamlStatus('Saving…', 'muted');
        const saveBtn = document.getElementById('yaml-save-btn');
        saveBtn && (saveBtn.disabled = true);

        try {
            const res = await fetch('/api/config/raw', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ yaml: payload })
            });
            const result = await res.json();
            if (!res.ok || !result.success) {
                throw new Error(result.error || 'Save failed');
            }

            this.rawYaml = payload;
            this.setYamlDirty(false);
            await this.loadConfig();
            this.render();
            this.setYamlStatus('Config saved successfully', 'success');
        } catch (error) {
            this.setYamlStatus(error.message, 'error');
            this.setYamlDirty(true);
        }
    }

    async resetYamlEditor() {
        this.setYamlStatus('Reloading…', 'muted');
        try {
            await this.renderYaml();
            this.setYamlStatus('Reloaded from disk', 'success');
        } catch (error) {
            this.setYamlStatus(error.message, 'error');
        }
    }

    handleDocumentClick(e) {
        const drawer = document.getElementById('drawer');
        if (!drawer?.classList.contains('open')) return;
        const target = e.target;
        if (drawer.contains(target)) return;
        if (target.closest('.item-card') || target.closest('.flow-node') || target.closest('.connection-chip')) return;
        this.closeDrawer();
    }

    updateSearchBoxState(input) {
        const searchBox = input.parentElement;
        if (searchBox) {
            searchBox.classList.toggle('has-value', input.value.length > 0);
        }
    }

    switchView(view, save = true) {
        const validViews = ['overview', 'yaml', 'settings', 'http-routers', 'http-middlewares', 'http-services', 
                           'tcp-routers', 'tcp-middlewares', 'tcp-services', 'udp-routers', 'udp-services',
                           'entry-points', 'cert-resolvers'];
        if (!validViews.includes(view)) return;
        
        this.currentView = view;
        if (save) {
            this.saveState('currentView', view);
        }
        
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view);
        });
        document.querySelectorAll('.view').forEach(v => {
            v.classList.toggle('active', v.id === `view-${view}`);
        });
        if (view === 'yaml') this.renderYaml();
        if (view === 'settings') {
            if (!this.settingsManager && window.SettingsManager) {
                this.settingsManager = new window.SettingsManager(this);
            }
            this.settingsManager?.render();
        }
        if (view === 'entry-points') this.renderEntryPointsView();
        if (view === 'cert-resolvers') this.renderCertResolversView();
    }

    render() {
        this.updateCounts();
        this.renderOverview();
        this.renderAllSections();
        this.renderEntryPointsView();
        this.renderCertResolversView();
    }

    updateCounts() {
        const counts = {
            http: { r: Object.keys(this.getSection('http', 'routers')).length, m: Object.keys(this.getSection('http', 'middlewares')).length, s: Object.keys(this.getSection('http', 'services')).length },
            tcp: { r: Object.keys(this.getSection('tcp', 'routers')).length, m: Object.keys(this.getSection('tcp', 'middlewares')).length, s: Object.keys(this.getSection('tcp', 'services')).length },
            udp: { r: Object.keys(this.getSection('udp', 'routers')).length, s: Object.keys(this.getSection('udp', 'services')).length }
        };

        const setCount = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        setCount('nav-http-router-count', counts.http.r);
        setCount('nav-http-middleware-count', counts.http.m);
        setCount('nav-http-service-count', counts.http.s);
        setCount('nav-tcp-router-count', counts.tcp.r);
        setCount('nav-tcp-middleware-count', counts.tcp.m);
        setCount('nav-tcp-service-count', counts.tcp.s);
        setCount('nav-udp-router-count', counts.udp.r);
        setCount('nav-udp-service-count', counts.udp.s);

        setCount('http-router-count', counts.http.r);
        setCount('http-middleware-count', counts.http.m);
        setCount('http-service-count', counts.http.s);
        setCount('tcp-router-count', counts.tcp.r);
        setCount('tcp-middleware-count', counts.tcp.m);
        setCount('tcp-service-count', counts.tcp.s);
        setCount('udp-router-count', counts.udp.r);
        setCount('udp-service-count', counts.udp.s);
        setCount('nav-entry-point-count', this.getEntryPointNames().length);
        setCount('nav-cert-resolver-count', this.getCertResolverNames().length);
    }

    renderOverview() {
        this.renderFlowDiagram('http', 'http-flow-diagram');
        this.renderFlowDiagram('tcp', 'tcp-flow-diagram');
        this.renderFlowDiagram('udp', 'udp-flow-diagram');
        this.renderEntryPointsOverview();
        this.renderCertResolversOverview();

        const setDisplay = (id, show) => {
            const el = document.getElementById(id);
            if (el) el.style.display = show ? 'block' : 'none';
        };

        setDisplay('http-flow-section', this.countItems('http') > 0);
        setDisplay('tcp-flow-section', this.countItems('tcp') > 0);
        setDisplay('udp-flow-section', this.countItems('udp') > 0);

        // Recalculate heights after rendering
        requestAnimationFrame(() => this.calculateRowHeight());
    }

    // Strict prefix-based search matching - only matches from the start
    matchesPrefixSearch(name, search) {
        if (!search) return true;
        const nameLower = name.toLowerCase();
        const searchLower = search.toLowerCase();
        
        // Only check if name starts with search - no segment matching
        return nameLower.startsWith(searchLower);
    }

    // Extract IP address from service URL for sorting
    extractIpFromService(serviceData, protocol) {
        if (!serviceData?.loadBalancer?.servers?.[0]) return '';
        const server = serviceData.loadBalancer.servers[0];
        const url = protocol === 'http' ? server.url : server.address;
        if (!url) return '';
        
        try {
            // Try to extract IP from URL
            const match = url.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
            return match ? match[1] : url;
        } catch {
            return url;
        }
    }

    // Convert IP to sortable number
    ipToNumber(ip) {
        if (!ip) return 0;
        const parts = ip.split('.');
        if (parts.length !== 4) return 0;
        return parts.reduce((acc, part) => (acc << 8) + parseInt(part, 10), 0) >>> 0;
    }

    // Sort routers based on current sort setting
    sortRouters(routers, protocol, sort) {
        const p = this.validateProtocol(protocol);
        if (!p) return routers;

        return [...routers].sort((a, b) => {
            const [nameA, dataA] = a;
            const [nameB, dataB] = b;

            switch (sort) {
                case 'name-asc':
                    return nameA.localeCompare(nameB);
                case 'name-desc':
                    return nameB.localeCompare(nameA);
                case 'ip-asc':
                case 'ip-desc': {
                    const serviceA = dataA.service ? this.getSection(p, 'services')[dataA.service] : null;
                    const serviceB = dataB.service ? this.getSection(p, 'services')[dataB.service] : null;
                    const ipA = this.extractIpFromService(serviceA, p);
                    const ipB = this.extractIpFromService(serviceB, p);
                    const numA = this.ipToNumber(ipA);
                    const numB = this.ipToNumber(ipB);
                    
                    if (numA === numB) return nameA.localeCompare(nameB);
                    return sort === 'ip-asc' ? numA - numB : numB - numA;
                }
                default:
                    return nameA.localeCompare(nameB);
            }
        });
    }

    // Sort items, returning original order if sort is null
    sortItems(items, protocol, type, sort) {
        if (!sort) {
            // Return in original config order
            const originalKeys = this.originalOrder[protocol]?.[type] || [];
            return items.sort((a, b) => {
                const indexA = originalKeys.indexOf(a[0]);
                const indexB = originalKeys.indexOf(b[0]);
                return indexA - indexB;
            });
        }

        return [...items].sort((a, b) => {
            const [nameA, dataA] = a;
            const [nameB, dataB] = b;

            switch (sort) {
                case 'name-asc':
                    return nameA.localeCompare(nameB);
                case 'name-desc':
                    return nameB.localeCompare(nameA);
                case 'ip-asc':
                case 'ip-desc': {
                    let ipA, ipB;
                    if (type === 'services') {
                        ipA = this.extractIpFromServiceData(dataA, protocol);
                        ipB = this.extractIpFromServiceData(dataB, protocol);
                    } else {
                        // For routers, get IP from linked service
                        const serviceA = dataA.service ? this.getSection(protocol, 'services')[dataA.service] : null;
                        const serviceB = dataB.service ? this.getSection(protocol, 'services')[dataB.service] : null;
                        ipA = this.extractIpFromServiceData(serviceA, protocol);
                        ipB = this.extractIpFromServiceData(serviceB, protocol);
                    }
                    const numA = this.ipToNumber(ipA);
                    const numB = this.ipToNumber(ipB);
                    
                    if (numA === numB) return nameA.localeCompare(nameB);
                    return sort === 'ip-asc' ? numA - numB : numB - numA;
                }
                default:
                    return 0;
            }
        });
    }

    extractIpFromServiceData(serviceData, protocol) {
        if (!serviceData?.loadBalancer?.servers?.[0]) return '';
        const server = serviceData.loadBalancer.servers[0];
        const url = protocol === 'http' ? server.url : server.address;
        if (!url) return '';
        const match = url.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        return match ? match[1] : '';
    }

    renderFlowDiagram(protocol, containerId) {
        const p = this.validateProtocol(protocol);
        if (!p) return;
        
        const container = document.getElementById(containerId);
        const searchInfoContainer = document.getElementById(`${p}-search-info`);
        
        if (!container) return;
        
        let routers = Object.entries(this.getSection(p, 'routers'));
        const totalCount = routers.length;

        // Apply search filter
        const search = this.searches[p];
        if (search) {
            routers = routers.filter(([name]) => this.matchesPrefixSearch(name, search));
        }

        // Apply sorting (null = original order)
        const sort = this.sorts[p];
        routers = this.sortItems(routers, p, 'routers', sort);

        // Update search info
        if (searchInfoContainer) {
            if (search) {
                searchInfoContainer.textContent = `Showing ${routers.length} of ${totalCount} routers starting with "${this.escapeHtml(search)}"`;
            } else {
                searchInfoContainer.textContent = '';
            }
        }

        if (routers.length === 0) {
            container.innerHTML = `<div class="flow-diagram-scroll"><div class="flow-empty">${search ? 'No results found' : `No ${p.toUpperCase()} routers configured`}</div></div>`;
            return;
        }

        // Render rows
        const rowsHtml = routers.map(([name, data]) => {
            const middlewares = data.middlewares || [];
            const service = data.service;
            const serviceData = service ? this.getSection(p, 'services')[service] : null;
            const serverUrl = this.getServiceUrl(serviceData, p);
            const escapedName = this.escapeHtml(name);

            let html = `<div class="flow-row">`;
            const rulePreview = data.rule ? this.extractHost(data.rule) : '';
            html += `<div class="flow-node-wrapper"><span class="flow-node router" data-protocol="${p}" data-section="routers" data-name="${escapedName}">${escapedName}</span>`;
            if (rulePreview) html += `<span class="flow-node-sub">${this.escapeHtml(rulePreview)}</span>`;
            html += `</div>`;

            if (middlewares.length > 0 && p !== 'udp') {
                html += `<span class="flow-arrow">→</span><div class="flow-group">`;
                html += middlewares.map(m => {
                    const mwData = this.getSection(p, 'middlewares')[m];
                    const mwType = mwData ? Object.keys(mwData)[0] : '?';
                    const escapedM = this.escapeHtml(m);
                    return `<div class="flow-node-wrapper"><span class="flow-node middleware" data-protocol="${p}" data-section="middlewares" data-name="${escapedM}">${escapedM}</span><span class="flow-node-sub">${this.escapeHtml(mwType)}</span></div>`;
                }).join('');
                html += `</div>`;
            }

            if (service) {
                const escapedService = this.escapeHtml(service);
                html += `<span class="flow-arrow">→</span><div class="flow-node-wrapper"><span class="flow-node service" data-protocol="${p}" data-section="services" data-name="${escapedService}">${escapedService}</span>`;
                if (serverUrl) html += `<span class="flow-node-sub">${this.escapeHtml(this.truncateUrl(serverUrl))}</span>`;
                html += `</div>`;
            }
            return html + `</div>`;
        }).join('');

        container.innerHTML = `<div class="flow-diagram-scroll">${rowsHtml}</div>`;

        container.querySelectorAll('.flow-node').forEach(node => {
            node.addEventListener('click', () => {
                const nodeProtocol = this.validateProtocol(node.dataset.protocol);
                const nodeSection = this.validateSection(node.dataset.section);
                const nodeName = this.validateName(node.dataset.name);
                if (nodeProtocol && nodeSection && nodeName) {
                    this.openDrawer(nodeProtocol, nodeSection, nodeName);
                }
            });
        });
    }

    getServiceUrl(serviceData, protocol) {
        if (!serviceData) return '';
        return protocol === 'http' 
            ? serviceData.loadBalancer?.servers?.[0]?.url || ''
            : serviceData.loadBalancer?.servers?.[0]?.address || '';
    }

    renderAllSections() {
        this.renderSectionItems('http', 'routers');
        this.renderSectionItems('http', 'middlewares');
        this.renderSectionItems('http', 'services');
        this.renderSectionItems('tcp', 'routers');
        this.renderSectionItems('tcp', 'middlewares');
        this.renderSectionItems('tcp', 'services');
        this.renderSectionItems('udp', 'routers');
        this.renderSectionItems('udp', 'services');
    }

    renderSectionItems(protocol, type) {
        const p = this.validateProtocol(protocol);
        const t = this.validateSection(type);
        if (!p || !t) return;
        
        const containerId = `${p}-${t}-grid`;
        const container = document.getElementById(containerId);
        const searchInfoContainer = document.getElementById(`${p}-${t}-search-info`);
        if (!container) return;

        let items = Object.entries(this.getSection(p, t));
        const totalCount = items.length;
        const searchKey = `${p}-${t}`;
        const search = this.sectionSearches[searchKey] || '';

        // Apply search filter
        if (search) {
            items = items.filter(([name]) => this.matchesPrefixSearch(name, search));
        }

        // Apply sorting (null = original order)
        const sort = this.sectionSorts[searchKey] || null;
        items = this.sortItems(items, p, t, sort);

        // Update search info
        const totalTypeLabel = t === 'middlewares' ? 'middlewares' : t === 'routers' ? 'routers' : 'services';
        
        if (searchInfoContainer) {
            if (search) {
                searchInfoContainer.textContent = `Showing ${items.length} of ${totalCount} ${totalTypeLabel} starting with "${this.escapeHtml(search)}"`;
            } else {
                searchInfoContainer.textContent = '';
            }
        }

        if (items.length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">●</div>${search ? 'No results found' : `No ${p.toUpperCase()} ${t} configured`}</div>`;
            return;
        }

        if (t === 'routers') {
            this.renderRoutersGrid(container, items, p);
        } else if (t === 'middlewares') {
            this.renderMiddlewaresGrid(container, items, p);
        } else if (t === 'services') {
            this.renderServicesGrid(container, items, p);
        }
    }

    renderRoutersGrid(container, routers, protocol) {
        container.innerHTML = routers.map(([name, data]) => {
            const tags = [];
            if (data.tls) tags.push('<span class="item-tag tls">TLS</span>');
            (data.entryPoints || []).forEach(e => tags.push(`<span class="item-tag">${this.escapeHtml(e)}</span>`));

            const connections = [];
            if (data.middlewares && protocol !== 'udp') {
                data.middlewares.forEach(m => connections.push(`<span class="conn-chip middleware">${this.escapeHtml(m)}</span>`));
            }
            if (data.service) connections.push(`<span class="conn-chip service">${this.escapeHtml(data.service)}</span>`);

            return `<div class="item-card router" data-protocol="${protocol}" data-section="routers" data-name="${this.escapeHtml(name)}">
                <div class="item-card-header">
                    <div class="item-card-heading">
                        <span class="item-dot"></span>
                        <span class="item-name">${this.escapeHtml(name)}</span>
                    </div>
                    <div class="item-card-actions">
                        <button type="button" class="item-card-edit">Edit</button>
                        <button type="button" class="item-card-delete">Delete</button>
                    </div>
                </div>
                ${data.rule ? `<div class="item-rule">${this.escapeHtml(data.rule)}</div>` : ''}
                ${connections.length ? `<div class="item-connections">${connections.join('')}</div>` : ''}
                ${tags.length ? `<div class="item-tags">${tags.join('')}</div>` : ''}
            </div>`;
        }).join('');
        this.bindCardEvents(container);
    }

    renderMiddlewaresGrid(container, middlewares, protocol) {
        container.innerHTML = middlewares.map(([name, data]) => {
            const type = Object.keys(data)[0] || 'unknown';
            const typeConfig = data[type] || {};
            const usedBy = this.getRoutersUsing(protocol, 'middlewares', name);
            const configPreview = this.getMiddlewareConfigPreview(type, typeConfig);

            return `<div class="item-card middleware" data-protocol="${protocol}" data-section="middlewares" data-name="${this.escapeHtml(name)}">
                <div class="item-card-header">
                    <div class="item-card-heading">
                        <span class="item-dot"></span>
                        <span class="item-name">${this.escapeHtml(name)}</span>
                    </div>
                    <div class="item-card-actions">
                        <button type="button" class="item-card-edit">Edit</button>
                        <button type="button" class="item-card-delete">Delete</button>
                    </div>
                </div>
                <div class="middleware-detail">
                    ${configPreview ? `<div class="middleware-config-preview">${configPreview}</div>` : ''}
                </div>
                <div class="item-used-by">
                    ${usedBy.length > 0 
                        ? `<span class="used-by-label">Routers:</span> ${usedBy.map(r => `<span class="conn-chip router">${this.escapeHtml(r)}</span>`).join('')}`
                        : '<span class="unused-label">Not used</span>'}
                </div>
            </div>`;
        }).join('');
        this.bindCardEvents(container);
    }

    renderServicesGrid(container, services, protocol) {
        container.innerHTML = services.map(([name, data]) => {
            const servers = data.loadBalancer?.servers || [];
            const usedBy = this.getRoutersUsing(protocol, 'services', name);
            const urlField = protocol === 'http' ? 'url' : 'address';

            return `<div class="item-card service" data-protocol="${protocol}" data-section="services" data-name="${this.escapeHtml(name)}">
                <div class="item-card-header">
                    <div class="item-card-heading">
                        <span class="item-dot"></span>
                        <span class="item-name">${this.escapeHtml(name)}</span>
                    </div>
                    <div class="item-card-actions">
                        <button type="button" class="item-card-edit">Edit</button>
                        <button type="button" class="item-card-delete">Delete</button>
                    </div>
                </div>
                <div class="item-servers">
                    ${servers.slice(0, 3).map(s => `<div class="server-url">${this.escapeHtml(s[urlField] || s.url || s.address || '')}</div>`).join('')}
                    ${servers.length > 3 ? `<div class="server-more">+${servers.length - 3} more</div>` : ''}
                </div>
                <div class="item-used-by">
                    ${usedBy.length > 0 
                        ? `<span class="used-by-label">Routers:</span> ${usedBy.map(r => `<span class="conn-chip router">${this.escapeHtml(r)}</span>`).join('')}`
                        : '<span class="unused-label">Not used</span>'}
                </div>
            </div>`;
        }).join('');
        this.bindCardEvents(container);
    }

    bindCardEvents(container) {
        container.querySelectorAll('.item-card').forEach(card => {
            card.addEventListener('click', () => {
                const protocol = this.validateProtocol(card.dataset.protocol);
                const section = this.validateSection(card.dataset.section);
                const name = this.validateName(card.dataset.name);
                if (protocol && section && name) {
                    this.openDrawer(protocol, section, name);
                }
            });
            card.querySelector('.item-card-edit')?.addEventListener('click', (e) => {
                e.stopPropagation();
                const protocol = this.validateProtocol(card.dataset.protocol);
                const section = this.validateSection(card.dataset.section);
                const name = this.validateName(card.dataset.name);
                if (protocol && section && name) {
                    this.openEditorFor(protocol, section, name);
                }
            });
            card.querySelector('.item-card-delete')?.addEventListener('click', (e) => {
                e.stopPropagation();
                const protocol = this.validateProtocol(card.dataset.protocol);
                const section = this.validateSection(card.dataset.section);
                const name = this.validateName(card.dataset.name);
                if (protocol && section && name) {
                    this.deleteManager?.open({ protocol, section, name });
                }
            });
        });
    }

    openDrawer(protocol, section, name) {
        const p = this.validateProtocol(protocol);
        const s = this.validateSection(section);
        const n = this.validateName(name);
        if (!p || !s || !n) return;
        
        const data = this.getSection(p, s)[n];
        if (!data) return;

        const type = s.slice(0, -1);
        const dp = document.getElementById('drawer-protocol');
        dp.textContent = p.toUpperCase();
        dp.className = `drawer-protocol ${p}`;
        const dt = document.getElementById('drawer-type');
        dt.textContent = type;
        dt.className = `drawer-type ${type}`;
        document.getElementById('drawer-name').textContent = this.escapeHtml(n);
        document.getElementById('drawer-yaml').textContent = this.toYaml(data);

        this.renderDrawerProps(p, s, n, data);
        this.renderDrawerConnections(p, s, n, data);

        const canEdit = ['routers', 'middlewares', 'services'].includes(s);
        const drawerEdit = document.getElementById('drawer-edit');
        const drawerDelete = document.getElementById('drawer-delete');
        if (drawerEdit) {
            drawerEdit.hidden = !canEdit;
            drawerEdit.disabled = !window.editorModal;
        }
        if (drawerDelete) {
            drawerDelete.hidden = !canEdit;
            drawerDelete.disabled = !this.deleteManager;
        }
        this.currentDrawerContext = canEdit
            ? { protocol: p, section: s, name: n, data: this.cloneData(data) }
            : null;
        document.getElementById('drawer').classList.add('open');
        document.getElementById('overlay').classList.add('visible');
        
        // Close mobile menu if open
        this.closeMobileMenu();
    }

    openEditorFor(protocol, section, name) {
        if (!window.editorModal) return;
        const data = this.cloneData(this.getSection(protocol, section)[name]);
        if (!data) return;
        window.editorModal.open({ protocol, section, name, data });
    }

    renderDrawerProps(protocol, section, name, data) {
        const container = document.getElementById('drawer-props');
        let rows = [];

        if (section === 'routers') {
            if (data.rule) rows.push(['Rule', data.rule]);
            if (data.entryPoints) rows.push(['Entry Points', data.entryPoints.join(', ')]);
            if (data.service) rows.push(['Service', data.service]);
            if (data.middlewares) rows.push(['Middlewares', data.middlewares.join(', ')]);
            if (data.tls) rows.push(['TLS', typeof data.tls === 'object' ? (data.tls.certResolver || 'Yes') : 'Yes']);
            if (data.priority) rows.push(['Priority', data.priority]);
        } else if (section === 'middlewares') {
            const type = Object.keys(data)[0];
            rows.push(['Type', type]);
        } else if (section === 'services') {
            const servers = data.loadBalancer?.servers || [];
            const urlField = protocol === 'http' ? 'url' : 'address';
            rows.push(['Servers', servers.length]);
            servers.forEach((s, i) => rows.push([`Server ${i + 1}`, s[urlField] || s.url || s.address || '']));
        }

        container.innerHTML = rows.map(([l, v]) => `<div class="prop-row"><span class="prop-label">${this.escapeHtml(String(l))}</span><span class="prop-value">${this.escapeHtml(String(v))}</span></div>`).join('');
    }

    renderDrawerConnections(protocol, section, name, data) {
        const container = document.getElementById('drawer-connections');
        let html = '';

        if (section === 'routers') {
            const mw = data.middlewares || [], svc = data.service;
            if (mw.length) html += `<div class="connection-group"><span class="connection-label middleware">Middlewares</span><div class="connection-chips">${mw.map(m => `<span class="connection-chip middleware" data-protocol="${protocol}" data-section="middlewares" data-name="${this.escapeHtml(m)}">${this.escapeHtml(m)}</span>`).join('')}</div></div>`;
            if (svc) html += `<div class="connection-group"><span class="connection-label service">Service</span><div class="connection-chips"><span class="connection-chip service" data-protocol="${protocol}" data-section="services" data-name="${this.escapeHtml(svc)}">${this.escapeHtml(svc)}</span></div></div>`;
            if (!mw.length && !svc) html = '<span class="connection-empty">No connections</span>';
        } else {
            const usedBy = this.getRoutersUsing(protocol, section, name);
            html = usedBy.length 
                ? `<div class="connection-group"><span class="connection-label router">Routers</span><div class="connection-chips">${usedBy.map(r => `<span class="connection-chip router" data-protocol="${protocol}" data-section="routers" data-name="${this.escapeHtml(r)}">${this.escapeHtml(r)}</span>`).join('')}</div></div>`
                : '<span class="connection-empty">Not used by any routers</span>';
        }

        container.innerHTML = html;
        container.querySelectorAll('.connection-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const chipProtocol = this.validateProtocol(chip.dataset.protocol);
                const chipSection = this.validateSection(chip.dataset.section);
                const chipName = this.validateName(chip.dataset.name);
                if (chipProtocol && chipSection && chipName) {
                    this.openDrawer(chipProtocol, chipSection, chipName);
                }
            });
        });
    }

    closeDrawer() {
        const drawer = document.getElementById('drawer');
        const overlay = document.getElementById('overlay');
        const sidebar = document.getElementById('sidebar');
        drawer?.classList.remove('open');
        this.currentDrawerContext = null;
        // Only hide overlay if menu isn't open
        if (!sidebar?.classList.contains('open')) {
            overlay?.classList.remove('visible');
        }
    }

    cloneData(payload) {
        try {
            return structuredClone(payload);
        } catch {
            return JSON.parse(JSON.stringify(payload));
        }
    }

    extractHost(rule) {
        if (typeof rule !== 'string') return '';
        const m = rule.match(/Host\(`([^`]+)`\)/i);
        return m ? m[1] : '';
    }

    truncateUrl(url) {
        if (!url || typeof url !== 'string') return '';
        try { return new URL(url).host; } catch { return url.length > 25 ? url.substring(0, 25) + '...' : url; }
    }

    toYaml(obj, indent = 0) {
        const pad = '  '.repeat(indent);
        let result = '';
        for (const [key, value] of Object.entries(obj)) {
            if (value == null) continue;
            if (Array.isArray(value)) {
                result += `${pad}${key}:\n`;
                value.forEach(item => {
                    if (typeof item === 'object') {
                        const lines = this.toYaml(item, 0).split('\n').filter(l => l);
                        result += `${pad}  - ${lines[0]}\n`;
                        lines.slice(1).forEach(l => result += `${pad}    ${l}\n`);
                    } else result += `${pad}  - ${item}\n`;
                });
            } else if (typeof value === 'object') {
                result += `${pad}${key}:\n${this.toYaml(value, indent + 1)}`;
            } else {
                const v = typeof value === 'string' && (value.includes('`') || value.includes(':')) ? `"${value}"` : value;
                result += `${pad}${key}: ${v}\n`;
            }
        }
        return result;
    }

    // Add this method to the TraefikViewer class
    calculateRowHeight(rowElement) {
        if (!rowElement) return 'auto';
        // Simply return auto - let CSS handle the height
        return 'auto';
    }

    renderSettings() {
        if (!this.settingsManager && window.SettingsManager) {
            this.settingsManager = new window.SettingsManager(this);
        }
        this.settingsManager?.render();
    }

    getSettings() {
        return this.settings || {};
    }

    updateSettingsCache(settings) {
        this.settings = settings || {};
        this.settingsManager?.syncFromViewer();
        this.renderEntryPointsOverview();
        this.renderCertResolversOverview();
        this.renderEntryPointsView();
        this.renderCertResolversView();
        this.updateCounts();
    }

    getEntryPointConfigs() {
        return this.settings?.entryPointConfigs || {};
    }

    getCertResolverConfigs() {
        return this.settings?.certResolverConfigs || {};
    }

    getEntryPointNames() {
        const arrayNames = Array.isArray(this.settings?.entryPoints) ? this.settings.entryPoints : [];
        return arrayNames.length ? arrayNames : Object.keys(this.getEntryPointConfigs());
    }

    getCertResolverNames() {
        const arrayNames = Array.isArray(this.settings?.certResolvers) ? this.settings.certResolvers : [];
        return arrayNames.length ? arrayNames : Object.keys(this.getCertResolverConfigs());
    }

    getEntryPoints() {
        return this.getEntryPointNames();
    }

    getCertResolvers() {
        return this.getCertResolverNames();
    }

    renderEntryPointsOverview() {
        const container = document.getElementById('entry-points-overview');
        if (!container) return;
        const configs = this.getEntryPointConfigs();
        const names = this.getEntryPointNames();
        if (!names.length) {
            container.innerHTML = '<div class="settings-empty">No entry points detected</div>';
            return;
        }
        container.innerHTML = `
            <div class="items-grid">
                ${names.map(name => {
                    const yaml = this.toYaml(configs[name] || {}).trim();
                    return `
                        <div class="item-card infrastructure-entry">
                            <div class="item-card-header">
                                <span class="item-dot"></span>
                                <span class="item-name">${this.escapeHtml(name)}</span>
                            </div>
                            <div class="item-summary">Defined in traefik.yml</div>
                            <pre class="infra-yaml">${this.escapeHtml(yaml || '(empty)')}</pre>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    renderCertResolversOverview() {
        const container = document.getElementById('cert-resolvers-overview');
        if (!container) return;
        const configs = this.getCertResolverConfigs();
        const names = this.getCertResolverNames();
        if (!names.length) {
            container.innerHTML = '<div class="settings-empty">No certificate resolvers detected</div>';
            return;
        }
        container.innerHTML = `
            <div class="items-grid">
                ${names.map(name => {
                    const yaml = this.toYaml(configs[name] || {}).trim();
                    return `
                        <div class="item-card infrastructure-resolver">
                            <div class="item-card-header">
                                <span class="item-dot"></span>
                                <span class="item-name">${this.escapeHtml(name)}</span>
                            </div>
                            <div class="item-summary">Defined in traefik.yml</div>
                            <pre class="infra-yaml">${this.escapeHtml(yaml || '(empty)')}</pre>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    renderEntryPointsView() {
        const container = document.getElementById('entry-points-view-list');
        if (!container) return;
        const configs = this.getEntryPointConfigs();
        const names = this.getEntryPointNames();
        if (!names.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">◎</div>No entry points detected</div>';
            return;
        }
        container.innerHTML = names.map(name => {
            const yaml = this.toYaml(configs[name] || {}).trim();
            return `
                <div class="item-card infrastructure-entry">
                    <div class="item-card-header">
                        <span class="item-dot"></span>
                        <span class="item-name">${this.escapeHtml(name)}</span>
                    </div>
                    <div class="item-summary">Defined in traefik.yml</div>
                    <pre class="infra-yaml">${this.escapeHtml(yaml || '(empty)')}</pre>
                </div>
            `;
        }).join('');
    }

    renderCertResolversView() {
        const container = document.getElementById('cert-resolvers-view-list');
        if (!container) return;
        const configs = this.getCertResolverConfigs();
        const names = this.getCertResolverNames();
        if (!names.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">☁</div>No certificate resolvers detected</div>';
            return;
        }
        container.innerHTML = names.map(name => {
            const yaml = this.toYaml(configs[name] || {}).trim();
            return `
                <div class="item-card infrastructure-resolver">
                    <div class="item-card-header">
                        <span class="item-dot"></span>
                        <span class="item-name">${this.escapeHtml(name)}</span>
                    </div>
                    <div class="item-summary">Defined in traefik.yml</div>
                    <pre class="infra-yaml">${this.escapeHtml(yaml || '(empty)')}</pre>
                </div>
            `;
        }).join('');
    }

    getRoutersUsing(protocol, type, name) {
        const p = this.validateProtocol(protocol);
        const t = this.validateSection(type);
        if (!p || !t) return [];
        return Object.entries(this.getSection(p, 'routers'))
            .filter(([_, data]) => t === 'middlewares'
                ? (data.middlewares || []).includes(name)
                : data.service === name)
            .map(([routerName]) => routerName);
    }

    getMiddlewaresReferencing(protocol, name) {
        const p = this.validateProtocol(protocol);
        if (!p || !name) return [];
        const middlewares = this.getSection(p, 'middlewares');
        return Object.entries(middlewares).reduce((acc, [mwName, mwData]) => {
            if (mwName === name || !mwData) return acc;
            const typeKey = Object.keys(mwData)[0];
            const payload = mwData[typeKey];
            if (this.middlewarePayloadContains(payload, name)) acc.push(mwName);
            return acc;
        }, []);
    }

    middlewarePayloadContains(payload, target) {
        if (!payload) return false;
        if (Array.isArray(payload)) {
            return payload.some(item => this.middlewarePayloadContains(item, target));
        }
        if (typeof payload === 'object') {
            return Object.values(payload).some(value => this.middlewarePayloadContains(value, target));
        }
        return payload === target;
    }

    getMiddlewareConfigPreview(type, config) {
        const rows = [];
        if (type === 'chain') {
            const chain = config.middlewares || [];
            if (chain.length) {
                rows.push(['Middlewares', chain.length]);
                chain.forEach((mw, idx) => rows.push([`${idx + 1}.`, mw]));
            }
        } else {
            Object.entries(config || {}).forEach(([key, value]) => {
                if (value === null || value === undefined) return;
                let display = '';
                if (typeof value === 'boolean') {
                    display = value ? 'Yes' : 'No';
                } else if (Array.isArray(value)) {
                    display = `${value.length} item${value.length === 1 ? '' : 's'}`;
                } else if (typeof value === 'object') {
                    display = `${Object.keys(value).length} field${Object.keys(value).length === 1 ? '' : 's'}`;
                } else if (typeof value === 'number') {
                    display = value;
                } else {
                    display = value.length > 32 ? `${value.slice(0, 32)}…` : value;
                }
                rows.push([this.formatConfigKey(key), display]);
            });
        }
        return rows.slice(0, 6).map(
            ([label, val]) => `<div class="middleware-config-row"><span class="middleware-config-key">${this.escapeHtml(String(label))}</span><span class="middleware-config-value">${this.escapeHtml(String(val))}</span></div>`
        ).join('');
    }

    formatConfigKey(key) {
        return key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
    }

    closeMobileMenu() {
        const sidebar = document.getElementById('sidebar');
        const toggle = document.getElementById('mobile-menu-toggle');
        const overlay = document.getElementById('overlay');
        sidebar?.classList.remove('open');
        toggle?.classList.remove('open');
        toggle?.setAttribute('aria-expanded', 'false');
        if (!document.getElementById('drawer')?.classList.contains('open')) {
            overlay?.classList.remove('visible');
        }
    }
}

// Create instance and expose globally
window.traefik = new TraefikViewer();
