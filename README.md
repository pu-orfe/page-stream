# Page Stream

A headless web page video streamer for public displays. It loads a URL in a
Playwright-controlled Chromium under Xvfb, captures the virtual display with `ffmpeg`,
and publishes H.264 to any SRT/RTMP ingest — Kaltura, a self-hosted MediaMTX relay,
YouTube, or a local listener.

Display the resulting stream on Apple TV connected to public displays via [AutoStreamDisplay](https://apps.apple.com/us/app/autostreamdisplay/id6798754784).

## Features

* Stream any web page or local HTML, with injected CSS and JavaScript to skin it for a
  display.
* Composite several sources into one frame — see [COMPOSITOR-ARCHITECTURE.md](COMPOSITOR-ARCHITECTURE.md).
* Loop a local `.mp4` without browser overhead, with overlay watermarks.
* Exponential-backoff reconnect for SRT and RTMP drops.
* Separates the engine from channel maps, assets and stream keys.

---

## Decoupled GitOps Architecture

For production environments, combine:

* **Public Code Repository (`page-stream`):** open-source streaming engine, Dockerfiles, direct video file configurations, and local utility scripts.
* **Private Ops Repository (e.g., `page-stream-config`):** Live target maps (`example.env`), custom visual styles (`assets/`), and Docker Compose orchestration workflows.  Secrets such as ingest stream keys stored as GitHub Repository Secrets.

---

## Quick Start

1. Clone the codebase.
```bash
git clone https://github.com/pu-orfe/page-stream.git
cd page-stream
```

2. Run the bootstrapper.
```bash
./bootstrap-runner.sh
```
Choose `Option 5) Bootstrap a New Private Ops Repository`

3. Answer the prompts.
The wizard will guide you through:
    1. Entering your department code (e.g., `ECO`).
    2. Generating a local, custom, structured configuration repository folder containing templates for your `docker-compose.yml`, website target mapping `economics.env`, and visual assets (`assets/custom.css`).
    3. Automatically logging into GitHub and creating a brand new **private configuration repository** on your account (e.g., `economics/page-stream-config-economics`) using your authenticated `gh` session.

4. Configure & Launch
Once completed, follow the printed completion instructions:
    1. Add your private ingest URLs (Kaltura, etc) to your new repository's **GitHub Secrets** (as `STANDARD_1_INGEST`).
    2. Add your target website URLs to your new config file (e.g., `economics/economics.env`).
    3. Register your self-hosted runner for your new private repository, and trigger the **Deploy Action**.

> [!NOTE]
> When launching the stack via Docker Compose, an **automatic system requirements check** runs inside a helper container. If your Docker VM (e.g., Colima) is allocated too little RAM or CPU, the stack will halt with helpful allocation guidance.
>
> If you are using Colima, allocate resources by running:
> ```bash
> colima stop
> colima start --cpu 6 --memory 16
> ```

## Quick Local Demo (Standard Stack)

To run a stable test stack on your local host using standard fallback mock targets and local SRT output files (without sending to external Kaltura streams):

### **1. Configure Target URLs**
Copy the example stable environment file:
```bash
cp .env.stable.example .env
```
Edit `.env` to define your target websites (e.g., `STANDARD_1_URL`, `SOURCE_LEFT_URL`, etc.).

### **2. Build and Launch Stack**
```bash
# Compile the local Docker image
docker build -t page-stream:latest .

# Bring down any colliding containers and start a fresh stable stack
docker compose -f docker-compose.stable.yml down
docker compose -f docker-compose.stable.yml up -d
```
All outputs will appear as real-time transport stream files inside your local `./out/` directory for VLC/ffplay verification!

---

## Direct Video File Streaming

For looping pre-recorded videos without browser/render overhead:
1. Place your video files (e.g., `input.mp4`) inside the `./videos/` directory (git-ignored, mounted read-only into container).
2. Start streaming with direct file loop:
```bash
docker run --rm \
  -v $(pwd)/videos:/videos:ro \
  page-stream:latest \
  --ingest srt://your-srt-ingest-url \
  --video-file /videos/input.mp4 \
  --video-loop
```

## Operations

**Exit codes are part of the contract** — orchestration asserts on them.

| | |
| :--- | :--- |
| `0` | graceful stop |
| `1` | internal error |
| `10` | reconnect attempts exhausted (SRT/RTMP only) |
| `11` | ffmpeg failed on a protocol that is not retried |

Reconnect is protocol-gated: only `srt://` and `rtmp(s)://` get backoff. Everything else
exits `11` on the first ffmpeg failure. That gating is load-bearing wherever the ingest is
a relay that reboots for patching — the producers come back on their own.

**Health lines.** Every `--health-interval-seconds` (default 30, `0` disables) the process
logs one line of JSON after a `[health]` prefix: uptime, protocol, `restartAttempt`,
`lastFfmpegExitCode`, and `retrying`. Note it carries the ingest URI verbatim, which
includes the stream credential — everything downstream redacts it, and anything new that
reads these logs must too.

**The stack watchdog.** `scripts/stack-watchdog.sh`, installed as a LaunchAgent by
`scripts/install-watchdog.sh`, runs on the host rather than in a container, because a
container cannot report that the container runtime is down. It pings Healthchecks.io as a
dead-man's switch and emails detail through Resend on failure.

```bash
scripts/install-watchdog.sh --interval 300
scripts/stack-watchdog.sh --dry-run      # print, send nothing
scripts/stack-watchdog.sh --test-alert   # prove the wiring end to end
```

It distinguishes three things a monitor must never conflate: a **problem** (a container
down, unhealthy, or crash-looping), a **capacity warning** (over CPU budget — rides the
success ping, at most one email a day), and a **watchdog fault** (`docker` missing, or an
empty `WATCHDOG_EXPECTED`). A run that checked nothing never reports healthy.

`WATCHDOG_EXPECTED` is rendered from the channel map, so a channel disabled on purpose
cannot page anyone.

**A container healthcheck is not proof of delivery.** `pgrep Xvfb && pgrep chrome &&
pgrep ffmpeg` passes while ffmpeg reconnects to an ingest that rejects it — every signal
green, the display frozen. Whatever the ingest is, confirm bytes are arriving at the far
end, and that they are still rising a minute later.

---

## CLI Reference

```text
page-stream --ingest <URI> [options]

Required:
  -i, --ingest <uri>          Ingest URI (SRT/RTMP/etc)

Optional:
  -u, --url <url>             Page URL or local file (default: demo)
      --width <n>             Width (default 1280)
      --height <n>            Height (default 720)
      --fps <n>               FPS (default 30)
      --preset <p>            x264 preset (default veryfast)
      --video-bitrate <kbps>  Video bitrate (default 2500k; see note below)
      --audio-bitrate <kbps>  Audio bitrate (default 128k)
      --format <fmt>          Container format (default mpegts)
      --extra-ffmpeg <args..> Additional raw ffmpeg args
      --no-headless           Disable headless Chromium
      --no-fullscreen         Disable fullscreen mode
      --no-app-mode           Disable Chromium app mode (shows normal browser chrome)
      --refresh-signal <sig>  Signal for page reload (default SIGHUP)
      --graceful-stop-signal  Signal for graceful stop (default SIGTERM)
      --reconnect-attempts    Max reconnect attempts (0 = infinite, default 0)
      --auto-refresh-seconds  Auto page reload interval in seconds (0=disable)
      --inject-css <file>         Inject CSS from file into the page
      --inject-js <file>          Inject JavaScript from file into the page
      --video-file <path>         Stream video file directly (bypasses browser)
      --video-loop                Loop video file continuously
      --fallback-demo-page        Stream the bundled demo page if a local --url is
                                  missing, instead of exiting (legacy behaviour)
```

### `--video-bitrate`

The default is 2500k, which suits a Kaltura ingest that transcodes. A passthrough relay
does not re-encode, so whatever is sent is exactly what it pays egress on — and egress
scales with viewers, not channels. Deployments publishing to a relay should cap this from
their channel map rather than per container: `page-stream-config` renders one
`DEFAULT_VIDEO_BITRATE` into every producer for that reason.

### `--url` targets

`--url` accepts a remote URL, a `file://` URL, or a filesystem path (absolute or
relative). Query strings and fragments are preserved in every form, so a page can
configure itself from its own URL:

```bash
page-stream --ingest "$INGEST" --url '/assets/slate.html?channel=Studio%20A'
page-stream --ingest "$INGEST" --url 'file:///assets/slate.html#section'
```

**A missing local page is fatal.** If the file named by `--url` does not exist,
page-stream exits non-zero with the resolved path rather than starting the stream:

```text
Error: Local page not found: /out/assets/slate.html (from --url '/out/assets/slate.html').
  Pass a filesystem path or file:// URL that exists inside the container - a bind
  mount may be missing. Use --fallback-demo-page to stream the bundled demo page
  instead of exiting.
```

Earlier versions warned and quietly streamed the bundled demo page instead. That is
the worst outcome for an unattended display: the stream stays up and healthy, so
nothing alerts, and the wrong content plays until someone happens to look at the
screen. `--fallback-demo-page` restores the old behaviour where it is genuinely
wanted.
