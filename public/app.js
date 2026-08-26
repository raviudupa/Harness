/**
 * Apex Test Harness — Frontend JavaScript
 * Handles OAuth flow, class loading, harness execution, and real-time progress.
 */

// ─── State ────────────────────────────────────────────────
let allClasses = [];
let selectedClass = null;
let currentJobId = null;
let pollInterval = null;
let timerInterval = null;
let timerStart = 0;
let lastProgressIndex = 0;

// ─── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkAuthStatus();
  loadCliOrgs();

  // Check for OAuth callback result
  const params = new URLSearchParams(window.location.search);
  if (params.get('auth') === 'success') {
    showToast('Connected to Salesforce!', 'success');
    window.history.replaceState({}, '', '/');
    checkAuthStatus();
  } else if (params.get('auth') === 'error') {
    showToast('Authentication failed: ' + (params.get('message') || 'Unknown error'), 'error');
    window.history.replaceState({}, '', '/');
  }
});

// ─── SF CLI Integration ──────────────────────────────────
async function loadCliOrgs() {
  const select = document.getElementById('cli-org-select');
  try {
    const res = await fetch('/api/auth/cli/orgs');
    const data = await res.json();
    const orgs = data.orgs || [];

    if (orgs.length === 0) {
      select.innerHTML = '<option value="">No CLI orgs found</option>';
      return;
    }

    select.innerHTML = orgs.map((org) => {
      const label = org.alias !== org.username ? `${org.alias} (${org.username})` : org.username;
      const defaultTag = org.isDefault ? ' ⭐ [Default]' : '';
      return `<option value="${org.alias || org.username}" ${org.isDefault ? 'selected' : ''}>${label}${defaultTag}</option>`;
    }).join('');
  } catch (err) {
    select.innerHTML = '<option value="">Failed to detect CLI orgs</option>';
    console.error('Failed to load CLI orgs:', err);
  }
}

async function connectViaCli() {
  const select = document.getElementById('cli-org-select');
  const targetOrg = select.value;
  const btn = document.getElementById('btn-cli-connect');

  if (!targetOrg) {
    showToast('Please select a Salesforce CLI org', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Connecting...';

  try {
    const res = await fetch('/api/auth/cli/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetOrg }),
    });
    const data = await res.json();

    if (data.success) {
      showToast(`Connected to ${targetOrg}!`, 'success');
      await checkAuthStatus();
    } else {
      showToast('Failed to connect: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast('Error connecting via CLI: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '⚡ Connect Org';
  }
}

// ─── Authentication ───────────────────────────────────────
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();

    const statusEl = document.getElementById('auth-status');
    const btnAuth = document.getElementById('btn-auth');
    const cliContainer = document.getElementById('cli-connect-container');

    if (data.authenticated) {
      const orgDisplay = data.orgInfo?.userId || 'Salesforce';
      statusEl.className = 'auth-status connected';
      statusEl.querySelector('.status-text').textContent = `Connected: ${orgDisplay}`;
      btnAuth.textContent = 'Disconnect';
      btnAuth.className = 'btn btn-danger';
      if (cliContainer) cliContainer.style.opacity = '0.5';
      loadClasses();
    } else {
      statusEl.className = 'auth-status disconnected';
      statusEl.querySelector('.status-text').textContent = 'Disconnected';
      btnAuth.textContent = 'OAuth Login';
      btnAuth.className = 'btn btn-secondary';
      if (cliContainer) cliContainer.style.opacity = '1';
    }
  } catch (err) {
    console.error('Auth status check failed:', err);
  }
}

async function handleAuth() {
  const statusEl = document.getElementById('auth-status');
  const isConnected = statusEl.classList.contains('connected');

  if (isConnected) {
    // Logout
    await fetch('/api/auth/logout', { method: 'POST' });
    showToast('Disconnected from Salesforce', 'info');
    checkAuthStatus();
    resetUI();
  } else {
    // Login
    try {
      const res = await fetch('/api/auth/login');
      const data = await res.json();
      window.location.href = data.authUrl;
    } catch (err) {
      showToast('Failed to start login: ' + err.message, 'error');
    }
  }
}

function resetUI() {
  allClasses = [];
  selectedClass = null;
  document.getElementById('class-list').style.display = 'none';
  document.getElementById('class-list-empty').style.display = 'flex';
  document.getElementById('search-container').style.display = 'none';
  document.getElementById('code-preview-section').style.display = 'none';
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('progress-section').style.display = 'none';
  document.getElementById('right-empty').style.display = 'flex';
}

// ─── Load Classes ─────────────────────────────────────────
async function loadClasses() {
  try {
    const res = await fetch('/api/classes');
    const data = await res.json();
    allClasses = data.classes || [];
    renderClassList(allClasses);
  } catch (err) {
    showToast('Failed to load classes: ' + err.message, 'error');
  }
}

function renderClassList(classes) {
  const list = document.getElementById('class-list');
  const empty = document.getElementById('class-list-empty');
  const searchContainer = document.getElementById('search-container');

  if (classes.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    empty.querySelector('p').textContent = 'No Apex classes found';
    searchContainer.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  list.style.display = 'block';
  searchContainer.style.display = 'block';

  list.innerHTML = classes.map((cls) => `
    <li onclick="selectClass('${cls.name}')" id="class-${cls.name}"
        title="${cls.name} (${cls.lengthWithoutComments} chars)">
      ${cls.name}
    </li>
  `).join('');
}

function filterClasses() {
  const query = document.getElementById('class-search').value.toLowerCase();
  const filtered = allClasses.filter((cls) =>
    cls.name.toLowerCase().includes(query)
  );
  renderClassList(filtered);

  // Re-highlight selected if still in list
  if (selectedClass) {
    const el = document.getElementById(`class-${selectedClass}`);
    if (el) el.classList.add('active');
  }
}

// ─── Select & Preview Class ───────────────────────────────
async function selectClass(className) {
  // Remove previous selection
  document.querySelectorAll('.class-list li.active').forEach((el) =>
    el.classList.remove('active')
  );

  selectedClass = className;
  const el = document.getElementById(`class-${className}`);
  if (el) el.classList.add('active');

  // Show preview section
  const previewSection = document.getElementById('code-preview-section');
  previewSection.style.display = 'flex';
  document.getElementById('preview-class-name').textContent = className;
  document.getElementById('code-preview').querySelector('code').textContent = 'Loading...';
  document.getElementById('btn-generate').disabled = true;

  try {
    const res = await fetch(`/api/classes/${className}`);
    const data = await res.json();
    document.getElementById('code-preview').querySelector('code').textContent = data.body;
    document.getElementById('btn-generate').disabled = false;
  } catch (err) {
    document.getElementById('code-preview').querySelector('code').textContent =
      `Error loading class: ${err.message}`;
  }
}

// ─── Run Harness ──────────────────────────────────────────
async function runHarness() {
  if (!selectedClass) {
    showToast('Please select an Apex class first', 'error');
    return;
  }

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Running...';

  // Show progress, hide empty state
  document.getElementById('right-empty').style.display = 'none';
  document.getElementById('results-section').style.display = 'none';

  const progressSection = document.getElementById('progress-section');
  progressSection.style.display = 'block';
  document.getElementById('progress-steps').innerHTML = '';
  lastProgressIndex = 0;

  // Start timer
  timerStart = Date.now();
  timerInterval = setInterval(updateTimer, 1000);

  try {
    const res = await fetch('/api/harness/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ className: selectedClass }),
    });
    const data = await res.json();
    currentJobId = data.jobId;

    renderActivityCard('fetch', `Harness initialized for ${selectedClass}...`, {});

    // Start polling for progress
    pollInterval = setInterval(() => pollProgress(currentJobId), 1500);
  } catch (err) {
    showToast('Failed to start harness: ' + err.message, 'error');
    resetGenerateButton();
  }
}

async function pollProgress(jobId) {
  try {
    const res = await fetch(`/api/harness/status/${jobId}?since=${lastProgressIndex}`);
    const data = await res.json();

    for (const step of data.progress) {
      renderActivityCard(step.step, step.message, step.data || {});
    }
    lastProgressIndex = data.progressIndex;

    if (data.status !== 'running') {
      clearInterval(pollInterval);
      pollInterval = null;
      clearInterval(timerInterval);
      timerInterval = null;
      if (data.result) renderResults(data.result);
      resetGenerateButton();
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

function addProgressStep(iconOrType, message, cssClassOrData) {
  renderActivityCard('fetch', message, typeof cssClassOrData === 'object' ? cssClassOrData : {});
}

function renderActivityCard(stepType, message, data) {
  const container = document.getElementById('progress-steps');
  const icon = getStepIcon(stepType);
  const cssClass = getStepClass(stepType);

  const phaseEl = document.getElementById('progress-phase');
  if (phaseEl) {
    phaseEl.textContent = getPhaseLabel(stepType);
    phaseEl.className = 'phase-badge phase-' + stepType;
  }

  const detail = buildDetail(stepType, message, data);
  const stepId = 'act-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  const hasDetail = detail.length > 0;

  const card = document.createElement('div');
  card.className = 'activity-card ' + cssClass;
  card.innerHTML =
    '<div class="activity-card-header' + (hasDetail ? ' expandable' : '') + '"' +
    (hasDetail ? ' onclick="toggleActDetail(\'' + stepId + '\')"' : '') + '>' +
      '<div class="activity-card-left">' +
        '<span class="step-icon">' + icon + '</span>' +
        '<span class="step-message">' + escapeHtml(message) + '</span>' +
      '</div>' +
      '<div class="activity-card-right">' +
        '<span class="step-time">' + fmtElapsed() + '</span>' +
        (hasDetail ? '<span class="expand-chevron">▶</span>' : '') +
      '</div>' +
    '</div>' +
    (hasDetail ? '<div id="' + stepId + '" class="activity-detail" style="display:none;">' + detail + '</div>' : '');

  container.appendChild(card);
  container.scrollTop = container.scrollHeight;

  if (stepType === 'analyze' && data.dependencyReport && hasDetail) {
    toggleActDetail(stepId);
  }
}

window.toggleActDetail = function(id) {
  var el = document.getElementById(id);
  if (!el) return;
  var hidden = el.style.display === 'none';
  el.style.display = hidden ? 'block' : 'none';
  var hdr = el.previousElementSibling;
  if (hdr) {
    var ch = hdr.querySelector('.expand-chevron');
    if (ch) ch.textContent = hidden ? '▼' : '▶';
  }
};

function buildDetail(stepType, message, data) {
  if (stepType === 'analyze') return buildAnalyzeDetail(data);
  if (stepType === 'deploy') return buildDeployDetail(data);
  if (stepType === 'test') return buildTestDetail(data);
  if (stepType === 'fix') return buildFixDetail(data);
  if (stepType === 'generate') return buildGenerateDetail(data);
  if (stepType === 'coverage') return buildCoverageDetail(data);
  if (stepType === 'success' || stepType === 'failed') return buildFinalDetail(data);
  return '';
}

function buildAnalyzeDetail(data) {
  var report = data.dependencyReport;
  if (!report) return '';
  var html = '<div class="detail-grid">';

  var objects = report.objects || {};
  var entries = Object.entries(objects);
  if (entries.length > 0) {
    html += '<div class="detail-section"><div class="detail-label">📦 SObjects Detected</div>';
    html += '<table class="detail-table"><thead><tr><th>Object</th><th>Fields</th><th>Required</th><th>Lookups</th><th>VRs</th></tr></thead><tbody>';
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0], meta = entries[i][1];
      html += '<tr><td class="mono">' + escapeHtml(name) + '</td><td>' +
        (meta.usedFields || []).length + '</td><td>' +
        (meta.requiredFields || []).length + '</td><td>' +
        (meta.lookupFields || []).length + '</td><td>' +
        (meta.validationRules || []).length + '</td></tr>';
    }
    html += '</tbody></table></div>';

    var roFields = [];
    for (var j = 0; j < entries.length; j++) {
      var oName = entries[j][0], oMeta = entries[j][1];
      var fm = oMeta.fieldMetadata || {};
      for (var fk of Object.keys(fm)) {
        if (fm[fk].formula || fm[fk].autoNumber || !fm[fk].createable) {
          roFields.push(oName + '.' + fk);
        }
      }
    }
    if (roFields.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">🔒 Read-Only Fields (will NOT be set)</div>';
      html += '<div class="detail-tags">' + roFields.map(function(f) {
        return '<span class="tag tag-readonly">' + escapeHtml(f) + '</span>';
      }).join('') + '</div></div>';
    }
  }

  if (report.insertionOrder && report.insertionOrder.length > 1) {
    html += '<div class="detail-section"><div class="detail-label">📐 Insertion Order</div>';
    html += '<div class="detail-flow">' + report.insertionOrder.map(function(o) {
      return '<span class="flow-node">' + escapeHtml(o) + '</span>';
    }).join('<span class="flow-arrow">→</span>') + '</div></div>';
  }

  var patterns = [];
  if (report.calloutInfo && report.calloutInfo.hasCallout)
    patterns.push({ icon: '🌐', label: 'HTTP Callouts', values: report.calloutInfo.patterns });
  if (report.interfaceInfo && report.interfaceInfo.interfaces && report.interfaceInfo.interfaces.length > 0)
    patterns.push({ icon: '⚙️', label: 'Interfaces', values: report.interfaceInfo.interfaces });
  if (report.annotationInfo && report.annotationInfo.annotations && report.annotationInfo.annotations.length > 0)
    patterns.push({ icon: '🏷️', label: 'Annotations', values: report.annotationInfo.annotations });
  if (report.customSettings && report.customSettings.length > 0)
    patterns.push({ icon: '🔧', label: 'Custom Settings', values: report.customSettings });

  if (patterns.length > 0) {
    html += '<div class="detail-section"><div class="detail-label">🔍 Detected Patterns</div><div class="detail-patterns">';
    for (var p of patterns) {
      html += '<div class="pattern-row"><span class="pattern-icon">' + p.icon + '</span><span class="pattern-label">' + p.label + ':</span>';
      html += '<div class="detail-tags">' + p.values.map(function(v) {
        return '<span class="tag tag-pattern">' + escapeHtml(v) + '</span>';
      }).join('') + '</div></div>';
    }
    html += '</div></div>';
  }

  if (report.sharingModel) {
    html += '<div class="detail-section"><div class="detail-label">🛡️ Sharing: <span class="mono">' + escapeHtml(report.sharingModel) + '</span></div></div>';
  }

  html += '</div>';
  return html;
}

function buildDeployDetail(data) {
  if (data.error) {
    return '<div class="detail-error-box"><div class="detail-label">❌ Compile Error</div><pre class="detail-code-error">' + escapeHtml(data.error) + '</pre></div>';
  }
  if (data.classId) {
    return '<div class="detail-section"><span class="detail-label">✅ Deployed:</span> <span class="mono">' + escapeHtml(data.classId) + '</span></div>';
  }
  return '';
}

function buildTestDetail(data) {
  var results = data.results || [];
  if (results.length === 0) return '';
  var html = '<table class="detail-table"><thead><tr><th>Method</th><th>Status</th><th>Time</th><th>Error</th></tr></thead><tbody>';
  for (var r of results) {
    var cls = r.outcome === 'Pass' ? 'status-pass' : 'status-fail';
    var ico = r.outcome === 'Pass' ? '✅' : '❌';
    html += '<tr class="' + cls + '"><td class="mono">' + escapeHtml(r.methodName) + '</td><td>' + ico + ' ' + escapeHtml(r.outcome) + '</td><td>' + (r.runTime || 0) + 'ms</td><td class="error-cell">' + (r.message ? escapeHtml(r.message).substring(0, 150) : '—') + '</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

function buildFixDetail(data) {
  var failures = data.failures || [];
  if (failures.length === 0) return '';
  var html = '<div class="detail-section"><div class="detail-label">🔧 Sending to Claude:</div>';
  for (var f of failures) {
    html += '<div class="detail-error-item"><span class="mono">' + escapeHtml(f.methodName) + '</span>';
    if (f.message) html += '<pre class="detail-code-error">' + escapeHtml(f.message) + '</pre>';
    html += '</div>';
  }
  return html + '</div>';
}

function buildGenerateDetail(data) {
  var parts = [];
  if (data.testClassName) parts.push('Class: <span class="mono">' + escapeHtml(data.testClassName) + '</span>');
  if (data.tokensUsed) parts.push('Tokens: <strong>' + data.tokensUsed.input.toLocaleString() + '</strong> in / <strong>' + data.tokensUsed.output.toLocaleString() + '</strong> out');
  if (data.charsUsed && (data.charsUsed.input || data.charsUsed.output)) {
    parts.push('Chars: <strong>' + (data.charsUsed.input || 0).toLocaleString() + '</strong> in / <strong>' + (data.charsUsed.output || 0).toLocaleString() + '</strong> out');
  }
  if (data.estimatedCost && data.estimatedCost.totalCost > 0) {
    parts.push('Cost: <strong>$' + data.estimatedCost.totalCost.toFixed(4) + '</strong>');
  }
  return parts.length > 0 ? '<div class="detail-section">' + parts.join(' &nbsp;•&nbsp; ') + '</div>' : '';
}

function buildCoverageDetail(data) {
  var cov = data.coverage;
  if (!cov) return '';
  var pct = cov.coveragePercent;
  var color = pct >= 75 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--error)';
  return '<div class="detail-section">' +
    '<div class="coverage-bar-container"><div class="coverage-bar" style="width:' + Math.min(pct, 100) + '%;background:' + color + ';"></div></div>' +
    '<div class="coverage-stats"><span>Covered: <strong>' + cov.linesCovered + '</strong></span><span>Uncovered: <strong>' + cov.linesUncovered + '</strong></span><span>Total: <strong>' + cov.totalLines + '</strong></span></div></div>';
}

function buildFinalDetail(data) {
  if (data.attempts) return '<div class="detail-section">Completed in <strong>' + data.attempts + '</strong> attempt(s)</div>';
  return '';
}

function getStepIcon(step) {
  var icons = {
    fetch: '📖', check: '🔎', analyze: '🧠', generate: '✨',
    deploy: '🚀', test: '🧪', fix: '🔄', coverage: '📊',
    success: '✅', failed: '❌', error: '💥'
  };
  return icons[step] || '▸';
}

function getStepClass(step) {
  if (step === 'success') return 'card-status-success';
  if (step === 'failed' || step === 'error') return 'card-status-error';
  if (step === 'fix') return 'card-status-fix';
  if (step === 'coverage') return 'card-status-coverage';
  return '';
}

function getPhaseLabel(step) {
  var labels = {
    fetch: 'Fetching Class', check: 'Checking Tests', analyze: 'Analyzing Dependencies',
    generate: 'Generating via Claude', deploy: 'Deploying to Org', test: 'Running Tests',
    fix: 'Auto-Fixing', coverage: 'Checking Coverage', success: 'Complete ✅',
    failed: 'Failed ❌', error: 'Error 💥'
  };
  return labels[step] || step;
}

function fmtElapsed() {
  if (!timerStart) return '';
  var s = Math.floor((Date.now() - timerStart) / 1000);
  return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
}

function updateTimer() {
  var s = Math.floor((Date.now() - timerStart) / 1000);
  document.getElementById('progress-timer').textContent = Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
}

function resetGenerateButton() {
  var btn = document.getElementById('btn-generate');
  btn.disabled = false;
  btn.innerHTML = '🧠 Generate Test';
}

// ─── Render Results ───────────────────────────────────────
function renderResults(result) {
  const section = document.getElementById('results-section');
  section.style.display = 'block';

  // Title
  const title = document.getElementById('results-title');
  title.textContent = result.success
    ? '✅ Test Results — All Passed!'
    : '📊 Test Results';

  // Summary cards
  const summary = document.getElementById('results-summary');
  const s = result.summary || {};
  const coverage = result.coverage || {};
  const target = result.targetPercent || 80;
  const covPct = coverage.coveragePercent != null ? coverage.coveragePercent : 0;
  const coverageColor = covPct >= target ? 'card-success'
    : covPct >= 60 ? 'card-warning' : 'card-error';

  summary.innerHTML = `
    <div class="summary-card card-success">
      <div class="card-value">${s.passed || 0}</div>
      <div class="card-label">Passed</div>
    </div>
    <div class="summary-card card-error">
      <div class="card-value">${s.failed || 0}</div>
      <div class="card-label">Failed</div>
    </div>
    <div class="summary-card ${coverageColor}">
      <div class="card-value">${coverage.coveragePercent != null ? coverage.coveragePercent + '%' : 'N/A'}</div>
      <div class="card-label">Coverage (Target ${target}%)</div>
    </div>
    <div class="summary-card card-info">
      <div class="card-value">${result.attempts || 1}</div>
      <div class="card-label">Attempts</div>
    </div>
    <div class="summary-card card-warning">
      <div class="card-value">${formatDuration(result.duration)}</div>
      <div class="card-label">Duration</div>
    </div>
  `;

  // ─── Usage & Cost Summary ─────────────────────────────
  renderUsageSummary(result);

  // Individual test results
  const testResults = document.getElementById('test-results');
  if (result.testResults && result.testResults.length > 0) {
    testResults.innerHTML = result.testResults.map((t) => `
      <div class="test-method ${t.outcome === 'Pass' ? 'passed' : 'failed'}">
        <span class="method-icon">${t.outcome === 'Pass' ? '✅' : '❌'}</span>
        <div class="method-info">
          <div class="method-name">${escapeHtml(t.methodName)}</div>
          ${t.message ? `<div class="method-error">${escapeHtml(t.message)}</div>` : ''}
          ${t.stackTrace ? `<div class="method-error">${escapeHtml(t.stackTrace)}</div>` : ''}
        </div>
        <span class="method-time">${t.runTime || 0}ms</span>
      </div>
    `).join('');
  } else {
    testResults.innerHTML = '';
  }

  // Generated test code
  if (result.testClassBody) {
    const codeSection = document.getElementById('generated-code-section');
    codeSection.style.display = 'block';
    document.getElementById('generated-code').querySelector('code').textContent = result.testClassBody;
  }

  // Dependency report
  if (result.dependencyReport) {
    const depSection = document.getElementById('dependency-section');
    depSection.style.display = 'block';
    document.getElementById('dependency-details').textContent =
      JSON.stringify(result.dependencyReport, null, 2);
  }
}

// ─── Utilities ────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m`;
}

function copyTestCode() {
  const code = document.getElementById('generated-code').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    showToast('Test class copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

function toggleSection(id) {
  const el = document.getElementById(id);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ─── Usage & Cost Summary Renderer ──────────────────────
function renderUsageSummary(result) {
  // Remove existing usage section if re-rendering
  const existing = document.getElementById('usage-summary-section');
  if (existing) existing.remove();

  const tokens = result.totalTokensUsed || {};
  const chars = result.totalCharsUsed || {};
  const cost = result.estimatedCost || {};
  const modelName = cost.model || 'Unknown';

  const totalTokens = (tokens.input || 0) + (tokens.output || 0);
  const totalChars = (chars.input || 0) + (chars.output || 0);
  const totalCost = cost.totalCost || 0;

  // Don't render if there's no usage data at all
  if (totalTokens === 0 && totalChars === 0) return;

  const usageSection = document.createElement('div');
  usageSection.id = 'usage-summary-section';
  usageSection.className = 'usage-summary-section';

  usageSection.innerHTML = `
    <div class="usage-header">
      <h3>💰 API Usage & Cost</h3>
      <span class="usage-model-badge">${escapeHtml(modelName)}</span>
    </div>
    <div class="usage-grid">
      <div class="usage-card usage-card-tokens">
        <div class="usage-card-icon">🔤</div>
        <div class="usage-card-content">
          <div class="usage-card-value">${totalTokens.toLocaleString()}</div>
          <div class="usage-card-label">Total Tokens</div>
          <div class="usage-card-breakdown">
            <span class="usage-in">↗ ${(tokens.input || 0).toLocaleString()} in</span>
            <span class="usage-out">↙ ${(tokens.output || 0).toLocaleString()} out</span>
          </div>
        </div>
      </div>
      <div class="usage-card usage-card-chars">
        <div class="usage-card-icon">📝</div>
        <div class="usage-card-content">
          <div class="usage-card-value">${totalChars.toLocaleString()}</div>
          <div class="usage-card-label">Total Characters</div>
          <div class="usage-card-breakdown">
            <span class="usage-in">↗ ${(chars.input || 0).toLocaleString()} in</span>
            <span class="usage-out">↙ ${(chars.output || 0).toLocaleString()} out</span>
          </div>
        </div>
      </div>
      <div class="usage-card usage-card-cost">
        <div class="usage-card-icon">💵</div>
        <div class="usage-card-content">
          <div class="usage-card-value">${formatCost(totalCost)}</div>
          <div class="usage-card-label">Estimated Cost</div>
          <div class="usage-card-breakdown">
            <span class="usage-in">↗ $${(cost.inputCost || 0).toFixed(4)} in</span>
            <span class="usage-out">↙ $${(cost.outputCost || 0).toFixed(4)} out</span>
          </div>
        </div>
      </div>
    </div>
    <div class="usage-footer">
      <span>Pricing based on <strong>${escapeHtml(modelName)}</strong> rates • ${result.attempts || 1} API call(s)</span>
    </div>
  `;

  // Insert after the results-summary div
  const summaryEl = document.getElementById('results-summary');
  summaryEl.parentNode.insertBefore(usageSection, summaryEl.nextSibling);
}

function formatCost(dollars) {
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return '$' + dollars.toFixed(4);
  if (dollars < 1) return '$' + dollars.toFixed(3);
  return '$' + dollars.toFixed(2);
}
