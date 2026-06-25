// =====================================================================
// Main application logic
// =====================================================================

const state = {
  scanOutItem:    null,
  weeklyCheck:    { items: [], decisions: [] },
  settings:       null,
  siCatalogItems: null
};

// =====================================================================
// INIT
// =====================================================================

document.addEventListener('DOMContentLoaded', () => {
  state.settings = loadSettings();
  setupNav();
  setupScanIn();
  setupScanOut();
  setupDashboard();
  setupReconcile();
  setupSettings();
});

// =====================================================================
// NAVIGATION
// =====================================================================

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');
      if (tab === 'dashboard') loadDashboard();
      if (tab === 'scan-out')  loadScanOutTab();
    });
  });
}

// =====================================================================
// SCAN IN — Catalog search-as-you-type picker
// =====================================================================

function setupScanIn() {
  // Catalog search: lazy-load catalog on first focus
  document.getElementById('si-catalog-search').addEventListener('focus', () => {
    if (!state.siCatalogItems) loadScanInCatalogList();
  });
  document.getElementById('si-catalog-search').addEventListener('input', e => {
    renderSICatalogList(e.target.value.trim());
  });
  document.getElementById('btn-si-catalog-clear').addEventListener('click', clearSICatalogSelection);
  document.getElementById('btn-si-clear').addEventListener('click', clearScanInForm);

  document.getElementById('form-scan-in').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ref    = v('si-ref');
    const name   = v('si-name');
    const lot    = v('si-lot');
    const expiry = v('si-expiry');
    const qty    = parseInt(document.getElementById('si-qty').value, 10);

    if (!ref) { showToast('Select an item from the catalog first', 'error'); return; }
    if (isNaN(qty) || qty < 1) { showToast('Quantity must be at least 1', 'error'); return; }

    if (expiry && expiry < today()) {
      const warn = document.getElementById('si-expiry-warning');
      warn.classList.remove('hidden');
      document.getElementById('btn-si-override-yes').onclick = () => {
        warn.classList.add('hidden');
        submitScanIn(ref, lot, expiry, qty, name);
      };
      document.getElementById('btn-si-override-no').onclick = () => warn.classList.add('hidden');
      return;
    }

    await submitScanIn(ref, lot, expiry, qty, name);
  });
}

async function loadScanInCatalogList() {
  const result = await api.get('getCatalog');
  if (!result.success) { showToast('Error loading catalog: ' + result.error, 'error'); return; }
  state.siCatalogItems = (result.items || [])
    .sort((a, b) => (a.name || a.ref).localeCompare(b.name || b.ref));
  renderSICatalogList(document.getElementById('si-catalog-search').value.trim());
}

function renderSICatalogList(term) {
  const listEl = document.getElementById('si-catalog-list');
  const items  = state.siCatalogItems;
  if (!items) return;
  const t        = term.toLowerCase();
  const filtered = items.filter(i =>
    !t || (i.name && i.name.toLowerCase().includes(t)) || i.ref.toLowerCase().includes(t)
  );
  if (filtered.length === 0) {
    listEl.innerHTML = '<p class="no-items" style="padding:10px 16px">No items found.</p>';
    listEl.classList.remove('hidden');
    return;
  }
  listEl.innerHTML = filtered.map(i =>
    `<div class="search-result-row" data-ref="${esc(i.ref)}" data-name="${esc(i.name || '')}">
      <div class="search-result-name">${esc(i.name || i.ref)}</div>
      <div class="search-result-meta">REF: ${esc(i.ref)}</div>
    </div>`
  ).join('');
  listEl.classList.remove('hidden');
  listEl.querySelectorAll('.search-result-row').forEach(row => {
    row.addEventListener('click', () => selectSICatalogItem(row.dataset.ref, row.dataset.name));
  });
}

function selectSICatalogItem(ref, name) {
  document.getElementById('si-ref').value  = ref;
  document.getElementById('si-name').value = name;
  document.getElementById('si-catalog-selected-name').textContent = name || ref;
  document.getElementById('si-catalog-selected').classList.remove('hidden');
  document.getElementById('si-catalog-list').classList.add('hidden');
  document.getElementById('si-catalog-search').value = '';
  document.getElementById('si-lot').focus();
}

function clearSICatalogSelection() {
  document.getElementById('si-ref').value   = '';
  document.getElementById('si-name').value  = '';
  document.getElementById('si-catalog-selected').classList.add('hidden');
  document.getElementById('si-catalog-search').value = '';
  document.getElementById('si-catalog-search').focus();
}

function clearScanInForm() {
  ['si-lot', 'si-expiry'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('si-qty').value = '1';
  document.getElementById('si-expiry-warning').classList.add('hidden');
  clearSICatalogSelection();
  if (state.siCatalogItems) {
    document.getElementById('si-catalog-list').classList.add('hidden');
  }
}

async function submitScanIn(gtin, lot, expiry, qty, itemName) {
  const btn = document.getElementById('btn-si-submit');
  setLoading(btn, 'Logging...');
  const result = await api.post('scanIn', { gtin, lot, expiry, qty, itemName });
  resetButton(btn, 'Log Stock In');
  if (!result.success) { showToast('Error: ' + result.error, 'error'); return; }
  const msg = result.action === 'created'
    ? `New batch created. Qty: ${result.newQty}`
    : `Updated existing batch. New qty: ${result.newQty}`;
  showToast(msg, 'success');
  clearScanInForm();
}

// =====================================================================
// SCAN OUT
// =====================================================================

function setupScanOut() {
  document.getElementById('so-search').addEventListener('input', e => {
    renderSOList(e.target.value.trim());
  });

  document.getElementById('btn-so-lot-back').addEventListener('click', () => {
    hide('so-lot-step');
    show('so-item-list');
  });

  document.getElementById('btn-so-cancel').addEventListener('click', () => {
    hide('scan-out-result');
    show('so-manual-panel');
    hide('so-lot-step');
    show('so-item-list');
    state.scanOutItem = null;
    document.getElementById('btn-so-confirm').textContent = 'Confirm Use';
    document.getElementById('btn-so-cancel').textContent  = 'Cancel';
  });

  document.getElementById('form-scan-out').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.scanOutItem) return;
    const qty = parseInt(document.getElementById('so-qty').value, 10) || 1;
    await submitScanOut(qty);
  });
}

async function loadScanOutTab() {
  const listEl   = document.getElementById('so-item-list');
  const searchEl = document.getElementById('so-search');
  if (!listEl) return;
  if (searchEl) searchEl.value = '';
  hide('so-lot-step');
  show('so-item-list');
  listEl.innerHTML = '<p class="no-items">Loading&hellip;</p>';

  const result = await api.get('getInventory');
  if (!result.success) {
    listEl.innerHTML = '<p class="no-items">Error loading inventory</p>';
    return;
  }
  const items = result.items || [];
  if (items.length === 0) {
    listEl.innerHTML = '<p class="no-items">No items in inventory.</p>';
    return;
  }

  const groupMap = new Map();
  items.forEach(item => {
    if (!groupMap.has(item.gtin)) {
      groupMap.set(item.gtin, { gtin: item.gtin, name: item.name || item.gtin, lots: [], totalQty: 0, location: item.location, unit: item.unit });
    }
    const g = groupMap.get(item.gtin);
    g.lots.push(item);
    g.totalQty += item.qty;
    if (!g.name && item.name) g.name = item.name;
  });
  state.soGroups = Array.from(groupMap.values())
    .sort((a, b) => (a.name || a.gtin).localeCompare(b.name || b.gtin));
  renderSOList('');
}

function renderSOList(term) {
  const listEl = document.getElementById('so-item-list');
  const groups = state.soGroups;
  if (!groups || !listEl) return;
  const t        = term.toLowerCase();
  const todayStr = today();
  const filtered = groups.filter(g =>
    !t || (g.name && g.name.toLowerCase().includes(t)) || g.gtin.toLowerCase().includes(t)
  );
  if (filtered.length === 0) {
    listEl.innerHTML = '<p class="no-items">No items found.</p>';
    return;
  }
  listEl.innerHTML = filtered.map(g => {
    const anyExpired  = g.lots.some(l => l.expiry && l.expiry < todayStr);
    const anyExpiring = !anyExpired && g.lots.some(l => l.expiry && daysDiff(todayStr, l.expiry) <= state.settings.expiryWarningDays);
    const rowCls = anyExpired ? 'row-expired' : anyExpiring ? 'row-expiring' : '';
    const qtyStr = formatQty(g.totalQty, g.unit);
    const locStr = g.location ? ` &middot; ${esc(g.location)}` : '';
    const badge  = anyExpired
      ? ' <span class="badge badge-expired">Expired</span>'
      : anyExpiring ? ' <span class="badge badge-expiring">Soon</span>' : '';
    return `<div class="so-item-row ${rowCls}" data-gtin="${esc(g.gtin)}">
      <div>
        <div class="so-item-name">${esc(g.name)}${badge}</div>
        <div class="so-item-meta">Qty: ${qtyStr}${locStr}</div>
      </div>
      <span class="so-item-arrow">&#8250;</span>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.so-item-row').forEach(row => {
    row.addEventListener('click', () => {
      const group = state.soGroups.find(g => g.gtin === row.dataset.gtin);
      if (!group) return;
      if (group.lots.length === 1) {
        const lot = group.lots[0];
        lookupForScanOut({ gtin: lot.gtin, lot: lot.lot, expiry: lot.expiry }, lot.gtin);
      } else {
        showSOLotStep(group);
      }
    });
  });
}

function showSOLotStep(group) {
  hide('so-item-list');
  const lotListEl = document.getElementById('so-lot-list');
  const todayStr  = today();
  const sorted    = [...group.lots].sort((a, b) => {
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  });
  lotListEl.innerHTML = sorted.map((lot, i) => {
    const expired  = lot.expiry && lot.expiry < todayStr;
    const expiring = !expired && lot.expiry && daysDiff(todayStr, lot.expiry) <= state.settings.expiryWarningDays;
    const lotCls   = expired ? 'lot-expired' : expiring ? 'lot-expiring' : '';
    const qtyStr   = formatQty(lot.qty, lot.unit);
    return `<div class="so-lot-row ${lotCls}" data-lot-idx="${i}">
      <div>
        <div class="so-lot-expiry">${esc(formatExpiry(lot.expiry) || 'No expiry date')}</div>
        <div class="so-lot-meta">LOT: ${esc(lot.lot || '—')} &middot; Qty: ${qtyStr}</div>
      </div>
      <span class="so-item-arrow">&#8250;</span>
    </div>`;
  }).join('');
  lotListEl.querySelectorAll('.so-lot-row').forEach(row => {
    row.addEventListener('click', () => {
      const lot = sorted[parseInt(row.dataset.lotIdx, 10)];
      hide('so-lot-step');
      show('so-item-list');
      lookupForScanOut({ gtin: lot.gtin, lot: lot.lot, expiry: lot.expiry }, lot.gtin);
    });
  });
  show('so-lot-step');
}

async function lookupForScanOut(parsed, rawText) {
  const gtin   = parsed.gtin || rawText;
  const lot    = parsed.lot  || '';
  const expiry = parsed.expiry || '';

  const result    = await api.get('lookupBatch', { gtin, lot, expiry });
  const resultDiv = document.getElementById('scan-out-result');
  const card      = document.getElementById('so-status-card');

  if (!result.success) {
    showToast('API error: ' + result.error, 'error');
    return;
  }

  resultDiv.classList.remove('hidden');
  hide('so-manual-panel');

  if (!result.found) {
    state.scanOutItem = null;
    card.className    = 'card status-card';
    card.innerHTML    = `
      <div class="status-badge" style="background:var(--text3);color:#fff">Not Found</div>
      <strong>Not found in inventory</strong>
      <div class="status-detail">REF: ${esc(gtin)}${lot ? ' &middot; Lot: ' + esc(lot) : ''}</div>`;
    hide('form-scan-out');
    return;
  }

  const item = result.item;
  state.scanOutItem = item;
  show('form-scan-out');
  renderScanOutCard(item);
}

function renderScanOutCard(item) {
  const card     = document.getElementById('so-status-card');
  const daysLeft = daysDiff(today(), item.expiry);

  if (item.qty <= 0) {
    card.className = 'card status-card status-no-stock';
    card.innerHTML = `
      <div class="status-badge">No Stock</div>
      <strong>${esc(item.name || item.gtin)}</strong>
      <div class="status-detail">No stock recorded &mdash; check the physical shelf</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Expiry: ${esc(item.expiry || '&mdash;')}</div>`;
    document.getElementById('btn-so-confirm').disabled = true;
    return;
  }

  document.getElementById('btn-so-confirm').disabled = false;
  document.getElementById('so-qty').max = item.qty;

  const expiryLabel = formatExpiry(item.expiry);
  const qtyStr      = formatQty(item.qty, item.unit);
  const locLine     = item.location
    ? `<div class="status-detail">Location: ${esc(item.location)}</div>` : '';

  if (item.expiry && item.expiry < today()) {
    card.className = 'card status-card status-expired';
    card.innerHTML = `
      <div class="status-badge">EXPIRED</div>
      <strong>${esc(item.name || item.gtin)}</strong>
      <div class="status-detail">${esc(expiryLabel)}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty: ${qtyStr}</div>
      ${locLine}`;
  } else if (item.expiry && daysLeft <= state.settings.expiryWarningDays) {
    card.className = 'card status-card status-expiring';
    card.innerHTML = `
      <div class="status-badge">EXPIRING SOON</div>
      <strong>${esc(item.name || item.gtin)}</strong>
      <div class="status-detail">${esc(expiryLabel)}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty: ${qtyStr}</div>
      ${locLine}`;
  } else {
    card.className = 'card status-card status-ok';
    card.innerHTML = `
      <div class="status-badge">OK</div>
      <strong>${esc(item.name || item.gtin)}</strong>
      <div class="status-detail">${expiryLabel ? esc(expiryLabel) : 'No expiry date recorded'}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty: ${qtyStr}</div>
      ${locLine}`;
  }
}

async function submitScanOut(qty) {
  const item        = state.scanOutItem;
  const btn         = document.getElementById('btn-so-confirm');
  const prevBtnText = btn.textContent;
  setLoading(btn, 'Processing...');

  const result = await api.post('scanOut', {
    gtin:   item.gtin,
    lot:    item.lot,
    expiry: item.expiry,
    qty
  });

  if (!result.success) {
    resetButton(btn, prevBtnText);
    const msg = result.error === 'no_stock'
      ? 'No stock recorded — cannot go below 0'
      : 'Error: ' + result.error;
    showToast(msg, 'error');
    return;
  }

  const note = result.archived ? ' (archived — expired + empty)' : '';
  showToast(`Used ${qty}. Remaining: ${result.newQty}${note}`, 'success');

  if (result.archived || result.newQty <= 0) {
    resetButton(btn, 'Confirm Use');
    hide('scan-out-result');
    state.scanOutItem = null;
    return;
  }

  state.scanOutItem = { ...item, qty: result.newQty };
  renderScanOutCard(state.scanOutItem);
  document.getElementById('so-qty').value = '1';
  resetButton(btn, 'Use Same Item Again');
  document.getElementById('btn-so-cancel').textContent = 'Done';
}

// =====================================================================
// DASHBOARD
// =====================================================================

function setupDashboard() {
  document.getElementById('btn-refresh-dashboard').addEventListener('click', loadDashboard);
}

async function loadDashboard() {
  const content = document.getElementById('dashboard-content');
  document.getElementById('dashboard-summary').classList.add('hidden');
  content.innerHTML = '<p class="no-items">Loading&hellip;</p>';

  const result = await api.get('getInventory');
  if (!result.success) {
    content.innerHTML = `<p class="no-items">Error: ${esc(result.error)}</p>`;
    return;
  }

  const items = result.items || [];
  if (items.length === 0) {
    content.innerHTML = '<p class="no-items">No items in inventory yet.</p>';
    return;
  }

  state.dashboardFilters = { location: '', statuses: new Set() };

  const { expiryWarningDays: wDays, lowStockThreshold: lowQty } = state.settings;
  const todayStr = today();

  items.sort((a, b) => {
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  });

  const groupMap = new Map();
  items.forEach(item => {
    if (!groupMap.has(item.gtin)) {
      groupMap.set(item.gtin, { gtin: item.gtin, name: item.name || item.gtin, lots: [], totalQty: 0, soonestExpiry: null, location: item.location, unit: item.unit });
    }
    const g = groupMap.get(item.gtin);
    g.lots.push(item);
    g.totalQty += item.qty;
    if (item.expiry && (!g.soonestExpiry || item.expiry < g.soonestExpiry)) g.soonestExpiry = item.expiry;
    if (!g.name && item.name) g.name = item.name;
  });
  state.dashboardGroups = Array.from(groupMap.values());

  let expiredCount = 0, soonCount = 0, lowCount = 0;
  state.dashboardGroups.forEach(g => {
    const anyExpired  = g.lots.some(l => l.expiry && l.expiry < todayStr);
    const anyExpiring = !anyExpired && g.lots.some(l => l.expiry && daysDiff(todayStr, l.expiry) <= wDays);
    if (anyExpired)       expiredCount++;
    else if (anyExpiring) soonCount++;
    if (g.totalQty > 0 && g.totalQty <= lowQty) lowCount++;
  });

  const kpiHtml = `<div class="kpi-grid">
    <div class="kpi-card kpi-total">
      <div class="kpi-lbl">Active Items</div>
      <div class="kpi-num">${state.dashboardGroups.length}</div>
    </div>
    <div class="kpi-card kpi-expiring">
      <div class="kpi-lbl">Expiring Soon</div>
      <div class="kpi-num">${soonCount}</div>
    </div>
    <div class="kpi-card kpi-expired">
      <div class="kpi-lbl">Expired</div>
      <div class="kpi-num">${expiredCount}</div>
    </div>
    <div class="kpi-card kpi-low">
      <div class="kpi-lbl">Low Stock</div>
      <div class="kpi-num">${lowCount}</div>
    </div>
  </div>`;

  // Expiry ring timeline (soonest-expiring, max 8)
  const withExpiry = items.filter(i => i.expiry).slice(0, 8);
  let timelineHtml = '';
  if (withExpiry.length > 0) {
    const rows = withExpiry.map(item => {
      const expired  = item.expiry < todayStr;
      const dLeft    = daysDiff(todayStr, item.expiry);
      const expiring = !expired && dLeft <= wDays;
      const color    = expired ? 'var(--red)' : expiring ? 'var(--amber)' : 'var(--green)';
      const pct      = expired ? 0 : Math.min(100, (dLeft / 90) * 100);
      const center   = expired ? 'EXP' : dLeft === 0 ? '0d' : dLeft < 100 ? dLeft + 'd' : '90+';
      return `<div class="ring-list-item">
        <div class="ring-wrap">${ringHTML(pct, color, center)}</div>
        <div class="ring-info">
          <div class="ring-name">${esc(item.name || item.gtin)}</div>
          <div class="ring-expiry" style="color:${color}">${esc(formatExpiry(item.expiry))}</div>
          <div class="ring-meta">Lot: ${esc(item.lot || '—')} · Qty: ${item.qty}</div>
        </div>
      </div>`;
    }).join('');
    timelineHtml = `<div class="panel">
      <div class="panel-header"><h3>Expiry Timeline</h3></div>
      <div class="panel-body">${rows}</div>
    </div>`;
  }

  // Stock levels chart (top 10 by qty)
  const nameMap = {};
  items.forEach(item => {
    const name = item.name || item.gtin;
    if (!nameMap[name]) nameMap[name] = { qty: 0, expired: false, expiring: false };
    nameMap[name].qty += item.qty;
    if (item.expiry && item.expiry < todayStr) nameMap[name].expired = true;
    else if (item.expiry && daysDiff(todayStr, item.expiry) <= wDays) nameMap[name].expiring = true;
  });
  const nameEntries = Object.entries(nameMap).sort((a, b) => b[1].qty - a[1].qty).slice(0, 10);
  let chartHtml = '';
  if (nameEntries.length > 1) {
    const maxQty = Math.max(1, ...nameEntries.map(([, v]) => v.qty));
    const bars = nameEntries.map(([name, v]) => {
      const color = v.expired ? 'var(--red)' : v.expiring ? 'var(--amber)' : 'var(--green)';
      const w = Math.max(3, Math.round((v.qty / maxQty) * 100));
      return `<div class="stock-bar-item">
        <div class="stock-bar-header">
          <span class="stock-bar-name">${esc(name)}</span>
          <span class="stock-bar-qty">${v.qty}</span>
        </div>
        <div class="stock-bar-track">
          <div class="stock-bar-fill" style="width:${w}%;background:${color}"></div>
        </div>
      </div>`;
    }).join('');
    chartHtml = `<div class="panel">
      <div class="panel-header"><h3>Stock Levels by Item</h3></div>
      <div class="panel-body">${bars}</div>
    </div>`;
  }

  // Filter bar
  const uniqueLocs = uniqueLocations(items);
  const locOptions = uniqueLocs.map(loc => {
    const label = loc === '__unassigned__' ? '(Unassigned)' : loc;
    return `<option value="${esc(loc)}">${esc(label)}</option>`;
  }).join('');
  const filterBarHtml = `<div class="filter-bar" id="dash-filter-bar">
    <select class="filter-location" id="dash-filter-loc">
      <option value="">All locations</option>
      ${locOptions}
    </select>
    <div class="filter-chips">
      <button type="button" class="filter-chip" data-status="expiring">Expiring Soon</button>
      <button type="button" class="filter-chip" data-status="expired">Expired</button>
      <button type="button" class="filter-chip" data-status="low">Low Stock</button>
    </div>
    <button type="button" class="filter-clear hidden" id="dash-filter-clear">Clear</button>
  </div>`;

  // Inventory cards (one per GTIN group)
  const cards = state.dashboardGroups.map((g, gIdx) => {
    const anyExpired  = g.lots.some(l => l.expiry && l.expiry < todayStr);
    const anyExpiring = !anyExpired && g.lots.some(l => l.expiry && daysDiff(todayStr, l.expiry) <= wDays);
    const isLow       = g.totalQty > 0 && g.totalQty <= lowQty;
    const cls         = anyExpired ? 'inv-card-expired' : anyExpiring ? 'inv-card-expiring' : 'inv-card-ok';
    const badge       = anyExpired
      ? '<span class="badge badge-expired">Expired</span>'
      : anyExpiring ? '<span class="badge badge-expiring">Soon</span>' : '';
    const qtyDisplay  = formatQty(g.totalQty, g.unit);
    const locChip     = g.location ? `<div class="inv-card-loc">&#128205; ${esc(g.location)}</div>` : '';
    const firstLot    = g.lots[0];
    const multiLot    = g.lots.length > 1;

    const lotsHtml = g.lots.map(lot => {
      const le = lot.expiry && lot.expiry < todayStr;
      const lx = !le && lot.expiry && daysDiff(todayStr, lot.expiry) <= wDays;
      const ec = le ? 'inv-lot-value-expiry-expired' : lx ? 'inv-lot-value-expiry-expiring' : '';
      return `<div class="inv-lot-row">
        <div class="inv-lot-row-fields">
          ${lot.lot    ? `<span class="inv-lot-field"><span class="inv-lot-label">LOT</span><span class="inv-lot-value">${esc(lot.lot)}</span></span>` : ''}
          ${lot.expiry ? `<span class="inv-lot-field"><span class="inv-lot-label">Expiry</span><span class="inv-lot-value ${ec}">${esc(formatExpiry(lot.expiry))}</span></span>` : ''}
          <span class="inv-lot-field"><span class="inv-lot-label">Qty</span><span class="inv-lot-value">${formatQty(lot.qty, lot.unit)}</span></span>
        </div>
      </div>`;
    }).join('');

    const expandBtn = multiLot ? `<button type="button" class="inv-lot-expand-btn" data-gidx="${gIdx}">${g.lots.length} lots &#9660;</button>` : '';

    return `<div class="inv-card ${cls}" data-group-idx="${gIdx}">
      <div class="inv-card-header">
        <span class="inv-card-name">${esc(g.name)}</span>
        ${badge}
        ${expandBtn}
      </div>
      ${g.gtin !== g.name ? `<div class="inv-card-meta" style="margin-bottom:4px"><span class="inv-lot-field"><span class="inv-lot-label">REF</span> <span class="inv-lot-value">${esc(g.gtin)}</span></span></div>` : ''}
      <div class="inv-card-expiry">${esc(formatExpiry(g.soonestExpiry) || 'No expiry date')}</div>
      <div class="inv-card-meta">
        <span>Qty: <strong class="${isLow ? 'inv-card-qty-low' : ''}">${qtyDisplay}${isLow ? ' · LOW' : ''}</strong></span>
        ${!multiLot && firstLot?.lot ? '<span>LOT: ' + esc(firstLot.lot) + '</span>' : ''}
      </div>
      ${locChip}
      ${multiLot ? `<div class="inv-lots-list hidden" id="inv-lots-${gIdx}">${lotsHtml}</div>` : ''}
    </div>`;
  }).join('');

  const inventoryHtml = `<div class="panel">
    <div class="panel-header"><h3>All Inventory</h3></div>
    <div class="panel-body" style="padding:6px 16px 14px">
      ${filterBarHtml}
      <div id="dash-inv-list">${cards}</div>
      <p class="no-items hidden" id="dash-no-matches">No items match the current filter.</p>
    </div>
  </div>`;

  content.innerHTML = kpiHtml + timelineHtml + chartHtml + inventoryHtml;

  document.getElementById('dash-filter-loc').addEventListener('change', e => {
    state.dashboardFilters.location = e.target.value;
    applyDashboardFilters();
  });
  content.querySelectorAll('#dash-filter-bar .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.status;
      const set = state.dashboardFilters.statuses;
      if (set.has(key)) set.delete(key); else set.add(key);
      chip.classList.toggle('selected', set.has(key));
      applyDashboardFilters();
    });
  });
  document.getElementById('dash-filter-clear').addEventListener('click', () => {
    state.dashboardFilters = { location: '', statuses: new Set() };
    document.getElementById('dash-filter-loc').value = '';
    content.querySelectorAll('#dash-filter-bar .filter-chip').forEach(c => c.classList.remove('selected'));
    applyDashboardFilters();
  });

  content.querySelectorAll('.inv-lot-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const gIdx   = parseInt(btn.dataset.gidx, 10);
      const lotsEl = document.getElementById('inv-lots-' + gIdx);
      if (!lotsEl) return;
      const open = !lotsEl.classList.contains('hidden');
      lotsEl.classList.toggle('hidden', open);
      btn.innerHTML = open
        ? `${state.dashboardGroups[gIdx].lots.length} lots &#9660;`
        : `${state.dashboardGroups[gIdx].lots.length} lots &#9650;`;
    });
  });
}

function applyDashboardFilters() {
  const groups  = state.dashboardGroups || [];
  const filters = state.dashboardFilters;
  const { expiryWarningDays: wDays, lowStockThreshold: lowQty } = state.settings;
  const todayStr = today();

  const active = Boolean(filters.location) || filters.statuses.size > 0;
  document.getElementById('dash-filter-clear').classList.toggle('hidden', !active);

  let visibleCount = 0;
  groups.forEach((g, gIdx) => {
    const card = document.querySelector(`.inv-card[data-group-idx="${gIdx}"]`);
    if (!card) return;
    let pass = true;
    if (filters.location) {
      const hasLoc = g.lots.some(l => (l.location || '__unassigned__') === filters.location);
      if (!hasLoc) pass = false;
    }
    if (pass && filters.statuses.size > 0) {
      const anyExpired  = g.lots.some(l => l.expiry && l.expiry < todayStr);
      const anyExpiring = !anyExpired && g.lots.some(l => l.expiry && daysDiff(todayStr, l.expiry) <= wDays);
      const isLow       = g.totalQty > 0 && g.totalQty <= lowQty;
      let any = false;
      if (filters.statuses.has('expiring') && anyExpiring) any = true;
      if (filters.statuses.has('expired')  && anyExpired)  any = true;
      if (filters.statuses.has('low')      && isLow)       any = true;
      if (!any) pass = false;
    }
    card.classList.toggle('hidden', !pass);
    if (pass) visibleCount++;
  });

  document.getElementById('dash-no-matches').classList.toggle('hidden', visibleCount > 0);
}

function uniqueLocations(items) {
  const set = new Set();
  items.forEach(i => set.add(i.location ? i.location : '__unassigned__'));
  return Array.from(set).sort((a, b) => {
    if (a === '__unassigned__') return 1;
    if (b === '__unassigned__') return -1;
    return a.localeCompare(b);
  });
}

// =====================================================================
// WEEKLY CHECK
// =====================================================================

function setupReconcile() {
  renderWCIdle();
}

function renderWCIdle() {
  const container = document.getElementById('wc-container');
  container.innerHTML = `
    <p class="helper-text">Walk through all items shelf-by-shelf, driven by the Item Catalog. Every known item appears even at zero stock.</p>
    <button id="btn-wc-start" class="btn-primary">Start Weekly Check</button>
  `;
  document.getElementById('btn-wc-start').addEventListener('click', loadWeeklyCheck);
}

async function loadWeeklyCheck() {
  const container = document.getElementById('wc-container');
  container.innerHTML = '<p class="no-items">Loading&hellip;</p>';

  const [catalogResult, inventoryResult] = await Promise.all([
    api.get('getCatalog'),
    api.get('getInventory')
  ]);

  if (!catalogResult.success) {
    container.innerHTML = `<p class="no-items">Error loading catalog: ${esc(catalogResult.error)}</p>`;
    return;
  }
  if (!inventoryResult.success) {
    container.innerHTML = `<p class="no-items">Error loading inventory: ${esc(inventoryResult.error)}</p>`;
    return;
  }

  const catalogItems = catalogResult.items || [];
  if (catalogItems.length === 0) {
    container.innerHTML = '<p class="no-items">Item Catalog is empty — add items to the Catalog sheet first.</p>';
    return;
  }
  const inventoryItems = inventoryResult.items || [];

  const invByRef = new Map();
  inventoryItems.forEach(item => {
    const ref = (item.gtin || '').trim();
    if (!invByRef.has(ref)) invByRef.set(ref, []);
    invByRef.get(ref).push(item);
  });

  const joined   = [];
  const flatLots = [];

  catalogItems.forEach((catalogItem, jiIdx) => {
    const lots = invByRef.get(catalogItem.ref) || [];
    lots.sort((a, b) => {
      if (!a.expiry && !b.expiry) return 0;
      if (!a.expiry) return 1;
      if (!b.expiry) return -1;
      return a.expiry.localeCompare(b.expiry);
    });
    const totalPieces = lots.reduce((sum, lot) => sum + (lot.qty || 0), 0);
    lots.forEach(lot => {
      lot._flatIdx = flatLots.length;
      lot._jiIdx   = jiIdx;
      flatLots.push(lot);
    });
    joined.push({ catalogItem, lots, totalPieces });
  });

  state.weeklyCheck = {
    joined,
    items:     flatLots,
    decisions: flatLots.map(() => ({
      integrityStatus: null,
      flagNote:        '',
      qtyMode:         null,
      physicalQty:     null,
      reason:          '',
      done:            false
    }))
  };
  state.wcFilters = { location: '', statuses: new Set() };

  renderWCChecklist();
}

function renderWCChecklist() {
  const { joined, items } = state.weeklyCheck;
  const container = document.getElementById('wc-container');

  const catalogLocs = new Set();
  joined.forEach(ji => catalogLocs.add(ji.catalogItem.location || '__unassigned__'));
  const sortedLocKeys = Array.from(catalogLocs).sort((a, b) => {
    if (a === '__unassigned__') return 1;
    if (b === '__unassigned__') return -1;
    return a.localeCompare(b);
  });
  const locOptions = sortedLocKeys.map(loc => {
    const label = loc === '__unassigned__' ? '(Unassigned)' : loc;
    return `<option value="${esc(loc)}">${esc(label)}</option>`;
  }).join('');
  const filterBarHtml = `<div class="filter-bar" id="wc-filter-bar">
    <select class="filter-location" id="wc-filter-loc">
      <option value="">All locations</option>
      ${locOptions}
    </select>
    <div class="filter-chips">
      <button type="button" class="filter-chip" data-status="expiring">Expiring Soon</button>
      <button type="button" class="filter-chip" data-status="below-norm">Below Norm</button>
      <button type="button" class="filter-chip" data-status="flagged">Flagged</button>
    </div>
    <button type="button" class="filter-clear hidden" id="wc-filter-clear">Clear</button>
  </div>`;

  const locationGroups = new Map();
  joined.forEach((ji, jiIdx) => {
    const loc = ji.catalogItem.location || '__unassigned__';
    if (!locationGroups.has(loc)) locationGroups.set(loc, []);
    locationGroups.get(loc).push({ ji, jiIdx });
  });

  let html = filterBarHtml + '<p class="no-items hidden" id="wc-no-matches">No items match the current filter.</p>';

  for (const locKey of sortedLocKeys) {
    const locItems = locationGroups.get(locKey);
    if (!locItems) continue;
    const label     = locKey === '__unassigned__' ? 'Unassigned' : locKey;
    const totalLots = locItems.reduce((n, { ji }) => n + ji.lots.length, 0);

    let locHtml = '';
    for (const { ji, jiIdx } of locItems) {
      const { catalogItem, lots, totalPieces } = ji;
      const normPieces   = catalogItem.norm * catalogItem.piecesPerUnit;
      const normBadgeCls = normPieces <= 0 ? '' :
        totalPieces >= normPieces ? 'norm-ok' :
        totalPieces === 0         ? 'norm-critical' : 'norm-low';
      const normLabel = normPieces > 0
        ? (totalPieces >= normPieces ? 'OK' : totalPieces === 0 ? 'Critical' : 'Low')
        : '';
      const piecesDisplay = fmtPieces(totalPieces, catalogItem.orderingUnit, catalogItem.piecesPerUnit);
      const normDisplay   = catalogItem.norm > 0
        ? `Norm: ${catalogItem.norm} ${catalogItem.orderingUnit}`
        : '';

      const todayNow    = today();
      const anyExpired  = lots.some(l => l.expiry && l.expiry < todayNow);
      const anyExpiring = !anyExpired && lots.some(l => l.expiry && daysDiff(todayNow, l.expiry) <= (state.settings.expiryWarningDays || 14));
      const expiryBadge = anyExpired
        ? '<span class="badge badge-expired">Expired</span>'
        : anyExpiring ? '<span class="badge badge-expiring">Soon</span>' : '';

      const lotsHtml = lots.length === 0
        ? '<div class="wc-no-stock">Not in stock &mdash; check if order is needed</div>'
        : lots.map(lot => renderWCItemCard(lot, lot._flatIdx)).join('');

      locHtml += `<div class="wc-catalog-item-group" data-jiidx="${jiIdx}">
        <div class="wc-catalog-item-header">
          <div class="wc-catalog-item-title">
            <span class="wc-catalog-item-name">${esc(catalogItem.name || catalogItem.ref)}</span>
            ${expiryBadge}
            ${normBadgeCls ? `<span class="norm-badge ${normBadgeCls}">${esc(normLabel)}</span>` : ''}
          </div>
          <div class="wc-catalog-item-details">
            <span class="wc-catalog-item-ref">REF: ${esc(catalogItem.ref)}</span>
            <span class="wc-catalog-item-qty">${piecesDisplay}</span>
            ${normDisplay ? `<span class="wc-catalog-norm">${esc(normDisplay)}</span>` : ''}
          </div>
        </div>
        ${lotsHtml}
      </div>`;
    }

    html += `<div class="wc-location-group" data-loc-key="${esc(locKey)}">
      <div class="wc-location-header">${esc(label)}<span class="wc-location-count">${totalLots}</span></div>
      ${locHtml}
    </div>`;
  }

  html += `<div id="wc-finish-area" class="hidden">
    <button id="btn-wc-finish" class="btn-primary">Finish Check</button>
  </div>`;

  container.innerHTML = html;
  items.forEach((_, i) => wireWCCard(i));
  document.getElementById('btn-wc-finish').addEventListener('click', submitWeeklyCheck);

  document.getElementById('wc-filter-loc').addEventListener('change', e => {
    state.wcFilters.location = e.target.value;
    applyWCFilters();
  });
  container.querySelectorAll('#wc-filter-bar .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.status;
      const set = state.wcFilters.statuses;
      if (set.has(key)) set.delete(key); else set.add(key);
      chip.classList.toggle('selected', set.has(key));
      applyWCFilters();
    });
  });
  document.getElementById('wc-filter-clear').addEventListener('click', () => {
    state.wcFilters = { location: '', statuses: new Set() };
    document.getElementById('wc-filter-loc').value = '';
    container.querySelectorAll('#wc-filter-bar .filter-chip').forEach(c => c.classList.remove('selected'));
    applyWCFilters();
  });
}

function applyWCFilters() {
  const { joined, decisions } = state.weeklyCheck;
  const filters = state.wcFilters;
  if (!filters) return;
  const { expiryWarningDays: wDays } = state.settings;
  const todayStr = today();

  const active = Boolean(filters.location) || filters.statuses.size > 0;
  const clearBtn = document.getElementById('wc-filter-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !active);

  joined.forEach((ji, jiIdx) => {
    const groupEl = document.querySelector(`.wc-catalog-item-group[data-jiidx="${jiIdx}"]`);
    if (!groupEl) return;
    let pass = true;

    if (filters.location) {
      const itemLoc = ji.catalogItem.location || '__unassigned__';
      if (itemLoc !== filters.location) pass = false;
    }

    if (pass && filters.statuses.size > 0) {
      const normPieces  = ji.catalogItem.norm * ji.catalogItem.piecesPerUnit;
      const isBelowNorm = normPieces > 0 && ji.totalPieces < normPieces;
      const anyExpiring = ji.lots.some(lot => {
        const expired = lot.expiry && lot.expiry < todayStr;
        return !expired && lot.expiry && daysDiff(todayStr, lot.expiry) <= wDays;
      });
      const anyFlagged = ji.lots.some(lot => {
        const dec = (lot._flatIdx !== undefined) ? decisions[lot._flatIdx] : null;
        return dec && dec.integrityStatus === 'flagged';
      });
      let any = false;
      if (filters.statuses.has('below-norm') && isBelowNorm) any = true;
      if (filters.statuses.has('expiring')   && anyExpiring)  any = true;
      if (filters.statuses.has('flagged')    && anyFlagged)   any = true;
      if (!any) pass = false;
    }

    groupEl.classList.toggle('hidden', !pass);
  });

  let anyLocVisible = false;
  document.querySelectorAll('.wc-location-group').forEach(locGroup => {
    const anyVisible = Array.from(locGroup.querySelectorAll('.wc-catalog-item-group'))
      .some(g => !g.classList.contains('hidden'));
    locGroup.classList.toggle('hidden', !anyVisible);
    if (anyVisible) anyLocVisible = true;
  });

  const noMatch = document.getElementById('wc-no-matches');
  if (noMatch) noMatch.classList.toggle('hidden', anyLocVisible);
}

function renderWCItemCard(item, i) {
  const todayStr  = today();
  const expired   = item.expiry && item.expiry < todayStr;
  const expiring  = !expired && item.expiry && daysDiff(todayStr, item.expiry) <= (state.settings.expiryWarningDays || 14);
  const badgeCls  = expired ? 'badge-expired' : expiring ? 'badge-expiring' : '';
  const expiryStr = formatExpiry(item.expiry);
  const borderCls = expired ? 'wc-item-card-expired' : expiring ? 'wc-item-card-expiring' : '';

  return `<div class="wc-item-card ${borderCls}" id="wc-card-${i}">
    <div class="wc-item-meta">
      ${item.lot ? 'LOT: <strong>' + esc(item.lot) + '</strong>' : '<em>No lot number</em>'}
      ${expiryStr ? ' &nbsp;&middot;&nbsp; ' + esc(expiryStr) : ''}
      &nbsp;&middot;&nbsp; Qty: <strong>${item.qty} pcs</strong>
      ${badgeCls ? `&nbsp;<span class="badge ${badgeCls}">${expired ? 'Expired' : 'Soon'}</span>` : ''}
    </div>

    <div class="wc-integrity-row">
      <span class="wc-row-label">Integrity</span>
      <button type="button" class="wc-btn-integrity" data-index="${i}" data-choice="ok">&#10003; OK</button>
      <button type="button" class="wc-btn-integrity" data-index="${i}" data-choice="flagged">&#9873; Flag</button>
    </div>
    <div class="wc-flag-note hidden" id="wc-flag-note-${i}">
      <input type="text" id="wc-flag-input-${i}" placeholder="Brief note (e.g. packaging torn)">
    </div>

    <div class="wc-qty-row">
      <span class="wc-row-label">Quantity</span>
      <button type="button" class="wc-btn-qty" data-index="${i}" data-choice="matches">&#10003; Matches</button>
      <button type="button" class="wc-btn-qty" data-index="${i}" data-choice="adjusted">Different</button>
    </div>
    <div class="wc-adjusted-qty hidden" id="wc-adj-qty-${i}">
      <label>Physical count (pieces):</label>
      <div class="wc-qty-input-row">
        <input type="number" id="wc-qty-input-${i}" value="${item.qty}" min="0" inputmode="numeric">
      </div>
    </div>

    <div class="wc-reason-field hidden" id="wc-reason-${i}">
      <label>Reason (required)</label>
      <input type="text" id="wc-reason-input-${i}" placeholder="e.g. damaged packaging, found extra, used without scanning">
    </div>
  </div>`;
}

function wireWCCard(i) {
  const item = state.weeklyCheck.items[i];

  document.querySelectorAll(`.wc-btn-integrity[data-index="${i}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.choice;
      state.weeklyCheck.decisions[i].integrityStatus = choice;

      document.querySelectorAll(`.wc-btn-integrity[data-index="${i}"]`).forEach(b => {
        b.classList.remove('selected-ok', 'selected-flag');
      });
      btn.classList.add(choice === 'ok' ? 'selected-ok' : 'selected-flag');

      const flagNoteEl = document.getElementById('wc-flag-note-' + i);
      if (choice === 'flagged') {
        flagNoteEl.classList.remove('hidden');
        document.getElementById('wc-flag-input-' + i).focus();
      } else {
        flagNoteEl.classList.add('hidden');
        state.weeklyCheck.decisions[i].flagNote = '';
      }
      updateWCItemDone(i);
      if (state.wcFilters && state.wcFilters.statuses && state.wcFilters.statuses.has('flagged')) {
        applyWCFilters();
      }
    });
  });

  document.getElementById('wc-flag-input-' + i).addEventListener('input', e => {
    state.weeklyCheck.decisions[i].flagNote = e.target.value.trim();
    updateWCItemDone(i);
  });

  document.querySelectorAll(`.wc-btn-qty[data-index="${i}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.choice;
      state.weeklyCheck.decisions[i].qtyMode = choice;
      if (choice === 'matches') state.weeklyCheck.decisions[i].physicalQty = item.qty;

      document.querySelectorAll(`.wc-btn-qty[data-index="${i}"]`).forEach(b => {
        b.classList.remove('selected-ok', 'selected-adj');
      });
      btn.classList.add(choice === 'matches' ? 'selected-ok' : 'selected-adj');

      const adjEl = document.getElementById('wc-adj-qty-' + i);
      if (choice === 'adjusted') {
        adjEl.classList.remove('hidden');
        document.getElementById('wc-qty-input-' + i).select();
      } else {
        adjEl.classList.add('hidden');
      }
      updateWCItemDone(i);
    });
  });

  document.getElementById('wc-qty-input-' + i).addEventListener('input', e => {
    const val = parseInt(e.target.value, 10);
    state.weeklyCheck.decisions[i].physicalQty = isNaN(val) ? null : val;
    updateWCItemDone(i);
  });

  document.getElementById('wc-reason-input-' + i).addEventListener('input', e => {
    state.weeklyCheck.decisions[i].reason = e.target.value.trim();
    updateWCItemDone(i);
  });
}

function updateWCItemDone(i) {
  const dec  = state.weeklyCheck.decisions[i];
  const item = state.weeklyCheck.items[i];

  const integritySet = dec.integrityStatus !== null;
  const physQty      = dec.physicalQty ?? item.qty;
  const variance     = physQty - item.qty;
  const qtySet       = dec.qtyMode === 'matches' ||
                       (dec.qtyMode === 'adjusted' && dec.physicalQty !== null);

  const needsReason = dec.integrityStatus === 'flagged' ||
                      (dec.qtyMode === 'adjusted' && variance !== 0);

  const reasonEl = document.getElementById('wc-reason-' + i);
  if (needsReason) {
    reasonEl.classList.remove('hidden');
  } else {
    reasonEl.classList.add('hidden');
    dec.reason = '';
  }

  dec.done = integritySet && qtySet && (!needsReason || dec.reason.length > 0);

  document.getElementById('wc-card-' + i).classList.toggle('done', dec.done);
  checkWCFinishReady();
}

function checkWCFinishReady() {
  const allDone  = state.weeklyCheck.decisions.every(d => d.done);
  const finishEl = document.getElementById('wc-finish-area');
  if (finishEl) finishEl.classList.toggle('hidden', !allDone);
}

async function submitWeeklyCheck() {
  const { items, decisions, joined } = state.weeklyCheck;
  const btn = document.getElementById('btn-wc-finish');

  const toSubmit = [];
  items.forEach((item, i) => {
    const dec      = decisions[i];
    const physQty  = dec.qtyMode === 'matches' ? item.qty : (dec.physicalQty ?? item.qty);
    const variance = physQty - item.qty;
    if (dec.integrityStatus === 'flagged' || variance !== 0) {
      toSubmit.push({ item, dec, physQty, variance });
    }
  });

  const label = toSubmit.length > 0 ? `Saving ${toSubmit.length} record(s)…` : 'Finishing…';
  setLoading(btn, label);

  let errorCount = 0;
  for (const { item, dec, physQty } of toSubmit) {
    const result = await api.post('reconcile', {
      gtin:            item.gtin,
      lot:             item.lot,
      expiry:          item.expiry,
      physicalCount:   physQty,
      integrityStatus: dec.integrityStatus === 'flagged' ? 'Flagged' : 'OK',
      reason:          dec.reason,
      location:        item.location || ''
    });
    if (!result.success) {
      errorCount++;
      showToast('Error (' + esc(item.name || item.gtin) + '): ' + result.error, 'error');
    } else {
      item.qty = physQty;
    }
  }

  if (errorCount > 0) {
    resetButton(btn, 'Finish Check');
    return;
  }

  joined.forEach(ji => {
    ji.totalPieces = ji.lots.reduce((sum, lot) => sum + (lot.qty || 0), 0);
  });

  renderWCSummary(items, decisions, toSubmit, joined);
}

function renderWCSummary(items, decisions, submitted, joined) {
  const container = document.getElementById('wc-container');
  const flagged   = submitted.filter(s => s.dec.integrityStatus === 'flagged');
  const adjusted  = submitted.filter(s => s.variance !== 0);
  const passed    = items.length - submitted.length;
  const timeStr   = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const flagList = flagged.length === 0 ? '' : `
    <div class="wc-summary-section">
      <div class="wc-summary-section-title">Integrity Flags</div>
      ${flagged.map(s => `
        <div class="wc-summary-flag-item">
          <span class="wc-summary-item-name">${esc(s.item.name || s.item.gtin)}</span>
          ${s.dec.flagNote ? `<span class="wc-summary-note">${esc(s.dec.flagNote)}</span>` : ''}
        </div>`).join('')}
    </div>`;

  const adjList = adjusted.length === 0 ? '' : `
    <div class="wc-summary-section">
      <div class="wc-summary-section-title">Quantity Adjustments</div>
      ${adjusted.map(s => `
        <div class="wc-summary-flag-item">
          <span class="wc-summary-item-name">${esc(s.item.name || s.item.gtin)}</span>
          <span class="wc-summary-variance ${s.variance > 0 ? 'pos' : 'neg'}">${s.variance > 0 ? '+' : ''}${s.variance}</span>
        </div>`).join('')}
    </div>`;

  const belowNorm   = (joined || []).filter(ji => {
    const normPieces = ji.catalogItem.norm * ji.catalogItem.piecesPerUnit;
    return normPieces > 0 && ji.totalPieces < normPieces;
  });
  const consumables = belowNorm.filter(ji => ji.catalogItem.category === 'Consumable');
  const implants    = belowNorm.filter(ji => ji.catalogItem.category === 'Implant');

  function orderItemHtml(ji) {
    const normPieces     = ji.catalogItem.norm * ji.catalogItem.piecesPerUnit;
    const shortfall      = normPieces - ji.totalPieces;
    const shortUnits     = Math.ceil(shortfall / (ji.catalogItem.piecesPerUnit || 1));
    const currentDisplay = fmtPieces(ji.totalPieces, ji.catalogItem.orderingUnit, ji.catalogItem.piecesPerUnit);
    return `<div class="wc-order-item">
      <div class="wc-order-item-name">${esc(ji.catalogItem.name || ji.catalogItem.ref)}</div>
      <div class="wc-order-item-detail">REF: ${esc(ji.catalogItem.ref)} &middot; Have: ${currentDisplay} &middot; Order: ${shortUnits} ${esc(ji.catalogItem.orderingUnit)}</div>
    </div>`;
  }

  function generateCopyText(jiList, title) {
    const lines = [title, ''];
    jiList.forEach(ji => {
      const normPieces = ji.catalogItem.norm * ji.catalogItem.piecesPerUnit;
      const shortfall  = normPieces - ji.totalPieces;
      const shortUnits = Math.ceil(shortfall / (ji.catalogItem.piecesPerUnit || 1));
      lines.push(`- ${ji.catalogItem.name || ji.catalogItem.ref} (REF: ${ji.catalogItem.ref}): order ${shortUnits} ${ji.catalogItem.orderingUnit}`);
    });
    return lines.join('\n');
  }

  const topUpHtml = consumables.length === 0 ? '' : `
    <div class="wc-summary-section wc-order-section">
      <div class="wc-summary-section-title">Top-Up List (Consumables)</div>
      <div style="padding:0 16px 4px">${consumables.map(orderItemHtml).join('')}</div>
      <div style="padding:0 16px 14px"><button type="button" class="btn-secondary wc-copy-btn" data-copy="topup">Copy to clipboard</button></div>
    </div>`;

  const vendorHtml = implants.length === 0 ? '' : `
    <div class="wc-summary-section wc-order-section">
      <div class="wc-summary-section-title">Vendor Order List (Implants)</div>
      <div style="padding:0 16px 4px">${implants.map(orderItemHtml).join('')}</div>
      <div style="padding:0 16px 14px"><button type="button" class="btn-secondary wc-copy-btn" data-copy="vendor">Copy to clipboard</button></div>
    </div>`;

  const noOrdersHtml = (consumables.length === 0 && implants.length === 0) ? `
    <div class="wc-summary-section">
      <div class="wc-summary-section-title" style="color:var(--green)">&#10003; All stock at or above norm</div>
    </div>` : '';

  container.innerHTML = `
    <div class="wc-summary">
      <div class="wc-summary-title">Check Complete &mdash; ${esc(timeStr)}</div>
      <div class="wc-summary-stats">
        <div class="wc-stat"><span class="wc-stat-num">${items.length}</span><span class="wc-stat-lbl">Checked</span></div>
        <div class="wc-stat ${flagged.length > 0 ? 'wc-stat-warn' : 'wc-stat-ok'}">
          <span class="wc-stat-num">${flagged.length}</span><span class="wc-stat-lbl">Flagged</span>
        </div>
        <div class="wc-stat ${adjusted.length > 0 ? 'wc-stat-warn' : 'wc-stat-ok'}">
          <span class="wc-stat-num">${adjusted.length}</span><span class="wc-stat-lbl">Adjusted</span>
        </div>
        <div class="wc-stat wc-stat-ok"><span class="wc-stat-num">${passed}</span><span class="wc-stat-lbl">All OK</span></div>
      </div>
      ${flagList}
      ${adjList}
      ${noOrdersHtml}
      ${topUpHtml}
      ${vendorHtml}
      <button id="btn-wc-done" class="btn-primary">Done</button>
    </div>`;

  container.querySelectorAll('.wc-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const which   = btn.dataset.copy;
      const dateStr = new Date().toLocaleDateString('en-GB');
      const text = which === 'topup'
        ? generateCopyText(consumables, 'Top-Up List (Consumables) — ' + dateStr)
        : generateCopyText(implants,    'Vendor Order List (Implants) — ' + dateStr);
      navigator.clipboard.writeText(text).then(
        ()  => showToast('Copied to clipboard', 'success'),
        ()  => showToast('Copy failed — please copy manually', 'error')
      );
    });
  });

  document.getElementById('btn-wc-done').addEventListener('click', renderWCIdle);
}

// =====================================================================
// SETTINGS
// =====================================================================

function setupSettings() {
  const s = state.settings;
  document.getElementById('set-expiry-days').value = s.expiryWarningDays;
  document.getElementById('set-low-stock').value   = s.lowStockThreshold;

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    state.settings.expiryWarningDays = parseInt(document.getElementById('set-expiry-days').value, 10) || 14;
    state.settings.lowStockThreshold = parseInt(document.getElementById('set-low-stock').value,   10) ?? 2;
    saveSettings(state.settings);
    showToast('Settings saved', 'success');
  });
}

// =====================================================================
// SHARED UTILITIES
// =====================================================================

let _toastTimer = null;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = 'toast' + (type ? ' toast-' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.add('hidden'), 3800);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysDiff(dateA, dateB) {
  if (!dateB) return Infinity;
  return Math.round((new Date(dateB) - new Date(dateA)) / 86400000);
}
function formatExpiry(isoDate) {
  if (!isoDate) return null;
  const days = daysDiff(today(), isoDate);
  if (days < 0)   return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  if (days <= 30) return `Expires in ${days} days`;
  const d = new Date(isoDate + 'T00:00:00');
  return 'Expires ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatQty(qty, unit) {
  const q = String(qty);
  const u = (unit || '').trim();
  return u ? `${q} ${esc(u)}` : q;
}

function fmtPieces(totalPieces, orderingUnit, piecesPerUnit) {
  const ppu  = piecesPerUnit || 1;
  const unit = orderingUnit  || 'Piece';
  if (ppu === 1 || unit === 'Piece') return totalPieces + ' pcs';
  const boxes = (totalPieces / ppu).toFixed(1).replace(/\.0$/, '');
  return `${totalPieces} pcs (${boxes} ${esc(unit)})`;
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ringHTML(pct, color, centerText) {
  const R    = 22;
  const circ = +(2 * Math.PI * R).toFixed(2);
  const dash = +((pct / 100) * circ).toFixed(2);
  return `<svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
    <circle cx="26" cy="26" r="${R}" fill="none" stroke="#dce4f0" stroke-width="4.5"/>
    <circle cx="26" cy="26" r="${R}" fill="none" stroke="${color}" stroke-width="4.5"
            stroke-dasharray="${dash} ${circ}" stroke-linecap="round"
            transform="rotate(-90 26 26)"/>
    <text x="26" y="26" text-anchor="middle" dominant-baseline="middle"
          font-size="9.5" font-family="'Inter',sans-serif" font-weight="600"
          fill="${color}">${esc(centerText)}</text>
  </svg>`;
}

function v(id)      { return document.getElementById(id).value.trim(); }
function show(id)   { document.getElementById(id).classList.remove('hidden'); }
function hide(id)   { document.getElementById(id).classList.add('hidden'); }
function setLoading(btn, text)  { btn.disabled = true;  btn.textContent = text; }
function resetButton(btn, text) { btn.disabled = false; btn.textContent = text; }

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('cons-tracker-settings') || '{}'); } catch (_) {}
  return {
    expiryWarningDays: raw.expiryWarningDays ?? 14,
    lowStockThreshold: raw.lowStockThreshold ?? 2
  };
}
function saveSettings(s) {
  localStorage.setItem('cons-tracker-settings', JSON.stringify(s));
}
