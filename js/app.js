// =====================================================================
// Main application logic
// =====================================================================

// --- App state ---
const state = {
  lastScan:       { text: '', time: 0 },  // for duplicate-scan guard
  scanOutItem:    null,                    // item found after scan-out lookup
  reconcileItems: [],                      // full inventory loaded for reconciliation
  settings:       null                     // loaded on init
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
  updateApiDisplay();
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
      // Auto-load dashboard when switching to it
      if (tab === 'dashboard') loadDashboard();
    });
  });
}

// =====================================================================
// SCAN IN
// =====================================================================

function setupScanIn() {
  document.getElementById('btn-scan-in-start').addEventListener('click', () => {
    startScanner('Scan In — point camera at barcode', (rawText, parsed) => {
      fillScanInForm(parsed, rawText);
    });
  });

  document.getElementById('btn-si-clear').addEventListener('click', clearScanInForm);

  document.getElementById('form-scan-in').addEventListener('submit', async (e) => {
    e.preventDefault();
    const gtin   = v('si-gtin');
    const lot    = v('si-lot');
    const expiry = v('si-expiry');
    const name   = v('si-name');
    const qty    = parseInt(document.getElementById('si-qty').value, 10);
    const minQty = document.getElementById('si-minqty').value.trim();
    const minQtyVal = minQty !== '' ? parseInt(minQty, 10) : null;

    if (!gtin) { showToast('GTIN / Ref is required', 'error'); return; }
    if (isNaN(qty) || qty < 1) { showToast('Quantity must be at least 1', 'error'); return; }

    // If expiry date is in the past, warn and ask before continuing
    if (expiry && expiry < today()) {
      const warn = document.getElementById('si-expiry-warning');
      warn.classList.remove('hidden');
      document.getElementById('btn-si-override-yes').onclick = () => {
        warn.classList.add('hidden');
        submitScanIn(gtin, lot, expiry, qty, name, minQtyVal);
      };
      document.getElementById('btn-si-override-no').onclick = () => {
        warn.classList.add('hidden');
      };
      return;
    }

    await submitScanIn(gtin, lot, expiry, qty, name, minQtyVal);
  });
}

function fillScanInForm(parsed, rawText) {
  document.getElementById('si-gtin').value   = parsed.gtin || rawText;
  document.getElementById('si-lot').value    = parsed.lot || '';
  document.getElementById('si-expiry').value = parsed.expiry || '';
  // Scroll to and focus item name field — likely needs manual entry
  if (!document.getElementById('si-name').value) {
    document.getElementById('si-name').focus();
  }
}

function clearScanInForm() {
  ['si-gtin', 'si-lot', 'si-expiry', 'si-name', 'si-minqty'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('si-qty').value = '1';
  document.getElementById('si-expiry-warning').classList.add('hidden');
}

async function submitScanIn(gtin, lot, expiry, qty, itemName, minQty = null) {
  const btn = document.getElementById('btn-si-submit');
  setLoading(btn, 'Logging...');

  const payload = { gtin, lot, expiry, qty, itemName };
  if (minQty !== null && !isNaN(minQty)) payload.minQty = minQty;
  const result = await api.post('scanIn', payload);

  resetButton(btn, 'Log Stock In');

  if (!result.success) {
    showToast('Error: ' + result.error, 'error');
    return;
  }

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
  document.getElementById('btn-scan-out-start').addEventListener('click', () => {
    startScanner('Scan Out — point camera at item barcode', async (rawText, parsed) => {
      if (!checkDuplicate(rawText)) return;
      await lookupForScanOut(parsed, rawText);
    });
  });

  document.getElementById('btn-so-cancel').addEventListener('click', () => {
    hide('scan-out-result');
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

async function lookupForScanOut(parsed, rawText) {
  const gtin   = parsed.gtin || rawText;
  const lot    = parsed.lot  || '';
  const expiry = parsed.expiry || '';

  const result = await api.get('lookupBatch', { gtin, lot, expiry });
  const resultDiv = document.getElementById('scan-out-result');
  const card      = document.getElementById('so-status-card');

  if (!result.success) {
    showToast('API error: ' + result.error, 'error');
    return;
  }

  resultDiv.classList.remove('hidden');

  if (!result.found) {
    state.scanOutItem = null;
    card.className    = 'card status-card';
    card.innerHTML    = `
      <div class="status-badge" style="color:#888">&#10067;</div>
      <div><strong>Not found in inventory</strong></div>
      <div class="status-detail">GTIN: ${esc(gtin)}${lot ? ' &middot; Lot: ' + esc(lot) : ''}</div>
      <div class="status-detail" style="margin-top:10px">
        <a href="#" id="so-go-scan-in">Log as new item &rarr;</a>
      </div>`;
    document.getElementById('so-go-scan-in').onclick = (e) => {
      e.preventDefault();
      document.querySelector('[data-tab="scan-in"]').click();
      fillScanInForm(parsed, rawText);
    };
    hide('form-scan-out');
    return;
  }

  const item = result.item;
  state.scanOutItem = item;
  show('form-scan-out');
  renderScanOutCard(item);
}

/** Build (or rebuild) the status card from an item object. Called on first lookup and after each use. */
function renderScanOutCard(item) {
  const card     = document.getElementById('so-status-card');
  const daysLeft = daysDiff(today(), item.expiry);

  if (item.qty <= 0) {
    card.className = 'card status-card status-no-stock';
    card.innerHTML = `
      <div class="status-badge" style="color:#999">&#9888;</div>
      <div><strong>${esc(item.name || item.gtin)}</strong></div>
      <div class="status-detail">No stock recorded &mdash; check the physical shelf</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Expiry: ${esc(item.expiry || '&mdash;')}</div>`;
    document.getElementById('btn-so-confirm').disabled = true;
    return;
  }

  document.getElementById('btn-so-confirm').disabled = false;
  document.getElementById('so-qty').max = item.qty;

  const expiryLabel = formatExpiry(item.expiry);

  if (item.expiry && item.expiry < today()) {
    card.className = 'card status-card status-expired';
    card.innerHTML = `
      <div class="status-badge">EXPIRED</div>
      <div><strong>${esc(item.name || item.gtin)}</strong></div>
      <div class="status-detail">${esc(expiryLabel)}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty in stock: ${item.qty}</div>`;
  } else if (item.expiry && daysLeft <= state.settings.expiryWarningDays) {
    card.className = 'card status-card status-expiring';
    card.innerHTML = `
      <div class="status-badge">EXPIRING SOON</div>
      <div><strong>${esc(item.name || item.gtin)}</strong></div>
      <div class="status-detail">${esc(expiryLabel)}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty in stock: ${item.qty}</div>`;
  } else {
    card.className = 'card status-card status-ok';
    card.innerHTML = `
      <div class="status-badge">OK</div>
      <div><strong>${esc(item.name || item.gtin)}</strong></div>
      <div class="status-detail">${expiryLabel ? esc(expiryLabel) : 'No expiry date recorded'}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty in stock: ${item.qty}</div>`;
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

  // Stock still available — update the card and offer to use the same item again
  // without needing to re-scan
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

  const { expiryWarningDays: wDays, lowStockThreshold: lowQty } = state.settings;
  const todayStr = today();

  // Sort: expired first → soonest expiry → no-expiry items last
  items.sort((a, b) => {
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  });

  // KPI counts
  let expiredCount = 0, soonCount = 0, lowCount = 0;
  items.forEach(item => {
    const threshold = item.minQty > 0 ? item.minQty : lowQty;
    if (item.expiry && item.expiry < todayStr)                           expiredCount++;
    else if (item.expiry && daysDiff(todayStr, item.expiry) <= wDays)   soonCount++;
    if (item.qty > 0 && item.qty <= threshold)                           lowCount++;
  });

  // ── KPI cards ───────────────────────────────────────────────────────
  const kpiHtml = `<div class="kpi-grid">
    <div class="kpi-card kpi-total">
      <div class="kpi-lbl">Active Batches</div>
      <div class="kpi-num">${items.length}</div>
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

  // ── Expiry ring timeline (soonest-expiring, max 8) ──────────────────
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

  // ── Stock levels chart (grouped by item name, top 10 by qty) ────────
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

  // ── Full inventory cards ─────────────────────────────────────────────
  const cards = items.map((item, idx) => {
    const threshold = item.minQty > 0 ? item.minQty : lowQty;
    const expired  = item.expiry && item.expiry < todayStr;
    const expiring = !expired && item.expiry && daysDiff(todayStr, item.expiry) <= wDays;
    const low      = item.qty > 0 && item.qty <= threshold;
    const cls      = expired ? 'inv-card-expired' : expiring ? 'inv-card-expiring' : 'inv-card-ok';
    const badge    = expired
      ? '<span class="badge badge-expired">Expired</span>'
      : expiring ? '<span class="badge badge-expiring">Soon</span>' : '';
    return `<div class="inv-card ${cls}">
      <div class="inv-card-header">
        <span class="inv-card-name">${esc(item.name || item.gtin)}</span>
        ${badge}
      </div>
      <div class="inv-card-expiry">${esc(formatExpiry(item.expiry) || 'No expiry date')}</div>
      <div class="inv-card-meta">
        <span>Qty: <strong class="${low ? 'inv-card-qty-low' : ''}">${item.qty}${low ? ' · LOW' : ''}</strong></span>
        ${item.lot    ? '<span>Lot: ' + esc(item.lot) + '</span>' : ''}
        ${item.gtin && item.name ? '<span class="mono" style="font-size:.7rem">' + esc(item.gtin) + '</span>' : ''}
      </div>
      <div class="inv-card-minqty">
        <label for="mq-${idx}" style="white-space:nowrap">Min qty alert:</label>
        <input type="number" id="mq-${idx}" class="minqty-input" data-idx="${idx}"
               value="${item.minQty > 0 ? item.minQty : ''}"
               placeholder="${lowQty}" min="0" title="Alert threshold (blank = global default of ${lowQty})">
      </div>
    </div>`;
  }).join('');

  const inventoryHtml = `<div class="panel">
    <div class="panel-header"><h3>All Inventory</h3></div>
    <div class="panel-body" style="padding:6px 16px 14px">
      ${cards}
      <p class="small" style="margin-top:10px">Min Qty per item — blank uses global default (${lowQty}). Saves automatically.</p>
    </div>
  </div>`;

  content.innerHTML = kpiHtml + timelineHtml + chartHtml + inventoryHtml;

  content.querySelectorAll('.minqty-input').forEach(input => {
    const save = async () => {
      const idx  = parseInt(input.dataset.idx, 10);
      const item = items[idx];
      const val  = input.value.trim();
      const minQty = val === '' ? 0 : parseInt(val, 10);
      if (isNaN(minQty) || minQty < 0) { showToast('Min qty must be 0 or higher', 'error'); return; }
      const result = await api.post('setMinQty', {
        gtin: item.gtin, lot: item.lot, expiry: item.expiry, minQty
      });
      if (result.success) showToast('Min qty saved', 'success');
      else showToast('Error: ' + result.error, 'error');
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });
}

// =====================================================================
// RECONCILIATION
// =====================================================================

function setupReconcile() {
  document.getElementById('btn-load-reconcile').addEventListener('click', loadReconcile);
  document.getElementById('btn-submit-reconcile').addEventListener('click', submitReconcile);
}

async function loadReconcile() {
  const list       = document.getElementById('reconcile-list');
  const submitArea = document.getElementById('reconcile-submit-area');
  list.innerHTML = '<p class="no-items">Loading&hellip;</p>';
  hide('reconcile-submit-area');

  const result = await api.get('getInventory');
  if (!result.success) {
    list.innerHTML = `<p class="no-items">Error: ${esc(result.error)}</p>`;
    return;
  }

  state.reconcileItems = result.items || [];
  if (state.reconcileItems.length === 0) {
    list.innerHTML = '<p class="no-items">No items in inventory.</p>';
    return;
  }

  list.innerHTML = state.reconcileItems.map((item, i) => `
    <div class="recon-item">
      <div class="recon-item-header">${esc(item.name || item.gtin)}</div>
      <div class="recon-item-meta">
        GTIN: ${esc(item.gtin)}
        ${item.lot    ? ' &middot; Lot: '    + esc(item.lot)    : ''}
        ${item.expiry ? ' &middot; Expiry: ' + esc(item.expiry) : ''}
      </div>
      <div class="recon-count-row">
        <span>System: <strong>${item.qty}</strong></span>
        <label for="recon-count-${i}">Physical&nbsp;count:</label>
        <input type="number" id="recon-count-${i}" data-index="${i}"
               value="${item.qty}" min="0" class="recon-count-input">
        <span class="recon-variance" id="recon-var-${i}"></span>
      </div>
      <div class="recon-reason" id="recon-reason-div-${i}">
        <label style="font-size:.82rem;font-weight:600;color:var(--warning)">
          Reason required:
        </label>
        <input type="text" id="recon-reason-${i}" data-index="${i}"
               placeholder="e.g. used without scanning, miscount, found extra">
      </div>
    </div>`).join('');

  // Show/hide reason field and variance live as user types counts
  document.querySelectorAll('.recon-count-input').forEach(input => {
    input.addEventListener('input', () => {
      const i      = parseInt(input.dataset.index, 10);
      const sysQty = state.reconcileItems[i].qty;
      const phys   = parseInt(input.value, 10);
      const varEl  = document.getElementById('recon-var-' + i);
      const rdiv   = document.getElementById('recon-reason-div-' + i);

      if (isNaN(phys)) {
        varEl.textContent = '';
        rdiv.classList.remove('visible');
        return;
      }
      const diff = phys - sysQty;
      varEl.textContent = diff === 0 ? '✓' : (diff > 0 ? '+' + diff : '' + diff);
      varEl.className   = 'recon-variance ' + (diff > 0 ? 'pos' : diff < 0 ? 'neg' : 'zero');
      rdiv.classList.toggle('visible', diff !== 0);
    });
  });

  show('reconcile-submit-area');
}

async function submitReconcile() {
  const items    = state.reconcileItems;
  const btn      = document.getElementById('btn-submit-reconcile');
  const errors   = [];
  const toSubmit = [];

  items.forEach((item, i) => {
    const countEl  = document.getElementById('recon-count-'  + i);
    const reasonEl = document.getElementById('recon-reason-' + i);
    const phys = parseInt(countEl?.value, 10);
    if (isNaN(phys)) return;

    const diff = phys - item.qty;
    if (diff === 0) return; // no discrepancy, skip

    const reason = reasonEl?.value.trim();
    if (!reason) {
      errors.push(`"${item.name || item.gtin}": reason is required`);
      return;
    }
    toSubmit.push({ item, physicalCount: phys, reason });
  });

  if (errors.length > 0) {
    showToast('Please fill in: ' + errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more)` : ''), 'error');
    return;
  }
  if (toSubmit.length === 0) {
    showToast('No discrepancies to submit', 'warning');
    return;
  }

  setLoading(btn, `Submitting ${toSubmit.length} adjustment(s)...`);
  let successCount = 0;

  for (const { item, physicalCount, reason } of toSubmit) {
    const result = await api.post('reconcile', {
      gtin:   item.gtin,
      lot:    item.lot,
      expiry: item.expiry,
      physicalCount,
      reason
    });
    if (result.success) successCount++;
    else showToast('Error (' + (item.name || item.gtin) + '): ' + result.error, 'error');
  }

  resetButton(btn, 'Submit Adjustments');

  if (successCount > 0) {
    showToast(`${successCount} adjustment${successCount > 1 ? 's' : ''} saved`, 'success');
    loadReconcile(); // reload with fresh data from server
  }
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

function updateApiDisplay() {
  const el = document.getElementById('api-url-display');
  if (el) el.textContent = (typeof API_URL !== 'undefined' && API_URL !== 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE')
    ? API_URL
    : '(not configured yet)';
}

// =====================================================================
// SHARED UTILITIES
// =====================================================================

/**
 * Duplicate-scan guard (30-second window).
 * Returns true to allow the scan, false to cancel it.
 */
function checkDuplicate(text) {
  const now = Date.now();
  if (text === state.lastScan.text && now - state.lastScan.time < 3000) {
    if (!confirm('You just scanned this item — scan again?')) return false;
  }
  state.lastScan = { text, time: now };
  return true;
}

// Toast notifications
let _toastTimer = null;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = 'toast' + (type ? ' toast-' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.add('hidden'), 3800);
}

// Date helpers
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

// Prevent XSS when inserting dynamic content into innerHTML
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// SVG ring progress indicator (pct 0–100, color CSS value, short center label)
function ringHTML(pct, color, centerText) {
  const R    = 22;
  const circ = +(2 * Math.PI * R).toFixed(2);
  const dash = +((pct / 100) * circ).toFixed(2);
  return `<svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
    <circle cx="26" cy="26" r="${R}" fill="none" stroke="#dce1ed" stroke-width="4.5"/>
    <circle cx="26" cy="26" r="${R}" fill="none" stroke="${color}" stroke-width="4.5"
            stroke-dasharray="${dash} ${circ}" stroke-linecap="round"
            transform="rotate(-90 26 26)"/>
    <text x="26" y="26" text-anchor="middle" dominant-baseline="middle"
          font-size="9.5" font-family="'DM Mono',monospace" font-weight="500"
          fill="${color}">${esc(centerText)}</text>
  </svg>`;
}

// DOM helpers
function v(id)      { return document.getElementById(id).value.trim(); }
function show(id)   { document.getElementById(id).classList.remove('hidden'); }
function hide(id)   { document.getElementById(id).classList.add('hidden'); }
function setLoading(btn, text)  { btn.disabled = true;  btn.textContent = text; }
function resetButton(btn, text) { btn.disabled = false; btn.textContent = text; }

// Settings persistence (localStorage)
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
