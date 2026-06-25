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
const ACTIVE_SHEET   = 'Active Inventory';
const ARCHIVE_SHEET  = 'Archive';
const RECON_SHEET    = 'Reconciliation Log';
const CATALOG_SHEET  = 'Item Catalog';

// --- Column indices (0-based) for Active Inventory ---
const C = {
  GTIN:         0,  // A: GTIN/Ref
  LOT:          1,  // B: Lot
  EXPIRY:       2,  // C: Expiry Date
  QTY:          3,  // D: Quantity
  NAME:         4,  // E: Item Name
  DATE_LOGGED:  5,  // F: Date First Logged
  LAST_UPDATED: 6,  // G: Last Updated
  ACTION_BY:    7,  // H: Last Action By
  LOCATION:     8,  // I: Shelf/drawer/cart identifier
  UNIT:         9   // J: Unit of measure (Box / Piece / Carton / …)
};

// --- Column indices (0-based) for Item Catalog ---
const CC = {
  REF:            0,  // A: Ref (matches GTIN/Ref in Active Inventory)
  NAME:           1,  // B: Item Name
  CATEGORY:       2,  // C: Category (Consumable / Implant)
  NORM:           3,  // D: Norm (target stock level, expressed in Ordering Unit)
  ORDERING_UNIT:  4,  // E: Ordering Unit (Box / Piece / Carton / Other)
  PIECES_PER:     5,  // F: Pieces Per Unit (conversion factor)
  LOCATION:       6,  // G: Location (shelf/drawer/cart)
  EXPIRY_WARNING: 7   // H: Expiry Warning Days (default 14)
};

// Archive-only extra columns (appended after Active Inventory columns A–J).
const CA = {
  ARCHIVED_DATE:  10,  // K
  ARCHIVE_REASON: 11   // L
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
      expiryWarningDays: Number(row[CC.EXPIRY_WARNING]) || 14
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
  const row = sheet.getRange(rowNum, 1, 1, 10).getValues()[0];
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
      // Existing batch — increment qty
      const qtyCell = sheet.getRange(rowNum, C.QTY + 1);
      const newQty  = (Number(qtyCell.getValue()) || 0) + qty;
      qtyCell.setValue(newQty);
      sheet.getRange(rowNum, C.LAST_UPDATED + 1).setValue(now);
      if (actionBy)  sheet.getRange(rowNum, C.ACTION_BY + 1).setValue(actionBy);
      if (location)  sheet.getRange(rowNum, C.LOCATION + 1).setValue(location);
      if (unit)      sheet.getRange(rowNum, C.UNIT + 1).setValue(unit);
      return { success: true, action: 'updated', newQty: newQty };
    } else {
      // New batch — append row (10 columns: A–J)
      sheet.appendRow([gtin, lot, expiry, qty, itemName, now, now, actionBy, location, unit]);
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

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const activeSheet  = getSheet(ACTIVE_SHEET);
    const archiveSheet = getSheet(ARCHIVE_SHEET);
    const rowNum = findBatchRow(activeSheet, gtin, lot, expiry);

    if (rowNum === -1) return { success: false, error: 'not_found' };

    const row        = activeSheet.getRange(rowNum, 1, 1, 10).getValues()[0];
    const currentQty = Number(row[C.QTY]) || 0;

    if (currentQty <= 0) return { success: false, error: 'no_stock' };

    const newQty = Math.max(0, currentQty - qty);
    const now    = new Date();

    activeSheet.getRange(rowNum, C.QTY + 1).setValue(newQty);
    activeSheet.getRange(rowNum, C.LAST_UPDATED + 1).setValue(now);
    if (actionBy) activeSheet.getRange(rowNum, C.ACTION_BY + 1).setValue(actionBy);

    // Auto-archive: qty now 0 AND expiry date is already past
    if (newQty === 0 && expiry && expiry < todayStr()) {
      // Read all 10 columns so Location and Unit carry over to the Archive sheet.
      const freshRow = activeSheet.getRange(rowNum, 1, 1, 10).getValues()[0];
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

  const lock = LockService.getScriptLock();
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
    sheet.appendRow([ref, name, category, norm, orderingUnit, piecesPerUnit, location, expiryWarningDays]);
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

  if (!ref) return { success: false, error: 'REF is required' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, error: 'Server busy — please try again' };

  try {
    const sheet  = getSheet(CATALOG_SHEET);
    const values = sheet.getDataRange().getValues();
    let rowNum   = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][CC.REF]).trim() === ref) { rowNum = i + 1; break; }
    }
    if (rowNum === -1) return { success: false, error: 'Item not found in catalog' };

    sheet.getRange(rowNum, CC.NAME           + 1).setValue(name);
    sheet.getRange(rowNum, CC.CATEGORY       + 1).setValue(category);
    sheet.getRange(rowNum, CC.NORM           + 1).setValue(norm);
    sheet.getRange(rowNum, CC.ORDERING_UNIT  + 1).setValue(orderingUnit);
    sheet.getRange(rowNum, CC.PIECES_PER     + 1).setValue(piecesPerUnit);
    sheet.getRange(rowNum, CC.LOCATION       + 1).setValue(location);
    sheet.getRange(rowNum, CC.EXPIRY_WARNING + 1).setValue(expiryWarningDays);
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

/**
 * Copy a row to Archive and delete it from Active Inventory.
 * Archive schema: A–J mirror Active Inventory, K = Archived Date, L = Archive Reason.
 */
function doArchiveRow(activeSheet, archiveSheet, rowNum, rowData, reason) {
  const archiveRow = rowData.slice(0, 10).concat([new Date(), reason]);
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
    location:    String(row[C.LOCATION] || '').trim(),
    unit:        String(row[C.UNIT] || '').trim()
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
