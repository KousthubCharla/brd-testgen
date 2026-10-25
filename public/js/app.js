/**
 * app.js — Frontend application logic for AL-FS-01 BRD Test Generator
 * Handles all UI interactions, API calls, and rendering.
 */

const API = '/api';

/* ══════════════════════════════════════════════════════════════
   UTILITY HELPERS
   ══════════════════════════════════════════════════════════════ */

function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

function showLoader(text = 'Processing…') {
  document.getElementById('loader-text').textContent = text;
  show('loading-overlay');
}
function hideLoader() { hide('loading-overlay'); }

function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, options);
  const json = await res.json().catch(() => ({ success: false, error: res.statusText }));
  if (!json.success) throw new Error(json.error || 'API error');
  return json.data;
}

function formatNum(n) { return n?.toLocaleString() ?? '0'; }

function badge(text, cls) {
  return `<span class="tag tag--${cls}">${text}</span>`;
}

function coverageBadge(coverage) {
  const map = { full: 'green', partial: 'warn', none: 'error' };
  return badge(coverage || 'none', map[coverage] || 'error');
}

function priorityBadge(p) {
  const map = { Critical: 'error', High: 'warn', Medium: 'blue', Low: 'accent' };
  return badge(p || '—', map[p] || 'blue');
}

function typeBadge(t) { return badge(t || '—', 'blue'); }

/* ══════════════════════════════════════════════════════════════
   APP STATE
   ══════════════════════════════════════════════════════════════ */
const state = {
  brdResult: null,
  crawlResults: null,
  knowledgeModel: null,
  mappingResult: null,
  testCaseResult: null,
  rtmResult: null,
  currentTCId: null,
  tcFilter: { type: '', priority: '', search: '' },
};

/* ══════════════════════════════════════════════════════════════
   NAVIGATION
   ══════════════════════════════════════════════════════════════ */
function initNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const sec = btn.dataset.section;
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.getElementById(`section-${sec}`)?.classList.add('active');
    });
  });
}

function navigateTo(section) {
  document.querySelector(`[data-section="${section}"]`)?.click();
}

/* ══════════════════════════════════════════════════════════════
   DASHBOARD
   ══════════════════════════════════════════════════════════════ */
function updateDashboardStats() {
  document.getElementById('stat-requirements').textContent =
    formatNum(state.brdResult?.requirements?.length);
  document.getElementById('stat-pages').textContent =
    formatNum(state.crawlResults?.reduce((a, r) => a + r.pages.length, 0));
  document.getElementById('stat-testcases').textContent =
    formatNum(state.testCaseResult?.test_cases?.length);
  document.getElementById('stat-coverage').textContent =
    state.rtmResult ? state.rtmResult.summary.coverage_percent + '%' : '0%';
}

function updatePipelineStep(stepLabel, status, detail = '') {
  const steps = document.querySelectorAll('.pipeline-step');
  steps.forEach(step => {
    const lbl = step.querySelector('.step-label').textContent;
    if (lbl.includes(stepLabel)) {
      step.className = `pipeline-step ${status}`;
      step.querySelector('.step-status').textContent =
        status === 'running' ? 'Running…'
        : status === 'complete' ? (detail || 'Done')
        : status === 'error' ? (detail || 'Error')
        : status === 'skipped' ? 'Skipped'
        : 'Pending';
    }
  });
}

function renderProgressLog(progress = []) {
  if (!progress.length) return;
  const stepMap = {
    'A': 'BRD Understanding',
    'B': 'Application Exploration',
    'C': 'Knowledge Model',
    'D': 'Requirement Mapping',
    'E': 'Test Case Generation',
    'F': 'Traceability & Output',
  };
  progress.forEach(p => {
    Object.entries(stepMap).forEach(([letter, name]) => {
      if (p.step.includes(letter) || p.step.includes(name)) {
        updatePipelineStep(name, p.status, p.detail);
      }
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   A — BRD UPLOAD
   ══════════════════════════════════════════════════════════════ */
function initBRDUpload() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('brd-file-input');
  const browseBtn = document.getElementById('btn-browse-brd');

  browseBtn.addEventListener('click', () => input.click());
  zone.addEventListener('click', e => { if (e.target !== browseBtn) input.click(); });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) uploadBRD(file);
  });

  input.addEventListener('change', () => {
    if (input.files[0]) uploadBRD(input.files[0]);
  });
}

async function uploadBRD(file) {
  showLoader(`Parsing BRD: ${file.name}…`);
  updatePipelineStep('BRD Understanding', 'running');

  try {
    const form = new FormData();
    form.append('brd', file);

    const res = await fetch(`${API}/brd/upload`, { method: 'POST', body: form });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    state.brdResult = json.data.brdResult;
    renderBRDResults(state.brdResult);
    updatePipelineStep('BRD Understanding', 'complete',
      `${state.brdResult.requirements.length} requirements`);
    updateDashboardStats();
    await fetchStats();
    toast(`BRD parsed: ${state.brdResult.requirements.length} requirements extracted`, 'success');
  } catch (err) {
    updatePipelineStep('BRD Understanding', 'error', err.message);
    toast(`BRD parse failed: ${err.message}`, 'error');
  } finally {
    hideLoader();
  }
}

function renderBRDResults(brd) {
  show('brd-results');
  document.getElementById('brd-title').textContent = brd.title || 'BRD Parsed';
  document.getElementById('brd-req-count').textContent = `${brd.requirements.length} requirements`;
  document.getElementById('brd-vague-count').textContent =
    `${brd.stats.vagueRequirements} vague`;

  document.getElementById('brd-summary').innerHTML =
    `<strong>Summary:</strong> ${brd.summary || '—'}<br/>
     <strong>Actors:</strong> ${(brd.actors || []).join(', ') || '—'}<br/>
     <strong>Modules:</strong> ${(brd.modules || []).join(', ') || '—'}`;


  const tbody = document.getElementById('requirements-tbody');
  tbody.innerHTML = brd.requirements.map(r => `
    <tr>
      <td><code>${r.id}</code></td>
      <td>${r.title}</td>
      <td>${r.module || '—'}</td>
      <td>${typeBadge(r.type)}</td>
      <td>${priorityBadge(r.priority)}</td>
      <td>${r.is_vague ? badge('Vague', 'warn') : badge('Clear', 'green')}</td>
    </tr>
  `).join('');
}

/* ══════════════════════════════════════════════════════════════
   B — CRAWL
   ══════════════════════════════════════════════════════════════ */
function initCrawler() {
  document.getElementById('btn-add-role').addEventListener('click', addRoleRow);
  document.getElementById('btn-start-crawl').addEventListener('click', startCrawl);
  document.getElementById('btn-load-model').addEventListener('click', loadSavedModel);

  // Remove role buttons
  document.getElementById('roles-container').addEventListener('click', e => {
    if (e.target.classList.contains('btn-remove-role')) {
      const rows = document.querySelectorAll('.role-row');
      if (rows.length > 1) e.target.closest('.role-row').remove();
    }
  });
}

function addRoleRow() {
  const container = document.getElementById('roles-container');
  const idx = container.querySelectorAll('.role-row').length;
  const row = document.createElement('div');
  row.className = 'role-row';
  row.dataset.roleIndex = idx;
  row.innerHTML = `
    <input type="text" class="input role-name" placeholder="Role Name (e.g. manager)" />
    <input type="text" class="input role-username" placeholder="Username" />
    <input type="password" class="input role-password" placeholder="Password" />
    <button class="btn-icon btn-remove-role" title="Remove">✕</button>
  `;
  container.appendChild(row);
}

function getRolesFromUI() {
  const roles = {};
  document.querySelectorAll('.role-row').forEach(row => {
    const name = row.querySelector('.role-name').value.trim();
    const user = row.querySelector('.role-username').value.trim();
    const pass = row.querySelector('.role-password').value.trim();
    if (name && user && pass) {
      roles[name] = { username: user, password: pass };
    }
  });
  return roles;
}

async function startCrawl() {
  const url = document.getElementById('crawl-url').value.trim();
  const roles = getRolesFromUI();

  if (!url) return toast('Please enter the application URL', 'warning');
  if (Object.keys(roles).length === 0) return toast('Please add at least one role with credentials', 'warning');

  showLoader('Crawling application…');
  updatePipelineStep('Application Exploration', 'running');

  try {
    const options = {
      maxDepth: parseInt(document.getElementById('crawl-depth').value),
      maxPages: parseInt(document.getElementById('crawl-max-pages').value),
      timeoutMs: parseInt(document.getElementById('crawl-timeout').value),
      excludePatterns: document.getElementById('crawl-exclude').value.split(',').map(s => s.trim()),
    };

    const data = await apiFetch('/crawl/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appUrl: url, roles, options }),
    });

    state.crawlResults = data.crawlResults;

    // Build model automatically
    updatePipelineStep('Knowledge Model', 'running');
    const modelData = await apiFetch('/model/build', { method: 'POST' });
    state.knowledgeModel = modelData.knowledgeModel;

    renderCrawlResults(data.crawlResults);
    updatePipelineStep('Application Exploration', 'complete',
      `${data.crawlResults.reduce((a, r) => a + r.pages.length, 0)} pages`);
    updatePipelineStep('Knowledge Model', 'complete',
      `${state.knowledgeModel.summary.totalPages} pages modelled`);
    updateDashboardStats();

    toast('Crawl complete! Knowledge model saved.', 'success');
  } catch (err) {
    updatePipelineStep('Application Exploration', 'error', err.message);
    toast(`Crawl failed: ${err.message}`, 'error');
  } finally {
    hideLoader();
  }
}

async function loadSavedModel() {
  showLoader('Loading saved knowledge model…');
  try {
    const data = await apiFetch('/model/load');
    state.knowledgeModel = data.knowledgeModel;
    updatePipelineStep('Knowledge Model', 'complete', 'Loaded from disk');
    toast('Knowledge model loaded from saved state', 'success');
  } catch (err) {
    toast(`Load failed: ${err.message}`, 'error');
  } finally {
    hideLoader();
  }
}

function renderCrawlResults(results) {
  show('crawl-results');
  const statsEl = document.getElementById('crawl-stats');
  statsEl.innerHTML = results.map(r => `
    <div class="tc-stat-chip">
      <span class="label">${r.role}</span>
      <span class="value">${r.pages.length}</span>
    </div>
  `).join('');

  const logEl = document.getElementById('crawl-log');
  const allLogs = results.flatMap(r =>
    r.crawlLog.map(l => ({ ...l, role: r.role }))
  );
  logEl.innerHTML = allLogs.slice(0, 200).map(l => `
    <div class="log-entry ${l.action}">
      [${l.role}] ${l.action.toUpperCase()} — ${l.url || l.detail || ''}
      ${l.reason ? `<span style="color:var(--text-muted)"> (${l.reason})</span>` : ''}
    </div>
  `).join('');
}

/* ══════════════════════════════════════════════════════════════
   D — REQUIREMENT MAPPING
   ══════════════════════════════════════════════════════════════ */
function initMapping() {
  document.getElementById('btn-run-mapping').addEventListener('click', runMapping);
}

async function runMapping() {
  if (!state.brdResult) return toast('Upload a BRD first', 'warning');
  if (!state.knowledgeModel) return toast('Build knowledge model first (run crawler)', 'warning');

  showLoader('Mapping requirements to application…');
  updatePipelineStep('Requirement Mapping', 'running');

  try {
    const data = await apiFetch('/mapping/run', { method: 'POST' });
    state.mappingResult = data.mappingResult;
    renderMappingResults(state.mappingResult);
    updatePipelineStep('Requirement Mapping', 'complete',
      `${state.mappingResult.stats.coveragePercent}% coverage`);
    toast(`Mapping complete: ${state.mappingResult.stats.coveragePercent}% coverage`, 'success');
  } catch (err) {
    updatePipelineStep('Requirement Mapping', 'error', err.message);
    toast(`Mapping failed: ${err.message}`, 'error');
  } finally {
    hideLoader();
  }
}

function renderMappingResults(mapping) {
  show('mapping-results');
  const s = mapping.stats;

  document.getElementById('mapping-summary').innerHTML = `
    <div class="stat-mini"><span class="value">${s.totalRequirements}</span><span class="label">Total reqs</span></div>
    <div class="stat-mini"><span class="value">${s.mappedRequirements}</span><span class="label">Mapped</span></div>
    <div class="stat-mini"><span class="value">${s.unmappedRequirements}</span><span class="label">BRD gaps</span></div>
    <div class="stat-mini"><span class="value">${s.unmappedFeatures}</span><span class="label">App gaps</span></div>
    <div class="stat-mini"><span class="value">${s.coveragePercent}%</span><span class="label">Coverage</span></div>
  `;

  const tbody = document.getElementById('mapping-tbody');
  tbody.innerHTML = mapping.mappings.map(m => `
    <tr>
      <td><code>${m.requirement_id}</code></td>
      <td>${m.requirement_title || '—'}</td>
      <td>${(m.mapped_pages || []).map(p => p.title || p.url).join('<br>') || '—'}</td>
      <td>${coverageBadge(m.coverage)}</td>
      <td>${((m.mapped_pages || [])[0]?.confidence * 100 || 0).toFixed(0)}%</td>
    </tr>
  `).join('');

  const unReqEl = document.getElementById('unmapped-requirements');
  unReqEl.innerHTML = (mapping.unmapped_requirements?.length)
    ? mapping.unmapped_requirements.map(r => `
      <div class="gap-item">
        <span class="gap-id">${r.requirement_id}</span>${r.requirement_title}
        <span class="gap-reason">${r.reason || ''}</span>
      </div>`).join('')
    : '<div class="gap-item" style="color:var(--text-muted)">No gaps — all requirements are mapped.</div>';

  const unFeatEl = document.getElementById('unmapped-features');
  unFeatEl.innerHTML = (mapping.unmapped_features?.length)
    ? mapping.unmapped_features.map(f => `
      <div class="gap-item">
        <span class="gap-id">${f.page_title || f.page_url || '—'}</span>${f.feature_description || ''}
        <span class="gap-reason">${f.reason || ''}</span>
      </div>`).join('')
    : '<div class="gap-item" style="color:var(--text-muted)">No gaps — all features are covered.</div>';
}

/* ══════════════════════════════════════════════════════════════
   E — TEST CASES
   ══════════════════════════════════════════════════════════════ */
function initTestCases() {
  document.getElementById('btn-generate-tests').addEventListener('click', generateTests);
  document.getElementById('filter-type').addEventListener('change', e => {
    state.tcFilter.type = e.target.value;
    renderTestCases();
  });
  document.getElementById('filter-priority').addEventListener('change', e => {
    state.tcFilter.priority = e.target.value;
    renderTestCases();
  });
  document.getElementById('filter-search').addEventListener('input', e => {
    state.tcFilter.search = e.target.value.toLowerCase();
    renderTestCases();
  });
  document.getElementById('btn-close-modal').addEventListener('click', closeTCModal);
  document.getElementById('btn-close-modal-footer').addEventListener('click', closeTCModal);
  document.getElementById('tc-modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'tc-modal-overlay') closeTCModal();
  });
  document.getElementById('btn-approve-tc').addEventListener('click', approveTCModal);
  document.getElementById('btn-regenerate-tc').addEventListener('click', regenerateTCModal);
}

async function generateTests() {
  if (!state.brdResult) return toast('Upload a BRD first', 'warning');
  if (!state.mappingResult) return toast('Run requirement mapping first', 'warning');

  showLoader('Generating contextual test cases…');
  updatePipelineStep('Test Case Generation', 'running');

  try {
    const data = await apiFetch('/testcases/generate', { method: 'POST' });
    state.testCaseResult = data.testCaseResult;
    renderTestCaseStats(state.testCaseResult.stats);
    renderTestCases();
    updatePipelineStep('Test Case Generation', 'complete',
      `${state.testCaseResult.test_cases.length} test cases`);
    updateDashboardStats();
    toast(`${state.testCaseResult.test_cases.length} test cases generated`, 'success');

    // Auto-build RTM
    await buildAndRenderRTM();
  } catch (err) {
    updatePipelineStep('Test Case Generation', 'error', err.message);
    toast(`Generation failed: ${err.message}`, 'error');
  } finally {
    hideLoader();
  }
}

function renderTestCaseStats(stats) {
  show('testcases-stats');
  const container = document.getElementById('testcases-stats');
  const chips = [
    { label: 'Total Test Cases', value: stats.totalTestCases },
    { label: 'Req Coverage', value: `${stats.requirementCoverage?.coveragePercent || 0}%` },
    ...((stats.typeBreakdown || []).map(t => ({ label: t.type, value: t.count }))),
  ];
  container.innerHTML = chips.map(c => `
    <div class="tc-stat-chip">
      <span class="label">${c.label}</span>
      <span class="value">${c.value}</span>
    </div>
  `).join('');
}

function getFilteredCases() {
  if (!state.testCaseResult?.test_cases) return [];
  return state.testCaseResult.test_cases.filter(tc => {
    if (state.tcFilter.type && tc.test_type !== state.tcFilter.type) return false;
    if (state.tcFilter.priority && tc.priority !== state.tcFilter.priority) return false;
    if (state.tcFilter.search) {
      const hay = `${tc.test_case_id} ${tc.title} ${tc.module} ${tc.requirement_id}`.toLowerCase();
      if (!hay.includes(state.tcFilter.search)) return false;
    }
    return true;
  });
}

function renderTestCases() {
  show('testcases-list');
  const list = document.getElementById('testcases-list');
  const filtered = getFilteredCases();

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><p>No test cases match the current filters.</p></div>`;
    return;
  }

  list.innerHTML = filtered.map(tc => `
    <div class="tc-card ${tc.status === 'approved' ? 'approved' : ''}"
         onclick="app.openTCModal('${tc.test_case_id}')">
      <span class="tc-id">${tc.test_case_id}</span>
      <div class="tc-title">${tc.title}</div>
      <span class="tc-meta">${typeBadge(tc.test_type)}</span>
      <span class="tc-meta">${priorityBadge(tc.priority)}</span>
      <span class="tc-meta">${badge(tc.role || 'all', 'accent')}</span>
    </div>
  `).join('');
}

function openTCModal(tcId) {
  const tc = state.testCaseResult?.test_cases?.find(t => t.test_case_id === tcId);
  if (!tc) return;
  state.currentTCId = tcId;

  document.getElementById('tc-modal-title').textContent = `${tc.test_case_id} — ${tc.title}`;

  const steps = Array.isArray(tc.test_steps) ? tc.test_steps : [tc.test_steps];
  const preconditions = Array.isArray(tc.preconditions) ? tc.preconditions : [tc.preconditions];
  const testData = typeof tc.test_data === 'object'
    ? Object.entries(tc.test_data).map(([k, v]) => `${k}: ${v}`).join(', ')
    : tc.test_data || '—';

  document.getElementById('tc-modal-body').innerHTML = `
    <div class="field-row"><span class="field-label">Req ID</span><span class="field-value"><code>${tc.requirement_id}</code></span></div>
    <div class="field-row"><span class="field-label">Module</span><span class="field-value">${tc.module}</span></div>
    <div class="field-row"><span class="field-label">Type</span><span class="field-value">${typeBadge(tc.test_type)}</span></div>
    <div class="field-row"><span class="field-label">Priority</span><span class="field-value">${priorityBadge(tc.priority)}</span></div>
    <div class="field-row"><span class="field-label">Role</span><span class="field-value">${badge(tc.role || 'all', 'purple')}</span></div>
    <hr style="border-color:var(--glass-border);margin:12px 0"/>
    <div class="field-row"><span class="field-label">Preconditions</span>
      <span class="field-value">${preconditions.map(p => `• ${p}`).join('<br>')}</span>
    </div>
    <div class="field-row" style="margin-top:10px"><span class="field-label">Test Steps</span>
      <ul class="steps-list">
        ${steps.map(s => `<li>${s}</li>`).join('')}
      </ul>
    </div>
    <div class="field-row"><span class="field-label">Test Data</span><span class="field-value">${testData}</span></div>
    <div class="field-row"><span class="field-label">Expected Result</span>
      <span class="field-value">${tc.expected_result}</span>
    </div>
    <div class="field-row"><span class="field-label">Status</span>
      <span class="field-value">${badge(tc.status || 'Draft', tc.status === 'approved' ? 'green' : 'blue')}</span>
    </div>
  `;

  show('tc-modal-overlay');
}

function closeTCModal() { hide('tc-modal-overlay'); }

async function approveTCModal() {
  if (!state.currentTCId) return;
  try {
    await apiFetch(`/testcases/${state.currentTCId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const tc = state.testCaseResult.test_cases.find(t => t.test_case_id === state.currentTCId);
    if (tc) tc.status = 'approved';
    renderTestCases();
    closeTCModal();
    toast(`${state.currentTCId} approved`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function regenerateTCModal() {
  if (!state.currentTCId) return;
  const tc = state.testCaseResult.test_cases.find(t => t.test_case_id === state.currentTCId);
  if (!tc) return;
  const feedback = prompt('Optional: Enter QA feedback for regeneration:');
  closeTCModal();
  showLoader(`Regenerating test cases for ${tc.requirement_id}…`);
  try {
    const data = await apiFetch('/testcases/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirementId: tc.requirement_id, feedback }),
    });
    // Refresh test cases from server state
    const freshData = await apiFetch('/testcases/generate', { method: 'POST' });
    state.testCaseResult = freshData.testCaseResult;
    renderTestCases();
    toast(`Regenerated ${data.regeneratedCases?.length || 0} test cases`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    hideLoader();
  }
}

/* ══════════════════════════════════════════════════════════════
   F — RTM & TRACEABILITY
   ══════════════════════════════════════════════════════════════ */
async function buildAndRenderRTM() {
  if (!state.testCaseResult) return;
  updatePipelineStep('Traceability & Output', 'running');
  try {
    const statsData = await apiFetch('/stats');
    // RTM is computed server-side during export; show inline summary
    if (state.brdResult && state.testCaseResult && state.mappingResult) {
      renderRTMLocal();
    }
    updatePipelineStep('Traceability & Output', 'complete', 'RTM ready');
    updateDashboardStats();
  } catch (err) {
    // Non-critical
  }
}

function renderRTMLocal() {
  hide('rtm-no-data');
  show('rtm-content');

  const reqs = state.brdResult.requirements;
  const testCases = state.testCaseResult.test_cases;
  const mappings = state.mappingResult.mappings;

  const rtm = reqs.map(req => {
    const tcs = testCases.filter(tc => tc.requirement_id === req.id);
    const mapping = mappings.find(m => m.requirement_id === req.id);
    return {
      id: req.id,
      title: req.title,
      module: req.module,
      priority: req.priority,
      mapped_pages: mapping?.mapped_pages?.map(p => p.title || p.url).join('; ') || '—',
      tc_count: tcs.length,
      tc_ids: tcs.map(tc => tc.test_case_id).join(', '),
      status: tcs.length > 0 ? 'Covered' : 'Not Covered',
    };
  });

  const covered = rtm.filter(r => r.status === 'Covered').length;
  const coveragePercent = Math.round((covered / rtm.length) * 100);

  document.getElementById('rtm-summary').innerHTML = `
    <div class="rtm-metric"><span class="value">${rtm.length}</span><span class="label">Total requirements</span></div>
    <div class="rtm-metric"><span class="value value--green">${covered}</span><span class="label">Covered</span></div>
    <div class="rtm-metric"><span class="value value--red">${rtm.length - covered}</span><span class="label">Not covered</span></div>
    <div class="rtm-metric"><span class="value">${testCases.length}</span><span class="label">Test cases</span></div>
    <div class="rtm-metric"><span class="value value--green">${coveragePercent}%</span><span class="label">Coverage</span></div>
  `;

  state.rtmResult = { summary: { coverage_percent: coveragePercent, covered, total_requirements: rtm.length, total_test_cases: testCases.length } };
  document.getElementById('stat-coverage').textContent = coveragePercent + '%';

  const tbody = document.getElementById('rtm-tbody');
  tbody.innerHTML = rtm.map(r => `
    <tr>
      <td><code>${r.id}</code></td>
      <td>${r.title}</td>
      <td>${r.module || '—'}</td>
      <td>${priorityBadge(r.priority)}</td>
      <td style="font-size:0.8rem;max-width:200px">${r.mapped_pages}</td>
      <td><strong>${r.tc_count}</strong></td>
      <td style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-secondary)">${r.tc_ids || '—'}</td>
      <td>${badge(r.status, r.status === 'Covered' ? 'green' : 'error')}</td>
    </tr>
  `).join('');
}

/* ══════════════════════════════════════════════════════════════
   FULL PIPELINE
   ══════════════════════════════════════════════════════════════ */
function initPipeline() {
  document.getElementById('btn-run-pipeline').addEventListener('click', runFullPipeline);
}

async function runFullPipeline() {
  if (!state.brdResult) {
    navigateTo('brd-upload');
    return toast('Upload a BRD file first, then click Run Full Pipeline', 'info');
  }

  const confirmRun = confirm(
    'This will run the complete pipeline:\n'
    + 'A. BRD Understanding (already done)\n'
    + 'B. App Crawling (skipped — no credentials on dashboard)\n'
    + 'C. Knowledge Model\n'
    + 'D. Requirement Mapping\n'
    + 'E. Test Case Generation\n'
    + 'F. Traceability & Export\n\n'
    + 'Continue?'
  );
  if (!confirmRun) return;

  showLoader('Running requirement mapping…');
  updatePipelineStep('Requirement Mapping', 'running');

  try {
    // D: Mapping
    const mapData = await apiFetch('/mapping/run', { method: 'POST' });
    state.mappingResult = mapData.mappingResult;
    updatePipelineStep('Requirement Mapping', 'complete',
      `${state.mappingResult.stats.coveragePercent}% coverage`);

    // E: Test Cases
    hideLoader();
    showLoader('Generating test cases…');
    updatePipelineStep('Test Case Generation', 'running');
    const tcData = await apiFetch('/testcases/generate', { method: 'POST' });
    state.testCaseResult = tcData.testCaseResult;
    updatePipelineStep('Test Case Generation', 'complete',
      `${state.testCaseResult.test_cases.length} test cases`);
    renderTestCaseStats(state.testCaseResult.stats);
    renderTestCases();

    // F: RTM
    renderRTMLocal();
    updatePipelineStep('Traceability & Output', 'complete', 'RTM built');
    updateDashboardStats();
    await fetchStats();

    toast(`Pipeline complete! ${state.testCaseResult.test_cases.length} test cases ready.`, 'success');
    navigateTo('test-cases');
  } catch (err) {
    toast(`Pipeline error: ${err.message}`, 'error');
  } finally {
    hideLoader();
  }
}

/* ══════════════════════════════════════════════════════════════
   EXPORT
   ══════════════════════════════════════════════════════════════ */
async function exportExcel() {
  if (!state.testCaseResult) return toast('Generate test cases first', 'warning');
  showLoader('Generating Excel report…');
  try {
    const res = await fetch(`${API}/export/excel`, { method: 'POST' });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'test-output.xlsx';
    a.click(); URL.revokeObjectURL(url);
    toast('Excel report downloaded', 'success');
  } catch (err) { toast(err.message, 'error'); } finally { hideLoader(); }
}

async function exportCSV() {
  if (!state.testCaseResult) return toast('Generate test cases first', 'warning');
  showLoader('Generating CSV…');
  try {
    const res = await fetch(`${API}/export/csv`, { method: 'POST' });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'test-cases.csv';
    a.click(); URL.revokeObjectURL(url);
    toast('CSV downloaded', 'success');
  } catch (err) { toast(err.message, 'error'); } finally { hideLoader(); }
}

async function exportJSON() {
  if (!state.testCaseResult) return toast('Generate test cases first', 'warning');
  showLoader('Generating JSON…');
  try {
    const res = await fetch(`${API}/export/json`, { method: 'POST' });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'test-output.json';
    a.click(); URL.revokeObjectURL(url);
    toast('JSON downloaded', 'success');
  } catch (err) { toast(err.message, 'error'); } finally { hideLoader(); }
}

/* ══════════════════════════════════════════════════════════════
   STATS POLLING (LLM cost tracker)
   ══════════════════════════════════════════════════════════════ */
async function fetchStats() {
  try {
    const data = await apiFetch('/stats');
    const cost = data.llm?.totalCost || 0;
    document.getElementById('llm-cost').textContent = `$${cost.toFixed(4)}`;
    if (data.data) {
      if (data.data.hasTestCases && !state.testCaseResult) {
        // Sync from server
      }
    }
  } catch { /* ignore */ }
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
window.app = { openTCModal, exportExcel, exportCSV, exportJSON };

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initBRDUpload();
  initCrawler();
  initMapping();
  initTestCases();
  initPipeline();
  fetchStats();

  // Poll stats every 10s for live LLM cost
  setInterval(fetchStats, 10000);
});
