export function renderHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>People CRM</title>
<style>
:root {
  --bg: #0f1117;
  --surface: #1a1d27;
  --surface2: #242736;
  --border: #2e3140;
  --text: #e1e4ed;
  --text2: #8b8fa3;
  --accent: #6c8cff;
  --accent2: #4a6cf7;
  --red: #ff6b6b;
  --green: #51cf66;
  --orange: #ffa94d;
  --radius: 8px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg); color: var(--text);
  line-height: 1.5;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

/* Layout */
.header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 12px 24px;
  display: flex; align-items: center; gap: 16px;
  position: sticky; top: 0; z-index: 100;
}
.header h1 { font-size: 18px; font-weight: 600; white-space: nowrap; }
.header input {
  flex: 1; max-width: 400px;
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); padding: 8px 12px; border-radius: var(--radius);
  font-size: 14px; outline: none;
}
.header input:focus { border-color: var(--accent); }
.nav { display: flex; gap: 4px; }
.nav button {
  background: none; border: 1px solid transparent;
  color: var(--text2); padding: 6px 14px; border-radius: var(--radius);
  cursor: pointer; font-size: 13px; white-space: nowrap;
}
.nav button:hover, .nav button.active {
  background: var(--surface2); color: var(--text);
  border-color: var(--border);
}

.main { max-width: 1200px; margin: 0 auto; padding: 24px; }

/* Stats cards */
.stats { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
.stat {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px 20px; min-width: 140px;
}
.stat .n { font-size: 28px; font-weight: 700; color: var(--accent); }
.stat .label { font-size: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }

/* Filters */
.filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.filters select {
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); padding: 6px 10px; border-radius: var(--radius);
  font-size: 13px; cursor: pointer;
}

/* Table */
.table-wrap { overflow-x: auto; }
table {
  width: 100%; border-collapse: collapse;
  background: var(--surface); border-radius: var(--radius);
  overflow: hidden;
}
th {
  text-align: left; padding: 10px 14px; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--text2); background: var(--surface2);
  border-bottom: 1px solid var(--border);
  cursor: pointer; user-select: none; white-space: nowrap;
}
th:hover { color: var(--text); }
td {
  padding: 10px 14px; font-size: 13px;
  border-bottom: 1px solid var(--border);
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
tr:hover td { background: var(--surface2); }
tr { cursor: pointer; }

/* Badges */
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 12px;
  font-size: 11px; font-weight: 500;
}
.badge-type { background: #6c8cff22; color: var(--accent); }
.badge-active { background: #51cf6622; color: var(--green); }
.badge-cooling { background: #ffa94d22; color: var(--orange); }
.badge-cold { background: #ff6b6b22; color: var(--red); }
.badge-overdue { background: #ff6b6b33; color: var(--red); font-weight: 600; }

/* Person detail */
.detail { display: none; }
.detail.show { display: block; }
.detail-header { margin-bottom: 24px; }
.detail-header h2 { font-size: 24px; margin-bottom: 4px; }
.detail-header .meta { color: var(--text2); font-size: 14px; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 768px) { .detail-grid { grid-template-columns: 1fr; } }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px;
}
.card h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text2); margin-bottom: 10px; }
.card ul { list-style: none; }
.card li { padding: 4px 0; font-size: 13px; }
.card li::before { content: "\\2022"; color: var(--accent); margin-right: 8px; }

/* Email panel */
.email-panel { margin-top: 20px; }
.email-thread {
  background: var(--surface2); border-radius: var(--radius);
  padding: 12px; margin-bottom: 8px; font-size: 13px;
  border: 1px solid var(--border);
}
.email-thread .from { color: var(--accent); font-weight: 500; }
.email-thread .date { color: var(--text2); font-size: 12px; float: right; }
.email-thread .subject { margin-top: 4px; }
.email-thread .snippet { color: var(--text2); margin-top: 4px; }

/* Compose */
.compose {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px; margin-top: 16px;
}
.compose h3 { margin-bottom: 12px; font-size: 14px; }
.compose label { display: block; font-size: 12px; color: var(--text2); margin-bottom: 4px; margin-top: 8px; }
.compose input, .compose select, .compose textarea {
  width: 100%; background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); padding: 8px 10px; border-radius: var(--radius);
  font-size: 13px; font-family: inherit;
}
.compose textarea { height: 120px; resize: vertical; }
.compose .actions { margin-top: 12px; display: flex; gap: 8px; }
.btn {
  padding: 8px 16px; border-radius: var(--radius);
  font-size: 13px; cursor: pointer; border: none; font-weight: 500;
}
.btn-primary { background: var(--accent2); color: white; }
.btn-primary:hover { background: var(--accent); }
.btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
.btn-secondary:hover { background: var(--border); }
.btn-back { background: none; border: none; color: var(--text2); cursor: pointer; font-size: 13px; }
.btn-back:hover { color: var(--text); }

/* Interactions table */
.interactions-table { width: 100%; border-collapse: collapse; }
.interactions-table td { padding: 6px 10px; font-size: 13px; border-bottom: 1px solid var(--border); }
.interactions-table .src { color: var(--text2); font-size: 11px; text-transform: uppercase; }

.hidden { display: none; }
.loading { color: var(--text2); font-style: italic; padding: 20px; }
</style>
</head>
<body>

<div class="header">
  <h1>People CRM</h1>
  <input type="text" id="search" placeholder="Search people, orgs, topics..." autocomplete="off">
  <div class="nav">
    <button class="active" data-view="dashboard">Dashboard</button>
    <button data-view="people">All People</button>
    <button data-view="overdue">Overdue</button>
  </div>
</div>

<div class="main">
  <!-- Dashboard view -->
  <div id="view-dashboard">
    <div class="stats" id="stats"></div>
    <h2 style="margin-bottom:16px;font-size:16px">Overdue Follow-ups</h2>
    <div id="overdue-list"></div>
  </div>

  <!-- People list view -->
  <div id="view-people" class="hidden">
    <div class="filters" id="filters"></div>
    <div class="table-wrap">
      <table>
        <thead id="people-head"></thead>
        <tbody id="people-body"></tbody>
      </table>
    </div>
  </div>

  <!-- Overdue view -->
  <div id="view-overdue" class="hidden">
    <h2 style="margin-bottom:16px;font-size:16px">All Overdue Follow-ups</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Org</th><th>Role</th><th>Type</th><th>Overdue Since</th></tr></thead>
        <tbody id="overdue-body"></tbody>
      </table>
    </div>
  </div>

  <!-- Person detail view -->
  <div id="view-detail" class="hidden">
    <button class="btn-back" onclick="goBack()">&larr; Back to list</button>
    <div class="detail-header" id="detail-header"></div>
    <div class="detail-grid" id="detail-grid"></div>
    <div class="email-panel" id="email-panel"></div>
  </div>
</div>

<script>
let allPeople = [];
let accounts = [];
let currentView = 'dashboard';
let previousView = 'dashboard';
let sortCol = 'name';
let sortDir = 1;

// ── Init ──
async function init() {
  accounts = await api('/api/accounts');
  await loadDashboard();
  setupNav();
  setupSearch();
}

function setupNav() {
  document.querySelectorAll('.nav button').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
}

function setupSearch() {
  let timer;
  document.getElementById('search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      showView('people');
      loadPeople({ q: e.target.value });
    }, 300);
  });
}

function showView(view) {
  previousView = currentView;
  currentView = view;
  ['dashboard', 'people', 'overdue', 'detail'].forEach(v => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== view);
  });
  document.querySelectorAll('.nav button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  if (view === 'people') loadPeople({});
  if (view === 'overdue') loadOverdueView();
  if (view === 'dashboard') loadDashboard();
}

function goBack() { showView(previousView === 'detail' ? 'people' : previousView); }

// ── API ──
async function api(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

// ── Dashboard ──
async function loadDashboard() {
  const [stats, overdue] = await Promise.all([api('/api/stats'), api('/api/overdue')]);

  document.getElementById('stats').innerHTML = [
    statCard(stats.people, 'People'),
    statCard(stats.topics, 'Topics'),
    statCard(stats.interactions, 'Meetings'),
    statCard(stats.overdue, 'Overdue', stats.overdue > 0 ? 'color:var(--red)' : ''),
  ].join('');

  document.getElementById('overdue-list').innerHTML = overdue.length === 0
    ? '<p class="loading">All caught up!</p>'
    : renderTable(overdue.slice(0, 15), true);
}

function statCard(n, label, style = '') {
  return '<div class="stat"><div class="n" style="' + style + '">' + n + '</div><div class="label">' + label + '</div></div>';
}

// ── People List ──
async function loadPeople(filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.type) params.set('type', filters.type);
  if (filters.org) params.set('org', filters.org);
  allPeople = await api('/api/people?' + params);
  renderFilters();
  renderPeopleTable();
}

async function renderFilters() {
  const [types, orgs] = await Promise.all([api('/api/types'), api('/api/orgs')]);
  const typeOpts = types.map(t => '<option value="' + t.type + '">' + t.type + ' (' + t.count + ')</option>').join('');
  const orgOpts = orgs.map(o => '<option value="' + esc(o.org) + '">' + esc(o.org) + ' (' + o.count + ')</option>').join('');

  document.getElementById('filters').innerHTML =
    '<select id="filter-type" onchange="applyFilters()"><option value="">All Types</option>' + typeOpts + '</select>' +
    '<select id="filter-org" onchange="applyFilters()"><option value="">All Orgs</option>' + orgOpts + '</select>' +
    '<button class="btn btn-secondary" onclick="clearFilters()">Clear</button>';
}

function applyFilters() {
  loadPeople({
    type: document.getElementById('filter-type').value,
    org: document.getElementById('filter-org').value,
    q: document.getElementById('search').value,
  });
}

function clearFilters() {
  document.getElementById('search').value = '';
  loadPeople({});
}

function renderPeopleTable() {
  const cols = [
    ['name', 'Name'], ['org', 'Org'], ['role', 'Role'],
    ['type', 'Type'], ['next_followup', 'Next Follow-up'],
    ['first_contact_date', 'First Contact'],
  ];

  document.getElementById('people-head').innerHTML = '<tr>' +
    cols.map(([key, label]) =>
      '<th onclick="sortBy(\\'' + key + '\\')">' + label + (sortCol === key ? (sortDir === 1 ? ' \\u25B2' : ' \\u25BC') : '') + '</th>'
    ).join('') + '</tr>';

  const sorted = [...allPeople].sort((a, b) => {
    const va = (a[sortCol] ?? '') + '';
    const vb = (b[sortCol] ?? '') + '';
    return va.localeCompare(vb) * sortDir;
  });

  document.getElementById('people-body').innerHTML = sorted.map(p => {
    const status = getStatus(p);
    const overdue = p.next_followup && p.next_followup < today();
    return '<tr onclick="openPerson(\\'' + p.slug + '\\')">' +
      '<td><strong>' + esc(p.name) + '</strong></td>' +
      '<td>' + esc(p.org || '') + '</td>' +
      '<td>' + esc(p.role || '') + '</td>' +
      '<td>' + (p.type ? '<span class="badge badge-type">' + p.type + '</span>' : '') + '</td>' +
      '<td>' + (overdue ? '<span class="badge badge-overdue">' + p.next_followup + '</span>' : (p.next_followup || '')) + '</td>' +
      '<td>' + (p.first_contact_date || '') + '</td>' +
    '</tr>';
  }).join('');
}

function sortBy(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = 1; }
  renderPeopleTable();
}

// ── Overdue View ──
async function loadOverdueView() {
  const overdue = await api('/api/overdue');
  document.getElementById('overdue-body').innerHTML = overdue.map(p =>
    '<tr onclick="openPerson(\\'' + p.slug + '\\')">' +
    '<td><strong>' + esc(p.name) + '</strong></td>' +
    '<td>' + esc(p.org || '') + '</td>' +
    '<td>' + esc(p.role || '') + '</td>' +
    '<td>' + (p.type ? '<span class="badge badge-type">' + p.type + '</span>' : '') + '</td>' +
    '<td><span class="badge badge-overdue">' + (p.next_followup || '') + '</span></td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="5" class="loading">All caught up!</td></tr>';
}

// ── Person Detail ──
async function openPerson(slug) {
  showView('detail');
  const data = await api('/api/people/' + slug);
  if (!data) return;
  const { person: p, topics, interactions, emails } = data;

  const status = getStatus(p);
  const overdue = p.next_followup && p.next_followup < today();

  document.getElementById('detail-header').innerHTML =
    '<h2>' + esc(p.name) + '</h2>' +
    '<div class="meta">' +
      (p.role ? esc(p.role) : '') + (p.org ? ' at <strong>' + esc(p.org) + '</strong>' : '') +
      (p.type ? ' &middot; <span class="badge badge-type">' + p.type + '</span>' : '') +
      ' &middot; <span class="badge badge-' + status + '">' + status + '</span>' +
      (overdue ? ' &middot; <span class="badge badge-overdue">OVERDUE</span>' : '') +
    '</div>' +
    '<div class="meta" style="margin-top:8px">' +
      '<strong>' + esc(p.email || '') + '</strong>' +
      (p.linkedin_url ? ' &middot; <a href="' + esc(p.linkedin_url) + '" target="_blank">LinkedIn</a>' : '') +
      ' &middot; First contact: ' + (p.first_contact_date || 'unknown') +
      (p.next_followup ? ' &middot; Next: ' + p.next_followup : '') +
    '</div>';

  let grid = '';

  // Topics
  if (topics.length > 0) {
    grid += '<div class="card"><h3>Topics (' + topics.length + ')</h3><ul>' +
      topics.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></div>';
  }

  // Personal notes
  if (p.personal_notes) {
    grid += '<div class="card"><h3>Personal Notes</h3><ul>' +
      p.personal_notes.split('\\n').filter(Boolean).map(n => '<li>' + esc(n) + '</li>').join('') +
      '</ul></div>';
  }

  // Interactions
  if (interactions.length > 0) {
    grid += '<div class="card" style="grid-column:span 2"><h3>Interactions (' + interactions.length + ')</h3>' +
      '<table class="interactions-table">' +
      interactions.map(i =>
        '<tr><td style="width:100px">' + i.date + '</td>' +
        '<td><span class="src">' + i.source + '</span></td>' +
        '<td>' + esc(i.summary) + '</td></tr>'
      ).join('') + '</table></div>';
  }

  document.getElementById('detail-grid').innerHTML = grid;

  // Email panel
  const emailPanel = document.getElementById('email-panel');
  emailPanel.innerHTML = '<div class="card" style="margin-top:0">' +
    '<h3>Email Threads</h3><div id="email-threads" class="loading">Loading emails...</div>' +
    '</div>' + renderCompose(p);

  loadEmails(slug);
}

async function loadEmails(slug) {
  try {
    const threads = await api('/api/people/' + slug + '/emails');
    const container = document.getElementById('email-threads');

    let html = '';
    for (const t of threads) {
      // Parse the text-based results from gmailSearch
      const entries = t.results.split('\\n\\n').filter(e => e.includes('Subject:'));
      if (entries.length === 0 && !t.results.includes('No emails found')) {
        html += '<div class="email-thread"><div class="snippet">' + esc(t.results.slice(0, 200)) + '</div></div>';
        continue;
      }
      for (const entry of entries) {
        const lines = entry.split('\\n');
        const dateLine = lines.find(l => l.startsWith('[')) || '';
        const date = dateLine.match(/\\[(.+?)\\]/)?.[1] || '';
        const from = (lines.find(l => l.startsWith('From:')) || '').replace('From: ', '');
        const subject = (lines.find(l => l.startsWith('Subject:')) || '').replace('Subject: ', '');
        const snippet = (lines.find(l => l.startsWith('Snippet:')) || '').replace('Snippet: ', '');
        const id = (lines.find(l => l.startsWith('ID:')) || '').replace('ID: ', '');
        const account = (lines.find(l => l.startsWith('Account:')) || '').replace('Account: ', '');

        html += '<div class="email-thread" data-id="' + id + '" data-account="' + esc(account) + '" data-subject="' + esc(subject) + '">' +
          '<div class="date">' + esc(date) + '</div>' +
          '<div class="from">' + esc(from) + '</div>' +
          '<div class="subject">' + esc(subject) + '</div>' +
          '<div class="snippet">' + esc(snippet) + '</div>' +
          '</div>';
      }
    }

    container.innerHTML = html || '<p class="loading">No email threads found.</p>';
  } catch {
    document.getElementById('email-threads').innerHTML = '<p class="loading">Could not load emails.</p>';
  }
}

function renderCompose(person) {
  const accountOpts = accounts.map(a =>
    '<option value="' + a.email + '">' + a.email + '</option>'
  ).join('');

  return '<div class="compose"><h3>Compose Email</h3>' +
    '<label>From</label><select id="compose-from">' + accountOpts + '</select>' +
    '<label>To</label><input id="compose-to" value="' + esc(person.email || '') + '">' +
    '<label>Subject</label><input id="compose-subject">' +
    '<label>Message</label><textarea id="compose-body"></textarea>' +
    '<div class="actions">' +
      '<button class="btn btn-primary" onclick="doSend()">Send</button>' +
    '</div>' +
    '<div id="compose-status"></div></div>';
}

async function doSend() {
  const btn = document.querySelector('.compose .btn-primary');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const res = await api('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: document.getElementById('compose-from').value,
        to: document.getElementById('compose-to').value,
        subject: document.getElementById('compose-subject').value,
        text: document.getElementById('compose-body').value,
      }),
    });
    document.getElementById('compose-status').innerHTML =
      '<p style="color:var(--green);margin-top:8px">' + (res.message || 'Sent!') + '</p>';
    document.getElementById('compose-subject').value = '';
    document.getElementById('compose-body').value = '';
  } catch (e) {
    document.getElementById('compose-status').innerHTML =
      '<p style="color:var(--red);margin-top:8px">Error: ' + e.message + '</p>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

// ── Helpers ──
function renderTable(people, showOverdue) {
  if (people.length === 0) return '<p class="loading">None</p>';
  return '<div class="table-wrap"><table><thead><tr>' +
    '<th>Name</th><th>Org</th><th>Role</th><th>Type</th>' +
    (showOverdue ? '<th>Overdue Since</th>' : '<th>Next Follow-up</th>') +
    '</tr></thead><tbody>' +
    people.map(p =>
      '<tr onclick="openPerson(\\'' + p.slug + '\\')">' +
      '<td><strong>' + esc(p.name) + '</strong></td>' +
      '<td>' + esc(p.org || '') + '</td>' +
      '<td>' + esc(p.role || '') + '</td>' +
      '<td>' + (p.type ? '<span class="badge badge-type">' + p.type + '</span>' : '') + '</td>' +
      '<td><span class="badge badge-overdue">' + (p.next_followup || '') + '</span></td></tr>'
    ).join('') + '</tbody></table></div>';
}

function getStatus(p) {
  if (!p.first_contact_date) return 'cold';
  const days = (Date.now() - new Date(p.first_contact_date).getTime()) / 86400000;
  // Use last followup as proxy for last contact
  if (p.next_followup) {
    const followDays = (new Date(p.next_followup).getTime() - Date.now()) / 86400000;
    if (followDays < -90) return 'cold';
    if (followDays < 0) return 'cooling';
    return 'active';
  }
  return days < 90 ? 'active' : days < 180 ? 'cooling' : 'cold';
}

function today() { return new Date().toISOString().slice(0, 10); }
function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
</script>
</body>
</html>`;
}
