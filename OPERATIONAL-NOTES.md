# Operational Notes & Best Practices

## Critical: Restart Procedures

### ❌ DO NOT Use `docker-compose restart`

**Issue**: Using `docker-compose restart` on streaming containers causes **timestamp synchronization problems** that degrade the system over time.

**Symptoms**:
- FFmpeg logs show continuous "timestamp discontinuity" warnings
- Stream output files stop growing despite processes running
- Compositor performance degrades (low FPS, stuttering)
- System appears healthy (health checks pass) but streams are stalled

**Root Cause**: When containers restart without full cleanup:
1. Source containers reconnect to compositor with different timestamp offsets
2. Compositor receives out-of-sync video/audio timestamps from multiple inputs
3. FFmpeg attempts to compensate but accumulated drift eventually stalls output
4. Health checks only validate process existence, not stream quality

### ✅ ALWAYS Use Full Recreation

**Correct restart procedure**:
```bash
docker-compose -f docker-compose.stable.yml down

# With production secret stream IDs (Kaltura, etc):
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d

# Or for local testing:
docker-compose -f docker-compose.stable.yml up -d
```

**Why this works**:
- Fully tears down containers and networks
- Clears all SRT connection state
- Resets timestamp synchronization across all sources
- Compositor receives fresh, synchronized inputs

**Note**: If your ingest URLs contain `#` characters (e.g., Kaltura stream IDs), you must source `.env.secrets.sh` before docker-compose. See [`SECRETS.md`](SECRETS.md).

## Timestamp Synchronization in Multi-Source Composition

### Implemented Mitigations ✅

The compositor includes aggressive FFmpeg timestamp correction flags to eliminate synchronization drift:

```bash
# In compositor configuration
-fflags +genpts+igndts \           # Generate PTS, ignore DTS
-i "srt://...?latency=200000" \    # 200ms SRT latency buffer
-filter_complex "[0:v]fps=30,setpts=N/FRAME_RATE/TB[v0];[1:v]fps=30,setpts=N/FRAME_RATE/TB[v1];[v0][v1]hstack=inputs=2[outv]" \
-async 1 \                         # Audio sync compensation
-vsync cfr \                       # Constant frame rate mode
-r 30                              # Force output framerate
```

**Key Mitigations**:
1. **`-fflags +genpts+igndts`**: Regenerates presentation timestamps, ignores decode timestamps
2. **`setpts=N/FRAME_RATE/TB`**: Resets PTS to frame number-based timing (eliminates drift)
3. **`fps=30` filter**: Normalizes input framerates before composition
4. **SRT latency=200ms**: Provides jitter buffer for network variations
5. **`-vsync cfr`**: Forces constant framerate output (drops/duplicates frames as needed)

### Test Results

**Before mitigations**:
- Continuous timestamp discontinuity warnings (>100/minute)
- Streams stalled within 15 minutes
- System degraded after rapid restarts

**After mitigations**:
- Zero timestamp discontinuity warnings
- Streams grow continuously and reliably
- System recovers cleanly from restarts
- Compositor handles source timing variations gracefully

### Known Limitations

1. **Timestamp discontinuities are warnings, not errors**: FFmpeg will continue processing but may drop frames or introduce latency
2. **Multiple SRT inputs compound drift**: Each source can have independent timestamp offsets
3. **Health checks don't detect degradation**: Process existence ≠ stream quality

### Monitoring for Timestamp Issues

**Warning signs in logs**:
```
[vist#0:0/h264] timestamp discontinuity (stream id=256): 440099145
[aist#0:1/aac] timestamp discontinuity (stream id=257): -440099142
```

**If you see these repeatedly (>100/minute)**:
1. Stop the system: `docker-compose down`
2. Wait 5 seconds
3. Restart: `docker-compose up -d`
4. Verify streams are growing: `watch -n 1 'ls -lh out/*.ts'`

## Production Deployment Recommendations

### 1. Automated Restart Strategy

**Avoid**:
- Scheduled `docker-compose restart` for "maintenance"
- Quick container restarts during deployments

**Prefer**:
- Rolling updates with full container recreation
- Blue/green deployments with fresh container instances
- Scheduled full system restarts during maintenance windows

### 2. Health Monitoring

Current health checks validate:
- ✅ Xvfb process running (X server)
- ✅ Chrome process running (browser)
- ✅ FFmpeg process running (streaming)

**Additional monitoring needed**:
- Stream file size growth rate (bytes/second)
- FFmpeg log error/warning count
- Network throughput to SRT ingest
- Timestamp discontinuity frequency

### 3. Restart Checklist

Before any restart operation:

1. **Check current stream health**:
   ```bash
   # Verify files are growing
   ls -lh out/*.ts
   sleep 5
   ls -lh out/*.ts
   ```

2. **Perform full restart**:
   ```bash
   docker-compose -f docker-compose.stable.yml down
   sleep 3  # Allow full cleanup

   # With production secrets:
   source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d

   # Or for local testing:
   docker-compose -f docker-compose.stable.yml up -d
   ```

3. **Verify recovery**:
   ```bash
   # Wait for health checks
   sleep 30
   
   # Confirm all containers healthy
   docker ps
   
   # Verify stream growth
   ls -lh out/*.ts
   sleep 10
   ls -lh out/*.ts
   ```

4. **Check for timestamp warnings**:
   ```bash
   docker logs compositor --tail 50 | grep -c "discontinuity"
   # Should be 0 or very low (<5) after fresh start
   ```

## Recovery Procedures

### Degraded Stream Detection

**Symptoms**:
- Stream files stop growing
- Compositor logs show timestamp discontinuities
- Health checks still pass (false positive)

**Recovery**:
1. Full system restart (see checklist above)
2. If issue persists, check source content for timing issues
3. Consider reducing number of sources or simplifying composition

### Emergency Recovery

If standard restart doesn't resolve:

```bash
# Nuclear option: destroy everything
docker-compose -f docker-compose.stable.yml down -v
docker system prune -f

# Rebuild and restart
docker-compose -f docker-compose.stable.yml build --no-cache

# With production secrets:
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d

# Or for local testing:
docker-compose -f docker-compose.stable.yml up -d
```

## Future Improvements

Potential enhancements to address timestamp synchronization:

1. **Add stream quality health checks**: Monitor file growth rate, not just process existence
2. **Implement PTS correction**: Use FFmpeg `-fflags +genpts` to regenerate timestamps
3. **Add jitter buffer**: Configure SRT latency parameters for better sync
4. **Periodic auto-restart**: Scheduled full recreation to prevent drift accumulation
5. **Enhanced monitoring**: Export metrics for timestamp discontinuity frequency

## Testing Results (Phase 5)

### Extended Runtime Test ✅
- **Duration**: 5 minutes continuous streaming
- **Result**: All containers stable, no degradation
- **Conclusion**: System is stable under normal operation

### Rapid Restart Test ⚠️
- **Method**: 10 rapid `docker-compose restart` cycles
- **Result**: Timestamp discontinuities, stream stall after ~15 minutes
- **Conclusion**: Restart method matters; use full recreation

### Recovery Test ✅
- **Method**: Full system restart after degradation
- **Result**: Complete recovery, clean synchronization
- **Conclusion**: System recovers reliably from degraded state

---

**Last Updated**: October 6, 2025  
**Validated On**: page-stream stable-compositor branch, Phase 5 testing
