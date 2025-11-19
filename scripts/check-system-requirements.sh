#!/bin/sh
set -e

# System Requirements Check for Page Stream
# Validates that the Docker host has sufficient resources allocated
# Minimum requirements: 16GB RAM total, 6 CPU cores

echo "=== Page Stream System Requirements Check ==="
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Required minimums
MIN_RAM_GB=16
MIN_CPUS=6

# Function to convert bytes to GB
bytes_to_gb() {
    echo "$1" | awk '{printf "%.2f", $1/1024/1024/1024}'
}

# Function to get total memory in bytes
get_total_memory() {
    # Try different methods to get memory info
    if [ -f /proc/meminfo ]; then
        # Linux - get MemTotal in kB and convert to bytes
        awk '/MemTotal/ {print $2 * 1024}' /proc/meminfo
    elif [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        # Docker cgroup v1
        cat /sys/fs/cgroup/memory/memory.limit_in_bytes
    elif [ -f /sys/fs/cgroup/memory.max ]; then
        # Docker cgroup v2
        cat /sys/fs/cgroup/memory.max
    else
        echo "0"
    fi
}

# Function to get CPU count
get_cpu_count() {
    # Try different methods
    if [ -f /proc/cpuinfo ]; then
        grep -c ^processor /proc/cpuinfo
    elif [ -f /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then
        # Docker cgroup v1
        quota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)
        period=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)
        if [ "$quota" -gt 0 ] && [ "$period" -gt 0 ]; then
            echo $((quota / period))
        else
            nproc 2>/dev/null || echo "1"
        fi
    else
        nproc 2>/dev/null || echo "1"
    fi
}

# Get system resources
TOTAL_MEMORY_BYTES=$(get_total_memory)
TOTAL_MEMORY_GB=$(bytes_to_gb "$TOTAL_MEMORY_BYTES")
CPU_COUNT=$(get_cpu_count)

echo "Detected system resources:"
echo "  Total Memory: ${TOTAL_MEMORY_GB} GB"
echo "  CPU Cores:    ${CPU_COUNT}"
echo ""

# Check memory requirement
MEMORY_OK=0
if [ "$(echo "$TOTAL_MEMORY_GB >= $MIN_RAM_GB" | bc -l 2>/dev/null || echo 0)" -eq 1 ]; then
    echo "${GREEN}✓${NC} Memory check passed (${TOTAL_MEMORY_GB} GB >= ${MIN_RAM_GB} GB)"
    MEMORY_OK=1
else
    echo "${RED}✗${NC} Memory check failed (${TOTAL_MEMORY_GB} GB < ${MIN_RAM_GB} GB)"
fi

# Check CPU requirement
CPU_OK=0
if [ "$CPU_COUNT" -ge "$MIN_CPUS" ]; then
    echo "${GREEN}✓${NC} CPU check passed (${CPU_COUNT} cores >= ${MIN_CPUS} cores)"
    CPU_OK=1
else
    echo "${RED}✗${NC} CPU check failed (${CPU_COUNT} cores < ${MIN_CPUS} cores)"
fi

echo ""

# Exit with appropriate status
if [ "$MEMORY_OK" -eq 1 ] && [ "$CPU_OK" -eq 1 ]; then
    echo "${GREEN}System requirements check PASSED${NC}"
    echo ""
    exit 0
else
    echo "${RED}System requirements check FAILED${NC}"
    echo ""
    echo "This Docker environment does not meet the minimum requirements for Page Stream."
    echo ""
    echo "Minimum requirements:"
    echo "  - ${MIN_RAM_GB} GB RAM"
    echo "  - ${MIN_CPUS} CPU cores"
    echo ""
    echo "If using Colima, you can allocate more resources with:"
    echo "  ${YELLOW}colima stop${NC}"
    echo "  ${YELLOW}colima start --cpu ${MIN_CPUS} --memory ${MIN_RAM_GB}${NC}"
    echo ""
    echo "If using Docker Desktop, increase resources in:"
    echo "  Settings > Resources > Advanced"
    echo ""
    echo "To disable this check, set: ${YELLOW}SKIP_REQUIREMENTS_CHECK=true${NC} in your .env file"
    echo "or remove the 'depends_on: requirements-check' from services in docker-compose.stable.yml"
    echo ""
    exit 1
fi
