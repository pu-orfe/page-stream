# Stable Compositor Quick Reference

## One-Command Test

```bash
# Build image
docker build -t page-stream:latest .

# Start everything (with secrets for production Kaltura endpoints)
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d

# Or for local testing without external ingest:
docker-compose -f docker-compose.stable.yml up -d

# Watch compositor logs
docker-compose -f docker-compose.stable.yml logs -f compositor

# View output
ffplay -fflags nobuffer -flags low_delay ./out/composite.ts
```

**Note**: If your ingest URLs contain `#` characters (e.g., Kaltura stream IDs), you **must** source `.env.secrets.sh` before running docker-compose. See [`SECRETS.md`](SECRETS.md) for setup.

## Verify Network Isolation

```bash
# Standard instances should be unaffected by compositor lifecycle
docker-compose -f docker-compose.stable.yml stop compositor source-left source-right srt-ingest
docker-compose -f docker-compose.stable.yml ps standard-1 standard-2 standard-3
# ^ All should still be "Up"

docker-compose -f docker-compose.stable.yml start compositor source-left source-right srt-ingest
# Standard instances should show no restart
```

## Service Layout

| Service | Network | Purpose | Resolution |
|---------|---------|---------|------------|
| `srt-ingest` | compositor_net | SRT listener (receives composite) | N/A |
| `compositor` | compositor_net | FFmpeg hstack filter | 1920×1080 out |
| `source-left` | compositor_net | Left half source | 960×1080 |
| `source-right` | compositor_net | Right half source | 960×1080 |
| `standard-1` | default | Independent stream 1 | 1920×1080 |
| `standard-2` | default | Independent stream 2 | 1920×1080 |
| `standard-3` | default | Independent stream 3 | 1920×1080 |

## Common Operations

```bash
# Restart a single source (avoid this, use full recreation instead - see OPERATIONAL-NOTES.md)
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml restart source-left

# Full system restart (RECOMMENDED - avoids timestamp sync issues)
docker-compose -f docker-compose.stable.yml down
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d

# Stop compositor stack only
docker-compose -f docker-compose.stable.yml stop compositor source-left source-right srt-ingest

# Tail logs from compositor and sources
docker-compose -f docker-compose.stable.yml logs -f --tail=20 compositor source-left source-right

# Check composite file growth
watch -n 1 'ls -lh ./out/composite.ts'

# Clean up everything
docker-compose -f docker-compose.stable.yml down
rm -rf out/*
```

## Troubleshooting

| Issue | Check | Fix |
|-------|-------|-----|
| Compositor won't start | `docker logs compositor` | Verify srt-ingest is healthy |
| Sources can't connect | `docker network inspect page-stream_compositor_net` | Restart compositor |
| Standard instances restart | `docker-compose ps` | **Network isolation broken** — see COMPOSITOR-ARCHITECTURE.md troubleshooting |
| No output file | `ls -la out/` | Check srt-ingest logs for errors |

## Success Criteria Checklist

- [ ] All 7 containers start successfully
- [ ] `./out/composite.ts` file grows continuously
- [ ] Standard instances survive compositor stop/start
- [ ] Sources reconnect after individual restarts
- [ ] No "network unreachable" or DNS errors in logs
- [ ] FFplay shows side-by-side LEFT/RIGHT video

## Architecture Summary

```
Standard Instances (default network)
├── standard-1 → ${STANDARD_1_INGEST}
├── standard-2 → ${STANDARD_2_INGEST}
└── standard-3 → ${STANDARD_3_INGEST}

Compositor Stack (compositor_net network)
├── source-left (960×1080) → srt://compositor:10001
├── source-right (960×1080) → srt://compositor:10002
├── compositor (FFmpeg hstack) → srt://srt-ingest:9000
└── srt-ingest → ./out/composite.ts
```

See [`COMPOSITOR-ARCHITECTURE.md`](COMPOSITOR-ARCHITECTURE.md) for full design details.
See [`TESTING-STABLE-COMPOSITOR.md`](TESTING-STABLE-COMPOSITOR.md) for comprehensive test phases.
