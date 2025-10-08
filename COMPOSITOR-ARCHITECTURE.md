# Stable Compositor Test Harness Architecture

## Overview
This document describes a stable, isolated test harness for page-stream compositor testing on macOS with Docker via Colima. The design prioritizes container independence and network stability.

## Requirements Summary
1. **1 SRT Ingest Listener** — receives final composite stream (can write to /dev/null or file)
2. **3 Standard Streaming Instances** — full HD (1920×1080) independent test pages streaming to external targets
3. **2 Half-Width Streaming Instances** — 960×1080 test pages streaming to compositor
4. **1 Compositor** — consumes 2 half-width streams, produces 1 full HD composite → SRT ingest

### Stability Requirements
- Each container must start/stop independently without affecting others
- Network disruption observed in prior attempts must be eliminated
- Compositor and sources can be restarted at will without impacting standard streaming instances

## Architectural Approach

### Option A: FFmpeg Compositor (Recommended for Stability)
Use a dedicated FFmpeg container to composite two incoming SRT streams and re-publish the result.

**Pros:**
- No browser overhead in compositor
- Well-tested FFmpeg filter_complex for side-by-side layouts
- Minimal resource usage
- Network isolation via dedicated bridge network for compositor traffic

**Cons:**
- Requires two source containers to publish SRT streams
- Slight latency from double-encoding (source → compositor → ingest)

### Option B: Dual Browser Desktop (Fallback)
Run two Playwright/Chromium instances side-by-side in a single Xvfb desktop at 1920×1080, each browser window sized to 960×1080.

**Pros:**
- Single container for composite output
- No intermediate SRT streams needed
- Lower latency (one encode step)

**Cons:**
- More complex window management (requires X11 window positioning)
- Higher CPU usage (two browser instances + ffmpeg in one container)
- Harder to debug/monitor individual sources

**Recommendation:** Start with Option A for maximum stability and isolation.

## Network Architecture (Option A)

### Networks
1. **default** — for standard streaming instances (no compositor traffic)
2. **compositor_net** — isolated bridge network for:
   - 2 half-width sources → compositor communication
   - compositor → SRT ingest communication

### Container Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Default Network (Isolated from Compositor)                  │
├─────────────────────────────────────────────────────────────┤
│  standard-1    standard-2    standard-3                     │
│  (1920×1080)   (1920×1080)   (1920×1080)                    │
│  → external    → external    → external                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Compositor Network (Isolated)                               │
├─────────────────────────────────────────────────────────────┤
│  source-left           source-right                         │
│  (960×1080)            (960×1080)                           │
│  → srt://compositor:10001  → srt://compositor:10002         │
│                                                             │
│  compositor (FFmpeg filter_complex)                         │
│  listens: 10001, 10002                                      │
│  → srt://srt-ingest:9000                                    │
│                                                             │
│  srt-ingest (FFmpeg listener)                               │
│  listens: 9000                                              │
│  → /out/composite.ts (or /dev/null)                         │
└─────────────────────────────────────────────────────────────┘
```

### Port Mapping Strategy
- **No host port exposure for compositor sources** — keeps SRT traffic internal
- **Optional:** Expose srt-ingest:9000 on host if you want external clients to test
- **Standard instances** can expose their own ports or stream externally as needed

## Docker Compose Design (Option A)

### Key Stability Features
1. **Separate networks** — `default` vs `compositor_net` ensures no cross-contamination
2. **No depends_on for standard instances** — they start independently
3. **Health checks** — compositor waits for FFmpeg readiness before sources connect
4. **Restart policies** — `restart: unless-stopped` for standard instances, `restart: on-failure` for compositor components (allows manual stop/start)
5. **Resource limits** (optional) — prevent runaway containers from starving others

### Service Definitions

#### 1. SRT Ingest Listener
```yaml
srt-ingest:
  image: jrottenberg/ffmpeg:4.4-ubuntu
  container_name: srt-ingest
  volumes:
    - ./out:/out
  networks:
    - compositor_net
  command: >
    ffmpeg -hide_banner -loglevel info
    -i "srt://0.0.0.0:9000?mode=listener"
    -c copy -f mpegts /out/composite.ts
  healthcheck:
    test: ["CMD-SHELL", "pgrep ffmpeg || exit 1"]
    interval: 5s
    timeout: 3s
    retries: 5
  restart: unless-stopped
```

#### 2. Compositor (FFmpeg filter_complex)
```yaml
compositor:
  image: jrottenberg/ffmpeg:4.4-ubuntu
  container_name: compositor
  networks:
    - compositor_net
  depends_on:
    srt-ingest:
      condition: service_healthy
  command: >
    ffmpeg -hide_banner -loglevel info
    -i "srt://0.0.0.0:10001?mode=listener"
    -i "srt://0.0.0.0:10002?mode=listener"
    -filter_complex "[0:v]scale=960:1080[left];[1:v]scale=960:1080[right];[left][right]hstack=inputs=2[outv]"
    -map "[outv]" -map 0:a?
    -c:v libx264 -preset ultrafast -tune zerolatency -b:v 3000k -maxrate 3500k -bufsize 6000k -g 30 -keyint_min 30 -sc_threshold 0
    -c:a aac -b:a 128k -ar 44100
    -f mpegts "srt://srt-ingest:9000?streamid=composite"
  healthcheck:
    test: ["CMD-SHELL", "pgrep ffmpeg || exit 1"]
    interval: 5s
    timeout: 3s
    retries: 10
    start_period: 10s
  restart: on-failure
```

#### 3. Half-Width Sources (2 instances)
```yaml
source-left:
  build: .
  image: page-stream:latest
  container_name: source-left
  environment:
    - WIDTH=960
    - HEIGHT=1080
  networks:
    - compositor_net
  depends_on:
    compositor:
      condition: service_healthy
  command: >
    --ingest srt://compositor:10001?streamid=left
    --url "file:///app/demo/index.html"
    --auto-refresh-seconds 1800
  restart: on-failure

source-right:
  build: .
  image: page-stream:latest
  container_name: source-right
  environment:
    - WIDTH=960
    - HEIGHT=1080
  networks:
    - compositor_net
  depends_on:
    compositor:
      condition: service_healthy
  command: >
    --ingest srt://compositor:10002?streamid=right
    --url "https://example.com"
    --auto-refresh-seconds 1800
  restart: on-failure
```

#### 4. Standard Streaming Instances (3 instances)
```yaml
standard-1:
  build: .
  image: page-stream:latest
  container_name: standard-1
  environment:
    - WIDTH=1920
    - HEIGHT=1080
  command: >
    --ingest ${STANDARD_1_INGEST}
    --url "https://example.com/feed1"
    --auto-refresh-seconds 1800
  restart: unless-stopped
  # No networks declaration = joins default network only

standard-2:
  build: .
  image: page-stream:latest
  container_name: standard-2
  environment:
    - WIDTH=1920
    - HEIGHT=1080
  command: >
    --ingest ${STANDARD_2_INGEST}
    --url "https://example.com/feed2"
    --auto-refresh-seconds 1800
  restart: unless-stopped

standard-3:
  build: .
  image: page-stream:latest
  container_name: standard-3
  environment:
    - WIDTH=1920
    - HEIGHT=1080
  command: >
    --ingest ${STANDARD_3_INGEST}
    --url "https://example.com/feed3"
    --auto-refresh-seconds 1800
  restart: unless-stopped
```

### Networks Declaration
```yaml
networks:
  compositor_net:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: br-compositor
```

## Testing the Harness

### Phase 1: Bring up standard instances
```bash
docker-compose up -d standard-1 standard-2 standard-3
docker-compose logs -f standard-1 standard-2 standard-3
```
Verify all three are streaming successfully without compositor running.

### Phase 2: Bring up compositor stack
```bash
docker-compose up -d srt-ingest compositor source-left source-right
docker-compose logs -f compositor
```
Verify composite stream is being received by srt-ingest.

### Phase 3: Stop/restart compositor stack
```bash
docker-compose stop compositor source-left source-right
# Verify standard instances are still running and streaming
docker-compose ps

docker-compose start compositor source-left source-right
# Verify compositor stack recovers
```

### Phase 4: Stop/restart individual sources
```bash
docker-compose restart source-left
# Verify compositor continues with one stream
docker-compose restart source-right
# Verify full composite resumes
```

## Troubleshooting Network Flakiness

If containers still experience network disruption:

1. **Enable explicit DNS** in compose:
   ```yaml
   services:
     compositor:
       dns:
         - 8.8.8.8
         - 1.1.1.1
   ```

2. **Increase container entropy** (macOS Colima-specific):
   ```bash
   colima ssh
   sudo sysctl -w net.core.rmem_max=134217728
   sudo sysctl -w net.core.wmem_max=134217728
   ```

3. **Use host network for standard instances** (bypasses bridge):
   ```yaml
   standard-1:
     network_mode: host
   ```
   Note: This removes container isolation but may improve stability.

4. **Add explicit /etc/hosts entries** to avoid DNS lookup delays:
   ```yaml
   extra_hosts:
     - "compositor:172.20.0.10"
     - "srt-ingest:172.20.0.11"
   ```

5. **Monitor with docker stats**:
   ```bash
   docker stats --no-stream
   ```
   Look for CPU/memory pressure that might cause network stack issues.

## Option B: Dual Browser Desktop (Fallback Implementation Notes)

If Option A still has network issues, implement a single container with:
- Xvfb at 1920×1080
- Two Playwright Chromium instances launched with `--window-position=0,0 --window-size=960,1080` and `--window-position=960,0 --window-size=960,1080`
- Single ffmpeg x11grab capturing the full desktop → SRT

This eliminates inter-container networking entirely but requires careful window manager setup (may need `openbox` or `fluxbox` for reliable positioning).

## Next Steps
1. Implement `docker-compose.stable.yml` with Option A architecture
2. Create simple test HTML pages for `demo/test-left.html` and `demo/test-right.html`
3. Add `.env.example` with placeholder ingest URIs for standard instances
4. Run stability tests per Phase 1-4 above
5. Document results and tune restart policies/health checks as needed
