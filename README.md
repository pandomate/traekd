# Traefik Config Manager

Traekd is a single-admin manager for Traefik file-provider routes. It supports HTTP, TCP, and UDP resources, stores structured configuration in SQLite, preserves revisions before every change, validates cross-resource references, and renders either one dynamic YAML file or its own `traekd.yml` in a watched directory.

The AUX navigation group also exposes static Entry Points. Administrators can add or edit them through a constrained form; Traekd updates only the `entryPoints` mapping in the jailed `traefik.yml`, records a snapshot and audit entry, and never evaluates submitted YAML or code. Restart Traefik after changing static configuration.

**Disclaimer** - this repository was largely vibe coded. The functionality was verified by the human overlords, but there can be edge cases that may cause errors in your configs. This is an automated configuration generation tool, so *back up your files*!

## Overview

Traefik Config Manager is a full-stack web application that allows users to:
- **Create, edit, and delete** routers, middlewares, and services
- **Manage** HTTP, TCP, and UDP protocols separately
- **Search and sort** configurations for quick navigation
- **Configure** paths to Traefik config files and certificate resolvers

## Key Features

### Configuration Management
- **Protocol Support**: HTTP, TCP, and UDP configurations
- **Section Types**: Routers, Middlewares, Services, and ServersTransports
- **Safe persistence**: Serialized atomic writes, revisions, audit log, stale-write detection, and rollback
- **Compatibility**: Traefik v2.11 and v3.7 validation modes

### Web Interface
- **Overview**: Dashboard view of all configuration items
- **Routers View**: Manage HTTP/TCP/UDP routers with rules and TLS settings
- **Middlewares View**: Create and manage middleware configurations
- **Services View**: Define backend services and load balancing
- **Safe YAML proposals**: Edit YAML through parse, validation, structural diff, SQLite storage, and canonical re-rendering
- **Settings**: Configure file paths and Traefik integration points


## Installation

### Prerequisites
- Node.js 22.5 or newer (for the built-in SQLite module)
- A running Traefik instance
- Traefik configuration files
- A user with permissions capable of editing the traefik configs
- A GNU/Linux operating system using Systemd or OpenRC init systems

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/pandomate/traekd.git
   ```

2. **Run the installer**
   ```bash
   chmod +x install.sh
   sudo ./install.sh
   ```

   If Traefik is not present, the interactive installer offers to download the official Community Linux binary and verifies it against the release checksum. A binary without a startup service triggers a second prompt to configure one. The managed setup preserves the original dynamic file, copies it to `/etc/traefik/dynamic/traekd.yml`, backs up the static configuration, enables a loopback-only API, and enables both services at boot. For an unattended pinned install, run `sudo env TRAEKD_INSTALL_TRAEFIK=yes TRAEKD_MANAGE_TRAEFIK_SERVICE=yes TRAEFIK_INSTALL_VERSION=v3.7.13 ./install.sh`.

3. **Save the generated administrator credentials** printed by the installer. Authentication is required by default. The Account screen supports password changes and sign-out independently from application Settings. Set the dynamic/static path roots before startup if the defaults do not match your deployment.


4. **Access the web interface**
   Open your browser and navigate to `http://localhost:3000` (or whatever your port is)

## Configuration

### Environment Variables

The application uses the following environment variables (can be set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | 3000 | Port for the Express server |
| `SERVER_HOST` | 127.0.0.1 | Host binding address |
| `TRAEFIK_CONFIG_PATH` | `./config.yml` | Dynamic config file or watched directory |
| `TRAEKD_CONFIG_ROOT` | Initial dynamic path/directory | Hard boundary for dynamic outputs; UI changes cannot escape it or traverse symlinks |
| `TRAEFIK_YML_FILE` | ./traefik.yml | Path to Traefik main configuration file |
| `TRAEKD_STATIC_CONFIG_ROOT` | Initial static file directory | Hard boundary for static-config reads and validated Entry Point writes |
| `TRAEKD_STORAGE_MODE` | file | `file` for an existing YAML file, `directory` for managed `traekd.yml` |
| `TRAEKD_MANAGED_DIRECTORY` | `/etc/traefik/dynamic` | Suggested path selected when changing to managed-directory mode |
| `TRAEKD_SINGLE_FILE_PATH` | `./config.yml` | Remembered path selected when changing back to single-file mode |
| `TRAEKD_TRAEFIK_VERSION` | v3.7 | Validation schema target: `v2.11` or `v3.7` |
| `TRAEFIK_API_URL` | empty | Optional read-only Traefik API for runtime status |
| `TRAEKD_AUTH_MODE` | required | Authentication mode; `disabled` is accepted only for loopback development |
| `TRAEKD_ADMIN_USER` | empty | Required administrator username |
| `TRAEKD_ADMIN_PASSWORD_HASH` | empty | Required scrypt password hash; generate with `npm run hash-password -- "password"` in `server/` |
| `TRAEKD_SESSION_SECRET` | empty | Required random session-signing secret of at least 32 characters |
| `SITE_TITLE` | Traefik Config Manager | Page title shown in the UI |

If `TRAEFIK_API_URL` is empty, Traekd tests a small set of common local and Docker addresses at startup, plus hostnames from dynamic routers whose service is `api@internal`. It saves the URL only after `/api/version` returns a valid Traefik version. You can run detection again from Settings. The API must be enabled and reachable, but the visual dashboard does not need to be enabled. `api.dashboard: true` alone does not expose either one; use a secured `api@internal` router or a loopback-only API listener. If the API is disabled, all file-management features still work, while runtime status and automatic version discovery remain unavailable.

To prevent server-side request forgery, Traefik API hosts must resolve exclusively to loopback or private-network addresses. Set `TRAEKD_ALLOW_PUBLIC_TRAEFIK_API=true` only when the API is intentionally hosted on a public address and protected independently.

### Managed directory mode

Managed directory mode keeps Traekd's changes isolated in one file while allowing Traefik to load other dynamic files from the same directory:

1. Configure Traefik's file provider with a directory and `watch: true`.
2. Give Traefik and Traekd access to the same host directory. Their container paths may differ.
3. Set `TRAEFIK_CONFIG_PATH` to that directory as Traekd sees it and set `TRAEKD_STORAGE_MODE=directory`. Selecting managed mode in Settings fills in the directory configured in `traefik.yml`, falling back to `/etc/traefik/dynamic`; it can be changed before saving.
4. Traekd creates and exclusively edits `<directory>/traekd.yml`. Backups, audit records, and revisions stay in Traekd's data directory, outside Traefik's watched directory.
5. Traefik continues loading any other YAML files in the directory. They are not modified by Traekd; the current UI displays resources from `traekd.yml` only.

For example, mount `./dynamic` at `/etc/traefik/dynamic` in the Traefik container and at `/dynamic` in the Traekd container. Traefik uses `providers.file.directory=/etc/traefik/dynamic`; Traekd uses `TRAEFIK_CONFIG_PATH=/dynamic`. Mount the directory rather than only `traekd.yml`, so atomic file replacement and filesystem watch events work reliably.

### File Paths

- **`logs/`**: Directory for application logs
- **`data/traekd.sqlite`**: Authoritative structured configuration database

The dynamic and static roots are fixed at process start. Settings requests may select only non-symlink paths below the corresponding root. Changing the dynamic output path never imports that file; it renders the current database to the selected location.

The generated dynamic YAML path is an output destination for Traefik's file provider. Existing YAML is imported only when the SQLite database is first created. After that migration, changing the output path publishes the database to the new location and never reads configuration from that target.

Raw YAML changes are submitted as proposals. Traekd rejects explicit tags, aliases, duplicate keys, excessive nesting, and oversized documents; parses with a restricted schema; performs semantic validation and shows changed paths; then stores the parsed objects in SQLite and generates fresh YAML. Submitted bytes are never written directly. Clearing an optional value in the structured editor removes its key rather than saving an empty string.

The administrator can change their password or sign out from Account. Password changes rotate the session-signing secret, invalidate other sessions, and persist the scrypt hash in the protected SQLite database and environment file.

For the container example, build with `TRAEKD_UID=$(id -u) TRAEKD_GID=$(id -g) docker compose -f docker-compose.example.yml up --build` so the unprivileged process can update the host-owned dynamic directory and `traefik.yml` bind mount.

## Troubleshooting

### Port Already in Use
Change the `SERVER_PORT` environment variable to an available port.

### Config File Not Found
Verify the `TRAEFIK_CONFIG_PATH` environment variable points to the correct file and is readable by the Node.js process.

### Traefik Changes Not Applied
- Ensure the selected file or directory is configured under Traefik's file provider with `watch: true`.
- Use the runtime endpoint or Traefik logs to inspect rejected dynamic configuration.
- Restore the last revision from the API if a change was not accepted.

## Development

### Running in Development Mode
```bash
cd server
npm start
```

Server runs on port 3000 by default. Access via `http://localhost:3000`

### Dependencies
- `express`: Web server framework
- `js-yaml`: YAML parsing and serialization
- `dotenv`: Environment variable management

Install with: `npm install` in the `server/` directory

## License

See LICENSE file for details.
