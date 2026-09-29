#!/bin/sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo_info() { printf "${GREEN}[INFO]${NC} %s\n" "$1"; }
echo_warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
echo_error() { printf "${RED}[ERROR]${NC} %s\n" "$1"; }

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect and use privilege escalation if needed
escalate_privileges() {
    # Already root, no escalation needed
    if [ "$(id -u)" -eq 0 ]; then
        return 0
    fi
    
    # Detect available privilege escalation command
    if command -v sudo >/dev/null 2>&1; then
        PRIV_CMD="sudo"
    elif command -v doas >/dev/null 2>&1; then
        PRIV_CMD="doas"
    else
        echo_error "This script requires root privileges."
        echo_error "Please install sudo or doas, or run as root."
        exit 1
    fi
    
    echo_info "Escalating privileges using $PRIV_CMD..."
    exec "$PRIV_CMD" sh "$0" "$@"
}

# Detect package manager
detect_pkg_manager() {
    if command -v apk >/dev/null 2>&1; then
        PKG_MANAGER="apk"
    elif command -v apt-get >/dev/null 2>&1; then
        PKG_MANAGER="apt"
    elif command -v dnf >/dev/null 2>&1; then
        PKG_MANAGER="dnf"
    elif command -v yum >/dev/null 2>&1; then
        PKG_MANAGER="yum"
    elif command -v pacman >/dev/null 2>&1; then
        PKG_MANAGER="pacman"
    elif command -v zypper >/dev/null 2>&1; then
        PKG_MANAGER="zypper"
    else
        echo_error "No supported package manager found"
        exit 1
    fi
    echo_info "Detected package manager: $PKG_MANAGER"
}

# Install Node.js based on package manager
install_nodejs() {
    echo_info "Installing Node.js..."
    
    case $PKG_MANAGER in
        apk)
            apk update
            apk add --no-cache nodejs npm
            ;;
        apt)
            apt-get update
            apt-get install -y curl ca-certificates
            if ! command -v node >/dev/null 2>&1; then
                curl -fsSL https://deb.nodesource.com/setup_lts.x | sh -
                apt-get install -y nodejs
            fi
            ;;
        dnf)
            dnf install -y nodejs npm
            ;;
        yum)
            yum install -y nodejs npm
            ;;
        pacman)
            pacman -Sy --noconfirm nodejs npm
            ;;
        zypper)
            zypper install -y nodejs npm
            ;;
    esac
}

# Check if Node.js is installed
check_nodejs() {
    if command -v node >/dev/null 2>&1; then
        NODE_VERSION="$(node -v)"
        echo_info "Node.js already installed: $NODE_VERSION"
        return 0
    fi
    return 1
}

# Setup .env file
setup_env() {
    ENV_FILE="$SCRIPT_DIR/.env"
    
    if [ ! -f "$ENV_FILE" ]; then
        cat > "$ENV_FILE" << 'ENVEOF'
# Path to your Traefik config.yml file
TRAEFIK_CONFIG_PATH=~/traekd/config.yml
TRAEFIK_YML_FILE=~/traekd/traefik.yml

# Web server settings
SERVER_PORT=3000
SERVER_HOST=127.0.0.1

# Site information
SITE_TITLE='Traefik Config Manager'
ENVEOF
        echo_info "Created default .env file"
    else
        echo_info ".env file already exists"
    fi
    
    # Create logs directory
    mkdir -p "$SCRIPT_DIR/logs"
    chmod 755 "$SCRIPT_DIR/logs"
}

# Install npm dependencies
install_dependencies() {
    cd "$SCRIPT_DIR/server"
    echo_info "Installing npm dependencies..."
    npm install --production
}

# Stop existing service
stop_service() {
    echo_info "Stopping existing service if running..."
    if command -v systemctl >/dev/null 2>&1; then
        systemctl stop traefik-config-manager 2>/dev/null || true
    elif command -v rc-service >/dev/null 2>&1; then
        rc-service traefik-config-manager stop 2>/dev/null || true
    fi
    pkill -f "node.*traekd.*index.js" 2>/dev/null || true
    sleep 2
}

# Create systemd service (if systemd exists)
create_systemd_service() {
    if command -v systemctl >/dev/null 2>&1; then
        NODE_PATH="$(command -v node)"
        
        cat > /etc/systemd/system/traefik-config-manager.service << SERVICEEOF
[Unit]
Description=Traefik Config Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR/server
ExecStart=$NODE_PATH index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICEEOF

        systemctl daemon-reload
        echo_info "Systemd service created"
        return 0
    fi
    return 1
}

# Create OpenRC service (Alpine Linux)
create_openrc_service() {
    if command -v rc-service >/dev/null 2>&1; then
        NODE_PATH="$(command -v node)"
        
        cat > /etc/init.d/traefik-config-manager << RCEOF
#!/sbin/openrc-run

name="traefik-config-manager"
description="Traefik Config Manager"
command="$NODE_PATH"
command_args="$SCRIPT_DIR/server/index.js"
command_background=true
pidfile="/run/\${RC_SVCNAME}.pid"
directory="$SCRIPT_DIR/server"

depend() {
    need net
    after firewall
}
RCEOF

        chmod +x /etc/init.d/traefik-config-manager
        echo_info "OpenRC service created"
        return 0
    fi
    return 1
}

# Start the server
start_server() {
    echo_info "Starting Traefik Config Manager..."
    
    if command -v systemctl >/dev/null 2>&1; then
        systemctl enable traefik-config-manager
        systemctl restart traefik-config-manager
        echo_info "Systemd service restarted and enabled"
        sleep 2
    elif command -v rc-service >/dev/null 2>&1; then
        rc-update add traefik-config-manager default
        rc-service traefik-config-manager restart
        echo_info "OpenRC service restarted and enabled"
    else
        cd "$SCRIPT_DIR/server"
        echo_info "Starting server manually..."
        nohup node index.js >> "$SCRIPT_DIR/logs/server.log" 2>&1 &
        echo $! > /tmp/traefik-config-manager.pid
        echo_info "Server started with PID $(cat /tmp/traefik-config-manager.pid)"
    fi
}

# Test API endpoint
test_api() {
    echo_info "Testing API endpoint..."
    sleep 3
    PORT="${PORT:-3000}"
    
    if command -v curl >/dev/null 2>&1; then
        RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/config" 2>/dev/null || echo "000")
        if [ "$RESPONSE" = "200" ]; then
            echo_info "API test passed (HTTP $RESPONSE)"
        else
            echo_warn "API test returned HTTP $RESPONSE"
            echo_warn "Check logs: $SCRIPT_DIR/logs/server.log"
        fi
    fi
}

# Main installation
main() {
    escalate_privileges "$@"
    
    echo "========================================"
    echo "  Traefik Config Manager Installer"
    echo "========================================"
    
    detect_pkg_manager
    
    if ! check_nodejs; then
        install_nodejs
    fi
    
    setup_env
    stop_service
    install_dependencies
    
    if ! create_systemd_service; then
        create_openrc_service
    fi
    
    start_server
    test_api
    
    PORT="${PORT:-3000}"
    
    echo ""
    echo "========================================"
    echo_info "Installation complete!"
    echo_info "Config: $SCRIPT_DIR/.env"
    echo_info "Logs: $SCRIPT_DIR/logs/server.log"
    echo_info "URL: http://localhost:$PORT"
    echo "========================================"
}

main "$@"
