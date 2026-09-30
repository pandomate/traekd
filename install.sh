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
SCRIPT_OWNER="$(stat -c '%U' "$SCRIPT_DIR" 2>/dev/null || printf 'root')"
SCRIPT_GROUP="$(stat -c '%G' "$SCRIPT_DIR" 2>/dev/null || printf 'root')"
if [ "$SCRIPT_OWNER" = "root" ] || ! id "$SCRIPT_OWNER" >/dev/null 2>&1; then
    DEFAULT_SERVICE_USER=traekd
else
    # A separate system account cannot traverse a typical mode-0700 home
    # directory. For an in-home install, run as the non-root repository owner.
    DEFAULT_SERVICE_USER="$SCRIPT_OWNER"
fi
SERVICE_USER="${TRAEKD_SERVICE_USER:-$DEFAULT_SERVICE_USER}"
TRAEFIK_SERVICE_SETUP=no
TRAEFIK_INSTALLED_NOW=no

# Read a simple KEY=value from .env without executing operator-provided shell.
read_env_value() {
    key="$1"
    fallback="$2"
    value="$(sed -n "s/^${key}=//p" "$SCRIPT_DIR/.env" 2>/dev/null | tail -n 1 | tr -d '\r' | sed "s/^['\"]//;s/['\"]$//")"
    printf '%s' "${value:-$fallback}"
}

set_env_value() {
    key="$1"
    value="$2"
    env_file="$SCRIPT_DIR/.env"
    temp_file="$SCRIPT_DIR/.env.$$.tmp"
    escaped_value="$(printf '%s' "$value" | sed 's/[\\&|]/\\&/g')"
    if grep -q "^${key}=" "$env_file" 2>/dev/null; then
        sed "s|^${key}=.*|${key}=\"${escaped_value}\"|" "$env_file" > "$temp_file"
    else
        cp "$env_file" "$temp_file"
        printf '%s="%s"\n' "$key" "$value" >> "$temp_file"
    fi
    chmod 600 "$temp_file"
    mv "$temp_file" "$env_file"
}

# Values loaded from .env do not receive shell tilde expansion. Older Traekd
# installers wrote ~/traekd literally, so map that legacy location to the
# directory containing this installer. Resolve other relative paths there too.
normalize_config_path() {
    raw_path="$1"
    case "$raw_path" in
        \\~/*) raw_path="${raw_path#\\}" ;;
    esac
    legacy_prefix='~/traekd/'
    case "$raw_path" in
        '~/traekd') printf '%s' "$SCRIPT_DIR" ;;
        '~/traekd/'*) printf '%s/%s' "$SCRIPT_DIR" "${raw_path#"$legacy_prefix"}" ;;
        '~/'*)
            echo_warn "Resolving legacy path $raw_path relative to $(dirname "$SCRIPT_DIR")" >&2
            printf '%s/%s' "$(dirname "$SCRIPT_DIR")" "${raw_path#'~/'}"
            ;;
        /*) printf '%s' "$raw_path" ;;
        ./*) printf '%s/%s' "$SCRIPT_DIR" "${raw_path#./}" ;;
        *) printf '%s/%s' "$SCRIPT_DIR" "$raw_path" ;;
    esac
}

ensure_service_user() {
    if id "$SERVICE_USER" >/dev/null 2>&1; then
        return 0
    fi
    echo_info "Creating dedicated service user: $SERVICE_USER"
    if command -v useradd >/dev/null 2>&1; then
        useradd --system --user-group --no-create-home "$SERVICE_USER"
    elif command -v adduser >/dev/null 2>&1; then
        adduser -S -D -H "$SERVICE_USER"
    else
        echo_error "Cannot create service user; useradd or adduser is required."
        exit 1
    fi
}

ensure_traefik_download_tools() {
    missing_tools=""
    for tool in curl tar sha256sum; do
        command -v "$tool" >/dev/null 2>&1 || missing_tools="$missing_tools $tool"
    done
    [ -z "$missing_tools" ] && return 0
    echo_info "Installing Traefik download tools:$missing_tools"
    case $PKG_MANAGER in
        apk) apk add --no-cache curl ca-certificates tar coreutils ;;
        apt) apt-get update && apt-get install -y curl ca-certificates tar coreutils ;;
        dnf|yum) "$PKG_MANAGER" install -y curl ca-certificates tar coreutils ;;
        pacman) pacman -Sy --noconfirm curl ca-certificates tar coreutils ;;
        zypper) zypper --non-interactive install curl ca-certificates tar coreutils ;;
    esac
}

install_traefik_binary() {
    ensure_traefik_download_tools
    machine="$(uname -m)"
    case "$machine" in
        x86_64|amd64) traefik_arch=amd64 ;;
        aarch64|arm64) traefik_arch=arm64 ;;
        armv7l|armv7) traefik_arch=armv7 ;;
        armv6l|armv6) traefik_arch=armv6 ;;
        i386|i486|i586|i686) traefik_arch=386 ;;
        *) echo_error "Unsupported architecture for Traefik binary: $machine"; exit 1 ;;
    esac

    traefik_version="${TRAEFIK_INSTALL_VERSION:-}"
    if [ -z "$traefik_version" ]; then
        echo_info "Finding the latest official Traefik release..."
        traefik_version="$(curl -fsSL --retry 3 https://api.github.com/repos/traefik/traefik/releases/latest | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    fi
    case "$traefik_version" in v*) ;; *) traefik_version="v$traefik_version" ;; esac
    if ! printf '%s' "$traefik_version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo_error "Invalid Traefik version '$traefik_version'. Expected a version such as v3.7.13."
        exit 1
    fi

    archive="traefik_${traefik_version}_linux_${traefik_arch}.tar.gz"
    checksums="traefik_${traefik_version}_checksums.txt"
    release_root="https://github.com/traefik/traefik/releases/download/$traefik_version"
    download_dir="$(mktemp -d /tmp/traekd-traefik.XXXXXX)"
    cleanup_traefik_download() {
        case "$download_dir" in /tmp/traekd-traefik.*) rm -rf "$download_dir" ;; esac
    }
    trap cleanup_traefik_download 0 1 2 15

    echo_info "Downloading Traefik $traefik_version for linux/$traefik_arch..."
    curl -fL --retry 3 "$release_root/$archive" -o "$download_dir/$archive"
    curl -fL --retry 3 "$release_root/$checksums" -o "$download_dir/$checksums"
    expected_hash="$(awk -v file="$archive" '$2 == file || $2 == "*" file { print $1; exit }' "$download_dir/$checksums")"
    actual_hash="$(sha256sum "$download_dir/$archive" | awk '{ print $1 }')"
    if [ -z "$expected_hash" ] || [ "$actual_hash" != "$expected_hash" ]; then
        echo_error "Traefik checksum verification failed; nothing was installed."
        exit 1
    fi

    tar -xzf "$download_dir/$archive" -C "$download_dir" traefik
    install -m 0755 "$download_dir/traefik" /usr/local/bin/traefik
    cleanup_traefik_download
    trap - 0 1 2 15
    echo_info "Installed $(traefik version 2>/dev/null | head -n 1) at /usr/local/bin/traefik"
    TRAEFIK_INSTALLED_NOW=yes
}

maybe_install_traefik() {
    if command -v traefik >/dev/null 2>&1; then
        echo_info "Traefik already installed: $(traefik version 2>/dev/null | head -n 1)"
    else
        choice="${TRAEKD_INSTALL_TRAEFIK:-ask}"
        if [ "$choice" = "ask" ]; then
            if [ -t 0 ]; then
                printf "Install the official Traefik Community binary now? [y/N]: "
                read -r choice
            else
                choice=no
                echo_warn "Traefik is not installed; skipping in non-interactive mode. Set TRAEKD_INSTALL_TRAEFIK=yes to install it."
            fi
        fi
        case "$choice" in
            y|Y|yes|YES|true|TRUE|1) install_traefik_binary ;;
            n|N|no|NO|false|FALSE|0|'') echo_info "Skipping Traefik binary installation"; return 0 ;;
            *) echo_error "TRAEKD_INSTALL_TRAEFIK must be yes, no, or ask"; exit 1 ;;
        esac
    fi

    if [ -f /etc/systemd/system/traefik.service ] || [ -f /lib/systemd/system/traefik.service ] || [ -f /etc/init.d/traefik ]; then
        echo_info "Existing Traefik service found; leaving it unchanged"
        return 0
    fi
    service_choice="${TRAEKD_MANAGE_TRAEFIK_SERVICE:-ask}"
    if [ "$service_choice" = "ask" ]; then
        if [ "$TRAEFIK_INSTALLED_NOW" = "yes" ]; then
            service_choice=yes
        elif [ -t 0 ]; then
            printf "Traefik has no startup service. Configure and enable one with managed directory mode? [Y/n]: "
            read -r service_choice
            service_choice="${service_choice:-yes}"
        else
            service_choice=no
            echo_warn "Traefik has no startup service. Set TRAEKD_MANAGE_TRAEFIK_SERVICE=yes to create one."
        fi
    fi
    case "$service_choice" in
        y|Y|yes|YES|true|TRUE|1) TRAEFIK_SERVICE_SETUP=yes ;;
        n|N|no|NO|false|FALSE|0|'') echo_info "Leaving Traefik service management to the operator" ;;
        *) echo_error "TRAEKD_MANAGE_TRAEFIK_SERVICE must be yes, no, or ask"; exit 1 ;;
    esac
}

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
    exec "$PRIV_CMD" env \
        TRAEKD_INSTALL_TRAEFIK="${TRAEKD_INSTALL_TRAEFIK:-ask}" \
        TRAEFIK_INSTALL_VERSION="${TRAEFIK_INSTALL_VERSION:-}" \
        TRAEKD_MANAGE_TRAEFIK_SERVICE="${TRAEKD_MANAGE_TRAEFIK_SERVICE:-ask}" \
        TRAEKD_SERVICE_USER="${TRAEKD_SERVICE_USER:-}" \
        sh "$0" "$@"
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
        cat > "$ENV_FILE" << ENVEOF
# Directory watched by Traefik's file provider. Traekd owns only traekd.yml in it.
TRAEFIK_CONFIG_PATH=/etc/traefik/dynamic
TRAEKD_CONFIG_ROOT=/etc/traefik/dynamic
TRAEFIK_YML_FILE=$SCRIPT_DIR/traefik.yml
TRAEKD_STATIC_CONFIG_ROOT=$SCRIPT_DIR
TRAEKD_STORAGE_MODE=directory
TRAEKD_TRAEFIK_VERSION=v3.7
TRAEKD_MANAGED_DIRECTORY=/etc/traefik/dynamic
TRAEKD_SINGLE_FILE_PATH=$SCRIPT_DIR/config.yml

# Web server settings
SERVER_PORT=3000
SERVER_HOST=127.0.0.1

# Site information
SITE_TITLE='Traefik Config Manager'
TRAEKD_AUTH_MODE=required
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
    if [ -f package-lock.json ]; then
        npm ci --omit=dev
    else
        npm install --omit=dev
    fi
    if [ "$SCRIPT_OWNER" != "root" ]; then
        chown -R "$SCRIPT_OWNER:$SCRIPT_GROUP" "$SCRIPT_DIR/server/node_modules"
    fi
}

# Create a single administrator on first install. The random password is shown
# once and only its scrypt hash is persisted.
setup_auth() {
    current_hash="$(read_env_value TRAEKD_ADMIN_PASSWORD_HASH '')"
    current_secret="$(read_env_value TRAEKD_SESSION_SECRET '')"
    [ -n "$current_hash" ] && [ "${#current_secret}" -ge 32 ] && return 0

    admin_user="${TRAEKD_INSTALL_ADMIN_USER:-admin}"
    admin_password="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
    session_secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    admin_hash="$(node "$SCRIPT_DIR/server/bin/hash-password.js" "$admin_password")"
    set_env_value TRAEKD_AUTH_MODE required
    set_env_value TRAEKD_ADMIN_USER "$admin_user"
    set_env_value TRAEKD_ADMIN_PASSWORD_HASH "$admin_hash"
    set_env_value TRAEKD_SESSION_SECRET "$session_secret"
    echo_warn "Initial Traekd admin username: $admin_user"
    echo_warn "Initial Traekd admin password (shown once): $admin_password"
}

# Configure the native Traefik binary as a boot service. This is only called
# after an explicit installer choice. Existing source files are preserved, and
# the static config receives a timestamped backup before it is adjusted.
configure_traefik_service() {
    [ "$TRAEFIK_SERVICE_SETUP" = "yes" ] || return 0

    MANAGED_DIRECTORY=/etc/traefik/dynamic
    TRAEFIK_STATE_DIRECTORY=/var/lib/traefik
    TRAEFIK_LOG_DIRECTORY=/var/log/traefik
    RAW_STATIC_PATH="$(read_env_value TRAEFIK_YML_FILE "$SCRIPT_DIR/traefik.yml")"
    STATIC_PATH="$(normalize_config_path "$RAW_STATIC_PATH")"
    if [ ! -f "$STATIC_PATH" ]; then
        echo_error "Cannot configure Traefik service; static config does not exist: $STATIC_PATH"
        exit 1
    fi

    mkdir -p "$MANAGED_DIRECTORY" "$TRAEFIK_STATE_DIRECTORY" "$TRAEFIK_LOG_DIRECTORY"
    RAW_CURRENT_CONFIG="$(read_env_value TRAEFIK_CONFIG_PATH "$SCRIPT_DIR/config.yml")"
    CURRENT_CONFIG="$(normalize_config_path "$RAW_CURRENT_CONFIG")"
    CURRENT_MODE="$(read_env_value TRAEKD_STORAGE_MODE file)"
    TARGET_CONFIG="$MANAGED_DIRECTORY/traekd.yml"
    if [ "$CURRENT_MODE" = "directory" ]; then
        CURRENT_SOURCE="$CURRENT_CONFIG/traekd.yml"
    else
        CURRENT_SOURCE="$CURRENT_CONFIG"
    fi
    if [ -f "$CURRENT_SOURCE" ] && [ "$CURRENT_SOURCE" != "$TARGET_CONFIG" ]; then
        if [ -s "$TARGET_CONFIG" ] && ! cmp -s "$CURRENT_SOURCE" "$TARGET_CONFIG"; then
            echo_error "Refusing to replace non-empty managed config: $TARGET_CONFIG"
            echo_error "Move or merge that file, then run the installer again."
            exit 1
        fi
        cp -p "$CURRENT_SOURCE" "$TARGET_CONFIG"
        echo_info "Copied existing dynamic configuration to $TARGET_CONFIG"
    else
        touch "$TARGET_CONFIG"
    fi

    STATIC_BACKUP="$(node "$SCRIPT_DIR/server/bin/configure-traefik.js" "$STATIC_PATH" "$MANAGED_DIRECTORY")"
    echo_info "Updated Traefik file provider and loopback API; backup: $STATIC_BACKUP"
    set_env_value TRAEFIK_CONFIG_PATH "$MANAGED_DIRECTORY"
    set_env_value TRAEKD_STORAGE_MODE directory
    set_env_value TRAEKD_MANAGED_DIRECTORY "$MANAGED_DIRECTORY"
    if [ "$CURRENT_MODE" = "file" ]; then
        set_env_value TRAEKD_SINGLE_FILE_PATH "$CURRENT_CONFIG"
    fi
    set_env_value TRAEFIK_API_URL http://127.0.0.1:8080

    chown "$SERVICE_USER:$SERVICE_USER" "$MANAGED_DIRECTORY" "$TARGET_CONFIG" "$TRAEFIK_STATE_DIRECTORY" "$TRAEFIK_LOG_DIRECTORY"
    chmod 750 "$MANAGED_DIRECTORY" "$TRAEFIK_STATE_DIRECTORY" "$TRAEFIK_LOG_DIRECTORY"
    chmod 640 "$TARGET_CONFIG"

    TRAEFIK_PATH="$(command -v traefik)"
    if command -v systemctl >/dev/null 2>&1; then
        cat > /etc/systemd/system/traefik.service << SERVICEEOF
[Unit]
Description=Traefik Community Reverse Proxy
Documentation=https://doc.traefik.io/traefik/
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$TRAEFIK_STATE_DIRECTORY
ExecStart=$TRAEFIK_PATH --configFile=$STATIC_PATH
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SERVICEEOF
        systemctl daemon-reload
        systemctl enable traefik.service
        systemctl restart traefik.service
        echo_info "Traefik systemd service created and enabled"
    elif command -v rc-service >/dev/null 2>&1; then
        cat > /etc/init.d/traefik << RCEOF
#!/sbin/openrc-run
name="Traefik Community Reverse Proxy"
command="$TRAEFIK_PATH"
command_args="--configFile=$STATIC_PATH"
command_background=true
pidfile="/run/traefik.pid"
directory="$TRAEFIK_STATE_DIRECTORY"
command_user="$SERVICE_USER:$SERVICE_USER"
capabilities="^cap_net_bind_service"
depend() {
    need net
    after docker
}
RCEOF
        chmod +x /etc/init.d/traefik
        rc-update add traefik default
        rc-service traefik restart
        echo_info "Traefik OpenRC service created and enabled"
    else
        echo_warn "No supported service manager found; Traefik service was not created"
    fi
}

# The service receives write access to logs/data and the exact dynamic-config
# directory needed for atomic sibling-file replacement. Traekd itself only
# targets traekd.yml when directory mode is active.
prepare_runtime_permissions() {
    mkdir -p "$SCRIPT_DIR/logs" "$SCRIPT_DIR/data"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$SCRIPT_DIR/logs" "$SCRIPT_DIR/data"
    chmod 750 "$SCRIPT_DIR/logs" "$SCRIPT_DIR/data"
    chown "$SERVICE_USER:$SERVICE_USER" "$SCRIPT_DIR/.env"
    chmod 600 "$SCRIPT_DIR/.env"

    RAW_CONFIG_PATH="$(read_env_value TRAEFIK_CONFIG_PATH "$SCRIPT_DIR/config.yml")"
    CONFIG_PATH="$(normalize_config_path "$RAW_CONFIG_PATH")"
    STORAGE_MODE="$(read_env_value TRAEKD_STORAGE_MODE file)"
    if [ "$STORAGE_MODE" = "directory" ]; then
        if [ ! -d "$CONFIG_PATH" ]; then
            echo_error "Managed config directory does not exist: $CONFIG_PATH"
            exit 1
        fi
        CONFIG_WRITE_PATH="$CONFIG_PATH/traekd.yml"
        CONFIG_WRITE_DIRECTORY="$CONFIG_PATH"
        touch "$CONFIG_WRITE_PATH"
        # Atomic replacement creates a sibling temporary file, so the service
        # needs write permission on the managed directory as well as the file.
        chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_PATH"
        chmod u+rwx "$CONFIG_PATH"
    else
        CONFIG_WRITE_PATH="$CONFIG_PATH"
        CONFIG_PARENT="$(dirname "$CONFIG_WRITE_PATH")"
        CONFIG_WRITE_DIRECTORY="$CONFIG_PARENT"
        if [ ! -d "$CONFIG_PARENT" ]; then
            echo_error "Dynamic config parent directory does not exist: $CONFIG_PARENT"
            exit 1
        fi
        if [ ! -e "$CONFIG_WRITE_PATH" ]; then
            echo_warn "Dynamic config file does not exist yet: $CONFIG_WRITE_PATH"
            touch "$CONFIG_WRITE_PATH"
        fi
    fi
    chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_WRITE_PATH"
    chmod 640 "$CONFIG_WRITE_PATH"

    RAW_STATIC_PATH="$(read_env_value TRAEFIK_YML_FILE "$SCRIPT_DIR/traefik.yml")"
    STATIC_WRITE_PATH="$(normalize_config_path "$RAW_STATIC_PATH")"
    if [ ! -f "$STATIC_WRITE_PATH" ]; then
        echo_error "Traefik static config file does not exist: $STATIC_WRITE_PATH"
        exit 1
    fi
    # Entry Point changes use a validated in-place fallback when the containing
    # directory cannot support atomic rename, so only this exact file needs to
    # be writable by the service account.
    chown "$SERVICE_USER:$SERVICE_USER" "$STATIC_WRITE_PATH"
    chmod 640 "$STATIC_WRITE_PATH"
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
Wants=network-online.target
After=network-online.target traefik.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$SCRIPT_DIR/server
ExecStart=$NODE_PATH index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
# Atomic configuration saves create and fsync a sibling temporary file before
# renaming it over the active YAML. The containing directory must therefore be
# writable inside systemd's ProtectSystem sandbox, not only the target file.
ReadWritePaths=$SCRIPT_DIR/.env $SCRIPT_DIR/logs $SCRIPT_DIR/data $CONFIG_WRITE_DIRECTORY $STATIC_WRITE_PATH

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
command_user="$SERVICE_USER:$SERVICE_USER"

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
    PORT="$(read_env_value SERVER_PORT 3000)"
    
    if command -v curl >/dev/null 2>&1; then
        RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/healthz" 2>/dev/null || echo "000")
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

    maybe_install_traefik
    
    if ! check_nodejs; then
        install_nodejs
    fi
    
    setup_env
    ensure_service_user
    stop_service
    install_dependencies
    setup_auth
    configure_traefik_service
    prepare_runtime_permissions
    
    if ! create_systemd_service; then
        create_openrc_service
    fi
    
    start_server
    test_api
    
    PORT="$(read_env_value SERVER_PORT 3000)"
    
    echo ""
    echo "========================================"
    echo_info "Installation complete!"
    echo_info "Config: $SCRIPT_DIR/.env"
    echo_info "Logs: $SCRIPT_DIR/logs/server.log"
    echo_info "URL: http://localhost:$PORT"
    echo "========================================"
}

main "$@"
