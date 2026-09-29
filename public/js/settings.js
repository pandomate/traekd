class SettingsManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.settings = {};
        this.bound = false;
    }

    syncFromViewer() {
        this.settings = this.viewer.getSettings() || {};
    }

    async render() {
        this.syncFromViewer();
        
        // Populate path inputs
        const configPathInput = document.getElementById('settings-config-path');
        const traefikPathInput = document.getElementById('settings-traefik-path');
        
        if (configPathInput) {
            configPathInput.value = this.settings.configPath || '';
        }
        if (traefikPathInput) {
            traefikPathInput.value = this.settings.traefikYmlPath || '';
        }

        // Render cert resolvers
        this.renderCertResolvers();
        
        // Render entry points
        this.renderEntryPoints();

        // Bind events only once
        if (!this.bound) {
            this.bindEvents();
            this.bound = true;
        }
    }

    renderCertResolvers() {
        const container = document.getElementById('cert-resolvers-list');
        if (!container) return;

        const resolvers = this.settings.certResolvers || [];
        
        if (resolvers.length === 0) {
            container.innerHTML = '<div class="settings-empty">No certificate resolvers detected. Check your traefik.yml path.</div>';
            return;
        }

        container.innerHTML = resolvers.map(name => `
            <div class="settings-list-item">
                <span class="settings-list-value">${this.escapeHtml(name)}</span>
            </div>
        `).join('');
    }

    renderEntryPoints() {
        const container = document.getElementById('entry-points-list');
        if (!container) return;

        const entryPoints = this.settings.entryPoints || [];
        
        if (entryPoints.length === 0) {
            container.innerHTML = '<div class="settings-empty">No entry points detected. Check your traefik.yml path.</div>';
            return;
        }

        container.innerHTML = entryPoints.map(name => `
            <div class="settings-list-item">
                <span class="settings-list-value">${this.escapeHtml(name)}</span>
            </div>
        `).join('');
    }

    bindEvents() {
        // Validate buttons
        document.querySelectorAll('.settings-validate-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const targetId = btn.dataset.target;
                const input = document.getElementById(targetId);
                const statusEl = document.getElementById(`${targetId}-status`);
                
                if (!input || !statusEl) return;
                
                const path = input.value.trim();
                if (!path) {
                    statusEl.textContent = 'Please enter a path';
                    statusEl.className = 'settings-status error';
                    return;
                }

                statusEl.textContent = 'Validating...';
                statusEl.className = 'settings-status';

                try {
                    const res = await fetch('/api/settings/validate-path', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path })
                    });
                    const result = await res.json();

                    if (result.valid && result.isFile) {
                        statusEl.textContent = '✓ Path is valid';
                        statusEl.className = 'settings-status success';
                    } else if (result.exists && result.isDirectory) {
                        statusEl.textContent = '✗ Path is a directory, not a file';
                        statusEl.className = 'settings-status error';
                    } else {
                        statusEl.textContent = '✗ File does not exist';
                        statusEl.className = 'settings-status error';
                    }
                } catch (e) {
                    statusEl.textContent = '✗ Validation failed: ' + e.message;
                    statusEl.className = 'settings-status error';
                }
            });
        });

        // Save button
        const saveBtn = document.getElementById('save-settings-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveSettings());
        }
    }

    async saveSettings() {
        const saveStatus = document.getElementById('settings-save-status');
        const saveBtn = document.getElementById('save-settings-btn');
        
        if (saveBtn) saveBtn.disabled = true;
        if (saveStatus) {
            saveStatus.textContent = 'Saving...';
            saveStatus.className = 'settings-save-status';
        }

        const configPath = document.getElementById('settings-config-path')?.value?.trim() || '';
        const traefikPath = document.getElementById('settings-traefik-path')?.value?.trim() || '';

        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    configPath,
                    traefikYmlPath: traefikPath
                })
            });

            const result = await res.json();

            if (res.ok && result.success) {
                if (saveStatus) {
                    saveStatus.textContent = '✓ Settings saved successfully';
                    saveStatus.className = 'settings-save-status success';
                }
                
                // Update viewer's settings cache
                this.viewer.updateSettingsCache(result.settings);
                
                // Re-render to show updated entry points/resolvers
                this.render();
                
                // Reload config if path changed
                await this.viewer.loadConfig();
                this.viewer.render();
            } else {
                throw new Error(result.error || 'Failed to save');
            }
        } catch (e) {
            if (saveStatus) {
                saveStatus.textContent = '✗ ' + e.message;
                saveStatus.className = 'settings-save-status error';
            }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    escapeHtml(text) {
        if (typeof text !== 'string') return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

window.SettingsManager = SettingsManager;
