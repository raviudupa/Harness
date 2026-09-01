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
  loadAuditCount();

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
  document.getElementById('btn-fls-check').disabled = true;

  // Hide any previous FLS report
  const flsSection = document.getElementById('fls-report-section');
  if (flsSection) flsSection.style.display = 'none';

  try {
    const res = await fetch(`/api/classes/${className}`);
    const data = await res.json();
    const code = data.body || '';
    document.getElementById('code-preview').querySelector('code').textContent = code;
    document.getElementById('btn-generate').disabled = false;
    document.getElementById('btn-fls-check').disabled = false;

    // Calculate characters with and without blanks
    const withBlanks = code.length;
    const withoutBlanks = code.replace(/\s/g, '').length;
    const blanks = withBlanks - withoutBlanks;
    const lines = code ? code.split('\n').length : 0;

    const elWith = document.getElementById('preview-chars-blanks');
    const elNo = document.getElementById('preview-chars-no-blanks');
    const elSp = document.getElementById('preview-chars-spaces');
    const elLn = document.getElementById('preview-lines');

    if (elWith) elWith.querySelector('.pill-val').textContent = withBlanks.toLocaleString();
    if (elNo) elNo.querySelector('.pill-val').textContent = withoutBlanks.toLocaleString();
    if (elSp) elSp.querySelector('.pill-val').textContent = blanks.toLocaleString();
    if (elLn) elLn.querySelector('.pill-val').textContent = lines.toLocaleString();
  } catch (err) {
    document.getElementById('code-preview').querySelector('code').textContent =
      `Error loading class: ${err.message}`;
  }
}

// ─── FLS State & Checker ─────────────────────────────────
let currentFLSData = null;
let currentFLSFilter = 'all';

async function checkFLS() {
  if (!selectedClass) {
    showToast('Please select an Apex class first', 'error');
    return;
  }

  const btn = document.getElementById('btn-fls-check');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Checking...';

  try {
    const res = await fetch('/api/fls/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ className: selectedClass }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast('FLS check failed: ' + (data.error || 'Unknown error'), 'error');
      return;
    }

    currentFLSData = data;
    renderFLSReport(data);
    openFLSModal();
    showToast('FLS analysis complete!', 'success');
  } catch (err) {
    showToast('FLS check error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🔐 Check FLS';
  }
}

function openFLSModal() {
  const modal = document.getElementById('fls-modal');
  if (!modal || !currentFLSData) return;
  modal.style.display = 'flex';
  renderFLSModalData(currentFLSData);
}

function closeFLSModal() {
  const modal = document.getElementById('fls-modal');
  if (modal) modal.style.display = 'none';
}

function renderFLSModalData(data) {
  const s = data.summary || {};
  const clsBadge = document.getElementById('fls-modal-class-badge');
  const statBadge = document.getElementById('fls-modal-status-badge');
  const summaryCards = document.getElementById('fls-modal-summary-cards');
  const warnBox = document.getElementById('fls-modal-warning');
  const objSelect = document.getElementById('fls-modal-object-select');

  if (clsBadge) clsBadge.textContent = data.className || selectedClass || 'Apex Class';

  const hasIssues = (s.noAccess || 0) > 0;
  if (statBadge) {
    if (hasIssues) {
      statBadge.className = 'fls-summary-badge fls-badge-danger';
      statBadge.textContent = `⚠️ ${s.noAccess} Field(s) Blocked`;
    } else if ((s.readOnly || 0) > 0) {
      statBadge.className = 'fls-summary-badge fls-badge-warn';
      statBadge.textContent = `${s.fullAccess} Full · ${s.readOnly} Read-Only`;
    } else {
      statBadge.className = 'fls-summary-badge fls-badge-ok';
      statBadge.textContent = `✅ ${s.fullAccess} Fields All Accessible`;
    }
  }

  // Render Summary Cards
  if (summaryCards) {
    summaryCards.innerHTML = `
      <div class="audit-card">
        <div class="audit-card-val" style="color:var(--error);">${s.noAccess || 0}</div>
        <div class="audit-card-lbl">🔴 No Access (Blocked)</div>
      </div>
      <div class="audit-card">
        <div class="audit-card-val" style="color:var(--warning);">${s.readOnly || 0}</div>
        <div class="audit-card-lbl">🟡 Read-Only Fields</div>
      </div>
      <div class="audit-card">
        <div class="audit-card-val" style="color:var(--success);">${s.fullAccess || 0}</div>
        <div class="audit-card-lbl">🟢 Full Access Fields</div>
      </div>
      <div class="audit-card">
        <div class="audit-card-val" style="color:var(--accent-bright);">${s.totalFields || 0}</div>
        <div class="audit-card-lbl">Total Detected Fields</div>
      </div>
      <div class="audit-card">
        <div class="audit-card-val" style="color:#38bdf8;">${s.totalObjects || 0}</div>
        <div class="audit-card-lbl">SObjects Touched</div>
      </div>
    `;
  }

  // Warning Banner
  if (warnBox) {
    if (hasIssues) {
      warnBox.style.display = 'flex';
      warnBox.innerHTML = `
        <div class="fls-warning-icon">⚠️</div>
        <div class="fls-warning-text">
          <strong>${s.noAccess} field(s) are NOT accessible</strong> to your Salesforce user.
          These fields require a <strong>Permission Set</strong> with Read and Edit permissions.
          If test data tries to set or query these fields, Salesforce will throw <code>FIELD_CUSTOM_VALIDATION_EXCEPTION</code> or <code>INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY</code> errors.
        </div>
      `;
    } else {
      warnBox.style.display = 'none';
    }
  }

  // Update count pills in filter buttons
  document.getElementById('fls-cnt-all').textContent = s.totalFields || 0;
  document.getElementById('fls-cnt-blocked').textContent = s.noAccess || 0;
  document.getElementById('fls-cnt-readonly').textContent = s.readOnly || 0;
  document.getElementById('fls-cnt-full').textContent = s.fullAccess || 0;

  // Populate Object Select Dropdown
  if (objSelect) {
    const objNames = Object.keys(data.objects || {});
    objSelect.innerHTML = '<option value="all">📦 All SObjects (' + objNames.length + ')</option>' +
      objNames.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  }

  // Default to 'blocked' tab if there are blocked fields, else 'all'
  const defTab = hasIssues ? 'blocked' : 'all';
  const btns = document.querySelectorAll('.fls-filter-btn');
  btns.forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-filter') === defTab);
  });
  currentFLSFilter = defTab;

  filterFLSModalTable();
}

function setFLSFilter(filter, btnEl) {
  currentFLSFilter = filter;
  document.querySelectorAll('.fls-filter-btn').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  filterFLSModalTable();
}

function filterFLSModalTable() {
  if (!currentFLSData) return;
  const tbody = document.getElementById('fls-modal-table-body');
  const search = (document.getElementById('fls-search-input')?.value || '').toLowerCase().trim();
  const selectedObj = document.getElementById('fls-modal-object-select')?.value || 'all';

  const rows = [];
  const objects = currentFLSData.objects || {};

  for (const [objName, objData] of Object.entries(objects)) {
    if (selectedObj !== 'all' && selectedObj.toLowerCase() !== objName.toLowerCase()) {
      continue;
    }

    const fls = objData.flsSummary || { fullAccess: [], readOnly: [], noAccess: [] };
    const all = [
      ...(fls.noAccess || []).map((f) => ({ ...f, sobject: objName, status: 'blocked' })),
      ...(fls.readOnly || []).map((f) => ({ ...f, sobject: objName, status: 'readonly' })),
      ...(fls.fullAccess || []).map((f) => ({ ...f, sobject: objName, status: 'full' })),
    ];

    for (const f of all) {
      // Filter by status tab
      if (currentFLSFilter !== 'all' && f.status !== currentFLSFilter) {
        continue;
      }

      // Filter by search string
      if (search) {
        const hay = `${f.sobject} ${f.field} ${f.label || ''} ${f.type || ''} ${f.reason || ''}`.toLowerCase();
        if (!hay.includes(search)) continue;
      }

      rows.push(f);
    }
  }

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">
          No fields found matching the current filter.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map((f) => {
    const isBlocked = f.status === 'blocked';
    const isReadOnly = f.status === 'readonly';
    const statusClass = isBlocked ? 'fls-status-blocked' : isReadOnly ? 'fls-status-readonly' : 'fls-status-full';
    const statusIcon = isBlocked ? '🔴' : isReadOnly ? '🟡' : '🟢';
    const statusLabel = isBlocked ? 'No Access' : isReadOnly ? 'Read Only' : 'Full Access';
    const rowClass = isBlocked ? 'fls-row-blocked' : isReadOnly ? 'fls-row-readonly' : '';
    const boolIcon = (v) => v ? '<span style="color:var(--success);">✅</span>' : '<span style="color:var(--error);">❌</span>';

    return `
      <tr class="${rowClass}">
        <td class="mono" style="font-weight:700;color:var(--accent-bright);">${escapeHtml(f.sobject)}</td>
        <td class="mono" style="font-weight:600;">${escapeHtml(f.field)}</td>
        <td>${escapeHtml(f.label || f.field)}</td>
        <td><span class="fls-type-tag">${escapeHtml(f.type || 'TEXT')}</span></td>
        <td class="fls-bool-cell">${boolIcon(f.accessible)}</td>
        <td class="fls-bool-cell">${boolIcon(f.createable)}</td>
        <td class="fls-bool-cell">${boolIcon(f.updateable)}</td>
        <td><span class="fls-status-tag ${statusClass}">${statusIcon} ${statusLabel}</span></td>
        <td style="font-size:11.5px;color:${isBlocked ? 'var(--error)' : 'var(--text-secondary)'};">
          ${escapeHtml(f.reason || (isBlocked ? 'Assign Permission Set with Read/Edit' : isReadOnly ? 'Read-only field' : 'Standard full access'))}
        </td>
      </tr>
    `;
  }).join('');
}

function downloadFLSCSV() {
  if (!currentFLSData) return;
  const objects = currentFLSData.objects || {};
  const rows = [
    ['SObject', 'Field API Name', 'Field Label', 'Type', 'Accessible', 'Createable', 'Updateable', 'Status', 'Reason / Action Required']
  ];

  for (const [objName, objData] of Object.entries(objects)) {
    const fls = objData.flsSummary || { fullAccess: [], readOnly: [], noAccess: [] };
    const all = [
      ...(fls.noAccess || []).map((f) => ({ ...f, sobject: objName, status: 'No Access' })),
      ...(fls.readOnly || []).map((f) => ({ ...f, sobject: objName, status: 'Read Only' })),
      ...(fls.fullAccess || []).map((f) => ({ ...f, sobject: objName, status: 'Full Access' })),
    ];
    for (const f of all) {
      rows.push([
        f.sobject,
        f.field,
        f.label || f.field,
        f.type || '',
        f.accessible ? 'TRUE' : 'FALSE',
        f.createable ? 'TRUE' : 'FALSE',
        f.updateable ? 'TRUE' : 'FALSE',
        f.status,
        f.reason || ''
      ]);
    }
  }

  const csvContent = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fls_report_${selectedClass || 'apex'}_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('FLS report downloaded as CSV!', 'success');
}

function renderFLSReport(data) {
  const section = document.getElementById('fls-report-section');
  const details = document.getElementById('fls-report-details');
  const badge = document.getElementById('fls-summary-badge');
  if (!section || !details) return;

  section.style.display = 'block';
  details.style.display = 'block';

  const s = data.summary || {};
  const hasIssues = s.noAccess > 0;

  // Update summary badge
  if (badge) {
    if (hasIssues) {
      badge.className = 'fls-summary-badge fls-badge-danger';
      badge.textContent = `⚠️ ${s.noAccess} field(s) blocked`;
    } else if (s.readOnly > 0) {
      badge.className = 'fls-summary-badge fls-badge-warn';
      badge.textContent = `${s.fullAccess} full · ${s.readOnly} read-only`;
    } else {
      badge.className = 'fls-summary-badge fls-badge-ok';
      badge.textContent = `✅ ${s.fullAccess} fields — all accessible`;
    }
  }

  let html = '';

  // Button to open the full interactive modal
  html += '<div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">';
  html += '<button class="fls-btn-expand" onclick="openFLSModal()">🔍 Open Fullscreen FLS Inspector (' + (s.totalFields || 0) + ' Fields)</button>';
  html += '<button class="btn btn-accent btn-small" onclick="downloadFLSCSV()">📥 Export CSV</button>';
  html += '</div>';

  // Warning banner
  if (hasIssues) {
    html += '<div class="fls-warning-banner">';
    html += '<div class="fls-warning-icon">⚠️</div>';
    html += '<div class="fls-warning-text">';
    html += '<strong>' + s.noAccess + ' field(s) are NOT accessible</strong> to the current user. ';
    html += 'These fields require a <strong>Permission Set</strong> assignment. ';
    html += 'Using them in test data will cause <code>FIELD_CUSTOM_VALIDATION_EXCEPTION</code> or <code>INSUFFICIENT_ACCESS</code> errors.';
    html += '</div></div>';
  }

  // Summary pills
  html += '<div class="fls-summary-pills">';
  html += '<span class="fls-pill fls-pill-blocked" onclick="openFLSModal()" style="cursor:pointer;" title="Click to view in inspector"><span class="fls-dot fls-dot-blocked"></span> 🔴 Blocked: <strong>' + (s.noAccess || 0) + '</strong></span>';
  html += '<span class="fls-pill fls-pill-readonly" onclick="openFLSModal()" style="cursor:pointer;" title="Click to view in inspector"><span class="fls-dot fls-dot-readonly"></span> 🟡 Read-Only: <strong>' + (s.readOnly || 0) + '</strong></span>';
  html += '<span class="fls-pill fls-pill-full" onclick="openFLSModal()" style="cursor:pointer;" title="Click to view in inspector"><span class="fls-dot fls-dot-full"></span> 🟢 Full Access: <strong>' + (s.fullAccess || 0) + '</strong></span>';
  html += '<span class="fls-pill fls-pill-total">Total: <strong>' + (s.totalFields || 0) + '</strong> fields across <strong>' + (s.totalObjects || 0) + '</strong> objects</span>';
  html += '</div>';

  // Per-object FLS tables
  const objects = data.objects || {};
  for (const [objName, objData] of Object.entries(objects)) {
    html += buildFLSObjectTable(objName, objData);
  }

  details.innerHTML = html;
}

function buildFLSObjectTable(objName, objData) {
  const fls = objData.flsSummary || { fullAccess: [], readOnly: [], noAccess: [] };
  const allFields = [...(fls.noAccess || []), ...(fls.readOnly || []), ...(fls.fullAccess || [])];
  if (allFields.length === 0) return '';

  const noAccessCount = (fls.noAccess || []).length;
  const readOnlyCount = (fls.readOnly || []).length;
  const objBadge = noAccessCount > 0
    ? '<span class="fls-obj-badge fls-obj-danger">' + noAccessCount + ' blocked</span>'
    : readOnlyCount > 0
      ? '<span class="fls-obj-badge fls-obj-warn">' + readOnlyCount + ' read-only</span>'
      : '<span class="fls-obj-badge fls-obj-ok">✅ All OK</span>';

  let html = '<div class="fls-object-card">';
  html += '<div class="fls-object-header">';
  html += '<span class="fls-object-name">📦 ' + escapeHtml(objName) + '</span>';
  html += '<div style="display:flex;gap:6px;align-items:center;">';
  html += objBadge;
  html += '<button class="btn btn-small" onclick="openFLSModal()" style="padding:2px 6px;font-size:10px;">🔍 View All</button>';
  html += '</div>';
  html += '</div>';
  html += '<table class="detail-table fls-field-table"><thead><tr>';
  html += '<th>Field</th><th>Label</th><th>Type</th><th>Accessible</th><th>Createable</th><th>Updateable</th><th>FLS Status</th>';
  html += '</tr></thead><tbody>';

  for (const f of allFields) {
    const statusClass = !f.accessible ? 'fls-status-blocked' : !f.createable ? 'fls-status-readonly' : 'fls-status-full';
    const statusIcon = !f.accessible ? '🔴' : !f.createable ? '🟡' : '🟢';
    const statusLabel = !f.accessible ? 'No Access' : !f.createable ? 'Read Only' : 'Full Access';
    const boolIcon = function(v) { return v ? '✅' : '❌'; };
    const rowClass = !f.accessible ? 'fls-row-blocked' : !f.createable ? 'fls-row-readonly' : '';

    html += '<tr class="' + rowClass + '">';
    html += '<td class="mono">' + escapeHtml(f.field) + '</td>';
    html += '<td>' + escapeHtml(f.label || '') + '</td>';
    html += '<td><span class="fls-type-tag">' + escapeHtml(f.type || '') + '</span></td>';
    html += '<td class="fls-bool-cell">' + boolIcon(f.accessible) + '</td>';
    html += '<td class="fls-bool-cell">' + boolIcon(f.createable) + '</td>';
    html += '<td class="fls-bool-cell">' + boolIcon(f.updateable) + '</td>';
    html += '<td><span class="fls-status-tag ' + statusClass + '">' + statusIcon + ' ' + statusLabel + '</span>';
    if (f.reason && !f.accessible) {
      html += '<div class="fls-reason">' + escapeHtml(f.reason) + '</div>';
    }
    html += '</td></tr>';
  }

  html += '</tbody></table></div>';
  return html;
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
    if (!res.ok) {
      console.warn(`[Poll] Received HTTP ${res.status}`);
      if (res.status === 404) {
        clearInterval(pollInterval);
        pollInterval = null;
        clearInterval(timerInterval);
        timerInterval = null;
        resetGenerateButton();
        loadAuditCount();
      }
      return;
    }
    const data = await res.json();

    if (Array.isArray(data.progress)) {
      for (const step of data.progress) {
        renderActivityCard(step.step, step.message, step.data || {});
      }
    }
    if (typeof data.progressIndex === 'number') {
      lastProgressIndex = data.progressIndex;
    }

    if (data.status && data.status !== 'running') {
      clearInterval(pollInterval);
      pollInterval = null;
      clearInterval(timerInterval);
      timerInterval = null;
      if (data.result) renderResults(data.result);
      resetGenerateButton();
      loadAuditCount();
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

    // ── FLS Summary Section ────────────────────────────
    var totalNoAccess = 0, totalReadOnly = 0, totalFullAccess = 0;
    for (var fi = 0; fi < entries.length; fi++) {
      var fMeta = entries[fi][1];
      var fls = fMeta.flsSummary || { fullAccess: [], readOnly: [], noAccess: [] };
      totalNoAccess += (fls.noAccess || []).length;
      totalReadOnly += (fls.readOnly || []).length;
      totalFullAccess += (fls.fullAccess || []).length;
    }

    html += '<div class="detail-section"><div class="detail-label">🔐 Field-Level Security (FLS)</div>';
    html += '<div class="fls-summary-pills" style="margin-bottom:8px;">';
    html += '<span class="fls-pill fls-pill-full"><span class="fls-dot fls-dot-full"></span> Full Access: <strong>' + totalFullAccess + '</strong></span>';
    html += '<span class="fls-pill fls-pill-readonly"><span class="fls-dot fls-dot-readonly"></span> Read-Only: <strong>' + totalReadOnly + '</strong></span>';
    html += '<span class="fls-pill fls-pill-blocked"><span class="fls-dot fls-dot-blocked"></span> No Access: <strong>' + totalNoAccess + '</strong></span>';
    html += '</div>';

    if (totalNoAccess > 0) {
      html += '<div class="fls-warning-banner fls-warning-compact">';
      html += '<div class="fls-warning-icon">⚠️</div>';
      html += '<div class="fls-warning-text">';
      html += '<strong>' + totalNoAccess + ' field(s) are NOT accessible.</strong> These need a Permission Set. Click <strong>🔐 Check FLS</strong> for full details.';
      html += '</div></div>';
    }

    // Per-object FLS compact tags
    for (var fj = 0; fj < entries.length; fj++) {
      var foName = entries[fj][0], foMeta = entries[fj][1];
      var foFls = foMeta.flsSummary || { fullAccess: [], readOnly: [], noAccess: [] };
      if ((foFls.noAccess || []).length > 0) {
        html += '<div class="detail-subsection"><span class="mono" style="font-weight:600;">' + escapeHtml(foName) + '</span> — blocked fields:</div>';
        html += '<div class="detail-tags">';
        for (var fk = 0; fk < foFls.noAccess.length; fk++) {
          html += '<span class="tag tag-fls-blocked">🔴 ' + escapeHtml(foFls.noAccess[fk].field) + '</span>';
        }
        html += '</div>';
      }
    }
    html += '</div>';

    var roFields = [];
    for (var j = 0; j < entries.length; j++) {
      var oName = entries[j][0], oMeta = entries[j][1];
      var fm = oMeta.fieldMetadata || {};
      for (var fk2 of Object.keys(fm)) {
        if (fm[fk2].formula || fm[fk2].autoNumber || !fm[fk2].createable) {
          roFields.push(oName + '.' + fk2);
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
<<<<<<< Updated upstream
  if (data.tokensUsed) parts.push('Tokens: <strong>' + data.tokensUsed.input.toLocaleString() + '</strong> in / <strong>' + data.tokensUsed.output.toLocaleString() + '</strong> out');
  if (data.charsUsed && (data.charsUsed.input || data.charsUsed.output)) {
    parts.push('Chars: <strong>' + (data.charsUsed.input || 0).toLocaleString() + '</strong> in / <strong>' + (data.charsUsed.output || 0).toLocaleString() + '</strong> out');
  }
  if (data.estimatedCost && data.estimatedCost.totalCost > 0) {
    parts.push('Cost: <strong>$' + data.estimatedCost.totalCost.toFixed(4) + '</strong>');
  }
=======
  
  if (data.characterMetrics?.output) {
    parts.push('Generated: <strong>' + (data.characterMetrics.output.withBlanks || 0).toLocaleString() + ' chars</strong> (w/ blanks)');
  }
  
  if (data.tokensUsed) {
    var tot = data.tokensUsed.total || ((data.tokensUsed.input || 0) + (data.tokensUsed.output || 0));
    parts.push('Tokens: <strong>' + (data.tokensUsed.input || 0).toLocaleString() + '</strong> in / <strong>' + (data.tokensUsed.output || 0).toLocaleString() + '</strong> out (' + tot.toLocaleString() + ' total)');
  }
  
  if (data.cost?.formattedCost) {
    parts.push('Charge: <strong style="color:var(--success);">' + escapeHtml(data.cost.formattedCost) + '</strong>');
  }
  
  if (data.totalCumulativeCost) {
    parts.push('Total Spent: <strong style="color:var(--accent-bright);">' + escapeHtml(data.totalCumulativeCost) + '</strong>');
  }
  
>>>>>>> Stashed changes
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
  var parts = [];
  if (data.attempts) parts.push('Completed in <strong>' + data.attempts + '</strong> attempt(s)');
  if (data.formattedCost) parts.push('Total Claude Cost: <strong style="color:var(--success);">' + escapeHtml(data.formattedCost) + '</strong>');
  return parts.length > 0 ? '<div class="detail-section">' + parts.join(' &nbsp;•&nbsp; ') + '</div>' : '';
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

  const ai = result.aiUsage || {};
  const chars = ai.characterStats || {};
  const testChars = chars.testClass?.withBlanks || (result.testClassBody ? result.testClassBody.length : 0);
  const totalTokens = ai.totalTokens || ((result.totalTokensUsed?.input || 0) + (result.totalTokensUsed?.output || 0));
  const formattedCost = ai.formattedCost || `$${(ai.totalCostUSD || 0).toFixed(4)}`;

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
      <div class="card-label">Coverage (${target}% target)</div>
    </div>
    <div class="summary-card card-tokens">
      <div class="card-value">${totalTokens.toLocaleString()}</div>
      <div class="card-label">Tokens Consumed</div>
    </div>
    <div class="summary-card card-chars">
      <div class="card-value">${testChars.toLocaleString()}</div>
      <div class="card-label">Chars (w/ blanks)</div>
    </div>
    <div class="summary-card card-cost">
      <div class="card-value">${formattedCost}</div>
      <div class="card-label">Claude Charges</div>
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

<<<<<<< Updated upstream
  // ─── Usage & Cost Summary ─────────────────────────────
  renderUsageSummary(result);
=======
  // AI Usage & Cost Breakdown Dashboard
  const aiSection = document.getElementById('ai-usage-section');
  if (aiSection && (ai.totalTokens || result.totalTokensUsed)) {
    aiSection.style.display = 'block';
    const costBadge = document.getElementById('ai-cost-badge');
    if (costBadge) costBadge.textContent = formattedCost;

    const inTokens = ai.totalInputTokens || result.totalTokensUsed?.input || 0;
    const outTokens = ai.totalOutputTokens || result.totalTokensUsed?.output || 0;
    const inCost = (ai.attempts || []).reduce((sum, a) => sum + (a.cost?.inputCostUSD || 0), 0);
    const outCost = (ai.attempts || []).reduce((sum, a) => sum + (a.cost?.outputCostUSD || 0), 0);

    const srcChars = chars.sourceClass || {};
    const tstChars = chars.testClass || {};
    const promptChars = chars.totalPromptCharsWithBlanks || 0;
    const genChars = chars.totalGeneratedCharsWithBlanks || tstChars.withBlanks || 0;

    let attemptsHtml = '';
    if (ai.attempts && ai.attempts.length > 0) {
      attemptsHtml = `
        <div class="ai-breakdown-table-wrapper">
          <div class="detail-label" style="margin: 16px 0 8px 0; font-size:12px; font-weight:700; color:var(--text-secondary);">
            🔄 Per-Attempt Token Consumption & Charges Breakdown
          </div>
          <table class="detail-table ai-attempts-table">
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Phase</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Total Tokens</th>
                <th>Chars (w/ blanks)</th>
                <th>Charges (USD)</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              ${ai.attempts.map((att) => `
                <tr>
                  <td><strong>#${att.attempt}</strong></td>
                  <td><span class="badge-phase">${escapeHtml(att.label || 'Generation')}</span></td>
                  <td>${(att.tokensUsed?.input || 0).toLocaleString()}</td>
                  <td>${(att.tokensUsed?.output || 0).toLocaleString()}</td>
                  <td>${((att.tokensUsed?.input || 0) + (att.tokensUsed?.output || 0)).toLocaleString()}</td>
                  <td>${(att.characterMetrics?.output?.withBlanks || 0).toLocaleString()} chars</td>
                  <td class="cost-cell"><strong>${att.cost?.formattedCost || '$0.0000'}</strong></td>
                  <td>${att.durationMs ? Math.round(att.durationMs / 1000) + 's' : '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    const aiDetails = document.getElementById('ai-usage-details');
    if (aiDetails) {
      aiDetails.innerHTML = `
        <div class="ai-usage-dashboard">
          <div class="ai-model-banner">
            <div class="model-info-left">
              <span class="ai-model-tag">Model: <strong>${escapeHtml(ai.model || 'claude-3-7-sonnet')}</strong></span>
              <span class="ai-rates-tag">Rates: $3.00/1M input • $15.00/1M output</span>
            </div>
            <div class="model-cost-right">
              Total Charges: <strong class="banner-cost">${formattedCost}</strong>
            </div>
          </div>

          <div class="ai-metrics-grid">
            <!-- Token Metrics -->
            <div class="ai-card">
              <div class="ai-card-title">🔢 Token Consumption</div>
              <div class="ai-stat-row">
                <span>Input Prompt Tokens:</span>
                <strong>${inTokens.toLocaleString()}</strong>
              </div>
              <div class="ai-stat-row">
                <span>Output Completion Tokens:</span>
                <strong>${outTokens.toLocaleString()}</strong>
              </div>
              <div class="ai-stat-row total-row">
                <span>Total Tokens Consumed:</span>
                <strong class="highlight-tokens">${totalTokens.toLocaleString()}</strong>
              </div>
            </div>

            <!-- Charges Breakdown -->
            <div class="ai-card">
              <div class="ai-card-title">💰 Charges Breakdown (USD)</div>
              <div class="ai-stat-row">
                <span>Input Prompt Cost ($3/1M):</span>
                <strong>$${inCost.toFixed(5)}</strong>
              </div>
              <div class="ai-stat-row">
                <span>Output Completion Cost ($15/1M):</span>
                <strong>$${outCost.toFixed(5)}</strong>
              </div>
              <div class="ai-stat-row total-row">
                <span>Total Claude Charges:</span>
                <strong class="highlight-cost">${formattedCost}</strong>
              </div>
            </div>

            <!-- Character Counts with Blanks -->
            <div class="ai-card">
              <div class="ai-card-title">🔤 Character Counts (With Blanks)</div>
              <div class="ai-stat-row">
                <span>Source Class (w/ blanks):</span>
                <strong>${(srcChars.withBlanks || 0).toLocaleString()}</strong>
              </div>
              <div class="ai-stat-row">
                <span>Generated Test (w/ blanks):</span>
                <strong>${(tstChars.withBlanks || 0).toLocaleString()}</strong>
              </div>
              <div class="ai-stat-row">
                <span>Test Class (no blanks):</span>
                <strong>${(tstChars.withoutBlanks || 0).toLocaleString()}</strong>
              </div>
              <div class="ai-stat-row total-row">
                <span>Total Chars Sent/Recv:</span>
                <strong class="highlight-chars">${(promptChars + genChars).toLocaleString()}</strong>
              </div>
            </div>
          </div>

          ${attemptsHtml}
        </div>
      `;
    }
  }
>>>>>>> Stashed changes

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

  // Generated test code & header metrics
  if (result.testClassBody) {
    const codeSection = document.getElementById('generated-code-section');
    codeSection.style.display = 'block';
    document.getElementById('generated-code').querySelector('code').textContent = result.testClassBody;

    const codeMetricsBadge = document.getElementById('test-code-metrics');
    if (codeMetricsBadge) {
      const tbWith = result.testClassBody.length;
      const tbLines = result.testClassBody.split('\n').length;
      codeMetricsBadge.textContent = `${tbWith.toLocaleString()} chars (with blanks) • ${tbLines} lines`;
    }
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

<<<<<<< Updated upstream
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
=======
// ─── Audit History & Monitoring ───────────────────────────
async function loadAuditCount() {
  try {
    const res = await fetch('/api/audit/history');
    const data = await res.json();
    const count = data.summary?.totalRuns || 0;
    const badge = document.getElementById('audit-count');
    if (badge) badge.textContent = count;
  } catch (err) {
    console.error('Failed to load audit count:', err);
  }
}

async function openAuditModal() {
  const modal = document.getElementById('audit-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  renderAuditLogs();
}

function closeAuditModal() {
  const modal = document.getElementById('audit-modal');
  if (modal) modal.style.display = 'none';
}

async function renderAuditLogs() {
  const summaryEl = document.getElementById('audit-summary-cards');
  const tbody = document.getElementById('audit-table-body');
  
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-secondary);">Loading audit history...</td></tr>';
  }

  try {
    const res = await fetch('/api/audit/history');
    const data = await res.json();
    const history = data.history || [];
    const summary = data.summary || {};

    const badge = document.getElementById('audit-count');
    if (badge) badge.textContent = summary.totalRuns || 0;

    // Render Aggregate Summary Cards
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="audit-card">
          <div class="audit-card-val" style="color:var(--accent-bright);">${summary.uniqueClasses || 0}</div>
          <div class="audit-card-lbl">Unique Classes (${summary.totalRuns || 0} Runs)</div>
        </div>
        <div class="audit-card">
          <div class="audit-card-val" style="color:#38bdf8;">${(summary.totalTestCharsWithBlanks || 0).toLocaleString()}</div>
          <div class="audit-card-lbl">Test Chars (w/ blanks)</div>
        </div>
        <div class="audit-card">
          <div class="audit-card-val" style="color:#c084fc;">${(summary.totalTokens || 0).toLocaleString()}</div>
          <div class="audit-card-lbl">Total Tokens Consumed</div>
        </div>
        <div class="audit-card">
          <div class="audit-card-val" style="color:var(--success);">${summary.formattedTotalCost || '$0.0000'}</div>
          <div class="audit-card-lbl">Total Claude Charges</div>
        </div>
        <div class="audit-card">
          <div class="audit-card-val" style="color:var(--warning);">${summary.averageCoverage || 0}%</div>
          <div class="audit-card-lbl">Average Coverage</div>
        </div>
        <div class="audit-card">
          <div class="audit-card-val" style="color:${summary.failCount === 0 ? 'var(--success)' : '#fb923c'};">${summary.passRate || '0%'}</div>
          <div class="audit-card-lbl">Pass Rate (${summary.passCount || 0} pass / ${summary.failCount || 0} fail)</div>
        </div>
      `;
    }

    // Render Audit Table
    if (tbody) {
      if (history.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="10" style="text-align:center;padding:32px;color:var(--text-muted);">
              No audit logs found yet. Generate tests for Apex classes to start monitoring.
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = history.map((r) => {
        const isPass = r.status === 'Pass';
        const covText = r.coveragePercent != null ? `${r.coveragePercent}%` : '—';
        const covColor = r.coveragePercent >= (r.targetPercent || 80) ? 'var(--success)' : r.coveragePercent >= 50 ? 'var(--warning)' : 'var(--error)';
        
        return `
          <tr>
            <td style="white-space:nowrap;font-size:11px;color:var(--text-muted);">${escapeHtml(r.formattedDate || r.timestamp)}</td>
            <td class="mono" style="font-weight:600;color:var(--accent-bright);">${escapeHtml(r.className)}</td>
            <td>
              <span class="status-tag ${isPass ? 'status-pass' : 'status-fail'}">
                ${isPass ? '✅ Pass' : '❌ Fail'}
              </span>
            </td>
            <td>${(r.sourceClassCharsWithBlanks || 0).toLocaleString()}</td>
            <td><strong>${(r.testClassCharsWithBlanks || 0).toLocaleString()}</strong></td>
            <td>${(r.inputTokens || 0).toLocaleString()} / ${(r.outputTokens || 0).toLocaleString()} (${(r.totalTokens || 0).toLocaleString()})</td>
            <td class="cost-cell" style="font-weight:700;">${r.formattedCost || '$0.0000'}</td>
            <td style="font-weight:700;color:${covColor};">${covText}</td>
            <td>${r.attempts || 1}</td>
            <td>${r.durationFormatted || (r.durationSeconds ? r.durationSeconds + 's' : '—')}</td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--error);padding:20px;">Failed to load audit history: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function downloadAuditCSV() {
  window.location.href = '/api/audit/export/csv';
  showToast('Downloading Audit History (CSV)...', 'info');
}

function downloadAuditJSON() {
  window.location.href = '/api/audit/export/json';
  showToast('Downloading Audit History (JSON)...', 'info');
}

async function clearAuditLogs() {
  if (!confirm('Are you sure you want to clear all generation audit history? This cannot be undone.')) {
    return;
  }
  try {
    const res = await fetch('/api/audit/clear', { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Audit history cleared', 'info');
      renderAuditLogs();
      loadAuditCount();
    }
  } catch (err) {
    showToast('Failed to clear audit logs: ' + err.message, 'error');
  }
}

>>>>>>> Stashed changes
