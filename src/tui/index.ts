#!/usr/bin/env node
import readline from 'node:readline';

const API_URL = process.env.CONTROL_API_URL || 'http://localhost:3000';

let selectedIndex = 0;
let streams: any[] = [];
let errorMsg = '';
let statusMsg = '';
let logBuffer: string = '';

async function fetchJson(endpoint: string, method = 'GET', body?: any) {
  try {
    const res = await fetch(`${API_URL}${endpoint}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(800) // fast timeout
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.headers.get('content-type')?.includes('application/json')) {
      return await res.json();
    }
    return await res.text();
  } catch (err: any) {
    throw new Error(`Failed to contact Control API: ${err.message}`);
  }
}

async function updateData() {
  try {
    streams = await fetchJson('/api/streams');
    errorMsg = '';
    
    // Also fetch logs for selected stream
    if (streams.length > 0) {
      if (selectedIndex >= streams.length) selectedIndex = streams.length - 1;
      const current = streams[selectedIndex];
      try {
        const rawLogs = await fetchJson(`/api/streams/${current.id}/logs`);
        const lines = rawLogs.split('\n').filter(Boolean);
        logBuffer = lines.slice(-8).join('\n'); // keep last 8 lines
      } catch {
        logBuffer = 'Could not fetch logs.';
      }
    }
  } catch (err: any) {
    errorMsg = err.message;
  }
}

function render() {
  // Clear screen and move cursor to top-left
  process.stdout.write('\x1B[2J\x1B[H');
  
  // Header
  console.log('\x1b[36m%s\x1b[0m', ' ============================================================================');
  console.log('\x1b[36m%s\x1b[0m', '   PAGE STREAM CONTROL PLANE - TERMINAL UI');
  console.log('\x1b[36m%s\x1b[0m', ' ============================================================================');
  console.log(` API Endpoint: \x1b[35m${API_URL}\x1b[0m | Time: ${new Date().toLocaleTimeString()}\n`);

  if (errorMsg) {
    console.log('\x1b[41m\x1b[37m%s\x1b[0m\n', ` ERROR: ${errorMsg} `);
    console.log(' Check if the Control API server is running.');
    console.log(' Press [q] to exit.');
    return;
  }

  if (streams.length === 0) {
    console.log(' Loading stream data...');
    return;
  }

  // Draw Stream List
  console.log('\x1b[1m%-22s %-12s %-10s %-12s\x1b[0m', 'STREAM ID', 'STATUS', 'UPTIME', 'RECONNECTS');
  console.log('-'.repeat(60));

  streams.forEach((s, idx) => {
    let statusText = 'STOPPED';
    let statusColor = '\x1b[31m'; // Red
    
    if (s.status === 'running') {
      statusText = 'RUNNING';
      statusColor = '\x1b[32m'; // Green
    } else if (s.status === 'retrying') {
      statusText = 'RETRYING';
      statusColor = '\x1b[33m'; // Yellow
    } else if (s.status === 'unhealthy') {
      statusText = 'UNHEALTHY';
      statusColor = '\x1b[31m'; // Red
    }

    const isSelected = idx === selectedIndex;
    const prefix = isSelected ? '\x1b[47m\x1b[30m > \x1b[0m ' : '   ';
    
    const row = `${s.id.padEnd(19)} ${statusColor}${statusText.padEnd(11)}\x1b[0m ${(s.uptimeSec + 's').padEnd(9)} ${String(s.reconnectAttempts).padEnd(10)}`;
    
    if (isSelected) {
      console.log(`${prefix}\x1b[1m\x1b[34m%s\x1b[0m`, row);
    } else {
      console.log(`${prefix}%s`, row);
    }
  });

  console.log('-'.repeat(60));
  
  // Draw Details Panel
  const selected = streams[selectedIndex];
  if (selected) {
    console.log('\n\x1b[1m\x1b[35m=== STREAM PROPERTIES (%s) ===\x1b[0m', selected.id);
    console.log(` Target URL:  \x1b[34m${selected.url}\x1b[0m`);
    console.log(` Ingest URI:  \x1b[34m${selected.ingest}\x1b[0m`);
    console.log(` Last Exit:   ${selected.lastExitCode ?? 'None (Healthy)'}`);
    
    console.log('\n\x1b[1m\x1b[33m=== RECENT LOG LINES ===\x1b[0m');
    console.log(logBuffer || 'No logs.');
  }

  // Draw Status Message
  if (statusMsg) {
    console.log('\n\x1b[42m\x1b[30m%s\x1b[0m', ` ${statusMsg} `);
  } else {
    console.log('\n');
  }

  // Footer Legend
  console.log('\x1b[90m%s\x1b[0m', ' ────────────────────────────────────────────────────────────');
  console.log('\x1b[1m Navigation: [↑/↓] Select Stream | Actions: [r] Refresh page | [R] Restart stream');
  console.log('\x1b[1m General:    [q] Quit TUI        |          [u] Set URL');
}

// Handle keys
function setupInput() {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  stdin.on('data', async (key: string) => {
    // ctrl-c or q to exit
    if (key === '\u0003' || key === 'q') {
      process.stdout.write('\x1B[2J\x1B[H'); // clear screen
      process.exit(0);
    }

    // Up arrow
    if (key === '\u001b[A') {
      if (selectedIndex > 0) {
        selectedIndex--;
        statusMsg = '';
        render();
      }
    }
    // Down arrow
    if (key === '\u001b[B') {
      if (selectedIndex < streams.length - 1) {
        selectedIndex++;
        statusMsg = '';
        render();
      }
    }

    const current = streams[selectedIndex];
    if (!current) return;

    // 'r' to refresh
    if (key === 'r') {
      statusMsg = `Triggering reload for ${current.id}...`;
      render();
      try {
        const res = await fetchJson(`/api/streams/${current.id}/refresh`, 'POST');
        statusMsg = res.success ? `Successfully reloaded ${current.id}!` : `Failed to reload ${current.id}.`;
      } catch (err: any) {
        statusMsg = `Error reloading: ${err.message}`;
      }
      await updateData();
      render();
    }

    // 'R' to restart
    if (key === 'R') {
      statusMsg = `Triggering restart for ${current.id}...`;
      render();
      try {
        const res = await fetchJson(`/api/streams/${current.id}/restart`, 'POST');
        statusMsg = res.success ? `Successfully restarted ${current.id}!` : `Failed to restart ${current.id}.`;
      } catch (err: any) {
        statusMsg = `Error restarting: ${err.message}`;
      }
      await updateData();
      render();
    }

    // 'u' to edit URL
    if (key === 'u') {
      stdin.setRawMode(false);
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      console.log('\n');
      rl.question(`Enter new URL for ${current.id}: `, async (newUrl) => {
        rl.close();
        stdin.setRawMode(true);
        stdin.resume();
        if (newUrl.trim()) {
          statusMsg = `Setting URL to ${newUrl}...`;
          render();
          try {
            const res = await fetchJson(`/api/streams/${current.id}/url`, 'POST', { url: newUrl.trim() });
            statusMsg = res.success ? `Successfully set URL for ${current.id}!` : `Failed to set URL for ${current.id}.`;
          } catch (err: any) {
            statusMsg = `Error setting URL: ${err.message}`;
          }
        }
        await updateData();
        render();
      });
    }
  });
}

async function loop() {
  await updateData();
  render();
  setTimeout(loop, 1500); // refresh UI every 1.5 seconds
}

console.log('Connecting to Control API...');
setupInput();
loop().catch(err => {
  console.error(err);
  process.exit(1);
});
