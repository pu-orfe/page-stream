# Stable Compositor Test Harness - Quick Start

This guide walks through testing the stable compositor harness with network isolation.

## Prerequisites

1. Build the page-stream image:
   ```bash
   docker build -t page-stream:latest .
   ```

2. Create output directory:
   ```bash
   mkdir -p out
   ```

3. (Optional) Copy environment file:
   ```bash
   cp .env.stable.example .env
   ```

4. **For production testing with Kaltura endpoints**: If your ingest URLs contain `#` characters, set up `.env.secrets.sh` and source it before all `docker-compose` commands. See [`SECRETS.md`](SECRETS.md) for setup. For local testing, this step is not required.

## Testing Phases

### Phase 1: Verify Standard Instances (Isolated from Compositor)

These instances should run completely independently and continue working even if the compositor stack is stopped.

```bash
# Start only the standard streaming instances
docker-compose -f docker-compose.stable.yml up -d standard-1 standard-2 standard-3

# Watch logs to verify they're streaming
docker-compose -f docker-compose.stable.yml logs -f standard-1

# Check all containers are running
docker-compose -f docker-compose.stable.yml ps
```

**Expected:** All three standard instances should be running and attempting to connect to their ingest targets. If the targets are unreachable, you'll see connection retry logs (this is normal for testing).

### Phase 2: Bring Up Compositor Stack

```bash
# Start the compositor pipeline: ingest → compositor → sources
docker-compose -f docker-compose.stable.yml up -d srt-ingest compositor source-left source-right

# Watch compositor logs
docker-compose -f docker-compose.stable.yml logs -f compositor

# Watch source logs
docker-compose -f docker-compose.stable.yml logs -f source-left source-right
```

**Expected:**
- `srt-ingest` starts listening on port 9000
- `compositor` starts listening on ports 10001 and 10002
- `source-left` and `source-right` connect to compositor and begin streaming
- Compositor produces a side-by-side composite and pushes to `srt-ingest`
- Check `./out/composite.ts` grows in size

### Phase 3: Verify Network Isolation

**Critical Test:** Verify standard instances are unaffected by compositor operations.

```bash
# With compositor running, check standard instances are still healthy
docker-compose -f docker-compose.stable.yml ps standard-1 standard-2 standard-3

# Stop the entire compositor stack
docker-compose -f docker-compose.stable.yml stop compositor source-left source-right srt-ingest

# Verify standard instances are STILL running
docker-compose -f docker-compose.stable.yml ps standard-1 standard-2 standard-3

# Check logs for standard-1 (should show no interruption)
docker-compose -f docker-compose.stable.yml logs --tail=50 standard-1
```

**Expected:** Standard instances should show no network errors or restarts when compositor stack is stopped.

### Phase 4: Test Compositor Restart Stability

```bash
# Restart the compositor stack
docker-compose -f docker-compose.stable.yml start srt-ingest compositor source-left source-right

# Verify services recover
docker-compose -f docker-compose.stable.yml logs -f compositor

# Restart individual sources while compositor runs
docker-compose -f docker-compose.stable.yml restart source-left
sleep 5
docker-compose -f docker-compose.stable.yml restart source-right

# Verify compositor continues processing
docker-compose -f docker-compose.stable.yml logs --tail=20 compositor
```

**Expected:**
- Compositor stack restarts cleanly
- Sources reconnect after individual restarts
- Standard instances remain unaffected

### Phase 5: Stress Test (Optional)

```bash
# Repeatedly stop/start compositor stack while monitoring standard instances
for i in {1..5}; do
  echo "=== Cycle $i ==="
  docker-compose -f docker-compose.stable.yml stop compositor source-left source-right
  sleep 3
  docker-compose -f docker-compose.stable.yml start compositor source-left source-right
  sleep 10
  docker-compose -f docker-compose.stable.yml ps
done

# Check if standard instances ever restarted
docker-compose -f docker-compose.stable.yml ps standard-1 standard-2 standard-3
```

**Expected:** Standard instances should never restart or show network errors during compositor cycling.

## Viewing the Output

The composite stream is written to `./out/composite.ts`. You can:

1. **Play locally with ffplay:**
   ```bash
   ffplay -fflags nobuffer -flags low_delay ./out/composite.ts
   ```

2. **Monitor file growth:**
   ```bash
   watch -n 1 'ls -lh ./out/composite.ts'
   ```

3. **Stream to external player via HTTP:**
   ```bash
   # In another terminal
   cd out
   python3 -m http.server 8080
   # Then open http://localhost:8080/composite.ts in VLC or similar
   ```

## Troubleshooting

### Compositor shows "Connection refused"
- Verify `srt-ingest` is healthy: `docker-compose -f docker-compose.stable.yml ps srt-ingest`
- Check health: `docker inspect srt-ingest | grep -A5 Health`

### Sources can't connect to compositor
- Verify compositor is listening: `docker-compose -f docker-compose.stable.yml logs compositor | grep listening`
- Check network: `docker network inspect page-stream_compositor_net`

### Standard instances disrupted when compositor starts
- **This indicates the original network isolation issue persists.**
- Try adding explicit DNS to compositor services:
  ```yaml
  compositor:
    dns:
      - 8.8.8.8
      - 1.1.1.1
  ```
- Consider using `network_mode: host` for standard instances as a last resort

### Containers show high CPU usage
- Reduce FFmpeg encoding quality in compositor:
  - Change `-preset ultrafast` to `-preset veryfast`
  - Lower bitrate: `-b:v 2000k -maxrate 2500k`

### macOS: permission error mounting `./out` (com.apple.macl)

On some macOS hosts the `out` directory can have a mandatory access control label (`com.apple.macl`) which prevents Docker (or Colima) from performing a `chown` on the bind mount. Symptoms:

- docker-compose fails with "permission denied" while creating mount source path '/.../out': chown ...: permission denied

Quick fix (run on the macOS host):

```bash
# remove the MACL label from the project out folder
sudo xattr -d com.apple.macl ./out

# re-run the compose stack
docker-compose -f docker-compose.stable.yml up -d
```

If you prefer not to run `sudo`, you can alternatively remove the directory and recreate it as your user:

```bash
rm -rf ./out && mkdir -p ./out
docker-compose -f docker-compose.stable.yml up -d
```

Note: this is a host-level ACL issue and not a bug in the compositor image.

### Colima / Docker resource allocation (CPU / memory)

When running the stable compositor locally under Colima (or other VM-backed Docker on macOS), ensure the VM has enough CPUs and memory allocated. On my test run the Docker host reported:

- CPUs: 6
- Memory: ~16.7 GiB

I exercised the stack and inspected compositor logs and metrics. Key findings:

- FFmpeg inputs reported 30 fps and the composed output was configured for 30 fps. Logs did not show frame drops, underruns, or "buffer"/"overrun" warnings in the compositor run we sampled. The only notable log line was the ffmpeg suggestion: `-vsync is deprecated. Use -fps_mode` which is informational.
- Container CPU usage for `compositor` was low (single-digit percent) in the sampled run; memory usage was modest. This indicates the current Colima allocation (6 CPU / 16GB) is adequate for the small stable-compositor test harness with the default configs and two 960x1080 input streams.

Recommendations:

- For local development and CI-style tests with a couple of sources: allocate at least **4 CPU and 8 GB RAM** to Colima/Docker.
- For heavier local testing (multiple HD sources, higher bitrates, or additional processing): allocate **6+ CPU and 16+ GB RAM**.
- For production-like workloads (many sources or high-resolution processing), use a dedicated host with 8+ CPUs and 32+ GB RAM and tune ffmpeg encoding presets/bitrate accordingly.

How to change Colima allocation:

```bash
# stop Colima, then start with explicit resources (example: 6 CPU, 16GB RAM)
colima stop
colima start --cpu 6 --memory 16

# verify status
colima status
```

Alternatively, if you're using Docker Desktop, update Resources -> CPU / Memory in the Docker Desktop preferences.

When changing allocation, re-run the composer stack and observe `docker stats --no-stream` and the compositor logs for dropped frames or high CPU usage.

## Clean Up

```bash
# Stop all services
docker-compose -f docker-compose.stable.yml down

# Remove output files
rm -rf out/*

# Remove networks
docker network prune
```

## Success Criteria

✅ Standard instances run independently of compositor
✅ Compositor can be stopped/started without affecting standard instances
✅ Sources can be restarted individually without compositor failure
✅ Composite video file grows continuously in `./out/composite.ts`
✅ No "network unreachable" or DNS errors in any container logs

If all criteria pass, the harness is stable and ready for production testing.

## Production sizing scenario

Consider the following production-like scenario when choosing host resources:

- 4 `standard` instances at full resolution (1920x1080)
- 2 `half-width` sources (960x1080) feeding a single compositor
- Each stream targets a distinct ingest endpoint (no shared IO bottleneck)

For this workload we recommend provisioning at least **8 CPUs and 32 GB RAM** on a real machine (not VM/Colima). This provides headroom for multiple encodes (x264) and avoids the VM I/O/CPU constraints that can show up in local Colima runs.

Note: In production or large-scale tests, 8+ CPUs is a minimum guideline. If you plan to run additional compositors, more simultaneous HD sources, or heavier encoding settings, increase CPU and memory proportionally (for example, 12+ CPUs and 64 GB RAM for the next scale tier).

## Enabling FFmpeg report files (FFREPORT) for soak testing

When running longer soak tests you can enable FFmpeg's report output so each ffmpeg process writes a detailed log file. This is useful for correlating compositor demux errors with source restarts.

1. Update `docker-compose.stable.yml` to mount `./out` into the page-stream source containers (this repo's compose file includes an example).
2. Set the following environment variables for each source service in the compose file:

```yaml
environment:
   INPUT_FFMPEG_FLAGS: "-thread_queue_size 2048 -probesize 20M -analyzeduration 4M -rtbufsize 400M"
   FFREPORT_DIR: /out
   ENABLE_FFREPORT: "1"
```

3. Bring up the stack and run a soak (example shown below). After the soak, ffmpeg report files will appear in `./out` with names like `ffreport-<pid>-<timestamp>.log`.

Example soak run:

```bash
docker-compose -f docker-compose.stable.yml up -d --build srt-ingest compositor source-left source-right
# wait 6-10 minutes while the stack runs
sleep 360
# Collect logs and FFREPORT files
ls -lh out
grep -H "FFREPORT" out/ffreport-*.log || true
```

Tip: The page-stream runtime also supports `INPUT_FFMPEG_FLAGS` so you can tune probe and buffer sizes without editing the ffmpeg invocation in the compose file directly.
