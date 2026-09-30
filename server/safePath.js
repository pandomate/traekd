const fs = require('fs');
const path = require('path');

class PathSecurityError extends Error {
    constructor(message) {
        super(message);
        this.code = 'path_outside_managed_root';
        this.status = 400;
    }
}

function isContained(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

class SafePathPolicy {
    constructor(root) {
        if (typeof root !== 'string' || !root.trim() || /[\r\n\0]/.test(root)) {
            throw new PathSecurityError('Managed root must be a non-empty single-line path');
        }
        this.root = path.resolve(root);
        if (this.root === path.parse(this.root).root) {
            throw new PathSecurityError('Managed root must not be the filesystem root');
        }
        fs.mkdirSync(this.root, { recursive: true, mode: 0o750 });
        this.realRoot = fs.realpathSync.native(this.root);
    }

    resolve(value, label = 'Path') {
        if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
            throw new PathSecurityError(`${label} must be a non-empty single-line path`);
        }
        const input = value.trim();
        if (input.startsWith('~')) throw new PathSecurityError(`${label} must not use home-directory expansion`);
        const candidate = path.resolve(path.isAbsolute(input) ? input : path.join(this.root, input));
        if (!isContained(this.root, candidate)) {
            throw new PathSecurityError(`${label} must stay inside managed root '${this.root}'`);
        }

        // Reject symlinks in every existing component. Checking only realpath is
        // insufficient because a link can be swapped between validation and use.
        let current = this.root;
        const relative = path.relative(this.root, candidate);
        for (const component of relative.split(path.sep).filter(Boolean)) {
            current = path.join(current, component);
            try {
                if (fs.lstatSync(current).isSymbolicLink()) {
                    throw new PathSecurityError(`${label} must not contain symbolic links`);
                }
            } catch (error) {
                if (error.code === 'ENOENT') break;
                throw error;
            }
        }

        let existing = candidate;
        while (!fs.existsSync(existing)) {
            const parent = path.dirname(existing);
            if (parent === existing) break;
            existing = parent;
        }
        const realExisting = fs.realpathSync.native(existing);
        if (!isContained(this.realRoot, realExisting)) {
            throw new PathSecurityError(`${label} resolves outside managed root '${this.root}'`);
        }
        return candidate;
    }
}

module.exports = { SafePathPolicy, PathSecurityError, isContained };
