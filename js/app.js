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
      if (!checkDuplicate(rawText)) return;
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

    if (!gtin) { showToast('GTIN / Ref is required', 'error'); return; }
    if (isNaN(qty) || qty < 1) { showToast('Quantity must be at least 1', 'error'); return; }

    // If expiry date is in the past, warn and ask before continuing
    if (expiry && expiry < today()) {
      const warn = document.getElementById('si-expiry-warning');
      warn.classList.remove('hidden');
      document.getElementById('btn-si-override-yes').onclick = () => {
        warn.classList.add('hidden');
        submitScanIn(gtin, lot, expiry, qty, name);
      };
      document.getElementById('btn-si-override-no').onclick = () => {
        warn.classList.add('hidden');
      };
      return;
    }

    await submitScanIn(gtin, lot, expiry, qty, name);
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
  ['si-gtin', 'si-lot', 'si-expiry', 'si-name'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('si-qty').value = '1';
  document.getElementById('si-expiry-warning').classList.add('hidden');
}

async function submitScanIn(gtin, lot, expiry, qty, itemName) {
  const btn = document.getElementById('btn-si-submit');
  setLoading(btn, 'Logging...');

  const result = await api.post('scanIn', { gtin, lot, expiry, qty, itemName });

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

  const item     = result.item;
  const daysLeft = daysDiff(today(), item.expiry);
  state.scanOutItem = item;
  show('form-scan-out');

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

  if (item.expiry && item.expiry < today()) {
    card.className = 'card status-card status-expired';
    card.innerHTML = `
      <div class="status-badge">EXPIRED</div>
      <div><strong>${esc(item.name || item.gtin)}</strong></div>
      <div class="status-detail">${Math.abs(daysLeft)} days overdue &middot; Expiry: ${esc(item.expiry)}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty in stock: ${item.qty}</div>`;
  } else if (item.expiry && daysLeft <= state.settings.expiryWarningDays) {
    card.className = 'card status-card status-expiring';
    card.innerHTML = `
      <div class="status-badge">EXPIRING SOON</div>
      <div><strong>${esc(item.name || item.gtin)}</strong></div>
      <div class="status-detail">${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining &middot; Expiry: ${esc(item.expiry)}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty in stock: ${item.qty}</div>`;
  } else {
    card.className = 'card status-card status-ok';
    const expiryLine = item.expiry
      ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining &middot; Expiry: ${esc(item.expiry)}`
      : 'No expiry date recorded';
    card.innerHTML = `
      <div class="status-badge">OK</div>
      <div><strong>${esc(item.name || item.gtin)}</strong></div>
      <div class="status-detail">${expiryLine}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty in stock: ${item.qty}</div>`;
  }
}

async function submitScanOut(qty) {
  const item = state.scanOutItem;
  const btn  = document.getElementById('btn-so-confirm');
  setLoading(btn, 'Processing...');

  const result = await api.post('scanOut', {
    gtin:   item.gtin,
    lot:    item.lot,
    expiry: item.expiry,
    qty
  });

  resetButton(btn, 'Confirm Use');

  if (!result.success) {
    const msg = result.error === 'no_stock'
      ? 'No stock recorded — cannot go below 0'
      : 'Error: ' + result.error;
    showToast(msg, 'error');
    return;
  }

  const note = result.archived ? ' (batch archived — expired + empty)' : '';
  showToast(`Done. Remaining qty: ${result.newQty}${note}`, 'success');
  hide('scan-out-result');
  state.scanOutItem = null;
}

// =====================================================================
// DASHBOARD
// =====================================================================

function setupDashboard() {
  document.getElementById('btn-refresh-dashboard').addEventListener('click', loadDashboard);
}

async function loadDashboard() {
  const content = document.getElementById('dashboard-content');
  const summary = document.getElementById('dashboard-summary');
  content.innerHTML = '<p class="no-items">Loading&hellip;</p>';
  summary.classList.add('hidden');

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

  // Sort: expired first, then soonest expiry, then no-expiry items at end
  items.sort((a, b) => {
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  });

  let expiredCount = 0, soonCount = 0;
  items.forEach(item => {
    if (!item.expiry) return;
    if (item.expiry < todayStr) expiredCount++;
    else if (daysDiff(todayStr, item.expiry) <= wDays) soonCount++;
  });

  summary.classList.remove('hidden');
  summary.innerHTML = `
    <div class="summary-badge badge-danger">
      <span class="count">${expiredCount}</span>Expired
    </div>
    <div class="summary-badge badge-warn">
      <span class="count">${soonCount}</span>Within ${wDays}d
    </div>
    <div class="summary-badge badge-ok">
      <span class="count">${items.length}</span>Total
    </div>`;

  const rows = items.map(item => {
    const expired  = item.expiry && item.expiry < todayStr;
    const expiring = !expired && item.expiry && daysDiff(todayStr, item.expiry) <= wDays;
    const low      = item.qty > 0 && item.qty <= lowQty;
    const rowClass = expired ? 'row-expired' : expiring ? 'row-expiring' : '';

    const tags = [
      expired  ? '<span class="badge-expired">EXPIRED</span>'   : '',
      expiring ? '<span class="badge-expiring">EXPIRING</span>' : '',
      low      ? '<span class="badge-low">LOW</span>'           : ''
    ].join('');

    return `<tr class="${rowClass}">
      <td>${esc(item.name || '&mdash;')}</td>
      <td>${esc(item.gtin)}</td>
      <td>${esc(item.lot || '&mdash;')}</td>
      <td class="${low ? 'cell-low' : ''}">${item.qty}${low ? ' <span class="badge-low">LOW</span>' : ''}</td>
      <td>${esc(item.expiry || '&mdash;')}${expired || expiring ? ' ' + tags : ''}</td>
    </tr>`;
  }).join('');

  content.innerHTML = `
    <div style="overflow-x:auto;margin-top:12px">
      <table class="inventory-table">
        <thead>
          <tr>
            <th>Item Name</th>
            <th>GTIN / Ref</th>
            <th>Lot</th>
            <th>Qty</th>
            <th>Expiry</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
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
  if (text === state.lastScan.text && now - state.lastScan.time < 30000) {
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

// Prevent XSS when inserting dynamic content into innerHTML
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
