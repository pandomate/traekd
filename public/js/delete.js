class DeleteManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.modal = document.getElementById('delete-modal');
        this.titleEl = this.modal?.querySelector('.delete-modal-title');
        this.bodyEl = this.modal?.querySelector('.delete-modal-body');
        this.statusEl = this.modal?.querySelector('.delete-modal-status');
        this.confirmBtn = this.modal?.querySelector('#delete-confirm');
        this.cancelBtn = this.modal?.querySelector('#delete-cancel');
        this.closeBtn = this.modal?.querySelector('#delete-close');
        this.backdrop = this.modal?.querySelector('.delete-backdrop');
        this.context = null;

        this.bindBaseEvents();
    }

    bindBaseEvents() {
        if (!this.modal) return;
        this.confirmBtn?.addEventListener('click', () => this.handleConfirm());
        this.cancelBtn?.addEventListener('click', () => this.close());
        this.closeBtn?.addEventListener('click', () => this.close());
        this.backdrop?.addEventListener('click', () => this.close());
    }

    open(context) {
        if (!this.modal) return;
        this.context = { ...context };
        this.modal.classList.remove('hidden');
        this.modal.classList.add('open');
        document.body.classList.add('delete-modal-open');
        this.render();
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.remove('open');
        this.modal.classList.add('hidden');
        document.body.classList.remove('delete-modal-open');
        this.context = null;
        this.status('');
    }

    render() {
        if (!this.bodyEl || !this.context) return;
        const { section } = this.context;
        this.status('');
        if (section === 'routers') {
            this.renderRouterContent();
        } else if (section === 'middlewares') {
            this.renderMiddlewareContent();
        } else if (section === 'services') {
            this.renderServiceContent();
        } else {
            this.bodyEl.innerHTML = '<p>Unsupported resource.</p>';
            this.confirmBtn.disabled = true;
        }
    }

    renderRouterContent() {
        const { protocol, name } = this.context;
        const router = this.viewer.getSection(protocol, 'routers')[name];
        if (!router) {
            this.bodyEl.innerHTML = '<p>Router not found.</p>';
            this.confirmBtn.disabled = true;
            return;
        }
        this.confirmBtn.disabled = false;
        this.titleEl.textContent = `Delete Router "${name}"`;

        const middlewareRows = (router.middlewares || []).map((mw) => {
            const others = this.viewer.getRoutersUsing(protocol, 'middlewares', mw).filter(r => r !== name);
            return `
                <label class="delete-checkbox">
                    <input type="checkbox" data-delete-middleware value="${this.escape(mw)}">
                    <div>
                        <strong>${this.escape(mw)}</strong>
                        <div class="delete-hint">${others.length ? `Also used by: ${others.map(this.escape).join(', ')}` : 'Not used elsewhere.'}</div>
                    </div>
                </label>
            `;
        }).join('');

        const serviceName = router.service;
        const serviceUsage = serviceName
            ? this.viewer.getRoutersUsing(protocol, 'services', serviceName).filter(r => r !== name)
            : [];

        this.bodyEl.innerHTML = `
            <p>Are you sure you want to delete router <strong>${this.escape(name)}</strong>?</p>
            <div class="delete-section">
                <h4>Optional: delete associated middlewares</h4>
                ${middlewareRows || '<p class="delete-empty">This router has no middlewares.</p>'}
            </div>
            <div class="delete-section">
                <h4>Optional: delete associated service</h4>
                ${serviceName ? `
                    <label class="delete-checkbox">
                        <input type="checkbox" id="delete-associated-service">
                        <div>
                            <strong>${this.escape(serviceName)}</strong>
                            <div class="delete-hint">${serviceUsage.length ? `Also used by: ${serviceUsage.map(this.escape).join(', ')}` : 'Not used elsewhere.'}</div>
                        </div>
                    </label>
                ` : '<p class="delete-empty">No dedicated service attached.</p>'}
            </div>
            <p class="delete-warning">Router deletion cannot be undone.</p>
        `;
    }

    renderMiddlewareContent() {
        const { protocol, name } = this.context;
        const middleware = this.viewer.getSection(protocol, 'middlewares')[name];
        const routerUsage = this.viewer.getRoutersUsing(protocol, 'middlewares', name);
        const middlewareUsage = this.viewer.getMiddlewaresReferencing(protocol, name);
        this.confirmBtn.disabled = !middleware;
        this.titleEl.textContent = `Delete Middleware "${name}"`;
        if (!middleware) {
            this.bodyEl.innerHTML = '<p>Middleware not found.</p>';
            return;
        }

        this.bodyEl.innerHTML = `
            <p>Deleting middleware <strong>${this.escape(name)}</strong>. This action cannot be undone.</p>
            <div class="delete-section">
                <h4>Routers using this middleware</h4>
                ${routerUsage.length
                    ? `<ul class="delete-usage-list">${routerUsage.map(r => `<li>${this.escape(r)}</li>`).join('')}</ul>`
                    : '<p class="delete-empty">No routers reference this middleware.</p>'}
            </div>
            <div class="delete-section">
                <h4>Other middlewares referencing it</h4>
                ${middlewareUsage.length
                    ? `<ul class="delete-usage-list">${middlewareUsage.map(m => `<li>${this.escape(m)}</li>`).join('')}</ul>`
                    : '<p class="delete-empty">No other middlewares reference this one.</p>'}
            </div>
        `;
    }

    renderServiceContent() {
        const { protocol, name } = this.context;
        const service = this.viewer.getSection(protocol, 'services')[name];
        const usage = this.viewer.getRoutersUsing(protocol, 'services', name);
        this.confirmBtn.disabled = !service;
        this.titleEl.textContent = `Delete Service "${name}"`;
        this.bodyEl.innerHTML = service
            ? `
                <p>Deleting service <strong>${this.escape(name)}</strong>. This action cannot be undone.</p>
                <div class="delete-section">
                    <h4>Usage</h4>
                    ${usage.length ? `<ul>${usage.map(r => `<li>${this.escape(r)}</li>`).join('')}</ul>` : '<p class="delete-empty">Not referenced by any router.</p>'}
                </div>
            `
            : '<p>Service not found.</p>';
    }

    async handleConfirm() {
        if (!this.context) return;
        this.confirmBtn.disabled = true;
        this.cancelBtn.disabled = true;
        this.status('Deleting…', 'info');

        try {
            await this.performDeletion();
            this.status('Deleted successfully', 'success');
            await this.viewer.loadConfig();
            this.viewer.render();
            if (this.viewer.currentDrawerContext?.name === this.context.name &&
                this.viewer.currentDrawerContext?.section === this.context.section) {
                this.viewer.closeDrawer();
            }
            setTimeout(() => this.close(), 700);
        } catch (error) {
            this.status(error.message || 'Deletion failed', 'error');
            this.confirmBtn.disabled = false;
            this.cancelBtn.disabled = false;
        }
    }

    async performDeletion() {
        const { protocol, section, name } = this.context;
        const queue = [];

        if (section === 'routers') {
            const middlewares = Array.from(this.modal.querySelectorAll('input[data-delete-middleware]:checked'))
                .map(input => input.value)
                .filter(Boolean);
            const deleteService = this.modal.querySelector('#delete-associated-service')?.checked;
            const router = this.viewer.getSection(protocol, 'routers')[name];

            middlewares.forEach((mw) => queue.push({ protocol, section: 'middlewares', name: mw }));
            if (deleteService && router?.service) {
                queue.push({ protocol, section: 'services', name: router.service });
            }
            queue.push({ protocol, section: 'routers', name });
        } else {
            queue.push({ protocol, section, name });
        }

        for (const task of queue) {
            this.status(`Deleting ${task.section.slice(0, -1)} "${task.name}"…`, 'info');
            await this.deleteItem(task);
        }
    }

    async deleteItem({ protocol, section, name }) {
        const res = await fetch(`/api/config/${section}/${encodeURIComponent(name)}?protocol=${protocol}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok || !result.success) {
            throw new Error(result.error || `Failed to delete ${name}`);
        }
    }

    status(message, variant = 'info') {
        if (!this.statusEl) return;
        this.statusEl.textContent = message || '';
        this.statusEl.dataset.variant = variant;
    }

    escape(str) {
        const div = document.createElement('div');
        div.textContent = str ?? '';
        return div.innerHTML;
    }
}

window.DeleteManager = DeleteManager;
