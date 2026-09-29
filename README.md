# Traefik Config Manager

This project aims to make creating and managing Traefik setups easy by providing a graphical environment to do so. It requires the Traefik setup to be split into `traefik.yml` and `dynamic_conf.yml`. Traekd will only read `traefik.yml` and perform its changes in `dynamic_conf.yml`. It features easy-to-use SSL/TLS setup and assignment for routers. While it mostly focuses on supporting HTTP configurations, it can also handle TCP and UDP setups as well.

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
- **Persistence**: Persists data in a traefik dynamic config file and `.env` file

### Web Interface
- **Overview**: Dashboard view of all configuration items
- **Routers View**: Manage HTTP/TCP/UDP routers with rules and TLS settings
- **Middlewares View**: Create and manage middleware configurations
- **Services View**: Define backend services and load balancing
- **Raw Editor**: Direct YAML editing with validation
- **Settings**: Configure file paths and Traefik integration points


## Installation

### Prerequisites
- Node.js
- A running Traefik instance
- Traefik configuration files
- A user with permissions capable of editing the traefik configs
- A GNU/Linux operating system using Systemd or OpenRC init systems

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/wynn32/traekd.git
   ```

2. **Run the installer**
   ```bash
   chmod +x install.sh
   sudo ./install.sh
   ```

3. **Update your environment variables** - The installer writes defaults to `.env`. You need to update the paths for it to work correctly.


4. **Access the web interface**
   Open your browser and navigate to `http://localhost:3000` (or whatever your port is)

## Configuration

### Environment Variables

The application uses the following environment variables (can be set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | 3000 | Port for the Express server |
| `SERVER_HOST` | 0.0.0.0 | Host binding address |
| `TRAEFIK_CONFIG_PATH` | /etc/traefik/config.yml | Path to Traefik configuration file |
| `TRAEFIK_YML_FILE` | ./traefik.yml | Path to Traefik main configuration file |
| `SITE_TITLE` | Traefik Config Manager | Page title shown in the UI |

### File Paths

- **`logs/`**: Directory for application logs

## Troubleshooting

### Port Already in Use
Change the `SERVER_PORT` environment variable to an available port.

### Config File Not Found
Verify the `TRAEFIK_CONFIG_PATH` environment variable points to the correct file and is readable by the Node.js process.

### Traefik Changes Not Applied
- Ensure the config file path is correct
- Reload/restart Traefik after making configuration changes
- Check Traefik logs for validation errors

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