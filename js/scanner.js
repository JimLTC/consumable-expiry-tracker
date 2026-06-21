// =====================================================================
// Camera scanner (html5-qrcode) + GS1 Data Matrix parser
// =====================================================================

let _scanner = null;
let _lastScanErrorLog = 0;  // throttle per-frame error logs (ms timestamp)

/**
 * Open the camera overlay and start scanning.
 * @param {string}   title    Heading shown in the overlay
 * @param {Function} onResult Called with (rawText, parsedGS1) when a code is read
 */
function startScanner(title, onResult) {
  document.getElementById('scanner-title').textContent = title;
  document.getElementById('scanner-overlay').classList.remove('hidden');

  // Explicitly list every format we want — without this, html5-qrcode
  // defaults to QR Code only and ignores 1D barcodes entirely.
  const F = Html5QrcodeSupportedFormats;
  _scanner = new Html5Qrcode('reader', {
    useBarCodeDetectorIfSupported: false,  // force ZXing; iOS BarcodeDetector is unreliable for 1D codes
    verbose: true,                         // log ZXing internals to console for debugging
    formatsToSupport: [
      F.EAN_13,      // standard product barcode (most OTC medicine / consumer goods)
      F.EAN_8,       // short EAN barcode
      F.UPC_A,       // US product barcode
      F.UPC_E,       // compressed UPC
      F.CODE_128,    // GS1-128 used on medical packaging
      F.CODE_39,     // older medical/lab barcodes
      F.DATA_MATRIX, // GS1 DataMatrix (implants, surgical items)
      F.QR_CODE,     // general QR codes
      F.CODABAR,     // Codabar (blood bank, libraries)
      F.ITF          // Interleaved 2-of-5 (cartons, logistics)
    ]
  });

  // Log available cameras to aid debugging
  Html5Qrcode.getCameraDevices().then((devices) => {
    console.log('[scanner] cameras:', devices.map(d => d.label));
  });

  const videoConstraints = { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } };
  const qrboxFn = (vw, vh) => ({
    width:  Math.min(Math.round(vw * 0.90), 600),   // 90% of viewfinder, max 600px
    height: Math.min(Math.round(vh * 0.38), 220)    // 38% of viewfinder, max 220px
  });
  console.log('[scanner] start — constraints:', videoConstraints, '| qrbox: fn(vw,vh)→90%/600 × 38%/220');
  _scanner.start(
    videoConstraints,
    // Wide, short box fn: 90% wide / 38% tall, capped at 600×220px
    { fps: 15, qrbox: qrboxFn },
    (decoded) => {
      console.log('[scanner] decoded:', decoded);
      stopScanner();
      onResult(decoded, parseBarcode(decoded));
    },
    (err) => {  // per-frame errors: log throttled to once per 3s
      const now = Date.now();
      if (now - _lastScanErrorLog > 3000) {
        console.log('[scanner] frame error:', err);
        _lastScanErrorLog = now;
      }
    }
  ).catch((err) => {
    stopScanner();
    showToast('Camera error: ' + err, 'error');
  });

  document.getElementById('btn-stop-scan').onclick = () => stopScanner();
}

function stopScanner() {
  document.getElementById('scanner-overlay').classList.add('hidden');
  if (_scanner) {
    _scanner.stop().then(() => _scanner.clear()).catch(() => {});
    _scanner = null;
  }
}

// =====================================================================
// GS1 Data Matrix parser
//
// GS1 barcodes encode multiple fields called "Application Identifiers" (AIs):
//   (01) GTIN — the product code (14 digits)
//   (17) Expiry date — YYMMDD
//   (10) Lot / batch number (variable length)
//   (21) Serial number (variable length, not used in v1)
//
// Two common formats returned by scanners:
//   Parenthesized: "(01)12345678901234(17)260531(10)LOT123"
//   Raw GS1:       "0112345678901234\x1d17260531\x1d10LOT123"
//                   where \x1d (ASCII 29) is the field separator
// =====================================================================

const FNC1 = '\x1d'; // GS1 field separator character

/**
 * Parse a raw barcode string and extract GS1 fields where present.
 * Returns { gtin, lot, expiry, serial } — any field may be empty string.
 */
function parseBarcode(raw) {
  if (!raw) return emptyResult();

  // Strip GS1 DataMatrix symbology identifier prefixes (]d0, ]d1, ]d2, ]C1, ]e0)
  let str = raw.replace(/^\]([dCe][012])/,'');

  // Strip leading FNC1 if present (some decoders include it)
  str = str.replace(/^\x1d/, '');

  // Detect parenthesized format: any "(nn)" pattern
  if (/\(\d{2,4}\)/.test(str)) {
    return parseParenthesized(str);
  }

  // Detect raw GS1: starts with a known fixed-length AI or contains FNC1
  if (/^0[12]\d{14}/.test(str) || str.includes(FNC1)) {
    return parseRawGS1(str);
  }

  // Plain 1D barcode (EAN, UPC, Code128 with just a product code)
  return { gtin: str.trim(), lot: '', expiry: '', serial: '' };
}

function emptyResult() {
  return { gtin: '', lot: '', expiry: '', serial: '' };
}

/** Parse parenthesized format: (01)...(17)...(10)... */
function parseParenthesized(str) {
  const result = emptyResult();
  const re = /\((\d{2,4})\)([^(]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const ai  = m[1];
    const val = m[2].trim();
    if      (ai === '01' || ai === '02') result.gtin   = val;
    else if (ai === '17')                result.expiry  = gs1DateToISO(val);
    else if (ai === '10')                result.lot     = val;
    else if (ai === '21')                result.serial  = val;
  }
  return result;
}

/**
 * Parse raw GS1 string with FNC1 (\x1d) as separator between variable-length fields.
 * Fixed-length AIs (01 = 14 digits, 17 = 6 digits) don't need a separator after them.
 */
function parseRawGS1(str) {
  const result = emptyResult();
  let pos = 0;

  while (pos < str.length) {
    if (pos + 2 > str.length) break;
    const ai = str.substr(pos, 2);
    pos += 2;

    if (ai === '01' || ai === '02') {
      result.gtin = str.substr(pos, 14);
      pos += 14;
    } else if (ai === '17') {
      result.expiry = gs1DateToISO(str.substr(pos, 6));
      pos += 6;
    } else if (ai === '20') {
      pos += 2;  // fixed-length 2-digit field; step over it
    } else if (ai === '10' || ai === '21') {
      // Variable-length field: read until next FNC1 or end of string
      const end = str.indexOf(FNC1, pos);
      const val = end === -1 ? str.substring(pos) : str.substring(pos, end);
      if (ai === '10') result.lot    = val;
      else             result.serial = val;
      pos = end === -1 ? str.length : end + 1;
    } else {
      // Unknown AI — skip ahead to the next field separator
      const next = str.indexOf(FNC1, pos);
      if (next === -1) break;
      pos = next + 1;
    }
  }
  return result;
}

/**
 * Convert a GS1 date (YYMMDD) to ISO format (YYYY-MM-DD).
 * GS1 rule: YY 00–49 → 20YY, YY 50–99 → 19YY.
 * DD = 00 means the last day of the given month (per GS1 spec).
 */
function gs1DateToISO(yymmdd) {
  if (!yymmdd || yymmdd.length !== 6) return '';
  const yy   = parseInt(yymmdd.slice(0, 2), 10);
  const mm   = yymmdd.slice(2, 4);
  const dd   = yymmdd.slice(4, 6);
  const year = yy < 50 ? 2000 + yy : 1900 + yy;

  if (dd === '00') {
    // Last day of the month
    const lastDay = new Date(year, parseInt(mm, 10), 0).getDate();
    return `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
  }
  return `${year}-${mm}-${dd}`;
}
