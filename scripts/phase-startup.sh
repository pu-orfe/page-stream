#!/usr/bin/env bash
set -uo pipefail

# ==============================================================================
# Phased Startup Script for Compositor Testing
# ==============================================================================
# Purpose: Bring up services incrementally to identify resource issues
# Usage: ./scripts/phase-startup.sh [phase]
#   phase 1: SRT test listener only
#   phase 2: Add 1 standard instance (std1)
#   phase 3: Add compositor stack (ingest, compositor, sources)
#   phase 4: Add all standard instances
#   cleanup: Stop everything
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.stable.yml"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

check_cpu() {
    local qemu_cpu=$(ps aux | grep qemu-system-aarch64 | grep -v grep | awk '{print $3}' | head -1)
    if [[ -n "${qemu_cpu}" ]]; then
        echo "${qemu_cpu}%"
    else
        echo "N/A"
    fi
}

wait_healthy() {
    local service=$1
    local max_wait=${2:-60}
    local waited=0
    
    log_info "Waiting for ${service} to be healthy (max ${max_wait}s)..."
    
    while [[ ${waited} -lt ${max_wait} ]]; do
        if docker-compose -f "${COMPOSE_FILE}" ps "${service}" 2>/dev/null | grep -q "healthy\|Up"; then
            log_success "${service} is ready"
            return 0
        fi
        sleep 2
        ((waited+=2))
        if (( waited % 10 == 0 )); then
            log_info "  Still waiting... (${waited}s elapsed, QEMU CPU: $(check_cpu))"
        fi
    done
    
    log_error "${service} did not become healthy in ${max_wait}s"
    return 1
}

show_status() {
    echo ""
    log_info "Current container status:"
    docker-compose -f "${COMPOSE_FILE}" ps
    echo ""
    log_info "QEMU CPU usage: $(check_cpu)"
    echo ""
}

# ==============================================================================
# Phase Functions
# ==============================================================================

phase_cleanup() {
    log_info "Cleaning up all containers..."
    docker-compose -f "${COMPOSE_FILE}" down
    log_success "Cleanup complete"
}

phase_1() {
    log_info "=== PHASE 1: SRT Test Listener Only ==="
    docker-compose -f "${COMPOSE_FILE}" up -d srt-test-listener
    wait_healthy srt-test-listener 30
    show_status
    log_success "Phase 1 complete - SRT listener running"
}

phase_2() {
    log_info "=== PHASE 2: Add First Standard Instance (std1) ==="
    docker-compose -f "${COMPOSE_FILE}" up -d standard-1
    sleep 15
    show_status
    
    # Check if std1.ts is growing
    if [[ -f "${PROJECT_ROOT}/out/std1.ts" ]]; then
        local size=$(stat -f%z "${PROJECT_ROOT}/out/std1.ts" 2>/dev/null || stat -c%s "${PROJECT_ROOT}/out/std1.ts" 2>/dev/null)
        log_info "std1.ts size: ${size} bytes"
    else
        log_warn "std1.ts not created yet"
    fi
    
    log_success "Phase 2 complete - Standard-1 running"
}

phase_3() {
    log_info "=== PHASE 3: Add Compositor Stack ==="
    log_warn "This will start: srt-ingest, compositor, source-left, source-right"
    log_warn "Press Ctrl+C within 5s to abort..."
    sleep 5
    
    docker-compose -f "${COMPOSE_FILE}" up -d srt-ingest compositor source-left source-right
    
    wait_healthy srt-ingest 30
    wait_healthy compositor 60
    
    sleep 15
    show_status
    
    # Check if composite.ts is growing
    if [[ -f "${PROJECT_ROOT}/out/composite.ts" ]]; then
        local size=$(stat -f%z "${PROJECT_ROOT}/out/composite.ts" 2>/dev/null || stat -c%s "${PROJECT_ROOT}/out/composite.ts" 2>/dev/null)
        log_info "composite.ts size: ${size} bytes"
    else
        log_warn "composite.ts not created yet"
    fi
    
    log_success "Phase 3 complete - Compositor stack running"
}

phase_4() {
    log_info "=== PHASE 4: Add All Standard Instances ==="
    docker-compose -f "${COMPOSE_FILE}" up -d standard-2 standard-3
    
    sleep 20
    show_status
    
    log_success "Phase 4 complete - Full stack running"
}

# ==============================================================================
# Main
# ==============================================================================

PHASE=${1:-help}

case "${PHASE}" in
    1)
        phase_1
        ;;
    2)
        phase_1
        phase_2
        ;;
    3)
        phase_1
        phase_2
        phase_3
        ;;
    4)
        phase_1
        phase_2
        phase_3
        phase_4
        ;;
    cleanup|clean|down)
        phase_cleanup
        ;;
    *)
        echo "Usage: $0 [1|2|3|4|cleanup]"
        echo ""
        echo "Phases:"
        echo "  1 - Start SRT test listener only"
        echo "  2 - Add first standard instance (phase 1 + std1)"
        echo "  3 - Add compositor stack (phase 2 + compositor)"
        echo "  4 - Add all standard instances (phase 3 + std2/std3)"
        echo "  cleanup - Stop all containers"
        echo ""
        echo "Current status:"
        docker-compose -f "${COMPOSE_FILE}" ps 2>/dev/null || echo "  (no containers running)"
        echo ""
        echo "QEMU CPU: $(check_cpu)"
        exit 1
        ;;
esac
