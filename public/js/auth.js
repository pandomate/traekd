(function () {
    const nativeFetch = window.fetch.bind(window);
    let csrf = null;

    function apiPath(input) {
        const value = typeof input === 'string' ? input : input?.url || '';
        try {
            const url = new URL(value, window.location.origin);
            return url.origin === window.location.origin && url.pathname.startsWith('/api/');
        } catch { return false; }
    }

    window.fetch = function secureFetch(input, options = {}) {
        const method = (options.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
        const inputUrl = typeof input === 'string' ? input : input?.url || '';
        const isLogin = new URL(inputUrl, window.location.origin).pathname === '/api/v1/auth/login';
        if (csrf && apiPath(input) && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !isLogin) {
            const headers = new Headers(options.headers || (typeof input !== 'string' ? input.headers : undefined));
            headers.set('X-CSRF-Token', csrf);
            options = { ...options, headers };
        }
        return nativeFetch(input, options);
    };
    window.traekdSetCsrf = token => { csrf = token || null; };

    async function bootstrap() {
        const stateResponse = await nativeFetch('/api/v1/auth/me', { cache: 'no-store' });
        if (!stateResponse.ok) throw new Error('Unable to check authentication status');
        const state = await stateResponse.json();
        if (!state.authRequired) return;
        if (state.authenticated) { csrf = state.csrf; return; }
        const screen = document.getElementById('login-screen');
        const form = document.getElementById('login-form');
        const errorElement = document.getElementById('login-error');
        const submit = document.getElementById('login-submit');
        screen.hidden = false;
        await new Promise(resolve => form.addEventListener('submit', async event => {
            event.preventDefault();
            submit.disabled = true;
            errorElement.textContent = '';
            try {
                const response = await nativeFetch('/api/v1/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value })
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(payload.error || 'Login failed');
                csrf = payload.csrf;
                form.elements.password.value = '';
                screen.hidden = true;
                resolve();
            } catch (error) {
                errorElement.textContent = error.message;
            } finally {
                submit.disabled = false;
            }
        }));
    }

    window.traekdAuthReady = bootstrap().catch(error => {
        const screen = document.getElementById('login-screen');
        const errorElement = document.getElementById('login-error');
        if (screen) screen.hidden = false;
        if (errorElement) errorElement.textContent = error.message;
        throw error;
    });
})();
