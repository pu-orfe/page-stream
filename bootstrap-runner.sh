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
echo -e "  ${BOLD}5)${NC} Exit"
read -rp "Select an option [1-5]: " OPTION

case $OPTION in
    1)
        echo -e "\n${CYAN}Checking runner processes...${NC}"
        if ps aux | grep "Runner.Listener" | grep -v grep &> /dev/null; then
            echo -e "${GREEN}✓ GitHub Actions self-hosted runner daemon is ACTIVE and running.${NC}"
        else
            echo -e "${RED}✗ GitHub Actions self-hosted runner daemon is STOPPED.${NC}"
        fi
        ;;
    2)
        echo -e "\n${YELLOW}Restarting self-hosted runner...${NC}"
        pkill -f "Runner.Listener" || true
        ./run.sh &
        sleep 2
        echo -e "${GREEN}✓ Runner successfully launched in the background!${NC}"
        ;;
    3)
        echo -e "\n${YELLOW}Stopping self-hosted runner...${NC}"
        pkill -f "Runner.Listener" || true
        echo -e "${GREEN}✓ Runner stopped.${NC}"
        ;;
    4)
        echo -e "\n${RED}${BOLD}Tearing down container stack...${NC}"
        docker compose -f docker-compose.stable.yml down --remove-orphans || true
        echo -e "${GREEN}✓ All page-stream containers stopped and removed.${NC}"
        ;;
    *)
        echo -e "\nExiting."
        exit 0
        ;;
esac
