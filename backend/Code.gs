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
//   "Item Catalog"       "Check History"
// =====================================================================

// --- Sheet names ---
const ACTIVE_SHEET   = 'Active Inventory';
const ARCHIVE_SHEET  = 'Archive';
const RECON_SHEET    = 'Reconciliation Log';
const CATALOG_SHEET  = 'Item Catalog';
const HISTORY_SHEET  = 'Check History';

// --- Column indices (0-based) for Active Inventory ---
const C = {
  GTIN:              0,  // A: GTIN/Ref
  LOT:               1,  // B: Lot
  EXPIRY:            2,  // C: Expiry Date
  QTY:               3,  // D: Quantity
  NAME:              4,  // E: Item Name
  DATE_LOGGED:       5,  // F: Date First Logged
  LAST_UPDATED:      6,  // G: Last Updated
  ACTION_BY:         7,  // H: Last Action By
  LOCATION:          8,  // I: Shelf/drawer/cart identifier
  UNIT:              9,  // J: Unit of measure (Box / Piece / Carton / …)
  INTEGRITY_FLAGGED: 10  // K: 'Yes' if lot was flagged during last Weekly Check
};

// --- Column indices (0-based) for Item Catalog ---
const CC = {
  REF:            0,  // A: Ref
  NAME:           1,  // B: Item Name
  CATEGORY:       2,  // C: Category (Consumable / Implant)
  NORM:           3,  // D: Norm
  ORDERING_UNIT:  4,  // E: Ordering Unit
  PIECES_PER:     5,  // F: Pieces Per Unit
  LOCATION:       6,  // G: Location
  EXPIRY_WARNING: 7,  // H: Expiry Warning Days
  COMPANY:        8,  // I: Manufacturer / vendor
  ORDER_TYPE:     9,  // J: Order Form / EPR / Consigned / OMS / ENT / Inform SCM / Do Not Order
  RETIRED:       10,  // K: 'Yes' when item is Do Not Order and retired
  BACK_ORDER:    11,  // L: 'Yes' when vendor has no stock (app-managed)
  COUNT_ONLY:    12   // M: 'Yes' when SCM-managed — no lot tracking, weekly count sets qty
};

// --- Archive-only extra columns (after Active Inventory A–K) ---
const CA = {
  ARCHIVED_DATE:  11,  // L
  ARCHIVE_REASON: 12   // M
};

// --- Column indices (0-based) for Check History ---
const CH = {
  TIMESTAMP:        0,  // A
  REF:              1,  // B
  ITEM_NAME:        2,  // C
  LOCATION:         3,  // D
  QTY_RECORDED:     4,  // E
  INTEGRITY_STATUS: 5,  // F
  CHECKED_BY:       6,  // G
  NOTES:            7   // H
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
    } else if (action === 'getCatalog') {
      result = getCatalog();
    } else if (action === 'lookupBatch') {
      result = lookupBatch(
        e.parameter.gtin   || '',
        e.parameter.lot    || '',
        e.parameter.expiry || ''
      );
    } else if (action === 'archiveSweep') {
      result = archiveSweep();
    } else if (action === 'getCheckHistory') {
      result = getCheckHistory();
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
    } else if (action === 'addCatalogItem') {
      result = addCatalogItem(params);
    } else if (action === 'updateCatalogItem') {
      result = updateCatalogItem(params);
    } else if (action === 'logCheckHistory') {
      result = logCheckHistory(params);
    } else if (action === 'setBackOrder') {
      result = setBackOrder(params);
    } else if (action === 'setRetired') {
      result = setRetired(params);
    } else if (action === 'setCountOnly') {
      result = setCountOnly(params);
    } else if (action === 'setCountedQty') {
      result = setCountedQty(params);
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

/** Return all rows from Item Catalog as an array of catalog item objects. */
function getCatalog() {
  const sheet  = getSheet(CATALOG_SHEET);
  const values = sheet.getDataRange().getValues();
  const items  = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[CC.REF]) continue;
    items.push({
      ref:               String(row[CC.REF]).trim(),
      name:              String(row[CC.NAME]            || '').trim(),
      category:          String(row[CC.CATEGORY]        || '').trim(),
      norm:              Number(row[CC.NORM])            || 0,
      orderingUnit:      String(row[CC.ORDERING_UNIT]   || 'Piece').trim(),
      piecesPerUnit:     Number(row[CC.PIECES_PER])     || 1,
      location:          String(row[CC.LOCATION]        || '').trim(),
      expiryWarningDays: Number(row[CC.EXPIRY_WARNING]) || 14,
      company:           String(row[CC.COMPANY]         || '').trim(),
      orderType:         String(row[CC.ORDER_TYPE]      || '').trim(),
      retired:           String(row[CC.RETIRED]         || '').trim().toLowerCase() === 'yes',
      backOrder:         String(row[CC.BACK_ORDER]      || '').trim().toLowerCase() === 'yes',
      countOnly:         String(row[CC.COUNT_ONLY]      || '').trim().toLowerCase() === 'yes'
    });
  }
  return { success: true, items: items };
}

/** Return all rows from Active Inventory as an array of item objects. */
function getInventory() {
  const sheet  = getSheet(ACTIVE_SHEET);
  const values = sheet.getDataRange().getValues();
  const items  = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[C.GTIN] && !row[C.NAME]) continue;
    items.push(rowToItem(row));
  }
  return { success: true, items: items };
}

/** Return up to 500 most-recent rows from Check History, newest first. */
function getCheckHistory() {
  const sheet   = getSheet(HISTORY_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { success: true, rows: [] };

  const startRow = Math.max(2, lastRow - 499);
  const numRows  = lastRow - startRow + 1;
  const values   = sheet.getRange(startRow, 1, numRows, 8).getValues();

  const rows = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    if (!row[CH.REF]) continue;
    rows.push({
      timestamp:        normalizeDateTime(row[CH.TIMESTAMP]),
      ref:              String(row[CH.REF]              || '').trim(),
      name:             String(row[CH.ITEM_NAME]        || '').trim(),
      location:         String(row[CH.LOCATION]         || '').trim(),
      qtyRecorded:      Number(row[CH.QTY_RECORDED])    || 0,
      integrityStatus:  String(row[CH.INTEGRITY_STATUS] || '').trim(),
      checkedBy:        String(row[CH.CHECKED_BY]       || '').trim(),
      notes:            String(row[CH.NOTES]            || '').trim()
    });
  }
  return { success: true, rows: rows };
}

/** Look up a single batch by GTIN + Lot + Expiry. */
function lookupBatch(gtin, lot, expiry) {
  const sheet  = getSheet(ACTIVE_SHEET);
  const rowNum = findBatchRow(sheet, gtin, lot, expiry);
  if (rowNum === -1) return { success: true, found: false };
  const row = sheet.getRange(rowNum, 1, 1, 11).getValues()[0];
  return { success: true, found: true, item: rowToItem(row) };
}

/**
 * Increment stock for an existing batch, or create a new row if not found.
 * Auto-clears Back Order flag in Item Catalog when stock arrives.
 */
function scanIn(params) {
  const gtin     = String(params.gtin     || '').trim();
  const lot      = String(params.lot      || '').trim();
  const expiry   = String(params.expiry   || '').trim();
  const qty      = Number(params.qty)     || 1;
  const itemName = String(params.itemName || '').trim();
  const actionBy = String(params.actionBy || '').trim();
  const location = String(params.location || '').trim();
  const unit     = String(params.unit     || '').trim();

  if (!gtin) return { success: false, error: 'GTIN is required' };
  if (qty < 1) return { success: false, error: 'Quantity must be at least 1' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const sheet  = getSheet(ACTIVE_SHEET);
    const rowNum = findBatchRow(sheet, gtin, lot, expiry);
    const now    = new Date();

    if (rowNum !== -1) {
      const qtyCell = sheet.getRange(rowNum, C.QTY + 1);
      const newQty  = (Number(qtyCell.getValue()) || 0) + qty;
      qtyCell.setValue(newQty);
      sheet.getRange(rowNum, C.LAST_UPDATED + 1).setValue(now);
      if (actionBy) sheet.getRange(rowNum, C.ACTION_BY + 1).setValue(actionBy);
      if (location) sheet.getRange(rowNum, C.LOCATION + 1).setValue(location);
      if (unit)     sheet.getRange(rowNum, C.UNIT + 1).setValue(unit);
      clearBackOrder_(gtin);
      return { success: true, action: 'updated', newQty: newQty };
    } else {
      // New batch — append 10 columns (A–J); K (Integrity Flagged) starts empty
      sheet.appendRow([gtin, lot, expiry, qty, itemName, now, now, actionBy, location, unit]);
      clearBackOrder_(gtin);
      return { success: true, action: 'created', newQty: qty };
    }
  } finally {
    lock.releaseLock();
  }
}

/** Clear Back Order flag for an item in the catalog if it was set. */
function clearBackOrder_(gtin) {
  try {
    const catSheet = getSheet(CATALOG_SHEET);
    const catVals  = catSheet.getDataRange().getValues();
    for (let i = 1; i < catVals.length; i++) {
      if (String(catVals[i][CC.REF]).trim() === gtin) {
        if (String(catVals[i][CC.BACK_ORDER] || '').trim().toLowerCase() === 'yes') {
          catSheet.getRange(i + 1, CC.BACK_ORDER + 1).setValue('');
        }
        break;
      }
    }
  } catch (_) {}
}

/**
 * Decrement stock. Guards against going negative.
 * Auto-archives when qty=0 AND expired.
 */
function scanOut(params) {
  const gtin     = String(params.gtin     || '').trim();
  const lot      = String(params.lot      || '').trim();
  const expiry   = String(params.expiry   || '').trim();
  const qty      = Number(params.qty)     || 1;
  const actionBy = String(params.actionBy || '').trim();

  if (!gtin) return { success: false, error: 'GTIN is required' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const activeSheet  = getSheet(ACTIVE_SHEET);
    const archiveSheet = getSheet(ARCHIVE_SHEET);
    const rowNum = findBatchRow(activeSheet, gtin, lot, expiry);

    if (rowNum === -1) return { success: false, error: 'not_found' };

    const row        = activeSheet.getRange(rowNum, 1, 1, 11).getValues()[0];
    const currentQty = Number(row[C.QTY]) || 0;

    if (currentQty <= 0) return { success: false, error: 'no_stock' };

    const newQty = Math.max(0, currentQty - qty);
    const now    = new Date();

    activeSheet.getRange(rowNum, C.QTY + 1).setValue(newQty);
    activeSheet.getRange(rowNum, C.LAST_UPDATED + 1).setValue(now);
    if (actionBy) activeSheet.getRange(rowNum, C.ACTION_BY + 1).setValue(actionBy);

    if (newQty === 0 && expiry && expiry < todayStr()) {
      const freshRow = activeSheet.getRange(rowNum, 1, 1, 11).getValues()[0];
      doArchiveRow(activeSheet, archiveSheet, rowNum, freshRow, 'qty=0 and expired');
      return { success: true, newQty: 0, archived: true };
    }

    return { success: true, newQty: newQty, archived: false };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Log a mismatch/flag to Reconciliation Log, adjust inventory qty,
 * and update the Integrity Flagged column.
 * Called only for mismatches or integrity flags during Weekly Check.
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

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const activeSheet = getSheet(ACTIVE_SHEET);
    const reconSheet  = getSheet(RECON_SHEET);
    const rowNum      = findBatchRow(activeSheet, gtin, lot, expiry);

    if (rowNum === -1) return { success: false, error: 'Batch not found in Active Inventory' };

    const row       = activeSheet.getRange(rowNum, 1, 1, 11).getValues()[0];
    const systemQty = Number(row[C.QTY]) || 0;
    const variance  = physicalCount - systemQty;
    const now       = new Date();

    reconSheet.appendRow([
      now, gtin, lot, expiry,
      systemQty, physicalCount, variance,
      reason, adjustedBy,
      integrityStatus,
      location
    ]);

    activeSheet.getRange(rowNum, C.QTY + 1).setValue(physicalCount);
    activeSheet.getRange(rowNum, C.LAST_UPDATED + 1).setValue(now);
    activeSheet.getRange(rowNum, C.INTEGRITY_FLAGGED + 1).setValue(integrityStatus === 'Flagged' ? 'Yes' : '');
    if (adjustedBy) activeSheet.getRange(rowNum, C.ACTION_BY + 1).setValue(adjustedBy);

    return { success: true, systemQty: systemQty, physicalCount: physicalCount, variance: variance };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Batch-log all Weekly Check results to Check History.
 * Fires for every item checked (passes + mismatches) — one row per lot.
 */
function logCheckHistory(params) {
  const checkedBy = String(params.checkedBy || '').trim();
  const rows      = params.rows || [];
  if (rows.length === 0) return { success: true };

  const sheet   = getSheet(HISTORY_SHEET);
  const lastRow = sheet.getLastRow();
  const now     = new Date();

  const newRows = rows.map(r => [
    now,
    String(r.gtin      || '').trim(),
    String(r.name      || '').trim(),
    String(r.location  || '').trim(),
    Number(r.qty)      || 0,
    String(r.integrityStatus || 'OK').trim(),
    checkedBy,
    String(r.notes     || '').trim()
  ]);

  sheet.getRange(lastRow + 1, 1, newRows.length, 8).setValues(newRows);
  return { success: true, logged: newRows.length };
}

/**
 * Set or clear the Back Order flag for an Item Catalog entry.
 * Called from Weekly Check when the checker toggles the back order status.
 */
function setBackOrder(params) {
  const ref   = String(params.ref   || '').trim();
  const value = params.value ? 'Yes' : '';

  if (!ref) return { success: false, error: 'REF is required' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { success: false, error: 'Server busy' };

  try {
    const sheet  = getSheet(CATALOG_SHEET);
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][CC.REF]).trim() === ref) {
        sheet.getRange(i + 1, CC.BACK_ORDER + 1).setValue(value);
        return { success: true };
      }
    }
    return { success: false, error: 'Item not found in catalog' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Set or clear the Retired flag for an Item Catalog entry.
 * Called automatically when a "Do Not Order" item reaches zero stock.
 */
function setRetired(params) {
  const ref     = String(params.ref || '').trim();
  const retired = (params.retired === true || params.retired === 'true' ||
                   String(params.retired || '').toLowerCase() === 'yes') ? 'Yes' : '';

  if (!ref) return { success: false, error: 'REF is required' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { success: false, error: 'Server busy' };

  try {
    const sheet  = getSheet(CATALOG_SHEET);
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][CC.REF]).trim() === ref) {
        sheet.getRange(i + 1, CC.RETIRED + 1).setValue(retired);
        return { success: true };
      }
    }
    return { success: false, error: 'Item not found in catalog' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Set or clear the Count Only flag for an Item Catalog entry.
 * Count-only items are SCM-managed: no lot tracking, weekly count sets qty.
 */
function setCountOnly(params) {
  const ref   = String(params.ref   || '').trim();
  const value = params.value ? 'Yes' : '';

  if (!ref) return { success: false, error: 'REF is required' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { success: false, error: 'Server busy' };

  try {
    const sheet  = getSheet(CATALOG_SHEET);
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][CC.REF]).trim() === ref) {
        sheet.getRange(i + 1, CC.COUNT_ONLY + 1).setValue(value);
        return { success: true };
      }
    }
    return { success: false, error: 'Item not found in catalog' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Set a count-only item's Active Inventory quantity absolutely.
 * Called from Weekly Check for items flagged Count Only. The counted total
 * goes on the item's first inventory row (a lotless row is created if none
 * exists); any additional lot rows are zeroed since lots no longer matter.
 * Every change is logged to the Reconciliation Log.
 */
function setCountedQty(params) {
  const gtin      = String(params.gtin || '').trim();
  const qty       = Number(params.qty);
  const checkedBy = String(params.checkedBy || '').trim();

  if (!gtin)                 return { success: false, error: 'GTIN/REF is required' };
  if (isNaN(qty) || qty < 0) return { success: false, error: 'qty must be a non-negative number' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const activeSheet = getSheet(ACTIVE_SHEET);
    const reconSheet  = getSheet(RECON_SHEET);
    const values      = activeSheet.getDataRange().getValues();
    const now         = new Date();

    const rowNums = [];
    let systemQty = 0;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][C.GTIN]).trim() === gtin) {
        rowNums.push(i + 1);
        systemQty += Number(values[i][C.QTY]) || 0;
      }
    }

    const variance = qty - systemQty;

    if (rowNums.length === 0) {
      // No inventory record yet — create a single lotless row from catalog data
      let name = '', location = '';
      const catValues = getSheet(CATALOG_SHEET).getDataRange().getValues();
      for (let i = 1; i < catValues.length; i++) {
        if (String(catValues[i][CC.REF]).trim() === gtin) {
          name     = String(catValues[i][CC.NAME]     || '').trim();
          location = String(catValues[i][CC.LOCATION] || '').trim();
          break;
        }
      }
      activeSheet.appendRow([gtin, '', '', qty, name, now, now, checkedBy, location, 'Piece', '']);
    } else {
      activeSheet.getRange(rowNums[0], C.QTY + 1).setValue(qty);
      activeSheet.getRange(rowNums[0], C.LAST_UPDATED + 1).setValue(now);
      if (checkedBy) activeSheet.getRange(rowNums[0], C.ACTION_BY + 1).setValue(checkedBy);
      for (let k = 1; k < rowNums.length; k++) {
        activeSheet.getRange(rowNums[k], C.QTY + 1).setValue(0);
        activeSheet.getRange(rowNums[k], C.LAST_UPDATED + 1).setValue(now);
      }
    }

    if (variance !== 0) {
      reconSheet.appendRow([
        now, gtin, '', '',
        systemQty, qty, variance,
        'Weekly check count (count-only item)', checkedBy,
        'OK', ''
      ]);
    }

    return { success: true, systemQty: systemQty, newQty: qty, variance: variance };
  } finally {
    lock.releaseLock();
  }
}

/** Add a new item to the Item Catalog. Returns error if REF already exists. */
function addCatalogItem(params) {
  const ref               = String(params.ref               || '').trim();
  const name              = String(params.name              || '').trim();
  const category          = String(params.category          || 'Consumable').trim();
  const norm              = Number(params.norm)             || 0;
  const orderingUnit      = String(params.orderingUnit      || 'Piece').trim();
  const piecesPerUnit     = Number(params.piecesPerUnit)    || 1;
  const location          = String(params.location          || '').trim();
  const expiryWarningDays = Number(params.expiryWarningDays)|| 14;
  const company           = String(params.company           || '').trim();
  const orderType         = String(params.orderType         || '').trim();
  const retired           = '';  // items never start retired; setRetired sets it explicitly
  const countOnly         = params.countOnly ? 'Yes' : '';

  if (!ref)  return { success: false, error: 'REF is required' };
  if (!name) return { success: false, error: 'Item Name is required' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const sheet  = getSheet(CATALOG_SHEET);
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][CC.REF]).trim() === ref) {
        return { success: false, error: 'An item with this REF already exists' };
      }
    }
    // 13 columns A–M; Back Order (L) starts empty
    sheet.appendRow([ref, name, category, norm, orderingUnit, piecesPerUnit, location,
                     expiryWarningDays, company, orderType, retired, '', countOnly]);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/** Update an existing catalog item by REF. REF itself cannot change. */
function updateCatalogItem(params) {
  const ref               = String(params.ref               || '').trim();
  const name              = String(params.name              || '').trim();
  const category          = String(params.category          || 'Consumable').trim();
  const norm              = Number(params.norm)             || 0;
  const orderingUnit      = String(params.orderingUnit      || 'Piece').trim();
  const piecesPerUnit     = Number(params.piecesPerUnit)    || 1;
  const location          = String(params.location          || '').trim();
  const expiryWarningDays = Number(params.expiryWarningDays)|| 14;
  const company           = String(params.company           || '').trim();
  const orderType         = String(params.orderType         || '').trim();

  if (!ref) return { success: false, error: 'REF is required' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const sheet  = getSheet(CATALOG_SHEET);
    const values = sheet.getDataRange().getValues();
    let rowIdx = -1, rowNum = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][CC.REF]).trim() === ref) { rowIdx = i; rowNum = i + 1; break; }
    }
    if (rowNum === -1) return { success: false, error: 'Item not found in catalog' };

    const existingRetired = String(values[rowIdx][CC.RETIRED] || '').trim();

    sheet.getRange(rowNum, CC.NAME           + 1).setValue(name);
    sheet.getRange(rowNum, CC.CATEGORY       + 1).setValue(category);
    sheet.getRange(rowNum, CC.NORM           + 1).setValue(norm);
    sheet.getRange(rowNum, CC.ORDERING_UNIT  + 1).setValue(orderingUnit);
    sheet.getRange(rowNum, CC.PIECES_PER     + 1).setValue(piecesPerUnit);
    sheet.getRange(rowNum, CC.LOCATION       + 1).setValue(location);
    sheet.getRange(rowNum, CC.EXPIRY_WARNING + 1).setValue(expiryWarningDays);
    sheet.getRange(rowNum, CC.COMPANY        + 1).setValue(company);
    sheet.getRange(rowNum, CC.ORDER_TYPE     + 1).setValue(orderType);
    sheet.getRange(rowNum, CC.RETIRED        + 1).setValue(existingRetired);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Move any Active Inventory row with qty=0 AND an expired date to Archive.
 * Designed to run daily via a time-based trigger.
 */
function archiveSweep() {
  const activeSheet  = getSheet(ACTIVE_SHEET);
  const archiveSheet = getSheet(ARCHIVE_SHEET);
  const values       = activeSheet.getDataRange().getValues();
  const today        = todayStr();
  let archivedCount  = 0;

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
 * Run this ONCE from the Apps Script editor to create a daily archiveSweep trigger.
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
      return i + 1;
    }
  }
  return -1;
}

/**
 * Copy a row to Archive and delete it from Active Inventory.
 * Archive schema: A–K mirror Active Inventory, L = Archived Date, M = Archive Reason.
 */
function doArchiveRow(activeSheet, archiveSheet, rowNum, rowData, reason) {
  const archiveRow = rowData.slice(0, 11).concat([new Date(), reason]);
  archiveSheet.appendRow(archiveRow);
  activeSheet.deleteRow(rowNum);
}

function rowToItem(row) {
  return {
    gtin:             String(row[C.GTIN]).trim(),
    lot:              String(row[C.LOT]).trim(),
    expiry:           normalizeDate(row[C.EXPIRY]),
    qty:              Number(row[C.QTY]) || 0,
    name:             String(row[C.NAME]).trim(),
    dateLogged:       normalizeDateTime(row[C.DATE_LOGGED]),
    lastUpdated:      normalizeDateTime(row[C.LAST_UPDATED]),
    actionBy:         String(row[C.ACTION_BY]).trim(),
    location:         String(row[C.LOCATION]          || '').trim(),
    unit:             String(row[C.UNIT]               || '').trim(),
    integrityFlagged: String(row[C.INTEGRITY_FLAGGED]  || '').trim().toLowerCase() === 'yes'
  };
}

function normalizeDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(val).trim();
}

function normalizeDateTime(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return String(val).trim();
}

function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
