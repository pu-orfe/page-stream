# Copilot / AI Agent Quick Instructions

This file gives focused, actionable guidance so an AI coding agent can be productive immediately in the
page-stream repository. Keep edits concise and reference concrete files/examples below.

1) Big-picture architecture
  - Purpose: headless web-page video streamer - loads a page in Chromium (Playwright) under Xvfb
    and captures the virtual display with `ffmpeg` to push to an ingest (SRT/RTMP/file).
  - Key runtimes: Node.js (>=18), Playwright Chromium, ffmpeg, Xvfb (containerized). See `README.md` for flow.
  - Primary components:
    - CLI and orchestrator: `src/index.ts` (PageStreamer class) — launches browser, builds ffmpeg args, restarts on failure.
    - Container entrypoint: `scripts/entrypoint.sh` — starts Xvfb, optional noVNC, manages `/tmp/page_refresh_fifo` and signals.
    - Demo page: `demo/index.html` — used as a default local content source.

2) Important developer workflows & commands
  - Build: `npm run build` (runs `tsc -p tsconfig.json` then copies `dist/src/index.js` -> `dist/index.js`).
  - Dev run (fast, uses TSX): `npm run dev`.
  - Test: `npm test` (builds first via `pretest`, then runs Node built-in tests with `--loader ts-node/esm`).
  - Quick local run (no Docker):
    - `npm install`
    - `npm run build`
    - `node dist/index.js --ingest srt://127.0.0.1:9000?streamid=demo --url demo/index.html`
  - Container: build `docker build -t page-stream:dev .` then run via examples in `README.md`.

3) Project-specific conventions & gotchas (do not change without running tests)
  - Build artifact location: the CLI runner is expected at `dist/index.js` (the build script copies `dist/src/index.js` there).
  - Test mode: set `PAGE_STREAM_TEST_MODE=1` to skip heavy browser/ffmpeg startup — used by tests in `tests/*.test.ts`.
  - DISPLAY resolution override: env vars `WIDTH`/`HEIGHT` (set by Xvfb in container) will override CLI `--width/--height` — see `src/index.ts` warning block.
  - ffmpeg arg ordering: ffmpeg input options must appear before codec/output options. The project assembles args in `PageStreamer.buildFfmpegArgs()` — be careful if changing ordering or adding args.
  - Crop vs user filters: automatic `--crop-infobar` only injects `-vf` if user didn't supply filters in `--extra-ffmpeg` (see check for `-vf` / `-filter_complex`).

4) Integration points / external dependencies
  - ffmpeg: spawned as `ffmpeg` process; logs printed directly. Restart/backoff logic in `scheduleRestartIfNeeded` uses ingest protocol detection (SRT/RTMP).
  - Playwright Chromium: launched via `playwright.chromium` (persistent context when `--app-mode` used). Remember to run `npx playwright install --with-deps chromium` in dev environments.
  - Xvfb / x11vnc / websockify (noVNC): orchestrated from `scripts/entrypoint.sh`; `ENABLE_NOVNC=1` turns on viewer stack.

5) Observability, signals and exit codes (use in tests/automation)
  - Health lines: periodic JSON health logs are printed prefixed with `[health]` when `--health-interval-seconds` > 0.
  - Page refresh: send `SIGHUP` to the Node process or write to FIFO `/tmp/page_refresh_fifo` in container. Entrypoint also relays container HUP.
  - Exit codes: 0 = graceful, 1 = internal error, 10 = retry protocol exhausted, 11 = non-retry ffmpeg failure. Tests or automation should assert these where relevant.

6) Helpful code locations & examples to reference when editing
  - `src/index.ts` — central logic: CLI parsing, PageStreamer class, ffmpeg arg build, restart logic, injectCss/Js, infobar dismissal heuristics.
  - `scripts/entrypoint.sh` — container startup, FIFO handling, noVNC setup, and signal wiring.
  - `README.md` — contains run examples, Docker instructions, and troubleshooting (copy examples when adding documentation-style output).
  - `tests/*.test.ts` — simple Node test harness using `PAGE_STREAM_TEST_MODE` to avoid launching heavy subsystems.

7) Typical small edits workflow for agents
  - Make minimal TypeScript change(s) in `src/`, run `npm run build`, then `npm test`.
  - If modifying ffmpeg args, add a targeted unit test or exercise via `PAGE_STREAM_TEST_MODE` and assert expected stdout/stderr snippets.
  - If changing container behavior, update `scripts/entrypoint.sh` and document required env vars in `README.md`.

8) When to ask the human
  - Any changes that affect runtime deps (ffmpeg flags, Playwright browser flags, Xvfb behavior) — ask to run a container integration test.
  - Changes to exit codes or retry semantics — ask for intended orchestration behavior (CI/runner expectations).

9) Conda-based build & test (useful when `npm` is not available globally)
  - This repository ships an `environment.yml` that installs Node, ffmpeg and other runtime deps. Use it when the host lacks `npm`/system libs.
  - Create and activate the environment (one-time):
    ```bash
    conda env create -f environment.yml -n page-stream-dev
    conda activate page-stream-dev
    ```
  - Or run commands inside the env without activating:
    ```bash
    conda run -n page-stream-dev npm install --no-audit --no-fund
    conda run -n page-stream-dev npm run build
    conda run -n page-stream-dev npm test
    ```
  - The steps I used in this session (successful build, tests executed):
    - `conda env create -f environment.yml -n page-stream-dev`
    - `conda run -n page-stream-dev npm install --no-audit --no-fund`
    - `conda run -n page-stream-dev npm run build`
    - `conda run -n page-stream-dev npm test`
  - Test caveats observed when running in a minimal environment:
    - One test failed in this run: `tests/novnc-light.test.ts` (timeout waiting for noVNC readiness output). The suite otherwise passed.
    - The noVNC tests expect `websockify` or a fallback HTTP readiness log. If `websockify` or other system tools are missing, some readiness assertions may fail or be skipped.
    - If you encounter failures, try re-running the single failing test to get more logs:
      ```bash
      # run single failing test file
      conda run -n page-stream-dev node --test --loader ts-node/esm tests/novnc-light.test.ts
      ```
  - Use `PAGE_STREAM_TEST_MODE=1` when editing code to avoid launching browser/ffmpeg during fast unit tests. Tests in `tests/*.test.ts` use this env var to run quickly.

If anything here is unclear or you'd like the instructions expanded for a specific agent task (e.g., "add health-check endpoint" or "refactor retry logic"), tell me which area to expand.
