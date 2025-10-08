#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Visualization Checkpoint Script
# ==============================================================================
# Purpose: Capture frames from all active streams for visual validation
# Usage: ./scripts/visualization-checkpoint.sh [checkpoint-name]
#   checkpoint-name: Optional suffix for frame files (default: timestamp)
#
# Creates JPEG frames in out/test-frames/ with names like:
#   std1-checkpoint-20251006-113000.jpg
#   composite-checkpoint-20251006-113000.jpg
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${PROJECT_ROOT}/out"
FRAMES_DIR="${OUT_DIR}/test-frames"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ==============================================================================
# Helper Functions
# ==============================================================================

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

# ==============================================================================
# Main Script
# ==============================================================================

# Get checkpoint name (default to timestamp)
CHECKPOINT_NAME=${1:-$(date +%Y%m%d-%H%M%S)}
log_info "Creating visualization checkpoint: ${CHECKPOINT_NAME}"

# Ensure directories exist
mkdir -p "${FRAMES_DIR}"

# Find all .ts files in out directory
TS_FILES=$(find "${OUT_DIR}" -name "*.ts" -type f 2>/dev/null | sort)

if [[ -z "${TS_FILES}" ]]; then
    log_error "No .ts files found in ${OUT_DIR}"
    exit 1
fi

log_info "Found $(echo "${TS_FILES}" | wc -l | xargs) stream files"

# Capture frames from each .ts file
CAPTURED_COUNT=0
TOTAL_SIZE=0

while IFS= read -r ts_file; do
    if [[ ! -f "${ts_file}" ]]; then
        continue
    fi
    
    # Get base name without extension
    base_name=$(basename "${ts_file}" .ts)
    
    # Create checkpoint filename
    frame_file="${FRAMES_DIR}/${base_name}-checkpoint-${CHECKPOINT_NAME}.jpg"
    
    log_info "Capturing frame: ${ts_file} → ${frame_file}"
    
    # Capture single frame
    if ffmpeg -hide_banner -loglevel error -y -i "${ts_file}" -vframes 1 -q:v 2 "${frame_file}" 2>/dev/null; then
        # Get file size
        file_size=$(stat -f%z "${frame_file}" 2>/dev/null || stat -c%s "${frame_file}" 2>/dev/null)
        TOTAL_SIZE=$((TOTAL_SIZE + file_size))
        
        # Get image dimensions
        dimensions=$(file "${frame_file}" 2>/dev/null | grep -oE '[0-9]+x[0-9]+' || echo "unknown")
        
        log_success "  ${base_name}: ${dimensions} (${file_size} bytes)"
        ((CAPTURED_COUNT++))
    else
        log_error "  Failed to capture frame from ${ts_file}"
    fi
done <<< "${TS_FILES}"

# Summary
echo ""
log_info "Checkpoint Summary:"
echo -e "  ${GREEN}Streams captured:${NC} ${CAPTURED_COUNT}"
echo -e "  ${GREEN}Total frame size:${NC} $((TOTAL_SIZE / 1024)) KB"
echo -e "  ${GREEN}Checkpoint name:${NC} ${CHECKPOINT_NAME}"
echo -e "  ${GREEN}Frames saved to:${NC} ${FRAMES_DIR}/"

# List all captured frames
echo ""
log_info "Captured frames:"
ls -la "${FRAMES_DIR}"/*-checkpoint-${CHECKPOINT_NAME}.jpg 2>/dev/null | while read -r line; do
    echo "  $line"
done

echo ""
log_success "Visualization checkpoint '${CHECKPOINT_NAME}' complete!"
echo ""
echo "To view frames (macOS):"
echo "  open ${FRAMES_DIR}/*-checkpoint-${CHECKPOINT_NAME}.jpg"
echo ""
echo "To compare with previous checkpoints:"
echo "  ls -la ${FRAMES_DIR}/*-checkpoint-*.jpg | sort"