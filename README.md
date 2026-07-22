# Page Stream

A headless, disposable web page video streamer designed to deliver high-fidelity web content, schedules, and loops directly to public displays.

`page-stream` launches a target URL or local HTML page in a Playwright-controlled Chromium browser under Xvfb (Virtual Framebuffer), captures the visual screen with `ffmpeg` in real-time, encodes it into a highly optimized video stream (H.264), and broadcasts it to any target ingest endpoint (such as Kaltura, YouTube, or local SRT/RTMP listeners).

---

## ✨ Features

* **Single-Command Streaming:** Instantly stream any web page or local static layout in containerized environments.
* **Custom Injectable Overrides:** Dynamically inject custom CSS stylesheets and Vanilla JavaScript scripts to format, automate, and skin web pages specifically for kiosk layouts.
* **Multi-Source Video Compositor:** Composite multiple streaming sources into dynamic collage-style layouts (e.g., side-by-side splits). See [COMPOSITOR-ARCHITECTURE.md](COMPOSITOR-ARCHITECTURE.md).
* **Direct Video File Loops:** Stream pre-recorded `.mp4` video files continuously in a loop without browser overhead, featuring overlay watermarks and citations.
* **Resilient Reconnections:** Features robust exponential backoff retry mechanisms for handling SRT and RTMP network drops.
* **Apple Silicon Native:** Fully optimized and validated for high-performance execution on macOS (Colima/Docker Desktop) and Linux runtimes.
* **GitOps Production Decoupling:** Securely splits your core code (public) from your deployment orchestration, website targets, and streaming keys (private).

---

## 🏗 Decoupled GitOps Architecture (Pattern 1)

For production environments, `page-stream` recommends **Pattern 1 (Ops Repository)**:
1. **Public Code Repository (`page-stream`):** Contains the open-source streaming engine, Dockerfiles, direct video file configurations, and local utility scripts.
2. **Private Ops Repository (`page-stream-config`):** Securely stores your live website target maps (`orfe.env`), custom visual styles (`assets/`), and Docker Compose orchestration workflows. Production kaltura ingest stream keys are stored as GitHub Repository Secrets, keeping them 100% safe from public leaks.

---

## 🛠 Local Administration Utilities

We have added two high-fidelity helper utilities to the public repository root to streamline local runner administration:

### **1. Interactive Runner Bootstrapper (`bootstrap-runner.sh`)**
A friendly, colorful terminal-based control panel to monitor, start, stop, or clean up your self-hosted environment:
```bash
./bootstrap-runner.sh
```
* **Resource Auditing:** Checks your host's memory, CPU allocations, and active Colima/Docker allocations.
* **Runner Management:** Checks process statuses, restarts the daemon, or stops the listener.
* **Quick Teardowns:** Lets you cleanly tear down local docker container stacks in a single click.

### **2. Automated Secrets Syncing (`sync-secrets.sh`)**
Instantly syncs your local kaltura streaming credentials from `.env.secrets.sh` to your private GitHub configuration repository's secrets using the `gh` API:
```bash
./sync-secrets.sh
```
* **Zero Manual Effort:** Eliminates copy-pasting multiple complex stream IDs containing `#` into the GitHub UI.

---

## 📋 Minimal Host Requirements

Streaming multiple HD browsers and real-time H.264 video encodes requires substantial computing power. 

* **Minimum Developer Allocation:** 6 CPU Cores, 16GB of RAM.
* **Recommended Production Allocation:** 8 CPU Cores, 16GB of RAM.

> [!NOTE]
> When launching the stack via Docker Compose, an **automatic system requirements check** runs inside a helper container. If your Docker VM (e.g., Colima) is allocated too little RAM or CPU, the stack will halt with helpful allocation guidance.
>
> If you are using Colima, allocate resources by running:
> ```bash
> colima stop
> colima start --cpu 6 --memory 16
> ```

---

## 🚀 Quick Local Demo (Standard Stack)

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

## 🐳 Direct Video File Streaming

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

---

## 💻 CLI Option Reference

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
```

---

## 🤝 Contributing & License

For issues, asset additions, or visual layouts, please open an issue in the public [pu-orfe/page-stream](https://github.com/pu-orfe/page-stream) repository. Licensed under MIT.
