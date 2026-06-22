// =====================================================================
// Consumables Expiry Tracker — Google Apps Script Backend
//
// HOW TO SET UP:
// 1. Open your Google Sheet → Extensions → Apps Script
// 2. Replace any existing code with this entire file and Save (Ctrl+S)
// 3. Click Deploy → New deployment
//    - Type: Web app
//    - "Execute as": Me
//    - "Who has access": Anyone
//    → Click Deploy and copy the Web App URL
// 4. Paste the URL into js/config.js in the GitHub repo
// 5. (One-time, optional) In the Apps Script editor, click Run →
//    setupDailyTrigger to enable automatic nightly archiving
//
// Expected sheet tab names (case-sensitive):
//   "Active Inventory"   "Archive"   "Reconciliation Log"
// =====================================================================

// --- Sheet names ---
const ACTIVE_SHEET  = 'Active Inventory';
const ARCHIVE_SHEET = 'Archive';
const RECON_SHEET   = 'Reconciliation Log';

// --- Column indices (0-based) for Active Inventory & Archive ---
const C = {
  GTIN:         0,  // A: GTIN/Ref
  LOT:          1,  // B: Lot
  EXPIRY:       2,  // C: Expiry Date
  QTY:          3,  // D: Quantity
  NAME:         4,  // E: Item Name
  DATE_LOGGED:  5,  // F: Date First Logged
  LAST_UPDATED: 6,  // G: Last Updated
  ACTION_BY:    7,  // H: Last Action By
  MIN_QTY:      8,  // I: Min Qty (per-item low-stock alert threshold)
  LOCATION:     9   // J: Shelf/drawer/cart identifier for weekly check grouping
};

// Archive-only extra columns
const CA = {
  ARCHIVED_DATE:  8,  // I
  ARCHIVE_REASON: 9   // J
};

// =====================================================================
// HTTP ENTRY POINTS
// =====================================================================

function doGet(e) {
  let result;
  try {
    const action = (e.parameter && e.parameter.action) || '';
    if (action === 'getInventory') {
      result = getInventory();
    } else if (action === 'lookupBatch') {
      result = lookupBatch(
        e.parameter.gtin   || '',
        e.parameter.lot    || '',
        e.parameter.expiry || ''
      );
    } else if (action === 'archiveSweep') {
      result = archiveSweep();
    } else {
      result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { success: false, error: err.toString() };
  }
  return jsonResponse(result);
}

function doPost(e) {
  let params;
  try {
    params = JSON.parse(e.postData.contents);
  } catch (_) {
    return jsonResponse({ success: false, error: 'Invalid JSON in request body' });
  }

  let result;
  try {
    const action = params.action || '';
    if (action === 'scanIn') {
      result = scanIn(params);
    } else if (action === 'scanOut') {
      result = scanOut(params);
    } else if (action === 'reconcile') {
      result = reconcile(params);
    } else if (action === 'setMinQty') {
      result = setMinQty(params);
    } else {
      result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { success: false, error: err.toString() };
  }
  return jsonResponse(result);
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================
// BUSINESS LOGIC
// =====================================================================

/** Return all rows from Active Inventory as an array of item objects. */
function getInventory() {
  const sheet  = getSheet(ACTIVE_SHEET);
  const values = sheet.getDataRange().getValues();
  const items  = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[C.GTIN] && !row[C.NAME]) continue; // skip blank rows
    items.push(rowToItem(row));
  }
  return { success: true, items: items };
}

/** Look up a single batch by GTIN + Lot + Expiry. */
function lookupBatch(gtin, lot, expiry) {
  const sheet  = getSheet(ACTIVE_SHEET);
  const rowNum = findBatchRow(sheet, gtin, lot, expiry);
  if (rowNum === -1) return { success: true, found: false };
  const row = sheet.getRange(rowNum, 1, 1, 8).getValues()[0];
  return { success: true, found: true, item: rowToItem(row) };
}

/**
 * Increment stock for an existing batch, or create a new row if not found.
 * Uses LockService to prevent race conditions.
 */
function scanIn(params) {
  const gtin     = String(params.gtin     || '').trim();
  const lot      = String(params.lot      || '').trim();
  const expiry   = String(params.expiry   || '').trim();
  const qty      = Number(params.qty)     || 1;
  const itemName = String(params.itemName || '').trim();
  const actionBy = String(params.actionBy || '').trim();
  const minQty   = params.minQty !== undefined ? Number(params.minQty) : null;
  const location = String(params.location || '').trim();

  if (!gtin) return { success: false, error: 'GTIN is required' };
  if (qty < 1) return { success: false, error: 'Quantity must be at least 1' };

  const lock = LockService.getSpreadsheetLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const sheet  = getSheet(ACTIVE_SHEET);
    const rowNum = findBatchRow(sheet, gtin, lot, expiry);
    const now    = new Date();

    if (rowNum !== -1) {
      // Existing batch — increment qty
      const qtyCell = sheet.getRange(rowNum, C.QTY + 1);
      const newQty  = (Number(qtyCell.getValue()) || 0) + qty;
      qtyCell.setValue(newQty);
      sheet.getRange(rowNum, C.LAST_UPDATED + 1).setValue(now);
      if (actionBy)  sheet.getRange(rowNum, C.ACTION_BY + 1).setValue(actionBy);
      if (location)  sheet.getRange(rowNum, C.LOCATION + 1).setValue(location);
      return { success: true, action: 'updated', newQty: newQty };
    } else {
      // New batch — append row
      const minQtyVal = (minQty !== null && minQty >= 0) ? minQty : '';
      sheet.appendRow([gtin, lot, expiry, qty, itemName, now, now, actionBy, minQtyVal, location]);
      return { success: true, action: 'created', newQty: qty };
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Decrement stock. Guards against going negative.
 * Auto-archives the batch if qty reaches 0 AND it is already expired.
 */
function scanOut(params) {
  const gtin     = String(params.gtin     || '').trim();
  const lot      = String(params.lot      || '').trim();
  const expiry   = String(params.expiry   || '').trim();
  const qty      = Number(params.qty)     || 1;
  const actionBy = String(params.actionBy || '').trim();

  if (!gtin) return { success: false, error: 'GTIN is required' };

  const lock = LockService.getSpreadsheetLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const activeSheet  = getSheet(ACTIVE_SHEET);
    const archiveSheet = getSheet(ARCHIVE_SHEET);
    const rowNum = findBatchRow(activeSheet, gtin, lot, expiry);

    if (rowNum === -1) return { success: false, error: 'not_found' };

    const row        = activeSheet.getRange(rowNum, 1, 1, 8).getValues()[0];
    const currentQty = Number(row[C.QTY]) || 0;

    if (currentQty <= 0) return { success: false, error: 'no_stock' };

    const newQty = Math.max(0, currentQty - qty);
    const now    = new Date();

    activeSheet.getRange(rowNum, C.QTY + 1).setValue(newQty);
    activeSheet.getRange(rowNum, C.LAST_UPDATED + 1).setValue(now);
    if (actionBy) activeSheet.getRange(rowNum, C.ACTION_BY + 1).setValue(actionBy);

    // Auto-archive: qty now 0 AND expiry date is already past
    if (newQty === 0 && expiry && expiry < todayStr()) {
      const freshRow = activeSheet.getRange(rowNum, 1, 1, 8).getValues()[0];
      doArchiveRow(activeSheet, archiveSheet, rowNum, freshRow, 'qty=0 and expired');
      return { success: true, newQty: 0, archived: true };
    }

    return { success: true, newQty: newQty, archived: false };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Log a weekly-check entry and adjust inventory to the physical count.
 * Called only for items where quantity differs OR integrity is flagged.
 * A reason note is always required for these cases.
 */
function reconcile(params) {
  const gtin            = String(params.gtin            || '').trim();
  const lot             = String(params.lot             || '').trim();
  const expiry          = String(params.expiry          || '').trim();
  const physicalCount   = Number(params.physicalCount);
  const reason          = String(params.reason          || '').trim();
  const adjustedBy      = String(params.adjustedBy      || '').trim();
  const integrityStatus = String(params.integrityStatus || 'OK').trim();
  const location        = String(params.location        || '').trim();

  if (!gtin)                return { success: false, error: 'GTIN is required' };
  if (isNaN(physicalCount)) return { success: false, error: 'physicalCount must be a number' };
  if (!reason)              return { success: false, error: 'A reason/note is required' };

  const lock = LockService.getSpreadsheetLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const activeSheet = getSheet(ACTIVE_SHEET);
    const reconSheet  = getSheet(RECON_SHEET);
    const rowNum      = findBatchRow(activeSheet, gtin, lot, expiry);

    if (rowNum === -1) return { success: false, error: 'Batch not found in Active Inventory' };

    const row       = activeSheet.getRange(rowNum, 1, 1, 10).getValues()[0];
    const systemQty = Number(row[C.QTY]) || 0;
    const variance  = physicalCount - systemQty;
    const now       = new Date();

    // Write to Reconciliation Log (columns A–K)
    reconSheet.appendRow([
      now, gtin, lot, expiry,
      systemQty, physicalCount, variance,
      reason, adjustedBy,
      integrityStatus,  // J: Integrity Status
      location          // K: Location
    ]);

    // Update Active Inventory quantity
    activeSheet.getRange(rowNum, C.QTY + 1).setValue(physicalCount);
    activeSheet.getRange(rowNum, C.LAST_UPDATED + 1).setValue(now);
    if (adjustedBy) activeSheet.getRange(rowNum, C.ACTION_BY + 1).setValue(adjustedBy);

    return { success: true, systemQty: systemQty, physicalCount: physicalCount, variance: variance };
  } finally {
    lock.releaseLock();
  }
}

/** Update the per-item low-stock alert threshold (column I). */
function setMinQty(params) {
  const gtin   = String(params.gtin   || '').trim();
  const lot    = String(params.lot    || '').trim();
  const expiry = String(params.expiry || '').trim();
  const minQty = Number(params.minQty);

  if (!gtin)        return { success: false, error: 'GTIN is required' };
  if (isNaN(minQty) || minQty < 0) return { success: false, error: 'minQty must be 0 or higher' };

  const lock = LockService.getSpreadsheetLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const sheet  = getSheet(ACTIVE_SHEET);
    const rowNum = findBatchRow(sheet, gtin, lot, expiry);
    if (rowNum === -1) return { success: false, error: 'Batch not found' };
    sheet.getRange(rowNum, C.MIN_QTY + 1).setValue(minQty);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Move any Active Inventory row with qty=0 AND an expired date to the Archive sheet.
 * Designed to run daily via a time-based trigger (see setupDailyTrigger below).
 */
function archiveSweep() {
  const activeSheet  = getSheet(ACTIVE_SHEET);
  const archiveSheet = getSheet(ARCHIVE_SHEET);
  const values       = activeSheet.getDataRange().getValues();
  const today        = todayStr();
  let archivedCount  = 0;

  // Iterate bottom-to-top: deleting a row shifts indices of rows below it,
  // so going backwards keeps earlier indices valid.
  for (let i = values.length - 1; i >= 1; i--) {
    const row    = values[i];
    const qty    = Number(row[C.QTY]) || 0;
    const expiry = normalizeDate(row[C.EXPIRY]);
    if (qty === 0 && expiry && expiry < today) {
      doArchiveRow(activeSheet, archiveSheet, i + 1, row, 'qty=0 and expired');
      archivedCount++;
    }
  }

  return { success: true, archivedCount: archivedCount };
}

/**
 * Run this ONCE from the Apps Script editor:
 *   Run menu → Run function → setupDailyTrigger
 * Creates a daily 1 AM trigger for archiveSweep. Re-running removes the old one first.
 */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'archiveSweep')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('archiveSweep')
    .timeBased()
    .everyDays(1)
    .atHour(1)
    .create();

  Logger.log('Daily archiveSweep trigger created — runs at ~1 AM each day.');
}

// =====================================================================
// HELPERS
// =====================================================================

function getSheet(name) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: "' + name + '". Check the tab name.');
  return sheet;
}

/**
 * Find the 1-based row number of a batch by GTIN + Lot + Expiry.
 * Returns -1 if not found.
 */
function findBatchRow(sheet, gtin, lot, expiry) {
  const data = sheet.getDataRange().getValues();
  const g = String(gtin).trim();
  const l = String(lot).trim();
  const e = String(expiry).trim();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[C.GTIN]).trim()   === g &&
        String(row[C.LOT]).trim()    === l &&
        normalizeDate(row[C.EXPIRY]) === e) {
      return i + 1; // convert to 1-based sheet row number
    }
  }
  return -1;
}

/** Copy a row to Archive and delete it from Active Inventory. */
function doArchiveRow(activeSheet, archiveSheet, rowNum, rowData, reason) {
  const archiveRow = rowData.slice(0, 8).concat([new Date(), reason]);
  archiveSheet.appendRow(archiveRow);
  activeSheet.deleteRow(rowNum);
}

/** Convert a sheet row array into a plain object for JSON responses. */
function rowToItem(row) {
  return {
    gtin:        String(row[C.GTIN]).trim(),
    lot:         String(row[C.LOT]).trim(),
    expiry:      normalizeDate(row[C.EXPIRY]),
    qty:         Number(row[C.QTY]) || 0,
    name:        String(row[C.NAME]).trim(),
    dateLogged:  normalizeDateTime(row[C.DATE_LOGGED]),
    lastUpdated: normalizeDateTime(row[C.LAST_UPDATED]),
    actionBy:    String(row[C.ACTION_BY]).trim(),
    minQty:      Number(row[C.MIN_QTY]) || 0,
    location:    String(row[C.LOCATION] || '').trim()
  };
}

/** Convert a cell value (Date object or string) to YYYY-MM-DD. */
function normalizeDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(val).trim();
}

/** Convert a cell value to "YYYY-MM-DD HH:mm". */
function normalizeDateTime(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return String(val).trim();
}

/** Today's date as a YYYY-MM-DD string in the script's timezone. */
function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
