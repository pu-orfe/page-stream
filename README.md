# Page Stream

A headless, disposable web page video streamer designed to deliver high-fidelity web content, schedules, and loops directly to public displays.

`page-stream` launches a target URL or local HTML page in a Playwright-controlled Chromium browser under Xvfb (Virtual Framebuffer), captures the visual screen with `ffmpeg` in real-time, encodes it into a highly optimized video stream (H.264), and broadcasts it to any target ingest endpoint (such as Kaltura, YouTube, or local SRT/RTMP listeners).

## Features

* Stream any web page or local static layout in containerized environments.
* Dynamically inject custom CSS stylesheets and Vanilla JavaScript scripts to format, automate, and skin web pages specifically for layouts.
* Composite multiple streaming sources into dynamic collage-style layouts (e.g., side-by-side splits). See [COMPOSITOR-ARCHITECTURE.md](COMPOSITOR-ARCHITECTURE.md).
* Stream pre-recorded `.mp4` video files continuously in a loop without browser overhead, featuring overlay watermarks and citations.
* Robust exponential backoff retry mechanisms for handling SRT and RTMP network drops.
* Optimized and validated for high-performance execution on macOS and Linux.
* Splits core page-stream codebase from orchestration, website targets, and streaming keys.

---

## Decoupled GitOps Architecture

For production environments, combine:

* **Public Code Repository (`page-stream`):** open-source streaming engine, Dockerfiles, direct video file configurations, and local utility scripts.
* **Private Ops Repository (e.g., `page-stream-config`):** Live target maps (`example.env`), custom visual styles (`assets/`), and Docker Compose orchestration workflows.  Secrets such as ingest stream keys stored as GitHub Repository Secrets.

---

## Quick Start

Deploy your own high-fidelity public display streams. 

1. Clone the codebase.
Clone the public streaming engine on your display runner machine:
```bash
git clone https://github.com/pu-orfe/page-stream.git
cd page-stream
```

2. Run the bootstrapper.
Launch the interactive helper script:
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
    1. Add your private ingest URLs to your new repository's **GitHub Secrets** (as `STANDARD_1_INGEST`).
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
      --video-bitrate <kbps>  Video bitrate (default 2500k)
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
