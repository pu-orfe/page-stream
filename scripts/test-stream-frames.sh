#!/bin/bash
# Test script to verify video streams are producing valid frames
# Usage: ./scripts/test-stream-frames.sh

set -e

OUT_DIR="./out"
FRAMES_DIR="./out/test-frames"
EXIT_CODE=0

echo "=== Stream Frame Capture Test ==="
echo

# Create frames directory
mkdir -p "$FRAMES_DIR"

# Function to test a single stream
test_stream() {
    local stream_file="$1"
    local stream_name=$(basename "$stream_file" .ts)
    local frame_output="$FRAMES_DIR/${stream_name}-frame.jpg"
    
    echo -n "Testing $stream_name... "
    
    # Check if file exists
    if [ ! -f "$stream_file" ]; then
        echo "❌ FAIL - File not found"
        return 1
    fi
    
    # Check if file has content
    local file_size=$(stat -f%z "$stream_file" 2>/dev/null || stat -c%s "$stream_file" 2>/dev/null)
    if [ "$file_size" -lt 10000 ]; then
        echo "❌ FAIL - File too small ($file_size bytes)"
        return 1
    fi
    
    # Try to capture a frame using ffmpeg
    if ffmpeg -hide_banner -loglevel error -y \
        -i "$stream_file" \
        -vframes 1 \
        -q:v 2 \
        "$frame_output" 2>&1; then
        
        # Verify the frame was created and has reasonable size
        if [ -f "$frame_output" ]; then
            local frame_size=$(stat -f%z "$frame_output" 2>/dev/null || stat -c%s "$frame_output" 2>/dev/null)
            if [ "$frame_size" -gt 1000 ]; then
                echo "✅ PASS - Frame captured ($frame_size bytes)"
                echo "   Saved to: $frame_output"
                return 0
            else
                echo "❌ FAIL - Frame too small ($frame_size bytes)"
                return 1
            fi
        else
            echo "❌ FAIL - Frame file not created"
            return 1
        fi
    else
        echo "❌ FAIL - FFmpeg frame capture failed"
        return 1
    fi
}

# Test all standard streams
echo "Standard Instance Streams:"
for stream in std1 std2 std3; do
    if ! test_stream "$OUT_DIR/${stream}.ts"; then
        EXIT_CODE=1
    fi
done

# Test composite stream if it exists
if [ -f "$OUT_DIR/composite.ts" ]; then
    echo
    echo "Compositor Stream:"
    if ! test_stream "$OUT_DIR/composite.ts"; then
        EXIT_CODE=1
    fi
fi

echo
if [ $EXIT_CODE -eq 0 ]; then
    echo "=== ✅ All stream tests PASSED ==="
    echo "Frame captures saved in: $FRAMES_DIR"
else
    echo "=== ❌ Some stream tests FAILED ==="
fi

exit $EXIT_CODE
