# Consumables Expiry Tracker — Project Spec

## Overview
Web app to track medical consumables (implants, drills, screws, etc.) at the workplace.
Tracks batches (not individual units, unless serialized), expiry, and quantity.
Built to hand off to Claude Code for implementation.

## Stack
- **Front-end:** HTML/JS, hosted on GitHub Pages
- **Backend:** Google Apps Script (web app, deployed as API)
- **Database:** Google Sheets
- **Barcode scanning:** `html5-qrcode` library (camera-based, supports 1D barcodes + QR/Data Matrix)
- **Repo:** new public GitHub repo (e.g. `consumables-expiry-tracker`)

## Barcode handling
Items use either:
- **1D barcode** (Code128/EAN/UPC) — typically only a product ID, no expiry encoded
- **GS1 Data Matrix** (QR-like) — may encode multiple Application Identifiers (AIs):
  - `(01)` GTIN — product ID
  - `(17)` Expiration date
  - `(10)` Batch/Lot number
  - `(21)` Serial number (only present for individually-serialized items, e.g. some implants)

App must attempt to parse GS1 AIs from scanned data. If expiry/lot found, auto-fill those
fields (user confirms). If not found (plain 1D barcode), leave expiry/lot blank for manual entry.
If a serial number AI is present, treat that unit as individually unique rather than part of
a batch count (future enhancement — not required for v1 unless time permits).

## Data model

### Sheet: `Active Inventory`
| Column | Description |
|---|---|
| GTIN/Ref | Product identifier from barcode |
| Lot | Batch/lot number (from barcode or manual entry) |
| Expiry Date | Expiry date (from barcode or manual entry) |
| Quantity | Current count of this ref+lot+expiry batch |
| Item Name | Human-readable name (manual entry, or looked up from a reference list) |
| Date First Logged | Timestamp of first scan-in for this batch |
| Last Updated | Timestamp of most recent scan-in/out |
| Last Action By | Optional — who performed the last action (if user ID added later) |

**Key identity for matching:** GTIN/Ref + Lot + Expiry Date together identify a unique batch row.

### Sheet: `Archive`
Same columns as Active Inventory, plus:
| Column | Description |
|---|---|
| Archived Date | When the row was moved here |
| Archive Reason | e.g. "qty=0 and expired" |

### Sheet: `Reconciliation Log`
| Column | Description |
|---|---|
| Timestamp | When the check was done |
| GTIN/Ref, Lot, Expiry | Which batch |
| System Qty | What the system said before adjustment |
| Physical Count | What was actually counted |
| Variance | Physical − System |
| Reason/Note | Required free-text explanation entered by checker |
| Adjusted By | Optional — who did the count |

## Core functions

### 1. Scan-in (log new stock)
- Scan barcode → parse GS1 AIs if present
- Look up GTIN+Lot+Expiry in Active Inventory:
  - **Match found** → increment Quantity by entered amount, update Last Updated
  - **No match** → create new row, Quantity = entered amount (ask user "how many units?", default 1)
- If expiry not found in barcode → prompt manual entry
  - **Validation:** reject dates already in the past at entry time (warn, allow override if user confirms — e.g. logging soon-to-expire clearance stock)
- **Duplicate-scan guard:** if the exact same barcode was scanned within the last ~30 seconds, prompt "you just logged this — log again?" before proceeding

### 2. Scan-check / Scan-out (use/remove stock)
- Scan barcode → parse GS1 AIs if present
- Look up GTIN+Lot+Expiry in Active Inventory:
  - **Not found** → "Not recognized — log as new item?" fallback to manual entry
  - **Found** → show status:
    - Expired? (Expiry Date < today) → show **"EXPIRED"** + days overdue
    - Not expired → show **"OK"** + days remaining
  - On confirm "use this item": decrement Quantity by 1 (or entered amount)
    - **Negative-quantity guard:** if Quantity is already 0, block the decrement and show "No stock recorded — check physical shelf" instead of going negative
  - **Duplicate-scan guard:** same 30-second check as scan-in, to catch accidental double scan-outs

### 3. Auto-archive
- Triggered in two ways:
  - **Immediately after scan-out**, if resulting Quantity = 0 AND Expiry Date has passed → move row to Archive (reason: "qty=0 and expired")
  - **Daily scheduled sweep** (Apps Script time-trigger) — checks all Active Inventory rows for Quantity = 0 AND Expiry Date < today (catches batches that hit 0 before expiring, then quietly expire later without being scanned again) → move to Archive
- Archived rows are excluded from all scan-check lookups and dashboard views by default

### 4. Expiry dashboard
- Lists Active Inventory items sorted by soonest expiry
- User sets a threshold (e.g. "notify me 14 days before expiry")
- Items within threshold are visually flagged (e.g. highlighted/color-coded)
- In-app only for v1 — no push/email notifications yet (deferred)

### 5. Low-stock alerts
- User sets a low-stock threshold per item (or a global default, e.g. "flag if qty ≤ 2")
- Dashboard separately flags items at/below this threshold, independent of expiry status

### 6. Stock reconciliation
- Manual-trigger function: pulls up Active Inventory list, checker enters physical count per item
- If physical count ≠ system count:
  - **Require a reason/note** before allowing the adjustment (e.g. "used without scanning", "miscount", "found extra box")
  - Log the mismatch (system qty, physical qty, variance, reason, timestamp) to `Reconciliation Log`
  - Only after reason is entered → update Active Inventory Quantity to match physical count
- This is the designated way to handle "stock used but never scanned" drift — not prevented, but caught and logged regularly

## Concurrency safety
- All quantity-modifying functions (scan-in increment, scan-out decrement, reconciliation adjustment)
  must use Apps Script `LockService` to prevent two simultaneous scans from corrupting the count
  (race condition: two people scan-out the last unit at the same time)

## Deferred to later versions
- Push/email notifications for expiry reminders
- Per-user accountability (who scanned what) — timestamp only for now
- Individual serialized-unit tracking (GS1 AI 21) — batch-level tracking is sufficient for v1
- Dedicated scanner hardware support (phone camera only for v1)
