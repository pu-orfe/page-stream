# Page Stream

A headless, disposable web page video streamer for supplying content to public displays.

Page Stream loads a supplied URL or local HTML in Playwright-controlled Chromium under Xvfb, captures the virtual display with `ffmpeg`, and pushes encoded video (no audio--yet) to an ingest endpoint.

## Features

- Single-command, containerized streaming of any web page or local HTML file.
- CSS overrides and JS vanilla scriptability for transformations and interactions with the resulting page.
- Compositor for multi-source, collage-style layouts.  See [`COMPOSITOR-ARCHITECTURE.md`](COMPOSITOR-ARCHITECTURE.md) and [`TESTING-STABLE-COMPOSITOR.md`](TESTING-STABLE-COMPOSITOR.md).
- Scales for production operations.  See [`OPERATIONAL-NOTES.md`](OPERATIONAL-NOTES.md) for restart guidance and troubleshooting.
- Primary support for SRT, secondary support for RTMP, extensible to other outputs (its just `ffmpeg`!).
- **Direct video file streaming** for looping pre-recorded content without browser overhead.
- noVNC viewer to interact with the Chromium session (disabled by default).
- Optimized for and tested on Apple Silicon.

## How It Works

1. Container launches Xvfb (virtual display) at requested resolution.
2. Headless Chromium (Playwright) loads the target page.
3. `ffmpeg` performs an `x11grab` of the Xvfb display, encodes with libx264 (tune zerolatency) and multiplexes silent audio.
4. Output is sent via SRT (default container format `mpegts`).
5. A `SIGHUP` to the Node process (or container) triggers a page reload only.


## Minimal Requirements

Requirements vary depending upon the scale and complexity of deployment, as each instance is running, at a minimum, a framebuffer, a browser, and a real-time HD (or greater!) encode to stream.

For the demo:

- Docker
- 6 CPU Cores (minimum)
- 16GB of RAM (minimum)

**Automatic Requirements Check:** When starting the stack with `docker-compose`, an automatic system requirements check will verify that your Docker environment has sufficient resources allocated. If requirements aren't met, the stack will fail to start with helpful instructions on how to allocate more resources. To disable this check, set `SKIP_REQUIREMENTS_CHECK=true` in your `.env` file.

## Quick Demo

### 1. Configure URLs

Copy the example `.env.stable.example` to `.env`:

```bash
cp .env.stable.example .env
```

Edit `.env`, setting your own URLs for:

- `STANDARD_1_URL`, etc — the target HTTP(S) pages streamed by the `standard-*`, full screen (HD) services.
- `SOURCE_LEFT_URL`, `SOURCE_RIGHT_URL` — the two half-width (HD) source pages used by the example compositor.

### 2. Configure Secret Stream IDs (Production)

**IMPORTANT**: If your ingest URLs contain `#` characters (common with Kaltura stream IDs), you **must** use `.env.secrets.sh`:

```bash
# Copy the example file
cp env.secrets.sh.example .env.secrets.sh

# Edit .env.secrets.sh with your actual stream IDs
# Replace the example values with your Kaltura credentials
```

See [`SECRETS.md`](SECRETS.md) for detailed configuration instructions.

### 3. Start the Stack

Make sure no existing stack is up, build the image, then bring up the stack:

```bash
docker build -t page-stream:latest .
docker-compose -f docker-compose.stable.yml down

# With production secret stream IDs (Kaltura, etc):
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d

# Or for local testing without external ingest:
docker-compose -f docker-compose.stable.yml up -d
```

Example streams that you can open with VLC, `ffplay`, etc will appear in the `out` folder.

## Resource Constraints

The project tests with Colima as the macOS Docker runtime, and the default VM memory and CPU allocations to Colima are too small (OOMKilled, Exit Code 137 errors).

An automatic system requirements check runs when you start the stack to verify sufficient resources are available. The minimum requirements are:
- **6 CPU cores**
- **16GB RAM**

1. Check current Colima status and resources:

```bash
colima status
```

2. Stop Colima and restart it with access to more CPUs and memory (make sure you have it):

```bash
colima stop
colima start --cpu 6 --memory 16
```

For better performance with the full demo stack (recommended):

```bash
colima stop
colima start --cpu 8 --memory 16
```

If increasing Colima memory isn't an option, consider reducing per-container resource use (lower resolution/bitrate) or running fewer concurrent standard instances.

**Note:** To bypass the requirements check (not recommended), set `SKIP_REQUIREMENTS_CHECK=true` in your `.env` file.

## Refreshing the Streamed Page

Manual refresh methods:

1. Send `HUP` to the main process (inside container this is PID 1):
   ```bash
   docker kill -s HUP <container-id>
   ```
2. Write anything to the FIFO `/tmp/page_refresh_fifo` inside the container:
   ```bash
   docker exec <container-id> sh -c 'echo refresh > /tmp/page_refresh_fifo'
   ```

### Automatic Periodic Refresh

Add `--auto-refresh-seconds <n>` to automatically reload the page every _n_ seconds.

The ffmpeg pipeline is not restarted; only the page is reloaded). Example:

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
  --video-file <path>         Stream video file directly (bypasses browser/Xvfb)
  --video-loop                Loop video file continuously (requires --video-file)
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
Per-container injection variables
-------------------------------
You can set per-container injection variables in your `.env.stable` (or `.env`) using names
like `STANDARD_1_INJECT_CSS` / `STANDARD_1_INJECT_JS` or `SOURCE_LEFT_INJECT_CSS`.
The entrypoint uses the following precedence:

- If `INJECT_CSS` or `INJECT_JS` (global) is set, it is used.
- Otherwise the entrypoint picks the first non-empty `*_INJECT_CSS` or `*_INJECT_JS` it finds
  in the container environment and passes it to the `page-stream` CLI as `--inject-css` / `--inject-js`.

This behavior is documented in `scripts/entrypoint.sh` and covered by a small unit test in `tests/inject-vars.test.ts`.

  --inject-js /custom.js
```

Per-service injection when using docker-compose
---------------------------------------------

When running the multi-container stable stack via `docker-compose.stable.yml` you can inject CSS/JS on a per-service basis using environment variables and mounted files. The compose file reads per-service env vars such as `STANDARD_1_INJECT_CSS`, `STANDARD_1_INJECT_JS`, `SOURCE_LEFT_INJECT_CSS`, etc.

Example `.env.stable` entries:

STANDARD_1_INJECT_CSS=/out/custom/std1.css
STANDARD_1_INJECT_JS=/out/custom/std1.js
SOURCE_LEFT_INJECT_CSS=/out/custom/left.css

Mount the host folder into the compose stack before bringing it up, for example by adding a bind mount to the service in `docker-compose.stable.yml` (the provided example compose already mounts `./out` into the containers):

1. Place your files under `./out/custom/` in the repo (or any path you prefer).
2. Set the env vars above in your local `.env.stable` (copy from `.env.stable.example`).
3. Start the stack:

```bash
docker-compose -f docker-compose.stable.yml up -d --build
```

Notes:
- Per-service inject env vars are optional — leaving them empty is safe and no injection will be attempted.
- Ensure the env value points to the absolute path inside the container where you mounted the file (the compose example uses `/out/...`).

Demo injection (quick test)
---------------------------

For a quick demo the repository includes small example assets under `demo/assets/` (`inject.css` and `inject.js`). To try them with the compose stack:

1. Copy the example env file and set an inject var (or edit directly):

```bash
cp .env.stable.example .env.stable
# in .env.stable set, for example:
# STANDARD_1_INJECT_CSS=/out/demo/assets/inject.css
# STANDARD_1_INJECT_JS=/out/demo/assets/inject.js
```

2. The compose configuration already mounts `./demo` into each service in two places. If you changed mounts, ensure the files are available inside the container at `/out/demo/assets/` or adjust the env path accordingly.

3. Start the stable stack and open the `standard-1` output (or inspect recorded `out/` files):

```bash
docker-compose -f docker-compose.stable.yml up -d --build
```

You should see the demo banner and pulsing H1 from the injected JS/CSS if injection was applied successfully. Check container logs for messages like `[demo-inject] inject.js loaded` in the Chromium console output captured by the Node process.

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

## Direct Video File Streaming

For looping pre-recorded video content without browser overhead, use the `--video-file` option. This bypasses the browser and Xvfb entirely, streaming directly from a video file via FFmpeg.

### Video Files Directory

Place your video files in the `./videos/` directory. This directory is:
- Tracked in git via `.gitkeep` (the directory structure is preserved)
- Contents are ignored via `.gitignore` (video files won't be committed)
- Mounted read-only into containers for security

```bash
# Copy your video file to the videos directory
cp /path/to/your/video.mp4 ./videos/input.mp4
```

### Basic Usage

```bash
# Stream a video file once
docker run --rm \
  -v $(pwd)/videos:/videos:ro \
  page-stream:latest \
  --ingest srt://host:9000?streamid=test \
  --video-file /videos/input.mp4

# Stream a video file in a continuous loop
docker run --rm \
  -v $(pwd)/videos:/videos:ro \
  page-stream:latest \
  --ingest srt://host:9000?streamid=test \
  --video-file /videos/input.mp4 \
  --video-loop
```

### Using Docker Compose

The `docker-compose.stable.yml` includes a `video-loop` service profile:

```bash
# 1. Place your video in the videos directory
cp /path/to/your/video.mp4 ./videos/input.mp4

# 2. Start the video loop service
docker compose -f docker-compose.stable.yml --profile video-loop up video-loop

# Or specify a custom filename
VIDEO_FILENAME=my-video.mp4 docker compose -f docker-compose.stable.yml --profile video-loop up video-loop
```

### Video Processing

When streaming a video file, the following processing is applied:
- **Scaling**: Video is scaled to target resolution (default 1920×1080) while preserving aspect ratio
- **Padding**: Letterboxing/pillarboxing is added if aspect ratios differ
- **Frame rate**: Normalized to target FPS (default 30)
- **Encoding**: Re-encoded with libx264 (zerolatency tune) for streaming
- **Audio**: Original audio is preserved if present; silent audio added if not

### macOS Permissions

If you encounter permission issues reading video files on macOS:
1. Ensure the `./videos/` directory has appropriate permissions: `chmod 755 ./videos`
2. Video files should be readable: `chmod 644 ./videos/*.mp4`
3. If using Colima/Docker Desktop, the directory must be within a shared/mounted path

## Optional noVNC Viewer

Set `ENABLE_NOVNC=1` to start a lightweight VNC server (`x11vnc`) bound to localhost plus a WebSocket bridge (`websockify`) serving the noVNC client on port `6080` (container).

Map the port (`-p 6080:6080`) and open:

```
http://localhost:6080
```

Security notes:
- noVNC is disabled by default and requires explicit env var.
- x11vnc is started with `-localhost` so only accessible via the container network and published port.
- No password is set (`-nopw`); for production use, consider an authenticating reverse proxy.
- Intended for short-lived debugging & layout tuning, not for long-term unattended exposure.

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
