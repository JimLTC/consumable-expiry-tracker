# Consumables Expiry Tracker

A web app for tracking medical consumables (implants, drills, screws, etc.) by expiry date and stock level. Runs on any phone — no app installation needed.

**Live app:** https://jimltc.github.io/consumable-expiry-tracker/

---

## What it does

| Tab | Purpose |
|---|---|
| **Scan In** | Scan a barcode (or type manually) to log new stock arriving |
| **Scan Out** | Scan an item before use — shows OK / EXPIRING SOON / EXPIRED status |
| **Dashboard** | Full inventory sorted by soonest expiry, colour-coded |
| **Weekly** | Full shelf-by-shelf audit: confirm integrity and quantity for every item, log only mismatches and flags |
| **Settings** | Set expiry warning window and global low-stock threshold |

Barcode scanning uses the phone camera (photo capture — no live camera feed required) and supports:
- Plain 1D barcodes (EAN, UPC, Code 128) — fills in the product ID
- GS1 Data Matrix — automatically fills in product ID, expiry date, and lot number

---

## Tech stack

| Layer | Technology |
|---|---|
| Front-end | HTML / CSS / JavaScript, hosted on GitHub Pages |
| Backend API | Google Apps Script (deployed as a Web App) |
| Database | Google Sheets |
| Barcode scanner | [html5-qrcode](https://github.com/mebjas/html5-qrcode) library |

---

## Google Sheet structure

The Sheet must have exactly three tabs with these names (case-sensitive):

### `Active Inventory`
| Column | Header | Description |
|---|---|---|
| A | GTIN/Ref | Product ID from barcode |
| B | Lot | Batch/lot number |
| C | Expiry Date | Expiry date (YYYY-MM-DD) |
| D | Quantity | Current stock count |
| E | Item Name | Human-readable name |
| F | Date First Logged | Timestamp of first scan-in |
| G | Last Updated | Timestamp of most recent change |
| H | Last Action By | Who performed the action (optional) |
| I | Min Qty | Per-item low-stock alert threshold (optional — leave blank to use global default) |
| J | Location | Shelf/drawer/cart identifier, e.g. `Shelf 3 / Drawer B` — used to group the weekly checklist in walking-route order (optional) |
| K | Unit | Unit of measure: `Box`, `Piece`, `Carton`, or any custom label — displayed next to Qty everywhere (optional) |

### `Archive`
Same columns as Active Inventory (A–H), plus:
| Column | Header | Description |
|---|---|---|
| I | Archived Date | When the row was moved here |
| J | Archive Reason | e.g. "qty=0 and expired" |
| K | Unit | Unit of measure carried over from Active Inventory at archive time |

### `Reconciliation Log`
| Column | Header | Description |
|---|---|---|
| A | Timestamp | When the check was done |
| B | GTIN/Ref | Product ID |
| C | Lot | Batch/lot number |
| D | Expiry | Expiry date |
| E | System Qty | What the system recorded before adjustment |
| F | Physical Count | What was physically counted |
| G | Variance | Physical − System |
| H | Reason/Note | Required explanation (mandatory for all flagged/adjusted items) |
| I | Adjusted By | Who did the check (optional) |
| J | Integrity Status | `OK` or `Flagged` — records physical condition separate from quantity |
| K | Location | Shelf/drawer where the item was checked |

---

## Initial setup

### Step 1 — Deploy the Apps Script backend

1. Open the Google Sheet → **Extensions → Apps Script**
2. Delete any existing code and paste in the entire contents of `backend/Code.gs`
3. Save (Ctrl+S)
4. Click **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy** and copy the Web App URL

### Step 2 — Connect the front-end to the backend

Open `js/config.js` and replace `YOUR_APPS_SCRIPT_WEB_APP_URL_HERE` with the URL from Step 1:

```js
const API_URL = 'https://script.google.com/macros/s/YOUR_ID_HERE/exec';
```

Commit and push to GitHub.

### Step 3 — Enable GitHub Pages

In the GitHub repo: **Settings → Pages → Branch: `main`, folder: `/` (root) → Save**

The app will be live at `https://<your-username>.github.io/consumable-expiry-tracker/` within a minute or two.

### Step 4 — Set up daily auto-archiving (optional but recommended)

In the Apps Script editor, click **Run → `setupDailyTrigger`** once. This creates a daily job (runs at ~1 AM) that automatically moves any zero-stock expired items to the Archive sheet.

---

## Redeploying after backend changes

When `backend/Code.gs` is updated, the Apps Script deployment must be refreshed:

1. Open the Apps Script editor → **Deploy → Manage deployments**
2. Click the pencil (edit) icon
3. Change version to **New version**
4. Click **Deploy**

The Web App URL does not change — no need to update `config.js`.

---

## Key behaviours

- **Duplicate scan guard:** if the same barcode is scanned twice within 30 seconds, the app prompts before logging it again (prevents accidental double-scans)
- **Expiry override:** logging a past-expiry item shows a warning but allows override (for clearance stock)
- **Negative stock guard:** Scan Out blocks decrementing below zero
- **Auto-archive:** a batch is moved to Archive automatically when its quantity hits 0 AND its expiry date has passed
- **Concurrency lock:** simultaneous scans from two phones cannot corrupt the stock count (Apps Script LockService)
- **Per-item low-stock threshold:** set in the Dashboard's Min Qty column; falls back to the global default in Settings if blank
- **Weekly Check audit trail:** only items where quantity differs or integrity is flagged are logged — items that pass generate no record. Every logged entry requires a written reason before the quantity is adjusted.
- **Weekly Check — scanning is optional:** the checker can proceed through every item without scanning. The per-row scan button is available only when confirming which physical lot is being checked (e.g. two lots of the same item side by side).
- **Weekly Check — location grouping:** items are ordered by their Location column value so the checker can walk one route without backtracking. Items with no location set appear in an "Unassigned" group at the bottom.
- **Filters on Dashboard and Weekly Check:** a filter bar at the top of each screen narrows the visible items by Location (dropdown) and by status chips (Expiring Soon / Expired / Low Stock on Dashboard; Expiring Soon / Low Stock / Flagged on Weekly Check). Filters combine with AND; a Clear button appears whenever any filter is active.
- **Unit of measure:** when logging stock in, the unit (Box / Piece / Carton / Other) is selectable from a dropdown and stored alongside the row. It is shown next to the quantity on the Dashboard, Weekly Check, and Scan Out screens. Existing rows with no unit set simply display the bare number until manually updated.
