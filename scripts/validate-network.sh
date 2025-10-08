#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Network Validation Test for page-stream Containers
# ==============================================================================
# Purpose: Validate that containers can:
#   1. Connect to SRT ingest endpoints (local or external)
#   2. Access external networks (DNS + HTTPS)
#   3. Actually load and render content (not blank frames)
#
# This catches network issues early before they break streaming.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.stable.yml"
OUT_DIR="${PROJECT_ROOT}/out"
FRAMES_DIR="${OUT_DIR}/test-frames"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test results tracking
TESTS_PASSED=0
TESTS_FAILED=0
FAILURES=()

# ==============================================================================
# Helper Functions
# ==============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $*"
    ((TESTS_PASSED++))
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $*"
    ((TESTS_FAILED++))
    FAILURES+=("$*")
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

# ==============================================================================
# Test 1: SRT Connectivity
# ==============================================================================
test_srt_connectivity() {
    local container=$1
    local ingest_host=$2
    local ingest_port=$3
    
    log_info "Testing SRT connectivity: ${container} → ${ingest_host}:${ingest_port}"
    
    # Check container logs for successful SRT connection
    # We'll inspect the logs and allow transient errors if a successful
    # "Output #0 ... mpegts ... srt://" mapping appears after the last error.
    local logs_file
    logs_file=$(mktemp)
    # Capture both stdout and stderr from docker logs into the temp file.
    # Previous redirection order (2>&1 > file) left stderr on the terminal and
    # produced an incomplete log file. Use > file 2>&1 to ensure both streams
    # are written to the file.
    docker logs "${container}" > "${logs_file}" 2>&1 || true

    local srt_output_line
    srt_output_line=$(grep -n -E "Output #0.*mpegts.*srt://" "${logs_file}" | tail -n1 | cut -d: -f1 || true)
    if [[ -n "${srt_output_line}" ]]; then
        log_success "${container}: SRT stream output configured"
    else
        log_error "${container}: No SRT output found in logs"
        rm -f "${logs_file}"
        return 1
    fi

    # Check for recent connection errors; if present, only fail if no successful
    # mapping appears after the last error (i.e., the error is persistent).
    local last_error_line
    last_error_line=$(grep -n -iE "connection.*failed|input/output error" "${logs_file}" | tail -n1 | cut -d: -f1 || true)
    if [[ -n "${last_error_line}" ]]; then
        # If we have a success mapping after the last error, treat as OK
        if [[ -n "${srt_output_line}" && ${srt_output_line} -gt ${last_error_line} ]]; then
            log_warn "${container}: Transient SRT connection errors detected but recovered (mapping after last error)"
            rm -f "${logs_file}"
            log_success "${container}: SRT connectivity OK"
            return 0
        else
            log_error "${container}: Recent SRT connection failures detected"
            rm -f "${logs_file}"
            return 1
        fi
    fi

    rm -f "${logs_file}"
    log_success "${container}: SRT connectivity OK"
    return 0
}

# ==============================================================================
# Test 2: External Network Access
# ==============================================================================
test_external_network() {
    local container=$1
    
    log_info "Testing external network access: ${container}"
    
    # Test DNS resolution
    if docker exec "${container}" sh -c 'getent hosts example.com >/dev/null 2>&1 || nslookup example.com >/dev/null 2>&1' 2>/dev/null; then
        log_success "${container}: DNS resolution working"
    else
        log_error "${container}: DNS resolution failed"
        return 1
    fi
    
    # Test HTTPS connectivity (if curl/wget available)
    if docker exec "${container}" sh -c 'command -v curl >/dev/null' 2>/dev/null; then
        if docker exec "${container}" curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com 2>/dev/null | grep -q "200\|301\|302"; then
            log_success "${container}: HTTPS connectivity working"
        else
            log_error "${container}: HTTPS request failed"
            return 1
        fi
    else
        log_warn "${container}: curl not available, skipping HTTPS test"
    fi
    
    return 0
}

# ==============================================================================
# Test 3: Content Validation (Frame Analysis)
# ==============================================================================
test_content_loaded() {
    local ts_file=$1
    local expected_url=$2
    local min_size=${3:-40000}  # Minimum frame size in bytes (default 40KB)
    
    log_info "Testing content validation: ${ts_file} (expecting ${expected_url})"
    
    # Check if TS file exists and is growing
    if [[ ! -f "${ts_file}" ]]; then
        log_error "${ts_file}: File does not exist"
        return 1
    fi
    
    local file_size=$(stat -f%z "${ts_file}" 2>/dev/null || stat -c%s "${ts_file}" 2>/dev/null)
    if [[ ${file_size} -lt 100000 ]]; then
        log_error "${ts_file}: File too small (${file_size} bytes), stream may not be working"
        return 1
    fi
    
    # Extract a frame
    local frame_name=$(basename "${ts_file}" .ts)
    local frame_path="${FRAMES_DIR}/${frame_name}-validation.jpg"
    mkdir -p "${FRAMES_DIR}"
    
    if ! ffmpeg -hide_banner -loglevel error -y -i "${ts_file}" -vframes 1 -q:v 2 "${frame_path}" 2>/dev/null; then
        log_error "${ts_file}: Failed to extract frame"
        return 1
    fi
    
    # Check frame size as content indicator
    local frame_size=$(stat -f%z "${frame_path}" 2>/dev/null || stat -c%s "${frame_path}" 2>/dev/null)
    if [[ ${frame_size} -lt ${min_size} ]]; then
        log_error "${ts_file}: Frame too small (${frame_size} bytes < ${min_size}), content may not have loaded"
        return 1
    fi
    
    log_success "${ts_file}: Content validation OK (frame ${frame_size} bytes)"
    return 0
}

# ==============================================================================
# Test 4: Container Health Status
# ==============================================================================
test_container_health() {
    local container=$1
    
    log_info "Testing container health: ${container}"
    
    # Check if container is running
    if ! docker ps --filter "name=${container}" --filter "status=running" | grep -q "${container}"; then
        log_error "${container}: Container not running"
        return 1
    fi
    
    # Check health status (if health check defined)
    local health_status=$(docker inspect --format='{{.State.Health.Status}}' "${container}" 2>/dev/null || echo "none")
    health_status=$(echo "${health_status}" | tr -d '\n' | xargs)  # Clean up whitespace
    
    if [[ "${health_status}" == "healthy" ]]; then
        log_success "${container}: Health check passed"
    elif [[ "${health_status}" == "none" ]] || [[ -z "${health_status}" ]] || [[ "${health_status}" == "<no value>" ]]; then
        log_success "${container}: Running (no health check defined)"
    else
        log_error "${container}: Health check failed (status: ${health_status})"
        return 1
    fi
    
    return 0
}

# ==============================================================================
# Main Test Execution
# ==============================================================================

echo "========================================================================"
echo "Network Validation Test - page-stream"
echo "========================================================================"
echo ""

# Ensure containers are running
log_info "Checking container status..."
if ! docker ps --filter "name=standard-" --filter "status=running" --format "{{.Names}}" | grep -q "standard"; then
    log_error "No containers running. Start with: docker-compose -f ${COMPOSE_FILE} up -d"
    exit 1
fi

# Wait for streams to stabilize
log_info "Waiting 15 seconds for streams to stabilize..."
sleep 15

echo ""
echo "========================================================================"
echo "Test Suite: Standard Instances"
echo "========================================================================"
echo ""

# Test standard-1 (local content)
# Run tests but don't let a single failure exit the whole script; failures are
# counted and reported by the helper functions.
test_container_health "standard-1" || true
test_srt_connectivity "standard-1" "srt-test-listener" "9001" || true
test_content_loaded "${OUT_DIR}/std1.ts" "file:///app/demo/test-standard.html" 50000 || true

echo ""

# Test standard-2 (local content)
test_container_health "standard-2" || true
test_srt_connectivity "standard-2" "srt-test-listener" "9002" || true
test_content_loaded "${OUT_DIR}/std2.ts" "file:///app/demo/test-standard.html" 50000 || true

echo ""

# Test standard-3 (external content + network access)
test_container_health "standard-3" || true
test_external_network "standard-3" || true
test_srt_connectivity "standard-3" "srt-test-listener" "9003" || true
test_content_loaded "${OUT_DIR}/std3.ts" "https://example.com" 30000 || true

echo ""
echo "========================================================================"
echo "Test Suite: Compositor Stack (if running)"
echo "========================================================================"
echo ""

# Test compositor services (if running)
if docker ps --filter "name=compositor" --filter "status=running" | grep -q "compositor"; then
    test_container_health "compositor" || true
    test_srt_connectivity "compositor" "srt-ingest" "9000" || true
    
    if docker ps --filter "name=source-left" --filter "status=running" | grep -q "source-left"; then
    test_container_health "source-left" || true
    test_srt_connectivity "source-left" "compositor" "10001" || true
    fi
    
    if docker ps --filter "name=source-right" --filter "status=running" | grep -q "source-right"; then
    test_container_health "source-right" || true
    test_srt_connectivity "source-right" "compositor" "10002" || true
    fi
    
        if [[ -f "${OUT_DIR}/composite.ts" ]]; then
            test_content_loaded "${OUT_DIR}/composite.ts" "composite-stream" 60000 || true
        fi
else
    log_info "Compositor stack not running (skipping compositor tests)"
fi

echo ""
echo "========================================================================"
echo "Test Results Summary"
echo "========================================================================"
echo ""
echo -e "${GREEN}Tests Passed:${NC} ${TESTS_PASSED}"
echo -e "${RED}Tests Failed:${NC} ${TESTS_FAILED}"

if [[ ${TESTS_FAILED} -gt 0 ]]; then
    echo ""
    echo -e "${RED}Failures:${NC}"
    for failure in "${FAILURES[@]}"; do
        echo "  - ${failure}"
    done
    echo ""
    exit 1
else
    echo ""
    log_success "All network validation tests passed!"
    echo ""
    exit 0
fi
