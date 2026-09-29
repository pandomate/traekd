#!/bin/sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo_info() { printf "${GREEN}[INFO]${NC} %s\n" "$1"; }
echo_warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$1"; }
echo_error() { printf "${RED}[ERROR]${NC} %s\n" "$1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect and use privilege escalation if needed
escalate_privileges() {
    if [ "$(id -u)" -eq 0 ]; then
        return 0
    fi
    
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

# Stop systemd service
stop_systemd_service() {
    if command -v systemctl >/dev/null 2>&1; then
        echo_info "Stopping systemd service..."
        systemctl stop traefik-config-manager 2>/dev/null || true
        systemctl disable traefik-config-manager 2>/dev/null || true
        
        if [ -f /etc/systemd/system/traefik-config-manager.service ]; then
            rm -f /etc/systemd/system/traefik-config-manager.service
            systemctl daemon-reload
            echo_info "Systemd service removed"
        fi
        return 0
    fi
    return 1
}

# Stop OpenRC service
stop_openrc_service() {
    if command -v rc-service >/dev/null 2>&1; then
        echo_info "Stopping OpenRC service..."
        rc-service traefik-config-manager stop 2>/dev/null || true
        rc-update del traefik-config-manager default 2>/dev/null || true
        
        if [ -f /etc/init.d/traefik-config-manager ]; then
            rm -f /etc/init.d/traefik-config-manager
            echo_info "OpenRC service removed"
        fi
        return 0
    fi
    return 1
}

# Kill any running node processes
kill_processes() {
    echo_info "Killing any running processes..."
    pkill -f "node.*traekd.*index.js" 2>/dev/null || true
    pkill -f "node.*traefik-config-manager.*index.js" 2>/dev/null || true
    
    # Clean up PID file if exists
    if [ -f /tmp/traefik-config-manager.pid ]; then
        PID=$(cat /tmp/traefik-config-manager.pid 2>/dev/null)
        if [ -n "$PID" ]; then
            kill "$PID" 2>/dev/null || true
        fi
        rm -f /tmp/traefik-config-manager.pid
    fi
    
    sleep 2
}

# Prompt for confirmation
confirm_action() {
    printf "${YELLOW}Are you sure you want to uninstall Traefik Config Manager? [y/N]: ${NC}"
    read -r response
    case "$response" in
        [yY][eE][sS]|[yY]) 
            return 0
            ;;
        *)
            echo_info "Uninstall cancelled."
            exit 0
            ;;
    esac
}

# Main uninstall
main() {
    escalate_privileges "$@"
    
    echo "========================================"
    echo "  Traefik Config Manager Uninstaller"
    echo "========================================"
    echo ""
    
    confirm_action
    
    echo ""
    echo_info "Starting uninstall process..."
    
    # Stop services
    if ! stop_systemd_service; then
        stop_openrc_service
    fi
    
    # Kill any remaining processes
    kill_processes
    
    echo ""
    echo "========================================"
    echo_info "Service stopped and removed!"
    echo ""
    echo_info "The following files remain (manual cleanup if needed):"
    echo "  - Application: $SCRIPT_DIR"
    echo "  - Config: $SCRIPT_DIR/.env"
    echo "  - Logs: $SCRIPT_DIR/logs/"
    echo ""
    echo_warn "To completely remove, run:"
    echo "  rm -rf $SCRIPT_DIR"
    echo "========================================"
}

main "$@"
