#!/usr/bin/env node
/// <reference types="node" />
// Node and CLI imports
import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import os from 'node:os';

interface StreamOptions {
  url: string;
  ingest: string; // e.g. srt://host:port?streamid=... or rtmp://...
  width: number;
  height: number;
  fps: number;
  preset: string;
  videoBitrate: string;
  audioBitrate: string;
  format: string; // container format, e.g. mpegts, flv
  extraFfmpeg: string[];
  headless: boolean;
  fullscreen: boolean; // launch chromium fullscreen (hide window chrome)
  appMode: boolean; // use Chromium --app= (minimal UI, no address bar)
  reconnectAttempts: number; // 0 = infinite
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  healthIntervalSeconds: number; // 0 = disabled
  autoRefreshSeconds: number; // 0 = disabled
  suppressAutomationBanner: boolean; // hide "controlled by automated test software" message
  autoDismissInfobar: boolean; // attempt to close top automation infobar via xdotool (best effort)
  cropInfobar: number; // if >0, crop this many pixels from top of capture to hide infobar
  injectCss?: string; // path to CSS file to inject into the page
  injectJs?: string; // path to JS file to inject into the page
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEMO_PAGE = path.join(__dirname, '..', 'demo', 'index.html');

export class PageStreamer {
  private browser?: Browser;
  private page?: Page;
  private persistentContext?: BrowserContext;
  private ff?: ChildProcessWithoutNullStreams;
  private refreshing = false;
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private startTime = Date.now();
  private lastFfmpegExitCode: number | null = null;
  private autoRefreshTimer?: NodeJS.Timeout;
  private userDataDir?: string;
  private suppressApplied = false;
  private xdotoolTried = false;

  constructor(private opts: StreamOptions) {}

  async start() {
    if (!fs.existsSync(this.opts.url) && !/^https?:/i.test(this.opts.url)) {
      console.warn(`Provided URL not found locally, falling back to demo page: ${this.opts.url}`);
      this.opts.url = DEMO_PAGE;
    }
    await this.launchBrowser();
    await this.launchFfmpeg();
    this.startHealthLoop();
  }

  async launchBrowser() {
    const commonArgs = [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      `--window-size=${this.opts.width},${this.opts.height}`,
      ...(this.opts.fullscreen ? [
        '--kiosk',
        '--start-fullscreen',
        '--hide-scrollbars',
        '--disable-infobars',
        '--autoplay-policy=no-user-gesture-required'
      ] : [])
    ];
    const startUrl = this.toFileUrlIfNeeded(this.opts.url);
    if (this.opts.appMode) {
      // Use persistent context so Chromium honors --app without spawning an unattached window.
      this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgstream-')); // ephemeral profile
      commonArgs.push(`--app=${startUrl}`);
      commonArgs.push('--no-first-run','--no-default-browser-check','--disable-features=TranslateUI','--disable-translate');
      if (this.opts.suppressAutomationBanner) {
        // Additional blink feature disable to reduce automation indicators
        commonArgs.push('--disable-blink-features=AutomationControlled');
      }
      this.persistentContext = await chromium.launchPersistentContext(this.userDataDir, {
        headless: this.opts.headless,
        args: commonArgs,
        viewport: { width: this.opts.width, height: this.opts.height }
      });
      if (this.opts.suppressAutomationBanner) {
        await this.installAutomationBannerSuppression(this.persistentContext);
      }
      // First page should be the app window.
      let pageFound = this.persistentContext.pages()[0];
      if (!pageFound) {
        pageFound = await this.persistentContext.newPage();
        await pageFound.goto(startUrl);
      }
      this.page = pageFound;
      // Expose browser object for unified shutdown logic
  const b = this.persistentContext.browser();
  if (b) this.browser = b;
    } else {
      this.browser = await chromium.launch({ headless: this.opts.headless, args: commonArgs });
      const ctx = await this.browser.newContext({ viewport: { width: this.opts.width, height: this.opts.height } });
      if (this.opts.suppressAutomationBanner) {
        await this.installAutomationBannerSuppression(ctx);
      }
      this.page = await ctx.newPage();
      await this.page.goto(startUrl);
    }
    // Inject custom CSS if provided
    if (this.opts.injectCss && this.page) {
      try {
        const cssContent = await readFileWithRetry(this.opts.injectCss);
        await this.page.addStyleTag({ content: cssContent });
        console.log(`Injected CSS from ${this.opts.injectCss}`);
      } catch (err) {
        console.error(`Failed to inject CSS from ${this.opts.injectCss}:`, err);
      }
    }
    // Inject custom JS if provided
    if (this.opts.injectJs && this.page) {
      try {
        const jsContent = fs.readFileSync(this.opts.injectJs, 'utf8');
        await this.page.addScriptTag({ content: jsContent });
        console.log(`Injected JS from ${this.opts.injectJs}`);
      } catch (err) {
        console.error(`Failed to inject JS from ${this.opts.injectJs}:`, err);
      }
    }
    if (this.opts.fullscreen && this.page) {
      try {
        await this.page.evaluate(() => { try { document.body?.focus(); } catch {} });
        await this.page.evaluate(() => {
          const el: any = document.documentElement; if (el?.requestFullscreen) el.requestFullscreen().catch(()=>{});
        });
        try { await this.page.keyboard.press('F11'); } catch {}
      } catch {
        // ignore
      }
    }
    // Schedule xdotool-based infobar dismissal if requested
    if (this.opts.autoDismissInfobar) {
      this.tryDismissInfobarLoop().catch(err => console.error('xdotool infobar dismissal failed', err));
    }
  }

  private async installAutomationBannerSuppression(ctx: BrowserContext) {
    if (this.suppressApplied) return;
    this.suppressApplied = true;
    const inject = () => {
      try {
        // Remove automation UI indicators repeatedly using MutationObserver
        const kill = () => {
          const needle = /is being controlled by automated test software/i;
          const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const el = walker.currentNode as HTMLElement;
            if (!el) continue;
            const txt = el.innerText || '';
            if (needle.test(txt)) {
              el.style.display = 'none';
              el.setAttribute('data-automation-hidden','1');
            }
          }
        };
        kill();
        const mo = new MutationObserver(() => kill());
        mo.observe(document.documentElement, { childList: true, subtree: true });
        // Also override navigator.webdriver property common detection
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {}
    };
    await ctx.addInitScript(inject);
    // Apply to any already existing pages
    for (const p of ctx.pages()) {
      try { await p.addInitScript(inject); await p.evaluate(() => {}); } catch {}
    }
    ctx.on('page', page => {
      page.addInitScript(inject).catch(()=>{});
      page.on('domcontentloaded', () => {
        page.evaluate(() => {}).catch(()=>{});
      });
    });
  }

  toFileUrlIfNeeded(u: string) {
    if (/^https?:/i.test(u)) return u;
    return 'file://' + path.resolve(u);
  }

  buildFfmpegArgs(): string[] {
    // Build ffmpeg command with correct ordering: all inputs first, then encoding/output options.
    const { width, height, fps, ingest, preset, videoBitrate, audioBitrate, format, extraFfmpeg } = this.opts;
    const display = process.env.DISPLAY || ':99';
    const args: string[] = [
      // Video input (X11)
      '-f','x11grab',
      '-framerate', String(fps),
      '-video_size', `${width}x${height}`,
      '-i', display,
    ];
    if (audioBitrate) {
      // Silent audio source input before specifying output codecs
      args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=44100');
    }
    // Encoding options (apply to outputs, must come after all -i inputs)
    args.push(
      '-c:v','libx264',
      '-preset', preset,
      '-tune','zerolatency',
      '-pix_fmt','yuv420p',
      '-b:v', videoBitrate,
      '-maxrate', videoBitrate,
      '-bufsize', (parseInt(videoBitrate) * 2) + 'k',
      '-g', String(fps * 2)
    );
    if (audioBitrate) {
      args.push('-c:a','aac','-b:a', audioBitrate);
    }
    // Inject crop filter if requested (before user-supplied extra args so they can still override with -filter_complex later)
    if (this.opts.cropInfobar && this.opts.cropInfobar > 0) {
      const cropH = this.opts.cropInfobar;
      const newHeight = this.opts.height - cropH;
      if (newHeight > 0) {
        // Prepend / merge with existing -vf if present in extra args would be complex; simpler: add -vf here if user didn't already.
        // If user also supplies -vf later ffmpeg will use the last occurrence, so we only add if not present in extraFfmpeg.
        const hasUserVf = extraFfmpeg.some(a => a === '-vf' || a === '-filter:v' || a === '-filter_complex');
        if (!hasUserVf) {
          args.push('-vf', `crop=${width}:${newHeight}:0:${cropH}`);
        } else {
          // If user has its own -vf we can attempt to chain via filter_complex but that's riskier; log advisory.
          console.warn('[crop-infobar] User-provided video filters detected; automatic crop not injected. Add crop manually if needed (crop=w:h:0:TOP).');
        }
      } else {
        console.warn(`[crop-infobar] Requested crop (${cropH}px) >= height (${this.opts.height}px); ignoring.`);
      }
    }
    // Extra user-supplied args before container/output format
    args.push(...extraFfmpeg);
    args.push('-f', format, ingest);
    return args;
  }

  async launchFfmpeg() {
    const args = this.buildFfmpegArgs();
    const child = spawn('ffmpeg', args, { stdio: ['ignore','inherit','inherit'] });
    this.ff = child as unknown as ChildProcessWithoutNullStreams; // relaxed cast
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      console.log(`ffmpeg exited code=${code} signal=${signal}`);
      this.lastFfmpegExitCode = code;
      this.scheduleRestartIfNeeded(code);
    });
  }

  async refreshPage() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      if (!this.page) return;
      console.log('Refreshing streamed page...');
      await this.page.reload({ waitUntil: 'networkidle' });
      // Re-inject custom CSS/JS after reload
      if (this.opts.injectCss) {
        try {
          const cssContent = await readFileWithRetry(this.opts.injectCss);
          await this.page.addStyleTag({ content: cssContent });
        } catch (err) {
          console.error(`Failed to re-inject CSS after refresh:`, err);
        }
      }
      if (this.opts.injectJs) {
        try {
          const jsContent = await readFileWithRetry(this.opts.injectJs);
          await this.page.addScriptTag({ content: jsContent });
        } catch (err) {
          console.error(`Failed to re-inject JS after refresh:`, err);
        }
      }
      console.log('Refresh complete.');
    } finally {
      this.refreshing = false;
    }
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearTimeout(this.healthTimer);
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    await this.page?.close();
    if (this.persistentContext) {
      await this.persistentContext.close();
    } else {
      await this.browser?.close();
    }
    if (this.userDataDir) {
      // Best-effort cleanup of the temporary profile directory
      try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch {}
    }
    if (this.ff && !this.ff.killed) this.ff.kill('SIGINT');
  }

  private scheduleRestartIfNeeded(code: number | null) {
    const { ingest, reconnectAttempts, reconnectInitialDelayMs, reconnectMaxDelayMs } = this.opts;
    if (this.stopping) return;
    if (code === 0) return; // clean exit
    const retryProtocol = this.isRetryProtocol(ingest);
    if (!retryProtocol) {
      console.error(`ffmpeg exited (code=${code}). Ingest protocol not configured for auto-retry. Exiting with code 11.`);
      // Give the event loop a tick so logs flush
      setTimeout(() => process.exit(11), 10);
      return;
    }
    // Retry path
    if (reconnectAttempts !== 0 && this.restartAttempt >= reconnectAttempts) {
      console.error(`${this.protocolName(ingest)} reconnect attempts exhausted (${this.restartAttempt}/${reconnectAttempts}). Giving up.`);
      this.printFailureHelp(ingest);
      setTimeout(()=> process.exit(10), 10);
      return;
    }
    this.restartAttempt += 1;
    const delay = Math.min(reconnectInitialDelayMs * Math.pow(2, this.restartAttempt - 1), reconnectMaxDelayMs);
    console.warn(`ffmpeg exited (code=${code}). Scheduling ${this.protocolName(ingest)} reconnect attempt ${this.restartAttempt} in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      if (this.stopping) return;
      this.launchFfmpeg().catch(err => console.error('ffmpeg restart failed', err));
    }, delay);
  }

  private printSrtFailureHelp(ingest: string) {
    // Attempt to extract host:port for guidance
    const match = ingest.match(/^srt:\/\/(\[[^\]]+\]|[^:\/?]+)(?::(\d+))?/i);
    const host = match?.[1] || 'HOST';
    const port = match?.[2] || 'PORT';
    console.error('\nSRT connection failed permanently. Troubleshooting suggestions:');
    console.error(`  • Verify the ingest listener is running and accessible: srt://${host}:${port}`);
    console.error('  • Confirm any firewalls / security groups allow UDP on the SRT port.');
    console.error('  • Check that the streamid or query params are correct for the target provider.');
    console.error('  • Test locally:');
    console.error(`      ffmpeg -loglevel info -f mpegts -i "${ingest.replace(/"/g,'\\"')}" -f null -`);
    console.error('  • Or run a local listener to validate output:');
    console.error('      ffmpeg -f mpegts -i "srt://:9000?mode=listener" -f null -');
    console.error('  • Increase verbosity with: --extra-ffmpeg -loglevel verbose');
    console.error('  • Enable infinite retries: --reconnect-attempts 0');
  }

  private printRtmpFailureHelp(ingest: string) {
    console.error('\nRTMP connection failed permanently. Troubleshooting suggestions:');
    console.error('  • Verify the RTMP endpoint is reachable (TCP) and the stream key/path is correct.');
    console.error('  • Check for required application context (e.g. rtmp://host/app/KEY).');
    console.error('  • Validate with a simple publish test:');
    console.error(`      ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i anullsrc -c:v libx264 -t 5 -f flv "${ingest.replace(/"/g,'\\"')}"`);
    console.error('  • Some services require flv muxing: use --format flv');
    console.error('  • Increase verbosity with: --extra-ffmpeg -loglevel verbose');
  }

  private printFailureHelp(ingest: string) {
    if (/^srt:\/\//i.test(ingest)) return this.printSrtFailureHelp(ingest);
    if (/^rtmps?:\/\//i.test(ingest)) return this.printRtmpFailureHelp(ingest);
  }

  private isRetryProtocol(ingest: string) {
    return /^srt:\/\//i.test(ingest) || /^rtmps?:\/\//i.test(ingest);
  }

  private protocolName(ingest: string) {
    if (/^srt:\/\//i.test(ingest)) return 'SRT';
    if (/^rtmps?:\/\//i.test(ingest)) return 'RTMP';
    return 'INGEST';
  }

  private startHealthLoop() {
    const { healthIntervalSeconds, ingest } = this.opts;
    if (!healthIntervalSeconds || healthIntervalSeconds <= 0) return;
    const intervalMs = healthIntervalSeconds * 1000;
    this.healthTimer = setInterval(() => {
      const now = Date.now();
      const uptimeSec = ((now - this.startTime) / 1000).toFixed(1);
      const payload = {
        type: 'health',
        ts: new Date().toISOString(),
        uptimeSec: Number(uptimeSec),
        ingest,
        protocol: this.protocolName(ingest),
        restartAttempt: this.restartAttempt,
        lastFfmpegExitCode: this.lastFfmpegExitCode,
        retrying: !!this.restartTimer,
        infobarDismissTried: this.xdotoolTried,
      };
      try {
        console.log('[health]', JSON.stringify(payload));
      } catch (e) {
        // ignore
      }
    }, intervalMs);
  }

  // Attempt to find & close Chromium infobar using xdotool heuristics.
  private async tryDismissInfobarLoop() {
    if (this.xdotoolTried) return; // only schedule once
    this.xdotoolTried = true;
    const { spawn } = await import('node:child_process');
    // Two-tier approach:
    // 1. Use wmctrl to focus Chromium app windows (brings to front) to ensure clicks register.
    // 2. Use xdotool with geometry-based sweep (existing logic).
    const cmd = 'xdotool';
    const wmctrl = 'wmctrl';
    const focusChromium = () => new Promise<void>(res => {
      const proc = spawn(wmctrl, ['-lx']);
      let out = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.on('exit', () => {
        out.split(/\n/).forEach(line => {
          // Typical format: 0x03600007  0 host chromium.Chromium  Title
          if (/chromium/i.test(line)) {
            const wid = line.split(/\s+/)[0];
            if (wid) spawn(wmctrl, ['-ia', wid]).on('error',()=>{});
          }
        });
        res();
      });
      proc.on('error', () => res());
    });
    const attempt = (iteration: number) => new Promise<void>(resolve => {
      const search = spawn(cmd, ['search','--classname','chromium']);
      let buf = '';
      search.stdout.on('data', d => buf += d.toString());
      const done = () => resolve();
      search.on('error', done);
      search.on('exit', code => {
        if (code !== 0 || !buf.trim()) return done();
        const wins = buf.trim().split(/\s+/).slice(0,8);
        wins.forEach(w => {
          // Retrieve geometry to tailor click positions (best-effort)
          const geo = spawn(cmd, ['getwindowgeometry','--shell', w]);
          let gBuf = '';
          geo.stdout.on('data', d => gBuf += d.toString());
          geo.on('exit', () => {
            // Parse WIDTH=, HEIGHT=
            let W = this.opts.width; let H = this.opts.height;
            const wMatch = gBuf.match(/WIDTH=(\d+)/); if (wMatch) W = parseInt(wMatch[1],10);
            const hMatch = gBuf.match(/HEIGHT=(\d+)/); if (hMatch) H = parseInt(hMatch[1],10);
            // Candidate positions: sweep top-right area plus legacy center click.
            const xs: number[] = [];
            const rightOffsets = [20, 40, 60, 90];
            rightOffsets.forEach(off => { if (W - off > 0) xs.push(W - off); });
            xs.push(Math.floor(W/2)); // fallback center
            const ys = [10, 14, 18, 22]; // different possible infobar heights / scaling
            // For each combination issue a quick move + click.
            xs.forEach(x => ys.forEach(y => {
              const seq: string[][] = [
                ['mousemove','--window', w, String(x), String(y)],
                ['click','1']
              ];
              seq.forEach(args => spawn(cmd, args).on('error',()=>{}));
            }));
            // Also try ESC key (occasionally closes transient bars)
            spawn(cmd, ['key','--window', w, 'Escape']).on('error',()=>{});
          });
        });
        resolve();
      });
    });
    // Try multiple spaced attempts allowing window + infobar to settle / reappear.
    const attempts = 7;
    for (let i=0;i<attempts;i++) {
      await new Promise(r => setTimeout(r, 700 + i*450));
      await focusChromium();
      await attempt(i);
    }
  }
}

async function main() {
  const program = new Command();
  program
    .name('page-stream')
    .description('Stream a web page (local file or URL) to an ingest (SRT/RTMP/etc)')
    .requiredOption('-i, --ingest <uri>', 'Ingest URI (e.g. srt://host:port?streamid=... or rtmp://...)')
    .option('-u, --url <url>', 'Page URL or local file path', DEMO_PAGE)
  .option('--width <n>', 'Width', (v: string)=>parseInt(v,10), 1280)
  .option('--height <n>', 'Height', (v: string)=>parseInt(v,10), 720)
  .option('--fps <n>', 'Frames per second', (v: string)=>parseInt(v,10), 30)
    .option('--preset <p>', 'x264 preset', 'veryfast')
    .option('--video-bitrate <kbps>', 'Video bitrate (k)', '2500k')
    .option('--audio-bitrate <kbps>', 'Audio bitrate (k)', '128k')
    .option('--format <fmt>', 'Output container format', 'mpegts')
    .option('--extra-ffmpeg <args...>', 'Extra raw ffmpeg args appended before output')
    .option('--no-headless', 'Disable headless (show window if DISPLAY)')
    .option('--no-fullscreen', 'Disable fullscreen (windowed)')
  .option('--no-app-mode', 'Disable Chromium app mode (show full browser UI)')
  .option('--no-suppress-automation-banner', 'Do not hide Chromium automation banner')
  .option('--auto-dismiss-infobar', 'Attempt to auto-dismiss Chromium automation infobar using xdotool (best effort)', false)
  .option('--crop-infobar <px>', 'Crop this many pixels from the top of the captured video (removes persistent infobar rather than clicking it)', (v: string)=>parseInt(v,10), 0)
  .option('--inject-css <file>', 'Inject CSS from file into the page')
  .option('--inject-js <file>', 'Inject JavaScript from file into the page')
    .option('--refresh-signal <sig>', 'POSIX signal to trigger page refresh', 'SIGHUP')
    .option('--graceful-stop-signal <sig>', 'Signal to gracefully stop', 'SIGTERM')
  .option('--reconnect-attempts <n>', 'Max reconnect attempts for SRT (0 = infinite)', '0')
  .option('--reconnect-initial-delay-ms <n>', 'Initial reconnect delay (ms)', '1000')
  .option('--reconnect-max-delay-ms <n>', 'Max reconnect delay (ms)', '15000')
  .option('--health-interval-seconds <n>', 'Interval for structured health log lines (0=disable)', '30')
  .option('--auto-refresh-seconds <n>', 'Automatically refresh the page every N seconds (0=disable)', '0')
    .parse(process.argv);

  const opts = program.opts();
  // Automatic display size fallback: If env WIDTH/HEIGHT (Xvfb) differ from requested capture size,
  // override the CLI width/height to prevent x11grab mismatch errors.
  const envW = process.env.WIDTH ? parseInt(process.env.WIDTH,10) : undefined;
  const envH = process.env.HEIGHT ? parseInt(process.env.HEIGHT,10) : undefined;
  if (envW && envH && (envW !== opts.width || envH !== opts.height)) {
    console.warn(`[display-mismatch] WARNING: Requested capture ${opts.width}x${opts.height} overridden to match Xvfb env ${envW}x${envH}.`);
    console.warn('  Reason: differing sizes cause ffmpeg x11grab errors (capture area outside screen).');
    console.warn('  To control resolution explicitly either:');
    console.warn('    • Pass matching --width/--height OR');
    console.warn('    • Unset WIDTH/HEIGHT env vars so CLI values apply, OR');
    console.warn('    • Set both env and CLI to the same intended resolution.');
    opts.width = envW;
    opts.height = envH;
  }
  const streamer = new PageStreamer({
    url: opts.url,
    ingest: opts.ingest,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    preset: opts.preset,
    videoBitrate: opts.videoBitrate,
    audioBitrate: opts.audioBitrate,
    format: opts.format,
    extraFfmpeg: opts.extraFfmpeg || [],
    headless: false, // force non-headless so a window is rendered to Xvfb for x11grab
    fullscreen: opts.fullscreen !== false,
    appMode: opts.appMode !== false,
    reconnectAttempts: parseInt(opts.reconnectAttempts, 10),
    reconnectInitialDelayMs: parseInt(opts.reconnectInitialDelayMs, 10),
    reconnectMaxDelayMs: parseInt(opts.reconnectMaxDelayMs, 10),
    healthIntervalSeconds: parseInt(opts.healthIntervalSeconds, 10),
    autoRefreshSeconds: parseInt(opts.autoRefreshSeconds, 10),
    suppressAutomationBanner: opts.suppressAutomationBanner !== false,
    autoDismissInfobar: !!opts.autoDismissInfobar,
    cropInfobar: parseInt(opts.cropInfobar,10) || 0,
    injectCss: opts.injectCss,
    injectJs: opts.injectJs,
  });


  // Print early log before heavy startup so tests can assert output.
  console.log(`Streaming page '${opts.url}' to ingest '${opts.ingest}' (${opts.width}x${opts.height}@${opts.fps}fps)`);

  if (process.env.PAGE_STREAM_TEST_MODE) {
    console.log('PAGE_STREAM_TEST_MODE enabled: skipping browser/ffmpeg startup.');
  } else {
    await streamer.start();
    // Set up automatic refresh interval if configured
    if (streamer['opts'].autoRefreshSeconds && streamer['opts'].autoRefreshSeconds > 0) {
      const secs = streamer['opts'].autoRefreshSeconds;
      (streamer as any).autoRefreshTimer = setInterval(() => {
        streamer.refreshPage().catch(err => console.error('Auto-refresh failed', err));
      }, secs * 1000);
      console.log(`Auto-refresh enabled: every ${secs} seconds.`);
    }
  }

  // Refresh on signal
  process.on(opts.refreshSignal, () => {
    streamer.refreshPage().catch(err => console.error('Refresh failed', err));
  });

  const stop = async () => {
    console.log('Stopping...');
    await streamer.stop();
    process.exit(0);
  };
  process.on(opts.gracefulStopSignal, stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}

export async function readFileWithRetry(filePath: string, retries = 3, delayMs = 100): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err: any) {
      if (err.code === 'ENOENT' && i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`File not found after ${retries} retries: ${filePath}`);
}
