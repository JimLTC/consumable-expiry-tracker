// =====================================================================
// Main application logic
// =====================================================================

const state = {
  scanOutItem:      null,
  weeklyCheck:      { items: [], decisions: [], joined: [], checkedBy: '' },
  siCatalogItems:   null,
  catalogMap:       null,
  soGroups:         null,
  dashboardGroups:  null,
  dashboardItems:   null,
  dashboardFilters: null,
  wcFilters:        null,
  history:          { rows: [], filters: { location: '', search: '' } }
};

// =====================================================================
// DASHBOARD PREFERENCES (localStorage, per device)
// =====================================================================

const DASH_PREFS_KEY = 'ct_dash_prefs_v1';

function loadDashPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DASH_PREFS_KEY) || '{}');
    return {
      sectionOrder:   saved.sectionOrder   || ['banner','kpi','timeline','chart','inventory'],
      hiddenSections: saved.hiddenSections || [],
      hiddenKPIs:     saved.hiddenKPIs     || []
    };
  } catch (_) {
    return { sectionOrder: ['banner','kpi','timeline','chart','inventory'], hiddenSections: [], hiddenKPIs: [] };
  }
}

function saveDashPrefs(prefs) {
  localStorage.setItem(DASH_PREFS_KEY, JSON.stringify(prefs));
}

// =====================================================================
// INIT
// =====================================================================

document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupScanIn();
  setupScanOut();
  setupDashboard();
  setupReconcile();
  setupEditModal();
  setupHistory();
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
      if (tab === 'history')   loadHistory();
    });
  });
}

// =====================================================================
// CATALOG HELPERS — shared cache across all tabs
// =====================================================================

function setCatalog(items) {
  state.siCatalogItems = [...items].sort((a, b) => (a.name || a.ref).localeCompare(b.name || b.ref));
  state.catalogMap = new Map(items.map(i => [i.ref, i]));
}

function getExpiryDays(ref) {
  if (state.catalogMap && state.catalogMap.has(ref)) {
    return state.catalogMap.get(ref).expiryWarningDays || 14;
  }
  return 14;
}

function getNormPieces(ref) {
  if (!state.catalogMap || !state.catalogMap.has(ref)) return 0;
  const cat = state.catalogMap.get(ref);
  return (cat.norm || 0) * (cat.piecesPerUnit || 1);
}

function deriveWCStatus(countedPieces, ji) {
  if (countedPieces === null || countedPieces === undefined) return null;
  const normPieces = (ji.catalogItem.norm || 0) * (ji.catalogItem.piecesPerUnit || 1);
  if (normPieces === 0) return countedPieces > 0 ? 'ok' : 'out';
  return countedPieces >= normPieces ? 'ok' : countedPieces === 0 ? 'out' : 'low';
}

// Convert a weekly-check decision's entered count to pieces, honouring the
// per-card unit toggle (boxes/packs vs individual pieces)
function wcCountedPieces(dec, ji) {
  if (dec.countedQty === null || dec.countedQty === undefined) return null;
  const ppu = ji.catalogItem.piecesPerUnit || 1;
  return dec.countUnit === 'pieces' ? dec.countedQty : dec.countedQty * ppu;
}

// Ordering units needed to bring the counted stock back up to norm (rounded up)
function wcOrderQty(dec, ji) {
  const ppu        = ji.catalogItem.piecesPerUnit || 1;
  const normPieces = (ji.catalogItem.norm || 0) * ppu;
  const counted    = wcCountedPieces(dec, ji) || 0;
  return Math.max(0, Math.ceil((normPieces - counted) / ppu));
}

async function ensureCatalogLoaded() {
  if (state.catalogMap) return true;
  const result = await api.get('getCatalog');
  if (!result.success) return false;
  setCatalog(result.items || []);
  return true;
}

// =====================================================================
// IN — Catalog search-as-you-type picker
// =====================================================================

function setupScanIn() {
  document.getElementById('si-catalog-search').addEventListener('focus', () => {
    if (!state.siCatalogItems) loadScanInCatalogList();
  });
  document.getElementById('si-catalog-search').addEventListener('input', e => {
    renderSICatalogList(e.target.value.trim());
  });
  document.getElementById('btn-si-catalog-clear').addEventListener('click', clearSICatalogSelection);
  document.getElementById('btn-si-clear').addEventListener('click', clearScanInForm);
  document.getElementById('btn-add-item-cancel').addEventListener('click', hideAddNewItemForm);
  document.getElementById('form-add-catalog-item').addEventListener('submit', async e => {
    e.preventDefault();
    await submitAddCatalogItem();
  });

  document.getElementById('form-scan-in').addEventListener('submit', async e => {
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
  setCatalog(result.items || []);
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
    listEl.innerHTML = `<p class="no-items" style="padding:10px 16px 4px">No items found.</p>
      <div style="padding:0 12px 12px">
        <button type="button" id="btn-show-add-item" class="btn-secondary" style="margin-top:6px">+ Add New Item to Catalog</button>
      </div>`;
    listEl.classList.remove('hidden');
    document.getElementById('btn-show-add-item').addEventListener('click', () => {
      listEl.classList.add('hidden');
      showAddNewItemForm();
    });
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

function showAddNewItemForm() {
  hide('si-catalog-list');
  show('si-add-item-panel');
  document.getElementById('ai-ref').focus();
}

function hideAddNewItemForm() {
  hide('si-add-item-panel');
  document.getElementById('form-add-catalog-item').reset();
  document.getElementById('ai-pieces-per').value    = '1';
  document.getElementById('ai-expiry-warning').value = '14';
}

async function submitAddCatalogItem() {
  const btn  = document.getElementById('btn-add-item-submit');
  const ref  = v('ai-ref');
  const name = v('ai-name');
  if (!ref)  { showToast('REF is required', 'error'); return; }
  if (!name) { showToast('Item Name is required', 'error'); return; }

  setLoading(btn, 'Adding…');
  const result = await api.post('addCatalogItem', {
    ref,
    name,
    category:          document.getElementById('ai-category').value || 'Consumable',
    norm:              parseInt(document.getElementById('ai-norm').value, 10) || 0,
    orderingUnit:      document.getElementById('ai-ordering-unit').value || 'Piece',
    piecesPerUnit:     parseInt(document.getElementById('ai-pieces-per').value, 10) || 1,
    location:          v('ai-location'),
    expiryWarningDays: parseInt(document.getElementById('ai-expiry-warning').value, 10) || 14,
    company:           v('ai-company'),
    orderType:         document.getElementById('ai-order-type').value || 'Order Form',
    countOnly:         document.getElementById('ai-count-only').checked
  });
  resetButton(btn, 'Add to Catalog & Select');

  if (!result.success) { showToast('Error: ' + result.error, 'error'); return; }

  const catResult = await api.get('getCatalog');
  if (catResult.success) setCatalog(catResult.items || []);
  hideAddNewItemForm();
  selectSICatalogItem(ref, name);
  showToast('New item added to catalog', 'success');
}

function selectSICatalogItem(ref, name) {
  document.getElementById('si-ref').value  = ref;
  document.getElementById('si-name').value = name;
  document.getElementById('si-catalog-selected-name').textContent = name || ref;
  document.getElementById('si-catalog-selected').classList.remove('hidden');
  document.getElementById('si-catalog-list').classList.add('hidden');
  hide('si-add-item-panel');
  document.getElementById('si-catalog-search').value = '';
  document.getElementById('si-lot').focus();
}

function clearSICatalogSelection() {
  document.getElementById('si-ref').value  = '';
  document.getElementById('si-name').value = '';
  document.getElementById('si-catalog-selected').classList.add('hidden');
  document.getElementById('si-catalog-search').value = '';
  document.getElementById('si-catalog-search').focus();
}

// Clears only the batch fields, keeping the selected catalog item —
// so multi-lot deliveries can be logged without reselecting the item
function resetScanInLotFields() {
  ['si-lot', 'si-expiry'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('si-qty').value = '1';
  document.getElementById('si-expiry-warning').classList.add('hidden');
  document.getElementById('si-lot').focus();
}

function clearScanInForm() {
  ['si-lot', 'si-expiry'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('si-qty').value = '1';
  document.getElementById('si-expiry-warning').classList.add('hidden');
  clearSICatalogSelection();
  if (state.siCatalogItems) document.getElementById('si-catalog-list').classList.add('hidden');
}

async function submitScanIn(gtin, lot, expiry, qty, itemName) {
  const btn = document.getElementById('btn-si-submit');
  setLoading(btn, 'Logging...');
  const result = await api.post('scanIn', { gtin, lot, expiry, qty, itemName });
  resetButton(btn, 'Log Stock In');
  if (!result.success) { showToast('Error: ' + result.error, 'error'); return; }
  const msg = result.action === 'created'
    ? `Batch logged (qty ${result.newQty}) — add another lot or tap Change`
    : `Existing batch topped up (new qty ${result.newQty}) — add another lot or tap Change`;
  showToast(msg, 'success');
  resetScanInLotFields();
}

// =====================================================================
// OUT
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
  document.getElementById('form-scan-out').addEventListener('submit', async e => {
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

  await ensureCatalogLoaded();

  const result = await api.get('getInventory');
  if (!result.success) { listEl.innerHTML = '<p class="no-items">Error loading inventory</p>'; return; }
  const items = result.items || [];
  if (items.length === 0) { listEl.innerHTML = '<p class="no-items">No items in inventory.</p>'; return; }

  const groupMap = new Map();
  items.forEach(item => {
    if (!groupMap.has(item.gtin)) {
      groupMap.set(item.gtin, { gtin: item.gtin, name: item.name || item.gtin, lots: [], totalQty: 0, unit: item.unit });
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
  if (filtered.length === 0) { listEl.innerHTML = '<p class="no-items">No items found.</p>'; return; }
  listEl.innerHTML = filtered.map(g => {
    const wDays      = getExpiryDays(g.gtin);
    const anyExpired  = g.lots.some(l => l.expiry && l.expiry < todayStr);
    const anyExpiring = !anyExpired && g.lots.some(l => l.expiry && daysDiff(todayStr, l.expiry) <= wDays);
    const rowCls     = anyExpired ? 'row-expired' : anyExpiring ? 'row-expiring' : '';
    const badge      = anyExpired
      ? ' <span class="badge badge-expired">Expired</span>'
      : anyExpiring ? ' <span class="badge badge-expiring">Soon</span>' : '';
    return `<div class="so-item-row ${rowCls}" data-gtin="${esc(g.gtin)}">
      <div>
        <div class="so-item-name">${esc(g.name)}${badge}</div>
        <div class="so-item-meta">Qty: ${formatQty(g.totalQty, g.unit)}</div>
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
        lookupForScanOut({ gtin: lot.gtin, lot: lot.lot, expiry: lot.expiry });
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
  const wDays     = getExpiryDays(group.gtin);
  const sorted    = [...group.lots].sort((a, b) => {
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  });
  lotListEl.innerHTML = sorted.map((lot, i) => {
    const expired  = lot.expiry && lot.expiry < todayStr;
    const expiring = !expired && lot.expiry && daysDiff(todayStr, lot.expiry) <= wDays;
    const lotCls   = expired ? 'lot-expired' : expiring ? 'lot-expiring' : '';
    return `<div class="so-lot-row ${lotCls}" data-lot-idx="${i}">
      <div>
        <div class="so-lot-expiry">${esc(formatExpiry(lot.expiry) || 'No expiry date')}</div>
        <div class="so-lot-meta">LOT: ${esc(lot.lot || '—')} &middot; Qty: ${formatQty(lot.qty, lot.unit)}</div>
      </div>
      <span class="so-item-arrow">&#8250;</span>
    </div>`;
  }).join('');
  lotListEl.querySelectorAll('.so-lot-row').forEach(row => {
    row.addEventListener('click', () => {
      const lot = sorted[parseInt(row.dataset.lotIdx, 10)];
      hide('so-lot-step');
      show('so-item-list');
      lookupForScanOut({ gtin: lot.gtin, lot: lot.lot, expiry: lot.expiry });
    });
  });
  show('so-lot-step');
}

async function lookupForScanOut(parsed) {
  const gtin   = parsed.gtin;
  const lot    = parsed.lot    || '';
  const expiry = parsed.expiry || '';

  const result    = await api.get('lookupBatch', { gtin, lot, expiry });
  const resultDiv = document.getElementById('scan-out-result');
  const card      = document.getElementById('so-status-card');

  if (!result.success) { showToast('API error: ' + result.error, 'error'); return; }

  resultDiv.classList.remove('hidden');
  hide('so-manual-panel');

  if (!result.found) {
    state.scanOutItem = null;
    card.className = 'card status-card';
    card.innerHTML = `
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
  const wDays    = getExpiryDays(item.gtin);

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
  const locLine     = item.location ? `<div class="status-detail">Location: ${esc(item.location)}</div>` : '';

  if (item.expiry && item.expiry < today()) {
    card.className = 'card status-card status-expired';
    card.innerHTML = `
      <div class="status-badge">EXPIRED</div>
      <strong>${esc(item.name || item.gtin)}</strong>
      <div class="status-detail">${esc(expiryLabel)}</div>
      <div class="status-detail">Lot: ${esc(item.lot || '&mdash;')} &middot; Qty: ${qtyStr}</div>
      ${locLine}`;
  } else if (item.expiry && daysLeft <= wDays) {
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

  const result = await api.post('scanOut', { gtin: item.gtin, lot: item.lot, expiry: item.expiry, qty });

  if (!result.success) {
    resetButton(btn, prevBtnText);
    showToast(result.error === 'no_stock' ? 'No stock recorded — cannot go below 0' : 'Error: ' + result.error, 'error');
    return;
  }

  const note = result.archived ? ' (archived — expired + empty)' : '';
  showToast(`Used ${qty}. Remaining: ${result.newQty}${note}`, 'success');

  if (result.newQty === 0 || result.archived) {
    const cat = state.catalogMap && state.catalogMap.get(item.gtin);
    if (cat && cat.orderType === 'Do Not Order' && !cat.retired) {
      await api.post('setRetired', { ref: item.gtin, retired: true });
      cat.retired = true;
    }
  }

  if (result.archived || result.newQty <= 0) {
    resetButton(btn, 'Confirm Use');
    hide('scan-out-result');
    show('so-manual-panel');
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
  document.getElementById('btn-dash-customize').addEventListener('click', openDashCustomize);
  document.getElementById('btn-dash-customize-close').addEventListener('click', () => hide('dash-customize-modal'));
  document.getElementById('dash-customize-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('dash-customize-modal')) hide('dash-customize-modal');
  });
}

async function loadDashboard() {
  const content = document.getElementById('dashboard-content');
  document.getElementById('dashboard-summary').classList.add('hidden');
  content.innerHTML = '<p class="no-items">Loading&hellip;</p>';

  const [invResult, catResult] = await Promise.all([api.get('getInventory'), api.get('getCatalog')]);

  if (!invResult.success) {
    content.innerHTML = `<p class="no-items">Error: ${esc(invResult.error)}</p>`;
    return;
  }
  if (catResult.success) setCatalog(catResult.items || []);

  const items = invResult.items || [];
  if (items.length === 0) { content.innerHTML = '<p class="no-items">No items in inventory yet.</p>'; return; }

  state.dashboardFilters = { location: '', statuses: new Set() };

  items.sort((a, b) => {
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.localeCompare(b.expiry);
  });

  const groupMap = new Map();
  items.forEach(item => {
    if (!groupMap.has(item.gtin)) {
      groupMap.set(item.gtin, { gtin: item.gtin, name: item.name || item.gtin, lots: [], totalQty: 0, soonestExpiry: null, unit: item.unit });
    }
    const g = groupMap.get(item.gtin);
    g.lots.push(item);
    g.totalQty += item.qty;
    if (item.expiry && (!g.soonestExpiry || item.expiry < g.soonestExpiry)) g.soonestExpiry = item.expiry;
    if (!g.name && item.name) g.name = item.name;
  });
  state.dashboardGroups = Array.from(groupMap.values());
  state.dashboardItems  = items;

  renderDashboard();
}

function renderDashboard() {
  const content = document.getElementById('dashboard-content');
  if (!state.dashboardGroups || !state.dashboardItems) return;

  const prefs    = loadDashPrefs();
  const todayStr = today();
  const items    = state.dashboardItems;

  let expiredCount = 0, soonCount = 0, lowCount = 0;
  state.dashboardGroups.forEach(g => {
    const wDays      = getExpiryDays(g.gtin);
    const normPcs    = getNormPieces(g.gtin);
    const anyExpired  = g.lots.some(l => l.expiry && l.expiry < todayStr);
    const anyExpiring = !anyExpired && g.lots.some(l => l.expiry && daysDiff(todayStr, l.expiry) <= wDays);
    if (anyExpired)       expiredCount++;
    else if (anyExpiring) soonCount++;
    if (normPcs > 0 && g.totalQty > 0 && g.totalQty < normPcs) lowCount++;
  });

  const attentionCount = expiredCount + soonCount + lowCount;
  const attentionParts = [
    expiredCount > 0 ? expiredCount + ' expired'       : '',
    soonCount > 0    ? soonCount    + ' expiring soon'  : '',
    lowCount > 0     ? lowCount     + ' below norm'     : ''
  ].filter(Boolean);
  const bannerHtml = attentionCount > 0
    ? `<div class="banner-attention">&#9888; ${attentionCount} item${attentionCount === 1 ? '' : 's'} need${attentionCount === 1 ? 's' : ''} attention: ${attentionParts.join(', ')}</div>`
    : '';

  const kpiDefs = [
    { id: 'total',    cls: 'kpi-total',    lbl: 'Active Items',  num: state.dashboardGroups.length },
    { id: 'expiring', cls: 'kpi-expiring', lbl: 'Expiring Soon', num: soonCount },
    { id: 'expired',  cls: 'kpi-expired',  lbl: 'Expired',       num: expiredCount },
    { id: 'low',      cls: 'kpi-low',      lbl: 'Below Norm',    num: lowCount }
  ].filter(k => !prefs.hiddenKPIs.includes(k.id));
  const kpiHtml = kpiDefs.length > 0
    ? `<div class="kpi-grid">${kpiDefs.map(k => `<div class="kpi-card ${k.cls}"><div class="kpi-lbl">${k.lbl}</div><div class="kpi-num">${k.num}</div></div>`).join('')}</div>`
    : '';

  const withExpiry = items.filter(i => i.expiry).slice(0, 8);
  let timelineHtml = '';
  if (withExpiry.length > 0) {
    const rows = withExpiry.map(item => {
      const wDays    = getExpiryDays(item.gtin);
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
    timelineHtml = `<div class="panel"><div class="panel-header"><h3>Expiry Timeline</h3></div><div class="panel-body">${rows}</div></div>`;
  }

  const nameMap = {};
  items.forEach(item => {
    const name = item.name || item.gtin;
    if (!nameMap[name]) nameMap[name] = { qty: 0, expired: false, expiring: false };
    nameMap[name].qty += item.qty;
    const wDays = getExpiryDays(item.gtin);
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
        <div class="stock-bar-header"><span class="stock-bar-name">${esc(name)}</span><span class="stock-bar-qty">${v.qty}</span></div>
        <div class="stock-bar-track"><div class="stock-bar-fill" style="width:${w}%;background:${color}"></div></div>
      </div>`;
    }).join('');
    chartHtml = `<div class="panel"><div class="panel-header"><h3>Stock Levels by Item</h3></div><div class="panel-body">${bars}</div></div>`;
  }

  const uniqueLocs = uniqueLocations(items);
  const locOptions = uniqueLocs.map(loc => {
    const label = loc === '__unassigned__' ? '(Unassigned)' : loc;
    return `<option value="${esc(loc)}">${esc(label)}</option>`;
  }).join('');
  const filterBarHtml = `<div class="filter-bar" id="dash-filter-bar">
    <select class="filter-location" id="dash-filter-loc"><option value="">All locations</option>${locOptions}</select>
    <div class="filter-chips">
      <button type="button" class="filter-chip" data-status="expiring">Expiring Soon</button>
      <button type="button" class="filter-chip" data-status="expired">Expired</button>
      <button type="button" class="filter-chip" data-status="low">Below Norm</button>
    </div>
    <button type="button" class="filter-clear hidden" id="dash-filter-clear">Clear</button>
  </div>`;

  const cards = state.dashboardGroups.map((g, gIdx) => {
    const wDays      = getExpiryDays(g.gtin);
    const normPcs    = getNormPieces(g.gtin);
    const anyExpired  = g.lots.some(l => l.expiry && l.expiry < todayStr);
    const anyExpiring = !anyExpired && g.lots.some(l => l.expiry && daysDiff(todayStr, l.expiry) <= wDays);
    const isLow       = normPcs > 0 && g.totalQty > 0 && g.totalQty < normPcs;
    const cls         = anyExpired ? 'inv-card-expired' : anyExpiring ? 'inv-card-expiring' : 'inv-card-ok';
    const badge       = anyExpired ? '<span class="badge badge-expired">Expired</span>'
                      : anyExpiring ? '<span class="badge badge-expiring">Soon</span>' : '';
    const cat            = state.catalogMap && state.catalogMap.get(g.gtin);
    const consignedBadge = cat && cat.orderType === 'Consigned' ? '<span class="badge badge-consigned">Consigned</span>' : '';
    const backOrderBadge = cat && cat.backOrder === true ? '<span class="badge badge-backorder">Back Order</span>' : '';
    const firstLot    = g.lots[0];
    const multiLot    = g.lots.length > 1;
    const locChip     = firstLot?.location ? `<div class="inv-card-loc">&#128205; ${esc(firstLot.location)}</div>` : '';

    const lotsHtml = g.lots.map(lot => {
      const le = lot.expiry && lot.expiry < todayStr;
      const lx = !le && lot.expiry && daysDiff(todayStr, lot.expiry) <= wDays;
      const ec = le ? 'inv-lot-value-expiry-expired' : lx ? 'inv-lot-value-expiry-expiring' : '';
      return `<div class="inv-lot-row"><div class="inv-lot-row-fields">
        ${lot.lot    ? `<span class="inv-lot-field"><span class="inv-lot-label">LOT</span><span class="inv-lot-value">${esc(lot.lot)}</span></span>` : ''}
        ${lot.expiry ? `<span class="inv-lot-field"><span class="inv-lot-label">Expiry</span><span class="inv-lot-value ${ec}">${esc(formatExpiry(lot.expiry))}</span></span>` : ''}
        <span class="inv-lot-field"><span class="inv-lot-label">Qty</span><span class="inv-lot-value">${formatQty(lot.qty, lot.unit)}</span></span>
      </div></div>`;
    }).join('');

    const expandBtn = multiLot ? `<button type="button" class="inv-lot-expand-btn" data-gidx="${gIdx}">${g.lots.length} lots &#9660;</button>` : '';
    const editBtn   = `<button type="button" class="inv-card-edit-btn" data-ref="${esc(g.gtin)}" title="Edit catalog item">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>`;

    return `<div class="inv-card ${cls}" data-group-idx="${gIdx}">
      <div class="inv-card-header">
        <span class="inv-card-name">${esc(g.name)}</span>
        ${badge}${consignedBadge}${backOrderBadge}
        ${expandBtn}
        ${editBtn}
      </div>
      ${g.gtin !== g.name ? `<div class="inv-card-meta" style="margin-bottom:4px"><span class="inv-lot-field"><span class="inv-lot-label">REF</span> <span class="inv-lot-value">${esc(g.gtin)}</span></span></div>` : ''}
      <div class="inv-card-expiry">${esc(formatExpiry(g.soonestExpiry) || 'No expiry date')}</div>
      <div class="inv-card-meta">
        <span>Qty: <strong class="${isLow ? 'inv-card-qty-low' : ''}">${formatQty(g.totalQty, g.unit)}${isLow ? ' · LOW' : ''}</strong></span>
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

  const allSections = { banner: bannerHtml, kpi: kpiHtml, timeline: timelineHtml, chart: chartHtml, inventory: inventoryHtml };
  content.innerHTML = prefs.sectionOrder
    .filter(id => !prefs.hiddenSections.includes(id))
    .map(id => allSections[id] || '')
    .join('');

  const filterLocEl = document.getElementById('dash-filter-loc');
  if (filterLocEl) {
    filterLocEl.value = (state.dashboardFilters && state.dashboardFilters.location) || '';
    filterLocEl.addEventListener('change', e => {
      state.dashboardFilters.location = e.target.value;
      applyDashboardFilters();
    });
    content.querySelectorAll('#dash-filter-bar .filter-chip').forEach(chip => {
      if (state.dashboardFilters && state.dashboardFilters.statuses.has(chip.dataset.status)) chip.classList.add('selected');
      chip.addEventListener('click', () => {
        const key = chip.dataset.status;
        const set = state.dashboardFilters.statuses;
        if (set.has(key)) set.delete(key); else set.add(key);
        chip.classList.toggle('selected', set.has(key));
        applyDashboardFilters();
      });
    });
    const clearBtn = document.getElementById('dash-filter-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        state.dashboardFilters = { location: '', statuses: new Set() };
        document.getElementById('dash-filter-loc').value = '';
        content.querySelectorAll('#dash-filter-bar .filter-chip').forEach(c => c.classList.remove('selected'));
        applyDashboardFilters();
      });
    }
    applyDashboardFilters();
  }
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
  content.querySelectorAll('.inv-card-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openEditModal(btn.dataset.ref);
    });
  });
}

// =====================================================================
// DASHBOARD CUSTOMIZE MODAL
// =====================================================================

function openDashCustomize() {
  renderDashCustomizePanel();
  show('dash-customize-modal');
}

function renderDashCustomizePanel() {
  const prefs = loadDashPrefs();
  const sectionLabels = { banner: 'Attention Banner', kpi: 'KPI Cards', timeline: 'Expiry Timeline', chart: 'Stock Levels Chart', inventory: 'Inventory List' };
  const kpiLabels     = { total: 'Active Items', expiring: 'Expiring Soon', expired: 'Expired', low: 'Below Norm' };

  const sectionRows = prefs.sectionOrder.map((id, i) => {
    const hidden = prefs.hiddenSections.includes(id);
    return `<div class="dash-prefs-row">
      <input type="checkbox" class="dash-prefs-toggle" id="dash-sec-${id}" ${hidden ? '' : 'checked'} data-section="${id}">
      <label class="dash-prefs-label" for="dash-sec-${id}">${esc(sectionLabels[id] || id)}</label>
      <button type="button" class="dash-arrow-btn" data-sec-up="${id}" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
      <button type="button" class="dash-arrow-btn" data-sec-down="${id}" ${i === prefs.sectionOrder.length - 1 ? 'disabled' : ''}>&#9660;</button>
    </div>`;
  }).join('');

  const kpiRows = Object.entries(kpiLabels).map(([id, label]) => {
    const hidden = prefs.hiddenKPIs.includes(id);
    return `<div class="dash-prefs-row">
      <input type="checkbox" class="dash-prefs-toggle" id="dash-kpi-${id}" ${hidden ? '' : 'checked'} data-kpi="${id}">
      <label class="dash-prefs-label" for="dash-kpi-${id}">${esc(label)}</label>
    </div>`;
  }).join('');

  document.getElementById('dash-customize-body').innerHTML = `
    <p class="dash-prefs-note">&#128241; Settings saved to this device only.</p>
    <div class="dash-prefs-group-label">Sections</div>
    ${sectionRows}
    <div class="dash-prefs-group-label" style="margin-top:16px">KPI Cards</div>
    ${kpiRows}
    <button type="button" class="dash-prefs-reset" id="btn-dash-prefs-reset">Reset to Default</button>
  `;
  wireDashCustomize();
}

function wireDashCustomize() {
  const body = document.getElementById('dash-customize-body');

  body.querySelectorAll('.dash-prefs-toggle[data-section]').forEach(cb => {
    cb.addEventListener('change', () => {
      const prefs = loadDashPrefs();
      const id    = cb.dataset.section;
      if (cb.checked) prefs.hiddenSections = prefs.hiddenSections.filter(s => s !== id);
      else if (!prefs.hiddenSections.includes(id)) prefs.hiddenSections.push(id);
      saveDashPrefs(prefs);
      renderDashboard();
    });
  });

  body.querySelectorAll('.dash-prefs-toggle[data-kpi]').forEach(cb => {
    cb.addEventListener('change', () => {
      const prefs = loadDashPrefs();
      const id    = cb.dataset.kpi;
      if (cb.checked) prefs.hiddenKPIs = prefs.hiddenKPIs.filter(k => k !== id);
      else if (!prefs.hiddenKPIs.includes(id)) prefs.hiddenKPIs.push(id);
      saveDashPrefs(prefs);
      renderDashboard();
    });
  });

  body.querySelectorAll('[data-sec-up]').forEach(btn => {
    btn.addEventListener('click', () => {
      const prefs = loadDashPrefs();
      const id    = btn.dataset.secUp;
      const idx   = prefs.sectionOrder.indexOf(id);
      if (idx > 0) {
        [prefs.sectionOrder[idx - 1], prefs.sectionOrder[idx]] = [prefs.sectionOrder[idx], prefs.sectionOrder[idx - 1]];
        saveDashPrefs(prefs);
        renderDashCustomizePanel();
        renderDashboard();
      }
    });
  });

  body.querySelectorAll('[data-sec-down]').forEach(btn => {
    btn.addEventListener('click', () => {
      const prefs = loadDashPrefs();
      const id    = btn.dataset.secDown;
      const idx   = prefs.sectionOrder.indexOf(id);
      if (idx < prefs.sectionOrder.length - 1) {
        [prefs.sectionOrder[idx], prefs.sectionOrder[idx + 1]] = [prefs.sectionOrder[idx + 1], prefs.sectionOrder[idx]];
        saveDashPrefs(prefs);
        renderDashCustomizePanel();
        renderDashboard();
      }
    });
  });

  document.getElementById('btn-dash-prefs-reset').addEventListener('click', () => {
    saveDashPrefs({ sectionOrder: ['banner','kpi','timeline','chart','inventory'], hiddenSections: [], hiddenKPIs: [] });
    renderDashCustomizePanel();
    renderDashboard();
  });
}

function applyDashboardFilters() {
  const groups  = state.dashboardGroups || [];
  const filters = state.dashboardFilters;
  const todayStr = today();

  const active = Boolean(filters.location) || filters.statuses.size > 0;
  const clearBtn = document.getElementById('dash-filter-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !active);

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
      const wDays      = getExpiryDays(g.gtin);
      const normPcs    = getNormPieces(g.gtin);
      const anyExpired  = g.lots.some(l => l.expiry && l.expiry < todayStr);
      const anyExpiring = !anyExpired && g.lots.some(l => l.expiry && daysDiff(todayStr, l.expiry) <= wDays);
      const isLow       = normPcs > 0 && g.totalQty > 0 && g.totalQty < normPcs;
      let any = false;
      if (filters.statuses.has('expiring') && anyExpiring) any = true;
      if (filters.statuses.has('expired')  && anyExpired)  any = true;
      if (filters.statuses.has('low')      && isLow)       any = true;
      if (!any) pass = false;
    }
    card.classList.toggle('hidden', !pass);
    if (pass) visibleCount++;
  });
  const noMatchEl = document.getElementById('dash-no-matches');
  if (noMatchEl) noMatchEl.classList.toggle('hidden', visibleCount > 0);
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
// EDIT CATALOG ITEM MODAL
// =====================================================================

function setupEditModal() {
  document.getElementById('btn-edit-modal-close').addEventListener('click', closeEditModal);
  document.getElementById('btn-edit-cancel').addEventListener('click', closeEditModal);
  document.getElementById('edit-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('edit-modal')) closeEditModal();
  });
  document.getElementById('form-edit-catalog').addEventListener('submit', async e => {
    e.preventDefault();
    await submitEditCatalogItem();
  });
}

function openEditModal(ref) {
  const cat = state.catalogMap && state.catalogMap.get(ref);
  document.getElementById('edit-ref').value          = ref;
  document.getElementById('edit-ref-display').textContent = 'REF: ' + ref;
  document.getElementById('edit-name').value         = cat ? (cat.name || '') : '';
  document.getElementById('edit-category').value     = cat ? (cat.category || 'Consumable') : 'Consumable';
  document.getElementById('edit-ordering-unit').value = cat ? (cat.orderingUnit || 'Piece') : 'Piece';
  document.getElementById('edit-pieces-per').value   = cat ? (cat.piecesPerUnit || 1) : 1;
  document.getElementById('edit-norm').value         = cat ? (cat.norm || 0) : 0;
  document.getElementById('edit-location').value     = cat ? (cat.location || '') : '';
  document.getElementById('edit-expiry-warning').value = cat ? (cat.expiryWarningDays || 14) : 14;
  document.getElementById('edit-company').value      = cat ? (cat.company || '') : '';
  document.getElementById('edit-order-type').value   = cat ? (cat.orderType || 'Order Form') : 'Order Form';
  document.getElementById('edit-back-order').checked = cat ? (cat.backOrder === true) : false;
  document.getElementById('edit-count-only').checked = cat ? (cat.countOnly === true) : false;
  show('edit-modal');
}

function closeEditModal() {
  hide('edit-modal');
}

async function submitEditCatalogItem() {
  const btn       = document.getElementById('btn-edit-save');
  const ref       = v('edit-ref');
  const name      = v('edit-name');
  const backOrder = document.getElementById('edit-back-order').checked;
  const countOnly = document.getElementById('edit-count-only').checked;
  if (!name) { showToast('Item Name is required', 'error'); return; }

  setLoading(btn, 'Saving…');
  const result = await api.post('updateCatalogItem', {
    ref,
    name,
    category:          document.getElementById('edit-category').value || 'Consumable',
    norm:              parseInt(document.getElementById('edit-norm').value, 10) || 0,
    orderingUnit:      document.getElementById('edit-ordering-unit').value || 'Piece',
    piecesPerUnit:     parseInt(document.getElementById('edit-pieces-per').value, 10) || 1,
    location:          v('edit-location'),
    expiryWarningDays: parseInt(document.getElementById('edit-expiry-warning').value, 10) || 14,
    company:           v('edit-company'),
    orderType:         document.getElementById('edit-order-type').value || 'Order Form'
  });

  if (!result.success) { resetButton(btn, 'Save Changes'); showToast('Error: ' + result.error, 'error'); return; }

  await api.post('setBackOrder', { ref, value: backOrder });
  await api.post('setCountOnly', { ref, value: countOnly });
  resetButton(btn, 'Save Changes');

  showToast('Catalog item updated', 'success');
  closeEditModal();

  const catResult = await api.get('getCatalog');
  if (catResult.success) setCatalog(catResult.items || []);

  const dashTab = document.getElementById('tab-dashboard');
  if (dashTab && dashTab.classList.contains('active')) loadDashboard();
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

  const [catalogResult, inventoryResult] = await Promise.all([api.get('getCatalog'), api.get('getInventory')]);

  if (!catalogResult.success) { container.innerHTML = `<p class="no-items">Error loading catalog: ${esc(catalogResult.error)}</p>`; return; }
  if (!inventoryResult.success) { container.innerHTML = `<p class="no-items">Error loading inventory: ${esc(inventoryResult.error)}</p>`; return; }

  setCatalog(catalogResult.items || []);

  const allCatalogItems = catalogResult.items || [];
  const catalogItems    = allCatalogItems.filter(ci => !ci.retired && !ci.backOrder);
  if (catalogItems.length === 0) { container.innerHTML = '<p class="no-items">Item Catalog is empty — add items to the Catalog sheet first.</p>'; return; }

  const inventoryItems = inventoryResult.items || [];
  const invByRef = new Map();
  inventoryItems.forEach(item => {
    const ref = (item.gtin || '').trim();
    if (!invByRef.has(ref)) invByRef.set(ref, []);
    invByRef.get(ref).push(item);
  });

  const joined = [], flatLots = [];
  catalogItems.forEach((catalogItem, jiIdx) => {
    const lots = invByRef.get(catalogItem.ref) || [];
    lots.sort((a, b) => {
      if (!a.expiry && !b.expiry) return 0;
      if (!a.expiry) return 1;
      if (!b.expiry) return -1;
      return a.expiry.localeCompare(b.expiry);
    });
    const totalPieces = lots.reduce((sum, lot) => sum + (lot.qty || 0), 0);
    lots.forEach(lot => { lot._flatIdx = flatLots.length; lot._jiIdx = jiIdx; flatLots.push(lot); });
    joined.push({ catalogItem, lots, totalPieces });
  });

  state.weeklyCheck = {
    joined, items: flatLots,
    decisions: joined.map(() => ({ countedQty: null, countUnit: 'unit', notes: '', done: false })),
    checkedBy: ''
  };
  showWCNamePrompt(renderWCChecklist);
}

function showWCNamePrompt(onSubmit) {
  const container = document.getElementById('wc-container');
  container.innerHTML = `
    <div class="card">
      <div class="field">
        <label for="wc-checker-name">Who is doing this check?</label>
        <input type="text" id="wc-checker-name" placeholder="Your name" autocomplete="off">
      </div>
      <button id="btn-wc-name-submit" class="btn-primary">Start Check</button>
    </div>`;
  const nameInput = document.getElementById('wc-checker-name');
  nameInput.focus();
  document.getElementById('btn-wc-name-submit').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('Please enter your name', 'error'); return; }
    state.weeklyCheck.checkedBy = name;
    onSubmit();
  });
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-wc-name-submit').click();
  });
}

function renderWCChecklist() {
  const { joined } = state.weeklyCheck;
  const container  = document.getElementById('wc-container');

  const locationGroups = new Map();
  joined.forEach((ji, jiIdx) => {
    const loc = (ji.catalogItem.location || '').trim() || '__unassigned__';
    if (!locationGroups.has(loc)) locationGroups.set(loc, []);
    locationGroups.get(loc).push({ ji, jiIdx });
  });

  const sortedLocKeys = Array.from(locationGroups.keys()).sort((a, b) => {
    if (a === '__unassigned__') return 1;
    if (b === '__unassigned__') return -1;
    return a.localeCompare(b);
  });

  const chevron = `<svg class="wc-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;

  let html = `<div class="wc-progress-wrap"><p class="wc-progress" id="wc-progress">0 / ${joined.length} items checked</p></div>`;
  for (const locKey of sortedLocKeys) {
    const locItems = locationGroups.get(locKey);
    if (!locItems) continue;
    const label     = locKey === '__unassigned__' ? 'Unassigned' : locKey;
    const itemCount = locItems.length;
    let locHtml = '';
    for (const { ji, jiIdx } of locItems) {
      locHtml += renderWCItemGroupCard(ji, jiIdx);
    }
    html += `<div class="wc-location-group" data-loc-key="${esc(locKey)}">
      <div class="wc-location-header">
        <span class="wc-location-label">${esc(label)}</span>
        <span class="wc-location-count">${itemCount}</span>
        ${chevron}
      </div>
      <div class="wc-location-body">${locHtml}</div>
    </div>`;
  }
  html += `<div id="wc-finish-area" class="hidden"><button id="btn-wc-finish" class="btn-primary">Finish Check</button></div>`;
  container.innerHTML = html;

  joined.forEach((_, jiIdx) => wireWCGroupCard(jiIdx));
  container.querySelectorAll('.wc-location-header').forEach(header => {
    header.addEventListener('click', () => header.closest('.wc-location-group').classList.toggle('open'));
  });
  document.getElementById('btn-wc-finish').addEventListener('click', submitWeeklyCheck);
}

function renderWCItemGroupCard(ji, jiIdx) {
  const { catalogItem, lots, totalPieces } = ji;
  const todayNow   = today();
  const wDays      = catalogItem.expiryWarningDays || 14;
  const ppu        = catalogItem.piecesPerUnit || 1;
  const normPieces = (catalogItem.norm || 0) * ppu;

  const anyExpired  = lots.some(l => l.expiry && l.expiry < todayNow);
  const anyExpiring = !anyExpired && lots.some(l => l.expiry && daysDiff(todayNow, l.expiry) <= wDays);
  const expiryBadge = anyExpired ? '<span class="badge badge-expired">Expired</span>'
                    : anyExpiring ? '<span class="badge badge-expiring">Soon</span>' : '';

  const unit          = catalogItem.orderingUnit || 'units';
  const systemUnits   = ppu > 1 ? (totalPieces / ppu).toFixed(ppu >= 10 ? 0 : 1).replace(/\.0$/, '') : totalPieces;
  const normDisplay   = catalogItem.norm > 0
    ? `Norm: ${catalogItem.norm} ${unit}${ppu > 1 ? ` (${normPieces} pcs)` : ''}`
    : '';
  const systemDisplay = `System: ${systemUnits} ${unit}`;

  const scmBadge = catalogItem.countOnly
    ? '<span class="badge badge-scm">SCM count</span>' : '';

  const lotsSection = lots.length === 0
    ? (catalogItem.countOnly
        ? '<div class="wc-no-stock">Count-managed item &mdash; enter what you find</div>'
        : '<div class="wc-no-stock">No inventory record &mdash; check physical shelf</div>')
    : `<div class="wc-lot-summary">${lots.map(l => {
        const le = l.expiry && l.expiry < todayNow;
        const lx = !le && l.expiry && daysDiff(todayNow, l.expiry) <= wDays;
        const cls = le ? 'lot-expired' : lx ? 'lot-expiring' : '';
        const chip = [l.lot ? esc(l.lot) : 'No lot', l.expiry ? esc(formatExpiry(l.expiry)) : ''].filter(Boolean).join(' · ');
        return `<span class="wc-lot-chip ${cls}">${chip}</span>`;
      }).join('')}
    </div>`;

  return `<div class="wc-catalog-item-group" data-ref="${esc(catalogItem.ref)}" data-jiidx="${jiIdx}" id="wc-item-${jiIdx}">
    <div class="wc-catalog-item-header">
      <div class="wc-catalog-item-title">
        <span class="wc-catalog-item-name">${esc(catalogItem.name || catalogItem.ref)}</span>
        ${scmBadge}
        ${expiryBadge}
      </div>
      <div class="wc-catalog-item-details">
        <span class="wc-catalog-item-ref">REF: ${esc(catalogItem.ref)}</span>
        ${normDisplay ? `<span class="wc-catalog-norm">${esc(normDisplay)}</span>` : ''}
        <span class="wc-catalog-norm" style="color:var(--text3)">${esc(systemDisplay)}</span>
      </div>
    </div>
    ${lotsSection}
    <div class="wc-count-row">
      <span class="wc-count-label">Counted qty</span>
      <input type="number" id="wc-count-input-${jiIdx}" class="wc-count-input" min="0" step="1" inputmode="numeric" placeholder="0">
      ${ppu > 1
        ? `<div class="wc-unit-toggle">
            <button type="button" class="wc-unit-btn selected" data-jiidx="${jiIdx}" data-unit="unit">${esc(unit)}</button>
            <button type="button" class="wc-unit-btn" data-jiidx="${jiIdx}" data-unit="pieces">pieces</button>
          </div>`
        : `<span class="wc-count-unit">${esc(unit)}</span>`}
      <span class="wc-count-preview hidden" id="wc-count-preview-${jiIdx}"></span>
    </div>
    <div class="wc-notes-field" id="wc-notes-${jiIdx}">
      <input type="text" id="wc-notes-input-${jiIdx}" placeholder="Integrity note (optional)" autocomplete="off">
    </div>
  </div>`;
}

function wireWCGroupCard(jiIdx) {
  const countInput = document.getElementById('wc-count-input-' + jiIdx);
  if (countInput) {
    countInput.addEventListener('input', e => {
      const raw = e.target.value.trim();
      state.weeklyCheck.decisions[jiIdx].countedQty = raw === '' ? null : Math.max(0, Number(raw));
      updateWCGroupDone(jiIdx);
    });
  }

  document.querySelectorAll(`.wc-unit-btn[data-jiidx="${jiIdx}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      state.weeklyCheck.decisions[jiIdx].countUnit = btn.dataset.unit;
      document.querySelectorAll(`.wc-unit-btn[data-jiidx="${jiIdx}"]`).forEach(b =>
        b.classList.toggle('selected', b === btn)
      );
      updateWCGroupDone(jiIdx);
    });
  });

  const notesInput = document.getElementById('wc-notes-input-' + jiIdx);
  if (notesInput) {
    notesInput.addEventListener('input', e => {
      state.weeklyCheck.decisions[jiIdx].notes = e.target.value.trim();
    });
  }
}

function updateWCGroupDone(jiIdx) {
  const ji     = state.weeklyCheck.joined[jiIdx];
  const dec    = state.weeklyCheck.decisions[jiIdx];
  const status = deriveWCStatus(wcCountedPieces(dec, ji), ji);
  dec.done = dec.countedQty !== null;

  const el = document.getElementById('wc-item-' + jiIdx);
  if (el) {
    el.classList.toggle('done',         dec.done);
    el.classList.toggle('wc-status-ok',  status === 'ok');
    el.classList.toggle('wc-status-low', status === 'low');
    el.classList.toggle('wc-status-out', status === 'out');
  }

  const previewEl = document.getElementById('wc-count-preview-' + jiIdx);
  if (previewEl) {
    if (!dec.done || status === 'ok') {
      previewEl.classList.add('hidden');
      previewEl.textContent = '';
    } else {
      const orderQty = wcOrderQty(dec, ji);
      const unit     = ji.catalogItem.orderingUnit || 'units';
      if (orderQty > 0) {
        previewEl.textContent = `Order ${orderQty} ${unit}`;
        previewEl.className   = `wc-count-preview ${status === 'out' ? 'preview-out' : 'preview-low'}`;
      } else {
        previewEl.classList.add('hidden');
      }
    }
  }

  updateWCProgress();
}

function updateWCProgress() {
  const done  = state.weeklyCheck.decisions.filter(d => d.done).length;
  const total = state.weeklyCheck.joined.length;
  const el    = document.getElementById('wc-progress');
  if (el) el.textContent = `${done} / ${total} items checked`;
  const finishEl = document.getElementById('wc-finish-area');
  if (finishEl) finishEl.classList.toggle('hidden', done < total);
}

async function submitWeeklyCheck() {
  const { joined, decisions, checkedBy } = state.weeklyCheck;
  const btn = document.getElementById('btn-wc-finish');
  setLoading(btn, 'Finishing…');

  // Auto-retire "Do Not Order" items confirmed as Out
  for (let jiIdx = 0; jiIdx < joined.length; jiIdx++) {
    const ji     = joined[jiIdx];
    const dec    = decisions[jiIdx];
    const status = deriveWCStatus(wcCountedPieces(dec, ji), ji);
    if (status === 'out' && ji.catalogItem.orderType === 'Do Not Order' && !ji.catalogItem.retired) {
      const r = await api.post('setRetired', { ref: ji.catalogItem.ref, retired: true });
      if (r.success) ji.catalogItem.retired = true;
    }
  }

  // The physical count is the source of truth: sync every counted item's
  // quantity to Active Inventory in one batch call
  const countItems = [];
  joined.forEach((ji, jiIdx) => {
    const dec = decisions[jiIdx];
    if (dec.countedQty !== null) {
      countItems.push({ gtin: ji.catalogItem.ref, qty: wcCountedPieces(dec, ji) ?? 0 });
    }
  });
  let appliedCount = null; // null = sync failed
  if (countItems.length > 0) {
    const syncResult = await api.post('applyWeeklyCounts', {
      checkedBy: checkedBy || 'Unknown',
      items:     countItems
    });
    if (syncResult.success) {
      appliedCount = syncResult.applied || 0;
    } else {
      showToast('Inventory sync failed: ' + syncResult.error, 'error');
    }
  } else {
    appliedCount = 0;
  }

  // Log one row per catalog item to Check History
  const historyRows = joined.map((ji, jiIdx) => {
    const dec = decisions[jiIdx];
    return {
      gtin:            ji.catalogItem.ref,
      name:            ji.catalogItem.name || ji.catalogItem.ref,
      location:        ji.catalogItem.location || '',
      qty:             wcCountedPieces(dec, ji) ?? 0,
      integrityStatus: dec.notes ? 'Flagged' : 'OK',
      notes:           dec.notes || ''
    };
  });

  const histResult = await api.post('logCheckHistory', { checkedBy: checkedBy || 'Unknown', rows: historyRows });
  if (!histResult.success) {
    resetButton(btn, 'Finish Check');
    showToast('Error saving check history: ' + histResult.error, 'error');
    return;
  }

  renderWCSummary(joined, decisions, appliedCount);
}

function renderWCSummary(joined, decisions, appliedCount) {
  const container = document.getElementById('wc-container');
  const timeStr   = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateStr   = new Date().toLocaleDateString('en-GB');

  const okCount  = decisions.filter((d, i) => deriveWCStatus(wcCountedPieces(d, joined[i]), joined[i]) === 'ok').length;
  const lowCount = decisions.filter((d, i) => deriveWCStatus(wcCountedPieces(d, joined[i]), joined[i]) === 'low').length;
  const outCount = decisions.filter((d, i) => deriveWCStatus(wcCountedPieces(d, joined[i]), joined[i]) === 'out').length;

  // Group items needing action by order type (exclude Do Not Order — no ordering action needed)
  const actionGroups = {};
  joined.forEach((ji, jiIdx) => {
    const dec    = decisions[jiIdx];
    const status = deriveWCStatus(wcCountedPieces(dec, ji), ji);
    if (status === 'ok') return;
    const ot = ji.catalogItem.orderType || 'Other';
    if (ot === 'Do Not Order') return;
    if (!actionGroups[ot]) actionGroups[ot] = [];
    actionGroups[ot].push({ ji, dec, status });
  });

  const copyDataMap = {};
  function orderSectionHtml(ot, items) {
    const key  = ot.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const text = `${ot} — ${dateStr}\n\n` + items.map(({ ji, dec, status }) => {
      const unit     = ji.catalogItem.orderingUnit || 'units';
      const orderQty = wcOrderQty(dec, ji);
      const orderStr = orderQty > 0 ? ` — ORDER ${orderQty} ${unit.toUpperCase()}` : '';
      const countStr = dec.countedQty !== null
        ? `, counted ${dec.countedQty} ${dec.countUnit === 'pieces' ? 'pieces' : unit}`
        : '';
      return `- ${ji.catalogItem.name || ji.catalogItem.ref} (REF: ${ji.catalogItem.ref}): ${status === 'out' ? 'OUT' : 'LOW'}${countStr}${orderStr}${dec.notes ? ' [' + dec.notes + ']' : ''}`;
    }).join('\n');
    copyDataMap[key] = text;
    return `<div class="wc-summary-section wc-order-section">
      <div class="wc-summary-section-title">${esc(ot)}</div>
      <div style="padding:0 16px 4px">${items.map(({ ji, dec, status }) => {
        const unit     = ji.catalogItem.orderingUnit || 'units';
        const orderQty = wcOrderQty(dec, ji);
        const statusBadge = status === 'out'
          ? '<span class="badge badge-expired" style="font-size:.6rem">OUT</span>'
          : '<span class="badge badge-expiring" style="font-size:.6rem">LOW</span>';
        const orderBadge = orderQty > 0
          ? `<span class="wc-order-qty-badge">${esc('Order ' + orderQty + ' ' + unit)}</span>`
          : '';
        return `<div class="wc-order-item">
          <div class="wc-order-item-name">${esc(ji.catalogItem.name || ji.catalogItem.ref)} ${statusBadge} ${orderBadge}</div>
          <div class="wc-order-item-detail">REF: ${esc(ji.catalogItem.ref)}${dec.notes ? ' &mdash; ' + esc(dec.notes) : ''}</div>
        </div>`;
      }).join('')}</div>
      <div style="padding:0 16px 14px"><button type="button" class="btn-secondary wc-copy-btn" data-copy="${esc(key)}">Copy to clipboard</button></div>
    </div>`;
  }

  const orderEntries = Object.entries(actionGroups);
  const orderSectionsHtml = orderEntries.length > 0
    ? orderEntries.map(([ot, items]) => orderSectionHtml(ot, items)).join('')
    : `<div class="wc-summary-section"><div class="wc-summary-section-title" style="color:var(--green)">&#10003; No ordering action required</div></div>`;

  const syncNote = appliedCount === null
    ? '<div class="wc-sync-note wc-sync-failed">&#9888; Inventory sync failed &mdash; Dashboard quantities NOT updated. Note the counts and retry later.</div>'
    : appliedCount === 0
      ? '<div class="wc-sync-note">Inventory already matched your counts &mdash; no adjustments needed.</div>'
      : `<div class="wc-sync-note">&#10003; Inventory updated &mdash; ${appliedCount} item${appliedCount === 1 ? '' : 's'} adjusted to the counted quantity.</div>`;

  container.innerHTML = `<div class="wc-summary">
    <div class="wc-summary-title">Check Complete &mdash; ${esc(timeStr)}</div>
    ${syncNote}
    <div class="wc-summary-stats">
      <div class="wc-stat wc-stat-ok"><span class="wc-stat-num">${okCount}</span><span class="wc-stat-lbl">All OK</span></div>
      <div class="wc-stat ${lowCount > 0 ? 'wc-stat-warn' : 'wc-stat-ok'}"><span class="wc-stat-num">${lowCount}</span><span class="wc-stat-lbl">Low Stock</span></div>
      <div class="wc-stat ${outCount > 0 ? 'wc-stat-danger' : 'wc-stat-ok'}"><span class="wc-stat-num">${outCount}</span><span class="wc-stat-lbl">Out of Stock</span></div>
    </div>
    ${orderSectionsHtml}
    <button id="btn-wc-done" class="btn-primary">Done</button>
  </div>`;

  container.querySelectorAll('.wc-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = copyDataMap[btn.dataset.copy];
      if (!text) return;
      navigator.clipboard.writeText(text).then(
        () => showToast('Copied to clipboard', 'success'),
        () => showToast('Copy failed — please copy manually', 'error')
      );
    });
  });
  document.getElementById('btn-wc-done').addEventListener('click', renderWCIdle);
}

// =====================================================================
// HISTORY TAB
// =====================================================================

function setupHistory() {
  // History loads on demand when the tab is opened
}

async function loadHistory() {
  const container = document.getElementById('history-container');
  if (!container) return;
  state.history.filters = { location: '', search: '' };
  container.innerHTML = '<p class="no-items">Loading&hellip;</p>';

  const result = await api.get('getCheckHistory');
  if (!result.success) {
    container.innerHTML = `<p class="no-items">Error: ${esc(result.error)}</p>`;
    return;
  }
  state.history.rows = result.rows || [];
  renderHistoryList();
}

function renderHistoryList() {
  const container = document.getElementById('history-container');
  if (!container) return;
  const { rows, filters } = state.history;

  const locLower    = (filters.location || '').toLowerCase();
  const searchLower = (filters.search   || '').toLowerCase();

  const filtered = rows.filter(r => {
    if (locLower    && !(r.location || '').toLowerCase().includes(locLower))    return false;
    if (searchLower && !(r.name || '').toLowerCase().includes(searchLower)
                    && !(r.ref  || '').toLowerCase().includes(searchLower))     return false;
    return true;
  });

  const uniqueLocs = [...new Set(rows.map(r => r.location || '').filter(Boolean))].sort();
  const locOptions = uniqueLocs.map(loc => `<option value="${esc(loc)}">${esc(loc)}</option>`).join('');

  const filterHtml = `<div class="filter-bar">
    <select class="filter-location" id="hist-filter-loc">
      <option value="">All locations</option>${locOptions}
    </select>
    <div class="search-input-wrap" style="flex:1;margin-bottom:0">
      <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="search" id="hist-search" class="search-input" placeholder="Search by name or REF&hellip;" value="${esc(filters.search)}" autocomplete="off">
    </div>
  </div>`;

  // Group rows into sessions by timestamp (minute precision) + checkedBy
  const sessionMap = new Map();
  filtered.forEach(r => {
    const key = (r.timestamp || '').slice(0, 16) + '\x00' + (r.checkedBy || '');
    if (!sessionMap.has(key)) sessionMap.set(key, { timestamp: r.timestamp, checkedBy: r.checkedBy, rows: [] });
    sessionMap.get(key).rows.push(r);
  });

  const sessions = Array.from(sessionMap.values());

  const chevron = `<svg class="wc-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;

  const listHtml = sessions.length === 0
    ? '<p class="no-items">No check history found.</p>'
    : sessions.map((session, idx) => {
        const dateStr = session.timestamp
          ? new Date(session.timestamp.replace(' ', 'T')).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
          : 'Unknown date';
        const flaggedCount = session.rows.filter(r => (r.integrityStatus || '').toLowerCase() === 'flagged').length;
        const itemRows = session.rows.map(r => {
          const isFlagged = (r.integrityStatus || '').toLowerCase() === 'flagged';
          return `<div class="hist-item-row${isFlagged ? ' hist-item-flagged' : ''}">
            <span class="hist-item-name">${esc(r.name || r.ref)}</span>
            <span class="hist-item-detail">Qty: ${r.qtyRecorded ?? '—'}${isFlagged ? ' &nbsp;<span class="badge badge-expired" style="font-size:.58rem">Flagged</span>' : ''}</span>
            ${r.notes ? `<span class="hist-item-note">${esc(r.notes)}</span>` : ''}
          </div>`;
        }).join('');
        return `<div class="hist-session${idx === 0 ? ' open' : ''}">
          <div class="hist-session-header">
            <span class="hist-session-date">${esc(dateStr)}</span>
            <span class="hist-session-by">by ${esc(session.checkedBy || 'Unknown')}</span>
            ${flaggedCount > 0 ? `<span class="badge badge-expired" style="font-size:.58rem">${flaggedCount} flagged</span>` : ''}
            <span class="hist-session-count">${session.rows.length} item${session.rows.length === 1 ? '' : 's'}</span>
            ${chevron}
          </div>
          <div class="hist-session-items">${itemRows}</div>
        </div>`;
      }).join('');

  container.innerHTML = filterHtml + listHtml;

  container.querySelectorAll('.hist-session-header').forEach(header => {
    header.addEventListener('click', () => header.closest('.hist-session').classList.toggle('open'));
  });

  document.getElementById('hist-filter-loc').value = filters.location;
  document.getElementById('hist-filter-loc').addEventListener('change', e => {
    state.history.filters.location = e.target.value;
    renderHistoryList();
  });
  document.getElementById('hist-search').addEventListener('input', e => {
    state.history.filters.search = e.target.value.trim();
    renderHistoryList();
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

function today() { return new Date().toISOString().slice(0, 10); }
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
  const u = (unit || '').trim();
  return u ? `${qty} ${esc(u)}` : String(qty);
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
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function ringHTML(pct, color, centerText) {
  const R    = 22;
  const circ = +(2 * Math.PI * R).toFixed(2);
  const dash = +((pct / 100) * circ).toFixed(2);
  return `<svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
    <circle cx="26" cy="26" r="${R}" fill="none" stroke="#dce4f0" stroke-width="4.5"/>
    <circle cx="26" cy="26" r="${R}" fill="none" stroke="${color}" stroke-width="4.5"
            stroke-dasharray="${dash} ${circ}" stroke-linecap="round" transform="rotate(-90 26 26)"/>
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
