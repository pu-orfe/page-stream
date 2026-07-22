#!/bin/bash
set -euo pipefail

# ANSI color codes for rich, beautiful terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${BLUE}${BOLD}======================================================================${NC}"
echo -e "${CYAN}${BOLD}              PAGE-STREAM INTERACTIVE RUNNER BOOTSTRAPPER            ${NC}"
echo -e "${BLUE}${BOLD}======================================================================${NC}"

# Detect Runner Dir
RUNNER_DIR="/Users/publicdisplays/actions-runner"
if [ ! -d "$RUNNER_DIR" ]; then
    # Fallback to local search or home dir
    RUNNER_DIR="${HOME}/actions-runner"
fi

# Helper to check if launchd service is installed
is_service_installed() {
    if [ -d "$RUNNER_DIR" ] && [ -f "$RUNNER_DIR/.service" ]; then
        return 0 # True
    else
        return 1 # False
    fi
}

# 1. System Resource Check
echo -e "\n${BOLD}[1/4] Checking System Resources...${NC}"
PHYSICAL_MEM_GB=$(sysctl hw.memsize | awk '{print $2/1024/1024/1024}')
CPUS=$(sysctl hw.physicalcpu | awk '{print $2}')

echo -e "  Host Memory: ${CYAN}${PHYSICAL_MEM_GB} GB${NC}"
echo -e "  Host CPUs:   ${CYAN}${CPUS}${NC}"

if (( $(echo "$PHYSICAL_MEM_GB < 8" | bc -l) )); then
    echo -e "  ${RED}⚠ Warning: Host has less than 8GB of RAM. The 11-container stream stack may experience latency.${NC}"
else
    echo -e "  ${GREEN}✓ Resource checks passed!${NC}"
fi

# 2. Dependency Check
echo -e "\n${BOLD}[2/4] Verifying Host Dependencies...${NC}"
deps=("git" "docker" "gh")
for dep in "${deps[@]}"; do
    if ! command -v "$dep" &> /dev/null; then
        echo -e "  ${RED}✗ Error: '$dep' is not installed or not in PATH.${NC}"
        exit 1
    fi
    echo -e "  ${GREEN}✓ $dep is installed.${NC}"
done

# Check Docker Daemon
if ! docker info &> /dev/null; then
    echo -e "  ${RED}✗ Error: Docker daemon is not running! Please start Docker Desktop or Colima.${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓ Docker daemon is active.${NC}"

# Check Colima VM specs if using Colima
if colima status &> /dev/null; then
    echo -e "  ${YELLOW}Detected Colima VM. Checking allocations...${NC}"
    COLIMA_MEM=$(colima list --format json | grep -o '"memory":[^,]*' | grep -o '[0-9]*' || echo "2")
    if [ "$COLIMA_MEM" -lt 4 ]; then
        echo -e "  ${RED}⚠ Colima is allocated only ${COLIMA_MEM}GB of RAM. Suggest running: 'colima stop && colima start --cpu 4 --memory 6'${NC}"
    fi
fi

# 3. Interactive CLI Selector
echo -e "\n${BOLD}[3/4] What would you like to do?${NC}"
echo -e "  ${BOLD}1)${NC} Check Runner Status"
echo -e "  ${BOLD}2)${NC} Restart Runner Daemon"
echo -e "  ${BOLD}3)${NC} Stop Runner Daemon"
echo -e "  ${BOLD}4)${NC} Teardown Local Container Stack (Clean slate)"
echo -e "  ${BOLD}5)${NC} Configure Auto-Start on System Boot (macOS Service)"
echo -e "  ${BOLD}6)${NC} Bootstrap a New Private Ops Repository (Other Units/Departments)"
echo -e "  ${BOLD}7)${NC} Exit"
read -rp "Select an option [1-7]: " OPTION

case $OPTION in
    1)
        echo -e "\n${CYAN}Checking runner status...${NC}"
        if is_service_installed; then
            echo -e "${YELLOW}Service is installed. Reading status via launchctl...${NC}"
            cd "$RUNNER_DIR" && ./svc.sh status || true
        else
            echo -e "${YELLOW}Service is not installed. Checking manual runner processes...${NC}"
            if ps aux | grep "Runner.Listener" | grep -v grep &> /dev/null; then
                echo -e "${GREEN}✓ GitHub Actions self-hosted runner is ACTIVE and running (Manual Mode).${NC}"
            else
                echo -e "${RED}✗ GitHub Actions self-hosted runner is STOPPED.${NC}"
            fi
        fi
        ;;
    2)
        echo -e "\n${YELLOW}Restarting self-hosted runner...${NC}"
        if is_service_installed; then
            echo -e "Restarting runner service..."
            cd "$RUNNER_DIR" && ./svc.sh stop || true
            cd "$RUNNER_DIR" && ./svc.sh start
            echo -e "${GREEN}✓ Runner service successfully restarted!${NC}"
        else
            echo -e "Restarting manual runner process..."
            pkill -f "Runner.Listener" || true
            ./run.sh &
            sleep 2
            echo -e "${GREEN}✓ Runner successfully launched in manual background mode!${NC}"
        fi
        ;;
    3)
        echo -e "\n${YELLOW}Stopping self-hosted runner...${NC}"
        if is_service_installed; then
            cd "$RUNNER_DIR" && ./svc.sh stop || true
            echo -e "${GREEN}✓ Runner service stopped.${NC}"
        else
            pkill -f "Runner.Listener" || true
            echo -e "${GREEN}✓ Manual runner stopped.${NC}"
        fi
        ;;
    4)
        echo -e "\n${RED}${BOLD}Tearing down container stack...${NC}"
        docker compose -f docker-compose.stable.yml down --remove-orphans || true
        echo -e "${GREEN}✓ All page-stream containers stopped and removed.${NC}"
        ;;
    5)
        echo -e "\n${BLUE}${BOLD}======================================================================${NC}"
        echo -e "${CYAN}${BOLD}             CONFIGURING AUTO-START ON SYSTEM BOOT                    ${NC}"
        echo -e "${BLUE}${BOLD}======================================================================${NC}"
        
        # 1. Stop manual runner to avoid collisions
        echo -e "Stopping any active manual runner instances..."
        pkill -f Runner.Listener || true
        
        # 2. Install Runner as system LaunchAgent service
        if [ -d "$RUNNER_DIR" ] && [ -f "$RUNNER_DIR/svc.sh" ]; then
            echo -e "Registering GitHub Actions runner as a system service..."
            cd "$RUNNER_DIR"
            if ! ./svc.sh status &> /dev/null; then
                ./svc.sh install || true
            fi
            ./svc.sh start || true
            echo -e "  ${GREEN}✓ GitHub Actions Runner successfully configured to start on boot.${NC}"
            cd - > /dev/null
        else
            echo -e "  ${RED}✗ Error: Actions runner folder or 'svc.sh' not found at ${RUNNER_DIR}.${NC}"
        fi
        
        # 3. Configure Colima startup LaunchAgent
        COLIMA_BIN=$(command -v colima || true)
        if [ -n "$COLIMA_BIN" ]; then
            echo -e "\nConfiguring Colima (Docker Engine) to auto-start on boot..."
            PLIST_PATH="${HOME}/Library/LaunchAgents/com.colima.startup.plist"
            mkdir -p "$(dirname "$PLIST_PATH")"
            
            cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.colima.startup</string>
    <key>ProgramArguments</key>
    <array>
        <string>${COLIMA_BIN}</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/colima-startup.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/colima-startup.err</string>
</dict>
</plist>
EOF
            launchctl unload "$PLIST_PATH" 2>/dev/null || true
            launchctl load "$PLIST_PATH"
            echo -e "  ${GREEN}✓ Colima (Docker Engine) successfully configured to start on boot.${NC}"
        else
            echo -e "  ${YELLOW}⚠ Colima binary not found in PATH. Skipping Colima plist creation.${NC}"
        fi
        
        echo -e "\n${GREEN}${BOLD}✓ Auto-Start configuration complete!${NC}"
        echo -e "Both your GitHub Runner and Docker Engine (Colima) will now automatically"
        echo -e "boot up and resume your streaming nodes after a system reboot!"
        ;;
    6)
        echo -e "\n${BLUE}${BOLD}======================================================================${NC}"
        echo -e "${CYAN}${BOLD}             BOOTSTRAPPING A NEW DEPARTMENT OPS REPOSITORY            ${NC}"
        echo -e "${BLUE}${BOLD}======================================================================${NC}"
        
        # Check gh auth status
        if ! gh auth status &> /dev/null; then
            echo -e "${RED}✗ Error: You must be logged into the 'gh' CLI first. Run 'gh auth login'.${NC}"
            exit 1
        fi
        
        read -rp "Enter your Department Code (lowercase, e.g., 'economics', 'cs'): " DEPT
        DEPT=$(echo "$DEPT" | tr '[:upper:]' '[:lower:]' | xargs)
        
        if [ -z "$DEPT" ]; then
            echo -e "${RED}✗ Error: Department code cannot be empty.${NC}"
            exit 1
        fi
        
        TARGET_DIR="page-stream-config-${DEPT}"
        echo -e "\nCreating local folder structure under: ${CYAN}${TARGET_DIR}/${NC}"
        
        mkdir -p "${TARGET_DIR}/.github/workflows"
        mkdir -p "${TARGET_DIR}/${DEPT}/assets"
        
        # Create docker-compose.yml template
        cat <<EOF > "${TARGET_DIR}/${DEPT}/docker-compose.yml"
services:
  requirements-check:
    image: alpine:latest
    container_name: requirements-check-${DEPT}
    volumes:
      - ../page-stream-src/scripts:/scripts:ro
    entrypoint: ["sh", "-c"]
    command: ["/scripts/check-system-requirements.sh"]
    restart: "no"

  standard-1:
    image: page-stream:latest
    container_name: standard-1-${DEPT}
    volumes:
      - ../page-stream-src/demo:/app/demo:ro
      - ../page-stream-src/demo:/out/demo:ro
    environment:
      - WIDTH=1920
      - HEIGHT=1080
      - DISPLAY=:101
      - INJECT_CSS=/out/demo/assets/custom.css
    depends_on:
      requirements-check:
        condition: service_completed_successfully
    command:
      - "--ingest"
      - "\${STANDARD_1_INGEST}"
      - "--url"
      - "\${STANDARD_1_URL}"
      - "--auto-refresh-seconds"
      - "3600"
      - "--crop-infobar"
      - "64"
    restart: unless-stopped
EOF

        # Create custom.css and custom.js templates
        cat <<EOF > "${TARGET_DIR}/${DEPT}/assets/custom.css"
/* Custom CSS styling for ${DEPT} public displays */
body {
  background-color: #111111 !important;
  color: #ffffff !important;
  font-family: 'Helvetica Neue', Arial, sans-serif;
}
EOF
        cat <<EOF > "${TARGET_DIR}/${DEPT}/assets/custom.js"
/* Custom JavaScript execution for ${DEPT} public displays */
console.log("[${DEPT}-inject] custom.js loaded");
EOF

        # Create target configuration env file
        cat <<EOF > "${TARGET_DIR}/${DEPT}/${DEPT}.env"
# ${DEPT} public display website targets (safe to check in)
STANDARD_1_URL=https://example.com/${DEPT}-slideshow
EOF

        # Create deploy workflow pipeline template
        cat <<EOF > "${TARGET_DIR}/.github/workflows/deploy.yml"
name: Deploy (GitOps)

on:
  workflow_dispatch:

jobs:
  deploy:
    name: Build & Deploy Stack (${DEPT})
    runs-on:
      - self-hosted
      - ${DEPT}
    
    steps:
    - name: Verify Host Dependencies
      run: |
        for cmd in git docker; do
          command -v \$cmd &> /dev/null || { echo "::error::\$cmd missing"; exit 1; }
        done

    - name: Checkout Private Configuration
      uses: actions/checkout@v4

    - name: Clone Public Codebase
      run: |
        rm -rf page-stream-src
        git clone https://github.com/pu-orfe/page-stream.git page-stream-src

    - name: Configure Ingest Secrets
      run: |
        echo '#!/bin/bash' > ${DEPT}/.env.secrets.sh
        echo "export STANDARD_1_INGEST='\${{ secrets.STANDARD_1_INGEST }}'" >> ${DEPT}/.env.secrets.sh
        chmod +x ${DEPT}/.env.secrets.sh

    - name: Build and Update Docker Compose Stack
      working-directory: ${DEPT}
      run: |
        export \$(grep -v '^#' ${DEPT}.env | xargs)
        source .env.secrets.sh && docker compose up -d --build --remove-orphans

    - name: Verify Stack Health
      working-directory: ${DEPT}
      run: |
        sleep 25
        docker ps
        UNHEALTHY=\$(docker ps -a --filter "label=com.docker.compose.project=${DEPT}" --filter "status=exited" --format "{{.Names}}" | grep -v "requirements-check" || true)
        if [ -n "\$UNHEALTHY" ]; then
          echo "::error::[DEPLOYMENT UNHEALTHY] Containers failed to start!"
          exit 1
        fi
EOF

        # Create a local README
        cat <<EOF > "${TARGET_DIR}/README.md"
# ${DEPT} Page Stream Configuration

This private repository securely hosts the deployment configuration for ${DEPT}'s public displays.

## 🚀 Getting Started

1. Set up your Kaltura/Ingest stream credentials as standard **GitHub Repository Secrets** in this repository:
   * \`STANDARD_1_INGEST\`
2. Configure your target website URL inside \`${DEPT}/${DEPT}.env\`.
3. Set up a self-hosted runner on your local display machine and register it for this repository.
4. Run the workflow under **Actions** -> **Deploy (GitOps)** to start the stream!
EOF

        echo -e "${GREEN}✓ Local templates generated successfully inside: ${TARGET_DIR}/${NC}"
        
        # Ask to create GitHub repository
        read -rp "Would you like to automatically create a private GitHub repository for this on your account? [y/N]: " PUSH_REPO
        if [[ "$PUSH_REPO" =~ ^[Yy]$ ]]; then
            read -rp "Enter GitHub Owner/Organization (default: pu-orfe): " OWNER
            OWNER=${OWNER:-pu-orfe}
            REPO_NAME="${OWNER}/${TARGET_DIR}"
            
            echo -e "\nCreating private GitHub repository ${CYAN}${REPO_NAME}${NC}..."
            if gh repo create "$REPO_NAME" --private --confirm &> /dev/null; then
                echo -e "${GREEN}✓ GitHub Repository created successfully!${NC}"
                
                # Push local code
                echo "Initializing Git and pushing templates..."
                cd "$TARGET_DIR"
                git init -b main &> /dev/null
                git add -A
                git commit -m "Initialize ${DEPT} Ops repository templates" &> /dev/null
                git remote add origin "https://github.com/${REPO_NAME}.git"
                if git push -u origin main &> /dev/null; then
                    echo -e "${GREEN}✓ Templates successfully pushed to https://github.com/${REPO_NAME}${NC}"
                else
                    echo -e "${YELLOW}⚠ Failed to push templates automatically. Please CD into '${TARGET_DIR}' and run 'git push' manually.${NC}"
                fi
                cd ..
            else
                echo -e "${RED}✗ Failed to create GitHub Repository automatically. Please make sure your token has repo-creation permissions.${NC}"
            fi
        fi
        
        echo -e "\n${GREEN}${BOLD}======================================================================${NC}"
        echo -e "${CYAN}${BOLD}             BOOTSTRAP COMPLETION SUCCESSFUL!                        ${NC}"
        echo -e "${GREEN}${BOLD}======================================================================${NC}"
        echo -e "Next steps for the new unit:"
        echo -e "  1. CD into: ${CYAN}${TARGET_DIR}/${NC}"
        echo -e "  2. Edit target URLs in: ${CYAN}${DEPT}/${DEPT}.env${NC}"
        echo -e "  3. Configure GitHub Secret: ${CYAN}STANDARD_1_INGEST${NC}"
        echo -e "  4. Register self-hosted runner for the new repo, and trigger the Deploy Action!"
        ;;
    *)
        echo -e "\nExiting."
        exit 0
        ;;
esac
