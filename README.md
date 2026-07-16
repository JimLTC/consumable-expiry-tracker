# Consumables Expiry Tracker

A mobile-first web app for tracking medical consumables (implants, drills, screws, sutures, etc.) by expiry date and stock level. Built for clinical teams: runs in any phone browser, no app installation, no login friction — open it, record stock, done.

> This is an internal tool. The app link, database access and operational guides are distributed to the care team separately and are not part of this repository.

---

## What it does

| Tab | Purpose |
|---|---|
| **In** | Record incoming stock: pick the item from the catalog, enter lot, expiry and quantity. Logging several lots of the same delivery takes one item selection. |
| **Out** | Record stock taken for use — lots are listed earliest-expiry first to encourage first-expired-first-out. |
| **Dashboard** | Live stock overview: colour-coded cards (expired / expiring soon / below target), plain-English expiry countdowns, per-device customisable layout. |
| **Weekly Check** | Shelf-by-shelf physical count, grouped by location in walking order. The counted number becomes the official stock figure, and the app builds the reorder report automatically. |
| **History** | Every past weekly check, collapsible by session, with integrity flags and search. |

---

## Feature highlights

- **Count-based weekly check** — staff type what they actually count (in boxes *or* pieces, the app converts); stock status (OK / Low / Out) is derived, never guessed.
- **Inventory self-heals** — weekly counts update the stock records in both directions, with every adjustment written to an audit log. Shortfalls are deducted from the earliest-expiring lots first.
- **Automatic reorder report** — after each check, items below target are grouped by ordering channel with exact order quantities and one-tap copy to clipboard.
- **Expiry intelligence** — per-item warning windows, human-readable countdowns ("Expires in 3 days"), automatic archiving of finished expired batches.
- **Lifecycle automation** — discontinued items retire themselves at zero stock; back-ordered items hide from the weekly check and reappear when stock arrives; SCM-managed items can skip lot tracking entirely.
- **Built for two phones at once** — server-side locking prevents simultaneous scans from corrupting counts.
- **Full audit trail** — who stocked in, who took out, who counted, what changed and why.

---

## Tech stack

| Layer | Technology |
|---|---|
| Front-end | Plain HTML / CSS / JavaScript — no frameworks, no build step |
| Hosting | GitHub Pages (static) |
| Backend API | Google Apps Script web app |
| Database | Google Sheets |

The entire stack runs on free tiers and requires no servers to maintain.

---

## Repository layout

```
index.html        App shell and all five tabs
css/styles.css    Styling (mobile-first)
js/app.js         Application logic
js/config.js      API endpoint configuration (placeholder — real endpoint is private)
js/api.js         Fetch wrapper for the backend
backend/Code.gs   Reference copy of the Google Apps Script backend
```

---

## Documentation

End-user and data-administration guides (with screenshots) are maintained as separate documents and distributed internally — they are intentionally not published in this repository.
