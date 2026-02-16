# DBus Outage Fix - 2026-02-16

## Problem Summary

Multiple containers were failing to start with continuous restarts and timeout errors. Analysis of logs revealed:

### Symptoms
- Containers timing out after 180 seconds during browser launch
- Continuous `TimeoutError` from Playwright
- Containers reporting unhealthy status
- Most containers in restart loops with exit code 1
- Only `standard-3` remained healthy

### Root Cause

**DBus Connection Failures**: Chromium was attempting to connect to DBus for system integration services (battery status, accessibility APIs, etc.) but DBus was not available in the containers.

Error patterns observed:
```
ERROR:dbus/bus.cc:408] Failed to connect to the bus: Failed to connect to socket /run/dbus/system_bus_socket: No such file or directory
ERROR:dbus/bus.cc:408] Failed to connect to the bus: Could not parse server address: Unknown address type
ERROR:components/viz/service/main/viz_main_impl.cc:189] Exiting GPU process due to errors during initialization
```

**GPU Initialization Failures**: Chromium's GPU process was failing to initialize, compounding the DBus issues and causing complete browser launch timeouts.

## Solution

### 1. Disable DBus Lookups (Dockerfile)

Added environment variable to prevent Chromium from attempting DBus connections:

```dockerfile
ENV DBUS_SESSION_BUS_ADDRESS=/dev/null
```

**File**: `Dockerfile` (line 32-35)

### 2. Disable GPU Hardware Acceleration (src/index.ts)

Added Chromium flags to disable GPU features that were failing in the containerized environment:

```typescript
'--disable-gpu',
'--disable-software-rasterizer',
'--disable-gpu-compositing',
```

**File**: `src/index.ts` (launchBrowser method, lines 91-93)

**Rationale**:
- `--disable-gpu`: Prevents GPU hardware acceleration attempts
- `--disable-software-rasterizer`: Disables software rasterizer (unnecessary since we use x11grab)
- `--disable-gpu-compositing`: Disables GPU compositing layer

## Testing Results

Tested with isolated container:
```bash
docker build -t page-stream:dbus-fix .
docker run --rm -d --name dbus-test -e WIDTH=1280 -e HEIGHT=720 \
  page-stream:dbus-fix --ingest file:///app/test.ts --format mpegts --url https://example.com
```

**Results**:
- ✅ Container starts successfully
- ✅ No DBus connection errors
- ✅ No GPU initialization errors
- ✅ No browser launch timeouts
- ✅ Xvfb starts within 2 attempts
- ✅ Browser launches and begins streaming

## Deployment

To apply this fix to the production stack:

```bash
# Rebuild with latest tag
docker build -t page-stream:latest .

# Restart stack with full recreation (per OPERATIONAL-NOTES.md)
docker-compose -f docker-compose.stable.yml down
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d
```

## Prevention

**Why didn't this affect standard-3?**
Standard-3 likely started earlier before system resource contention occurred, allowing it to complete browser initialization before the DBus timeout threshold.

**Why did the issue suddenly appear?**
Possible triggers:
- Base image update changed DBus behavior
- System resource constraints caused slower browser initialization
- Network latency increased Chromium startup time past timeout threshold

**Monitoring for recurrence:**
```bash
# Check for DBus errors in logs
docker logs <container-id> 2>&1 | grep -i dbus

# Check for GPU errors
docker logs <container-id> 2>&1 | grep -i "gpu process"

# Check container health
docker ps
```

## Files Modified

1. `Dockerfile` - Added `DBUS_SESSION_BUS_ADDRESS=/dev/null`
2. `src/index.ts` - Added GPU-disabling Chromium flags

## References

- [Chromium Headless Mode Documentation](https://www.chromium.org/developers/how-tos/run-chromium-with-flags/)
- [OPERATIONAL-NOTES.md](OPERATIONAL-NOTES.md) - Restart procedures
- Issue branch: `dbus-outage`
