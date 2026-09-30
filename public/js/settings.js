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
        const storageMode = document.getElementById('settings-storage-mode');
        const traefikVersion = document.getElementById('settings-traefik-version');
        const traefikApi = document.getElementById('settings-traefik-api');
        if (storageMode) storageMode.value = this.settings.storageMode || 'file';
        if (traefikVersion) traefikVersion.value = this.settings.traefikVersion || 'v3.7';
        if (traefikApi) traefikApi.value = this.settings.traefikApiUrl || '';
        this.updateDynamicPathHelp();
        this.renderTraefikApiStatus();

        // Bind events only once
        if (!this.bound) {
            this.bindEvents();
            this.bound = true;
        }
    }

    renderTraefikApiStatus() {
        const element = document.getElementById('settings-traefik-api-status');
        if (!element) return;
        const status = this.settings.traefikApiStatus || {};
        if (status.connected) {
            const source = status.source && status.source !== 'configured' ? `, ${status.message}` : '';
            element.textContent = `✓ Connected to Traefik ${status.version || ''}${source}`.trim();
            element.className = 'settings-status success';
        } else {
            element.textContent = status.message || 'Not checked yet';
            element.className = 'settings-status muted';
        }
    }

    updateDynamicPathHelp() {
        const directoryMode = document.getElementById('settings-storage-mode')?.value === 'directory';
        const input = document.getElementById('settings-config-path');
        const hint = document.getElementById('settings-config-path-hint');
        if (input) input.placeholder = directoryMode ? '/etc/traefik/dynamic' : '/etc/traefik/config.yml';
        if (hint) {
            const selectedPath = input?.value?.trim();
            const activePath = directoryMode && selectedPath ? `${selectedPath.replace(/\/+$/, '')}/traekd.yml` : selectedPath;
            hint.textContent = activePath
                ? `Generated HTTP/TCP/UDP output: ${activePath}. SQLite remains the source of truth.`
                : (directoryMode ? 'Select the watched directory that will receive traekd.yml.' : 'Select the generated YAML output file.');
        }
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
                    const expectedType = targetId === 'settings-config-path' && document.getElementById('settings-storage-mode')?.value === 'directory'
                        ? 'directory'
                        : 'file';
                    const res = await fetch('/api/settings/validate-path', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path, expectedType, pathKind: targetId === 'settings-traefik-path' ? 'static' : 'dynamic' })
                    });
                    const result = await res.json();

                    if (result.valid) {
                        statusEl.textContent = '✓ Path is valid';
                        statusEl.className = 'settings-status success';
                    } else if (result.exists) {
                        statusEl.textContent = `✗ Path is not a ${expectedType}`;
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
        const passwordBtn = document.getElementById('change-password-btn');
        if (passwordBtn) passwordBtn.addEventListener('click', () => this.changePassword());
        const signOutBtn = document.getElementById('sign-out-btn');
        if (signOutBtn) signOutBtn.addEventListener('click', () => this.signOut());
        const detectBtn = document.getElementById('detect-traefik-api-btn');
        if (detectBtn) detectBtn.addEventListener('click', () => this.detectTraefikApi());
        const storageMode = document.getElementById('settings-storage-mode');
        if (storageMode) storageMode.addEventListener('change', () => {
            const input = document.getElementById('settings-config-path');
            if (input) input.value = storageMode.value === 'directory'
                ? (this.settings.managedDirectoryDefault || '/etc/traefik/dynamic')
                : (this.settings.singleFileDefault || './config.yml');
            this.updateDynamicPathHelp();
        });
        const configPath = document.getElementById('settings-config-path');
        if (configPath) configPath.addEventListener('input', () => this.updateDynamicPathHelp());
    }

    async detectTraefikApi() {
        const button = document.getElementById('detect-traefik-api-btn');
        const status = document.getElementById('settings-traefik-api-status');
        if (button) button.disabled = true;
        if (status) { status.textContent = 'Checking accessible Traefik API endpoints…'; status.className = 'settings-status'; }
        try {
            const url = document.getElementById('settings-traefik-api')?.value?.trim() || '';
            const response = await fetch('/api/settings/discover-traefik-api', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || result.error || 'No accessible Traefik API was found');
            this.settings = result.settings;
            this.viewer.updateSettingsCache(result.settings);
            const input = document.getElementById('settings-traefik-api');
            const version = document.getElementById('settings-traefik-version');
            if (input) input.value = result.settings.traefikApiUrl || '';
            if (version) version.value = result.settings.traefikVersion || 'v3.7';
            this.renderTraefikApiStatus();
        } catch (error) {
            if (status) { status.textContent = `✗ ${error.message}`; status.className = 'settings-status error'; }
        } finally {
            if (button) button.disabled = false;
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
        const storageMode = document.getElementById('settings-storage-mode')?.value || 'file';
        const traefikVersion = document.getElementById('settings-traefik-version')?.value || 'v3.7';
        const traefikApiUrl = document.getElementById('settings-traefik-api')?.value?.trim() || '';

        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    configPath,
                    traefikYmlPath: traefikPath,
                    storageMode,
                    traefikVersion,
                    traefikApiUrl
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
                
                // Refresh views that depend on the updated application settings.
                this.render();
                
                // Reload config if path changed
                const loaded = await this.viewer.loadConfig();
                this.viewer.render();
                if (!loaded) throw new Error('Settings were saved, but the selected configuration source could not be loaded');
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

    async changePassword() {
        const currentInput = document.getElementById('settings-current-password');
        const newInput = document.getElementById('settings-new-password');
        const confirmInput = document.getElementById('settings-confirm-password');
        const button = document.getElementById('change-password-btn');
        const status = document.getElementById('change-password-status');
        const currentPassword = currentInput?.value || '';
        const newPassword = newInput?.value || '';
        if (newPassword.length < 12) {
            status.textContent = 'New password must be at least 12 characters';
            status.className = 'settings-save-status error';
            return;
        }
        if (newPassword !== (confirmInput?.value || '')) {
            status.textContent = 'New passwords do not match';
            status.className = 'settings-save-status error';
            return;
        }
        button.disabled = true;
        status.textContent = 'Changing password…';
        status.className = 'settings-save-status';
        try {
            const response = await fetch('/api/v1/auth/password', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Password change failed');
            window.traekdSetCsrf?.(result.csrf);
            currentInput.value = '';
            newInput.value = '';
            confirmInput.value = '';
            status.textContent = '✓ Password changed; other sessions were signed out';
            status.className = 'settings-save-status success';
        } catch (error) {
            status.textContent = `✗ ${error.message}`;
            status.className = 'settings-save-status error';
        } finally {
            button.disabled = false;
        }
    }

    async signOut() {
        const button = document.getElementById('sign-out-btn');
        const status = document.getElementById('sign-out-status');
        button.disabled = true;
        status.textContent = 'Signing out…';
        status.className = 'settings-save-status';
        try {
            const response = await fetch('/api/v1/auth/logout', { method: 'POST' });
            if (!response.ok) {
                const result = await response.json().catch(() => ({}));
                throw new Error(result.error || 'Sign out failed');
            }
            window.traekdSetCsrf?.(null);
            window.location.reload();
        } catch (error) {
            status.textContent = `✗ ${error.message}`;
            status.className = 'settings-save-status error';
            button.disabled = false;
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
