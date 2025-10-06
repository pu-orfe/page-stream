# Page Stream

Headless, disposable web page video streamer for supplying content to public displays. It loads a supplied URL or local HTML in Playwright-controlled Chromium under Xvfb, captures the virtual display with `ffmpeg`, and pushes encoded video (no audio) to an ingest endpoint.

> **Compositor Testing:** For multi-source 50/50 split layout with network-isolated test harness, see [`COMPOSITOR-ARCHITECTURE.md`](COMPOSITOR-ARCHITECTURE.md) and [`TESTING-STABLE-COMPOSITOR.md`](TESTING-STABLE-COMPOSITOR.md) on the `stable-compositor` branch.

> **⚠️ Production Operations:** For critical restart procedures and timestamp synchronization guidance, see [`OPERATIONAL-NOTES.md`](OPERATIONAL-NOTES.md). **Always use full container recreation (`down` + `up`) instead of `restart` for streaming services.**

## Features

- Single-command containerized streaming of any web page or local HTML file.
- Included OBS-style collage demo layout (`demo/index.html`).
- Primary support for SRT ingest (e.g. `srt://host:port?streamid=...`).
- Also works with RTMP or other `ffmpeg` supported outputs (just change the ingest URI & format flags).
- Refresh the streamed page live via signal (default `HUP`) without restarting the container or ffmpeg pipeline.
 - Refresh the streamed page live via signal (default `HUP`) without restarting the container or ffmpeg pipeline, or enable automatic periodic refresh.
- Configurable resolution, FPS, bitrate, codec preset, and extra raw ffmpeg args.
- Graceful shutdown on `SIGTERM` / `SIGINT`.
- Extensible Node.js CLI (TypeScript) + minimal test harness.
- Multi-arch friendly (Playwright base image) — works on ARM64 (Apple Silicon) & x86_64.
 - Exponential SRT reconnect/backoff with configurable attempts & delays plus clear failure diagnostics.
 - Auto-retry with exponential backoff for SRT and RTMP (same flags) with clear failure diagnostics.
 - Structured periodic health log lines (JSON) for observability.
 - Optional noVNC (VNC over WebSocket) viewer to interact with the Chromium session (disabled by default).
 - Minimal-UI app mode (Chromium --app=) to hide address bar / navigation chrome (enabled by default).

## How It Works

1. Container launches Xvfb (virtual display) at requested resolution.
2. Headless Chromium (Playwright) loads the target page.
3. `ffmpeg` performs an `x11grab` of the Xvfb display, encodes with libx264 (tune zerolatency) and multiplexes silent audio.
4. Output is sent via SRT (default container format `mpegts`).
5. A `SIGHUP` to the Node process (or container) triggers a page reload only.

## Quick Start (Local Without Container)

```bash
npm install
npm run build
node dist/index.js --ingest srt://127.0.0.1:9000?streamid=demo --url demo/index.html
```

## Building & Running the Container

```bash
# Build
docker build -t page-stream:dev .

# Run (SRT target example)
docker run --rm \
  -e WIDTH=1280 -e HEIGHT=720 \
  page-stream:dev \
  --ingest srt://your-srt-host:9000?streamid=yourStreamId \
  --url demo/index.html

# Enable noVNC (adds VNC + WebSocket bridge on :6080) then open http://localhost:6080
docker run --rm -p 6080:6080 \
  -e ENABLE_NOVNC=1 \
  page-stream:dev \
  --ingest srt://your-srt-host:9000?streamid=yourStreamId
```

## Environment configuration (docker-compose)

This repository includes an example env file: `.env.stable.example`. Copy it to `.env.stable` or to `.env` before starting the stable docker-compose stack. The compose file will read environment variables so you can override the target pages and ingestion endpoints without editing YAML.

Important variables in `.env.stable.example`:

- `STANDARD_1_URL`, `STANDARD_2_URL`, `STANDARD_3_URL` — the target HTTP(S) pages streamed by the `standard-*` services.
- `SOURCE_LEFT_URL`, `SOURCE_RIGHT_URL` — the two half-width source pages used by the compositor sources.
- `COMPOSITOR_INGEST` — where the compositor sends the composed output. Defaults to the local `srt-ingest` service: `srt://srt-ingest:9000?streamid=composite`. Set this if you want the compositor to forward the composite to an external endpoint.

Quick copy and start (uses the fallback COMPOSITOR_INGEST if unset):

```bash
cp .env.stable.example .env.stable   # or cp .env.stable.example .env
# Bring down any running stable stack, then recreate so env changes take effect
docker-compose -f docker-compose.stable.yml down
docker-compose -f docker-compose.stable.yml up -d --build
```

Note: prefer `down` + `up` to `restart` for streaming services — restarting in-place can leave SRT/ffmpeg timestamp state that causes drift; full recreate clears the state.

## Running on macOS with Colima (increase memory)

If you're using Colima as your Docker runtime on macOS (a common lightweight alternative to Docker Desktop), the default VM memory may be too small for multiple full-HD encoders and a compositor. If you see OOMKilled containers (exit code 137) or ffmpeg thread-queue blocking, increase Colima's memory allocation before starting the stack.

1. Check current Colima status and resources:

```bash
colima status
```

2. Stop Colima and restart it with more memory (example: 8 GB). Adjust `--memory` to 12g or 16g if you plan to run more concurrent encoders:

```bash
colima stop
colima start --cpu 4 --memory 8g --disk 50g
```

Notes:
- `--cpu` controls CPU cores available to Colima; 4 is a reasonable starting point for multi-encoder tests.
- `--memory` accepts values like `8g` or `12g`.
- `--disk` increases the VM disk; not strictly required for memory but helpful for large builds or logs.

3. Recreate the compose stack so containers pick up the new VM resources:

```bash
docker-compose -f docker-compose.stable.yml down
docker-compose -f docker-compose.stable.yml up -d --build
```

4. Watch logs / health lines to confirm stability:

```bash
docker-compose -f docker-compose.stable.yml logs --tail 200 --follow
# or check a specific container
docker logs --tail 200 -f standard-2
```

If increasing Colima memory isn't an option, consider reducing per-container resource use (lower resolution/bitrate) or running fewer concurrent standard instances.


If the provided `--url` is not an absolute HTTP(S) URL and does not exist as a local file, the demo page is used.

## Refreshing the Streamed Page

Manual refresh methods (either works):

1. Send `HUP` to the main process (inside container this is PID 1):
   ```bash
   docker kill -s HUP <container-id>
   ```
2. Write anything to the FIFO `/tmp/page_refresh_fifo` inside the container:
   ```bash
   docker exec <container-id> sh -c 'echo refresh > /tmp/page_refresh_fifo'
   ```

### Automatic Periodic Refresh

Add `--auto-refresh-seconds <n>` to automatically reload the page every _n_ seconds (the ffmpeg pipeline is not restarted; only the page is reloaded). Example:

```bash
docker run --rm \
  -e WIDTH=1280 -e HEIGHT=720 \
  page-stream:dev \
  --ingest srt://your-srt-host:9000?streamid=yourStreamId \
  --url demo/index.html \
  --auto-refresh-seconds 300   # reload every 5 minutes
```

## CLI Options

```
page-stream --ingest <URI> [options]

Required:
  -i, --ingest <uri>          Ingest URI (SRT/RTMP/etc)

Optional:
  -u, --url <url>             Page URL or local file (default: demo)
      --width <n>             Width (default 1280)
      --height <n>            Height (default 720)
      --fps <n>               FPS (default 30)
      --preset <p>            x264 preset (default veryfast)
      --video-bitrate <kbps>  Video bitrate (default 2500k)
      --audio-bitrate <kbps>  Audio bitrate (default 128k)
      --format <fmt>          Container format (default mpegts)
      --extra-ffmpeg <args..> Additional raw ffmpeg args
      --no-headless           Disable headless Chromium
  --no-fullscreen         Disable fullscreen mode (enabled by default; best-effort kiosk/fullscreen under Xvfb)
  --no-app-mode           Disable Chromium app mode (shows normal browser chrome)
      --refresh-signal <sig>  Signal for page reload (default SIGHUP)
    --graceful-stop-signal <sig> Signal for graceful stop (default SIGTERM)
  --reconnect-attempts <n>     Max reconnect attempts for SRT/RTMP (0 = infinite, default 0)
  --reconnect-initial-delay-ms <n>  Initial reconnect delay ms (default 1000)
  --reconnect-max-delay-ms <n>      Max reconnect delay ms (default 15000)
  --health-interval-seconds <n> Interval for structured health log lines (0=disable, default 30)
  --auto-refresh-seconds <n>  Auto page reload interval in seconds (0=disable)
  --inject-css <file>         Inject CSS from file into the page
  --inject-js <file>          Inject JavaScript from file into the page
```

## Page Customization

You can inject custom CSS or JavaScript into the streamed page for styling or behavior modifications:

- `--inject-css <file>`: Reads CSS from the specified file and applies it to the page.
- `--inject-js <file>`: Reads JavaScript from the specified file and executes it on the page.

Mount the files into the container and provide absolute paths. Example:

```bash
docker run --rm \
  -v $(pwd)/custom.css:/custom.css \
  -v $(pwd)/custom.js:/custom.js \
  page-stream:latest \
  --ingest srt://host:9000?streamid=demo \
  --url demo/index.html \
  --inject-css /custom.css \
  --inject-js /custom.js
```

## SRT Examples

Common SRT ingest patterns (change to match your broadcaster):

```
# Simple stream id
srt://example.com:9000?streamid=live.slp

# With latency + passphrase
srt://example.com:9000?streamid=live.slp&latency=120&pbkeylen=16&passphrase=secret
```

For some broadcast endpoints you'll embed path inside `streamid` (consult provider docs).

## Alternate Outputs

Use RTMP:
```
--ingest rtmp://live.example.com/app/streamKey --format flv
```
Use local file (for testing):
```
--ingest output.ts --format mpegts
```
Add scaling or overlays via extra args (before output):
```
--extra-ffmpeg -vf scale=1920:1080
```

## Refresh Strategy
## Optional noVNC Viewer

Set `ENABLE_NOVNC=1` to start a lightweight VNC server (`x11vnc`) bound to localhost plus a WebSocket bridge (`websockify`) serving the noVNC client on port `6080` (container). Map the port (`-p 6080:6080`) and open:

```
http://localhost:6080
```

Security notes:
- Disabled by default; requires explicit env var.
- x11vnc is started with `-localhost` so only accessible via the container network / published port.
- No password is set (`-nopw`); for production use, consider an authenticating reverse proxy or adding `-passwdfile`.
- Intended for short-lived debugging & layout tuning, not for long-term unattended exposure.


We reload the Chromium page only, keeping ffmpeg running. This avoids reconnect jitter on ingest.

## Reconnect & Failure Handling (SRT / RTMP)

The streamer implements exponential backoff for SRT and RTMP connection failures:

- Backoff delay = `initialDelay * 2^(attempt-1)` capped at `maxDelay`.
- `--reconnect-attempts 0` means retry forever until manually stopped.
- Protocols currently retried: SRT (`srt://`), RTMP / RTMPS (`rtmp://` / `rtmps://`).

Example (finite attempts):
```
ffmpeg exited (code=1). Scheduling SRT reconnect attempt 1 in 1000ms
ffmpeg exited (code=1). Scheduling SRT reconnect attempt 2 in 2000ms
SRT reconnect attempts exhausted (2/2). Giving up.

SRT connection failed permanently. Troubleshooting suggestions:
  • Verify the ingest listener is running and accessible: srt://example.com:9000
  • Confirm any firewalls / security groups allow UDP on the SRT port.
  • Check that the streamid or query params are correct for the target provider.
  • Test locally:
      ffmpeg -loglevel info -f mpegts -i "srt://example.com:9000?streamid=test" -f null -
  • Or run a local listener:
      ffmpeg -f mpegts -i "srt://:9000?mode=listener" -f null -
  • Increase verbosity with: --extra-ffmpeg -loglevel verbose
  • Enable infinite retries: --reconnect-attempts 0
```

### Choosing Retry Settings
| Scenario | Suggested Flags |
|----------|-----------------|
| Unstable network, must persist | `--reconnect-attempts 0 --reconnect-initial-delay-ms 1000 --reconnect-max-delay-ms 30000` |
| Rapid local dev | `--reconnect-attempts 5 --reconnect-initial-delay-ms 500 --reconnect-max-delay-ms 5000` |

### Exit Behavior & Codes

Distinct exit codes are used for clearer orchestration handling:

| Code | Meaning |
|------|---------|
| 0 | Graceful stop (signal or normal termination) |
| 1 | Unhandled internal error (startup, unexpected exception) |
| 10 | Retry protocol (SRT/RTMP) reconnect attempts exhausted |
| 11 | Non-retry protocol ffmpeg failure (no auto-retry) |

On exhaustion for a retry protocol a diagnostic help block is printed (SRT or RTMP specific) before exiting with 10. For non-retry protocols, the process exits with 11 immediately after the first failure.

### Health Logging

If `--health-interval-seconds > 0` the process prints structured JSON lines prefixed with `[health]`, e.g.:

```
[health] {"type":"health","ts":"2024-01-01T00:00:00.000Z","uptimeSec":30.1,"ingest":"srt://example.com:9000?streamid=test","protocol":"SRT","restartAttempt":2,"lastFfmpegExitCode":1,"retrying":true}
```

Fields:
- `uptimeSec` – process uptime
- `protocol` – detected ingest protocol (SRT / RTMP / INGEST)
- `restartAttempt` – number of completed reconnect attempts
- `lastFfmpegExitCode` – last observed ffmpeg exit code (null until first exit)
- `retrying` – whether a reconnect timer is currently scheduled

Disable health output with `--health-interval-seconds 0`.

## Local Development Without Docker (Conda)

While production deployment is container-based, a `environment.yml` is provided for a lightweight local setup:

```
conda env create -f environment.yml
conda activate page-stream-dev
npm install
npx playwright install --with-deps chromium
npm run build
WIDTH=1280 HEIGHT=720 node dist/index.js --ingest file.ts --format mpegts --url demo/index.html
```

Notes:
- The conda env supplies Node.js, ffmpeg, and X11 helpers; on macOS Xvfb components are effectively unused (prefer Docker for full fidelity).
- Playwright browser binaries still need to be installed (`npx playwright install`).
- For SRT or RTMP targets you generally still test best via Docker to mirror network + library stack.

### Quick conda-based build & test (non-interactive)

If your system lacks a global `npm` or you prefer to run everything inside the provided Conda environment without activating it, run:

```bash
conda env create -f environment.yml -n page-stream-dev
conda run -n page-stream-dev npm install --no-audit --no-fund
conda run -n page-stream-dev npm run build
conda run -n page-stream-dev npm test
```

This reproduces the same steps used by the maintainers for local validation. One caveat: a noVNC-related test may time out if `websockify` or other optional tools are missing; re-run the single test file for diagnostics if needed.


## Test Mode (Internal)

Setting `PAGE_STREAM_TEST_MODE=1` skips launching the browser & ffmpeg while still exercising CLI parsing. This is used by the included test suite for fast feedback.

## Testing

Current tests (Node built-in test runner) validate CLI basics.

```bash
npm run build
npm test
```

## UI Flags & Automation Indicators

The tool tries to minimize any non-content chrome from Chromium for clean broadcast capture:

- Fullscreen + kiosk: enabled by default (disable with `--no-fullscreen`).
- App mode (`--app=`) removes address bar and tabs (disable with `--no-app-mode`).
- DOM / blink automation banner suppression is on by default (disable with `--no-suppress-automation-banner`).
- Experimental xdotool dismissal: add `--auto-dismiss-infobar` to send synthetic X11 mouse clicks near the top center of the window a few times shortly after launch. This attempts to close the "is being controlled by automated test software" infobar if present. It is best-effort and ignored if `xdotool` isn’t available.
  - Enhanced dismissal now also uses `wmctrl` (if present) to focus Chromium windows and sweeps multiple top-right coordinates plus ESC key presses for better reliability.
  - If the banner persists or you prefer a guaranteed absence without clicking, use `--crop-infobar <px>` to crop N pixels from the top of the captured frame via ffmpeg (injected as a `crop=w:h:0:TOP` filter when no conflicting user `-vf` is supplied). Example: `--crop-infobar 36`.
  - Cropping is disabled by default (value 0). Choose a value slightly larger than the infobar height (common ranges: 30–50) to fully remove it.

Health log lines include `infobarDismissTried` when the xdotool heuristic ran.
