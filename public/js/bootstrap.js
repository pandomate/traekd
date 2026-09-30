'use strict';

document.addEventListener('DOMContentLoaded', () => {
    if (!window.traefik) return;
    window.configModal = new ConfigModal(window.traefik);
    window.editorModal = new EditorModal(window.traefik);
});
