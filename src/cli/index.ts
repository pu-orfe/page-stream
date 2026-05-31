#!/usr/bin/env node
import { Command } from 'commander';

const API_URL = process.env.CONTROL_API_URL || 'http://localhost:3000';

async function fetchJson(endpoint: string, method = 'GET', body?: any) {
  try {
    const res = await fetch(`${API_URL}${endpoint}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    if (res.headers.get('content-type')?.includes('application/json')) {
      return await res.json();
    }
    return await res.text();
  } catch (err: any) {
    console.error(`Error connecting to Control API at ${API_URL}:`, err.message);
    process.exit(1);
  }
}

const program = new Command();

program
  .name('page-stream-ctl')
  .description('CLI tool to control and monitor page-stream instances via Control API')
  .version('0.1.0');

program
  .command('list')
  .description('List all active page streams and their status')
  .action(async () => {
    const streams = await fetchJson('/api/streams');
    console.log('\n=== Page Stream Instances ===');
    console.log(
      ''.padEnd(16) +
        '| STATUS'.padEnd(12) +
        '| UPTIME'.padEnd(10) +
        '| RECONNECTS'.padEnd(12) +
        '| TARGET URL'
    );
    console.log('-'.repeat(80));
    
    streams.forEach((s: any) => {
      const statusColor =
        s.status === 'running'
          ? '🟢 running'
          : s.status === 'retrying'
          ? '🟡 retrying'
          : '🔴 stopped';
          
      console.log(
        s.id.padEnd(16) +
          `| ${statusColor.padEnd(15)}` +
          `| ${String(s.uptimeSec) + 's'}`.padEnd(11) +
          `| ${String(s.reconnectAttempts)}`.padEnd(13) +
          `| ${s.url}`
      );
    });
    console.log('');
  });

program
  .command('status <id>')
  .description('Show detailed status of a specific stream')
  .action(async (id) => {
    const streams = await fetchJson('/api/streams');
    const stream = streams.find((s: any) => s.id === id);
    if (!stream) {
      console.error(`Error: Stream with ID "${id}" not found.`);
      process.exit(1);
    }
    console.log('\n=== Stream Details ===');
    console.log(`ID:           ${stream.id}`);
    console.log(`Name:         ${stream.name}`);
    console.log(`Status:       ${stream.status.toUpperCase()}`);
    console.log(`Uptime:       ${stream.uptimeSec} seconds`);
    console.log(`Reconnects:   ${stream.reconnectAttempts}`);
    console.log(`Last Exit:    ${stream.lastExitCode ?? 'N/A'}`);
    console.log(`Target URL:   ${stream.url}`);
    console.log(`Ingest URI:   ${stream.ingest}`);
    console.log('');
  });

program
  .command('refresh <id>')
  .description('Reload page in the stream container')
  .action(async (id) => {
    console.log(`Refreshing page for stream: ${id}...`);
    const result = await fetchJson(`/api/streams/${id}/refresh`, 'POST');
    if (result.success) {
      console.log(`🟢 Successfully triggered refresh for stream: ${id}`);
    } else {
      console.error(`🔴 Failed to trigger refresh for stream: ${id}`);
    }
  });

program
  .command('restart <id>')
  .description('Restart the stream container')
  .action(async (id) => {
    console.log(`Restarting stream: ${id}...`);
    const result = await fetchJson(`/api/streams/${id}/restart`, 'POST');
    if (result.success) {
      console.log(`🟢 Successfully restarted stream: ${id}`);
    } else {
      console.error(`🔴 Failed to restart stream: ${id}`);
    }
  });

program
  .command('set-url <id> <url>')
  .description('Temporarily update target URL for a stream')
  .action(async (id, url) => {
    console.log(`Setting URL for stream: ${id} to "${url}"...`);
    const result = await fetchJson(`/api/streams/${id}/url`, 'POST', { url });
    if (result.success) {
      console.log(`🟢 Successfully set URL for stream: ${id}`);
    } else {
      console.error(`🔴 Failed to set URL for stream: ${id}`);
    }
  });

program
  .command('logs <id>')
  .description('Retrieve recent logs from the stream')
  .action(async (id) => {
    console.log(`=== Recent Logs for stream: ${id} ===`);
    const logs = await fetchJson(`/api/streams/${id}/logs`);
    console.log(logs);
  });

program.parse(process.argv);
