# Consumables Expiry Tracker

A web app for tracking medical consumables (implants, drills, screws, etc.) by expiry date and stock level. Runs on any phone — no app installation needed.

**Live app:** https://jimltc.github.io/consumable-expiry-tracker/

---

## What it does

| Tab | Purpose |
|---|---|
| **In** | Search the Item Catalog to select what you're stocking in, then enter lot, expiry, and quantity |
| **Out** | Search or scan an item before use — shows OK / EXPIRING SOON / EXPIRED status and decrements stock |
| **Dashboard** | Full inventory sorted by soonest expiry, colour-coded cards; tap the pencil icon to edit item details |
| **Weekly** | Full shelf-by-shelf audit: confirm integrity and quantity for every item, log only mismatches and flags |

---

## Tech stack

| Layer | Technology |
|---|---|
| Front-end | HTML / CSS / JavaScript, hosted on GitHub Pages |
| Backend API | Google Apps Script (deployed as a Web App) |
| Database | Google Sheets |

---

## Google Sheet structure

The Sheet must have exactly four tabs with these names (case-sensitive):

### `Active Inventory`
| Column | Header | Description |
|---|---|---|
| A | GTIN/Ref | Product REF matching the Item Catalog |
| B | Lot | Batch/lot number |
| C | Expiry Date | Expiry date (YYYY-MM-DD) |
| D | Quantity | Current stock count (in ordering units) |
| E | Item Name | Human-readable name (copied from Catalog) |
| F | Date First Logged | Timestamp of first stock-in |
| G | Last Updated | Timestamp of most recent change |
| H | Last Action By | Who performed the action (optional) |
| I | Location | Shelf/drawer/cart identifier, e.g. `Shelf 3 / Drawer B` — used to group the weekly checklist and dashboard in walking-route order (optional) |
| J | Unit | Ordering unit carried over from the Item Catalog |

### `Archive`
Same columns as Active Inventory (A–J), plus:
| Column | Header | Description |
|---|---|---|
| K | Archived Date | When the row was moved here |
| L | Archive Reason | e.g. "qty=0 and expired" |

### `Reconciliation Log`
| Column | Header | Description |
|---|---|---|
| A | Timestamp | When the check was done |
| B | GTIN/Ref | Product REF |
| C | Lot | Batch/lot number |
| D | Expiry | Expiry date |
| E | System Qty | What the system recorded before adjustment |
| F | Physical Count | What was physically counted |
| G | Variance | Physical − System |
| H | Reason/Note | Required explanation (mandatory for all flagged/adjusted items) |
| I | Adjusted By | Who did the check (optional) |
| J | Integrity Status | `OK` or `Flagged` — records physical condition separate from quantity |
| K | Location | Shelf/drawer where the item was checked |

### `Item Catalog`
Master list of all products. One row per product reference.
| Column | Header | Description |
|---|---|---|
| A | REF | Unique product reference / barcode ID |
| B | Name | Human-readable item name |
| C | Category | e.g. `Consumable`, `Implant` |
| D | Norm | Normal stocking level (in ordering units) — used for Below Norm alerts |
| E | Ordering Unit | `Piece`, `Box`, `Carton`, or any custom label |
| F | Pieces Per Unit | How many individual pieces are in one ordering unit (default: 1) |
| G | Location | Default shelf/drawer location for this item |
| H | Expiry Warning Days | Days before expiry to start showing the warning (default: 14 if blank) |

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

Open `js/config.js` and replace the placeholder with the URL from Step 1:

```js
const API_URL = 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
```

Commit and push to GitHub.

### Step 3 — Enable GitHub Pages

In the GitHub repo: **Settings → Pages → Branch: `main`, folder: `/` (root) → Save**

The app will be live at `https://<your-username>.github.io/consumable-expiry-tracker/` within a minute or two.

### Step 4 — Populate the Item Catalog

Add one row per product to the `Item Catalog` sheet before your first stock-in. You can also add items directly from the **In** tab by tapping **Add New Item to Catalog** when a search returns no results.

### Step 5 — Set up daily auto-archiving (optional but recommended)

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

- **Catalog-driven stock-in:** items must exist in the Item Catalog before they can be stocked in. If an item is missing, tap **Add New Item to Catalog** on the In tab to create it on the spot.
- **Expiry warning per item:** the Item Catalog's `Expiry Warning Days` column controls when each item turns orange. Defaults to 14 days if left blank.
- **Dashboard cards:** inventory is displayed as colour-coded cards (red = expired, orange = expiring soon, green = OK) with plain-English countdown ("Expires in 3 days"). Tap the pencil icon on any card to edit the item's catalog details.
- **Expiry countdown:** all expiry dates are shown as human-readable text: "Expires today", "Expires in N days", "Expired N days ago", or the absolute date for items far in the future.
- **Duplicate scan guard:** if the same item + lot is scanned in twice within 30 seconds, the app prompts before logging it again (prevents accidental double-scans).
- **Expiry override:** logging a past-expiry item shows a warning but allows override (for clearance stock).
- **Negative stock guard:** Out blocks decrementing below zero.
- **Auto-archive:** a batch is moved to Archive automatically when its quantity hits 0 AND its expiry date has passed.
- **Concurrency lock:** simultaneous scans from two phones cannot corrupt the stock count (Apps Script LockService).
- **Weekly Check audit trail:** only items where quantity differs or integrity is flagged are logged — items that pass generate no record. Every logged entry requires a written reason before the quantity is adjusted.
- **Weekly Check — location grouping:** items are ordered by their lot location so the checker can walk one route without backtracking. Items with no location set appear in an "Unassigned" group at the bottom.
- **Filters on Dashboard:** a filter bar narrows visible items by Location (dropdown) and by status chips (Expiring Soon / Expired / Below Norm). Filters combine with AND; a Clear button appears whenever any filter is active.
- **Filters on Weekly Check:** same filter bar with chips Expired / Expiring Soon / Below Norm / Flagged. Location filter reflects where lots are physically stored (set at scan-in), not the catalog default location.
- **Below Norm alerts:** if the total pieces on hand fall below `Norm × Pieces Per Unit` from the Item Catalog, the item shows a "Below Norm" badge on the Dashboard and Weekly Check.
- **Unit of measure:** the ordering unit (Box / Piece / Carton / Other) is set in the Item Catalog and displayed next to quantities everywhere.
