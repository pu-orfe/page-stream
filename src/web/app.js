/* ============================================================================
   Page Stream Control Plane - JavaScript Frontend Controller
   ============================================================================ */

const API_BASE = '/api';
let selectedStreamId = null;
let streamsData = [];
let pollInterval = null;

// On Page Load
document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

function initDashboard() {
  refreshAllData();
  // Poll data every 2.5 seconds
  pollInterval = setInterval(refreshAllData, 2500);

  // Setup ambient animation reactions
  const body = document.body;
  body.addEventListener('mousemove', (e) => {
    const orb1 = document.getElementById('glow-orb-1');
    const orb2 = document.getElementById('glow-orb-2');
    if (orb1 && orb2) {
      const x = (e.clientX / window.innerWidth - 0.5) * 50;
      const y = (e.clientY / window.innerHeight - 0.5) * 50;
      orb1.style.transform = `translate(${x}px, ${y}px)`;
      orb2.style.transform = `translate(${-x}px, ${-y}px)`;
    }
  });
}

// Fetch stats and render
async function refreshAllData() {
  try {
    const res = await fetch(`${API_BASE}/streams`);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();
    streamsData = data;
    
    updateAPIStatus(true);
    updateMetrics(data);
    renderStreams(data);
    
    // Automatically select first stream if none is selected
    if (!selectedStreamId && data.length > 0) {
      selectStream(data[0].id);
    } else if (selectedStreamId) {
      // Refresh current log display if selected
      const current = data.find(s => s.id === selectedStreamId);
      if (current) {
        updateInspectorMeta(current);
      }
    }
  } catch (err) {
    console.error('Failed to fetch stream states:', err);
    updateAPIStatus(false);
  }
}

function updateAPIStatus(connected) {
  const text = document.getElementById('api-status-text');
  const dot = document.querySelector('.pulse-dot');
  if (connected) {
    text.textContent = 'Connected to API';
    dot.className = 'pulse-dot green';
  } else {
    text.textContent = 'API Disconnected';
    dot.className = 'pulse-dot';
    dot.style.backgroundColor = 'var(--accent-red)';
  }
}

function updateMetrics(streams) {
  const activeCountEl = document.getElementById('active-count');
  const totalUptimeEl = document.getElementById('total-uptime');
  const controlModeEl = document.getElementById('control-mode');

  // Active Count
  const runningCount = streams.filter(s => s.status === 'running').length;
  activeCountEl.textContent = runningCount;

  // Max Uptime as representative uptime
  const maxUptime = streams.reduce((max, s) => s.uptimeSec > max ? s.uptimeSec : max, 0);
  const minutes = Math.floor(maxUptime / 60);
  totalUptimeEl.textContent = `${minutes}m`;

  // Detect environment (usually standard mock fallback if no docker present)
  // We can infer mock state from the endpoints or response
  const isMock = streams.some(s => s.id === 'standard-2' && s.reconnectAttempts === 2);
  controlModeEl.textContent = isMock ? 'Simulated' : 'Docker';
}

function renderStreams(streams) {
  const container = document.getElementById('streams-grid-container');
  if (!container) return;

  // Build grid
  let html = '';
  
  if (streams.length === 0) {
    container.innerHTML = `
      <div class="loading-state">
        <p>No streams currently registered in the configuration.</p>
      </div>
    `;
    return;
  }

  streams.forEach(s => {
    const isSelected = s.id === selectedStreamId;
    const statusText = s.status.toUpperCase();
    
    html += `
      <div class="stream-card ${isSelected ? 'selected' : ''}" onclick="selectStream('${s.id}')" data-id="${s.id}">
        <div class="card-top">
          <div class="stream-id-title">${s.id}</div>
          <span class="stream-status-pill ${s.status}">${statusText}</span>
        </div>
        
        <div class="card-body">
          <div class="info-row">
            <span class="info-label">Uptime</span>
            <span class="info-val">${s.uptimeSec}s</span>
          </div>
          <div class="info-row">
            <span class="info-label">Reconnects</span>
            <span class="info-val">${s.reconnectAttempts}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Target URL</span>
            <span class="info-val" title="${s.url}">${s.url}</span>
          </div>
        </div>

        <div class="card-actions">
          <button class="btn btn-secondary btn-sm" onclick="triggerRefresh(event, '${s.id}')">
            Reload Page
          </button>
          <button class="btn btn-secondary btn-sm" onclick="openEditUrl(event, '${s.id}', '${s.url}')">
            Set URL
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Select stream for details panel
function selectStream(id) {
  selectedStreamId = id;
  
  // Highlight selected card in DOM
  document.querySelectorAll('.stream-card').forEach(card => {
    if (card.dataset.id === id) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });

  const stream = streamsData.find(s => s.id === id);
  if (stream) {
    updateInspectorMeta(stream);
    fetchLogs(id);
  }
}

function updateInspectorMeta(stream) {
  document.getElementById('selected-stream-name').textContent = `${stream.id} (${stream.status.toUpperCase()})`;
}

// Fetch logs
async function fetchLogs(id) {
  const consoleEl = document.getElementById('logs-output');
  try {
    const res = await fetch(`${API_BASE}/streams/${id}/logs`);
    if (!res.ok) throw new Error('Logs fetch failed');
    const logs = await res.text();
    
    // Auto-scroll logs only if user is near bottom
    const isAtBottom = consoleEl.scrollHeight - consoleEl.clientHeight <= consoleEl.scrollTop + 30;
    consoleEl.textContent = logs || 'No log lines output yet.';
    if (isAtBottom) {
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  } catch (err) {
    consoleEl.textContent = `Error loading logs for ${id}: ${err.message}`;
  }
}

// Action triggers
async function triggerRefresh(e, id) {
  e.stopPropagation(); // prevent card selection trigger
  const btn = e.target;
  const originalText = btn.textContent;
  
  btn.textContent = 'Reloading...';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/streams/${id}/refresh`, { method: 'POST' });
    const result = await res.json();
    if (result.success) {
      showTemporaryStatus(`Reload page successfully sent to ${id}`);
    } else {
      showTemporaryStatus(`Failed to reload page for ${id}`, true);
    }
  } catch (err) {
    showTemporaryStatus(`Network error triggering reload for ${id}`, true);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
    refreshAllData();
  }
}

// URL editing modal actions
function openEditUrl(e, id, currentUrl) {
  e.stopPropagation(); // prevent selection trigger
  document.getElementById('modal-stream-id').value = id;
  document.getElementById('input-stream-url').value = currentUrl === 'Querying...' ? '' : currentUrl;
  
  const modal = document.getElementById('edit-url-modal');
  modal.classList.add('active');
}

function closeEditModal() {
  document.getElementById('edit-url-modal').classList.remove('active');
}

async function submitUrlUpdate(e) {
  e.preventDefault();
  const id = document.getElementById('modal-stream-id').value;
  const url = document.getElementById('input-stream-url').value.trim();
  
  const submitBtn = document.getElementById('btn-modal-submit');
  submitBtn.textContent = 'Updating...';
  submitBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/streams/${id}/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const result = await res.json();
    
    if (result.success) {
      showTemporaryStatus(`Updated URL for stream: ${id}`);
      closeEditModal();
    } else {
      showTemporaryStatus(`Failed to update URL for ${id}`, true);
    }
  } catch (err) {
    showTemporaryStatus(`Network error updating URL for ${id}`, true);
  } finally {
    submitBtn.textContent = 'Apply Changes';
    submitBtn.disabled = false;
    refreshAllData();
  }
}

// Helper diagnostics log box triggers
function clearInspector() {
  document.getElementById('logs-output').textContent = 'Display cleared.';
}

function copyInspectorLogs() {
  const content = document.getElementById('logs-output').textContent;
  navigator.clipboard.writeText(content);
  showTemporaryStatus('Logs copied to clipboard!');
}

function showTemporaryStatus(message, isError = false) {
  // Simple toast or alert fallback logic
  const alertBar = document.createElement('div');
  alertBar.style.position = 'fixed';
  alertBar.style.bottom = '2rem';
  alertBar.style.right = '2rem';
  alertBar.style.background = isError ? 'var(--accent-red)' : 'var(--accent-purple)';
  alertBar.style.color = '#fff';
  alertBar.style.padding = '0.75rem 1.5rem';
  alertBar.style.borderRadius = '12px';
  alertBar.style.boxShadow = '0 10px 30px rgba(0,0,0,0.3)';
  alertBar.style.zIndex = '200';
  alertBar.style.fontWeight = '600';
  alertBar.style.fontFamily = 'inherit';
  alertBar.textContent = message;

  document.body.appendChild(alertBar);
  setTimeout(() => {
    alertBar.remove();
  }, 3000);
}
