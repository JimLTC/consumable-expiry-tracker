// =====================================================================
// API wrapper — all calls to the Apps Script backend go through here
// =====================================================================

const api = {
  /**
   * GET request — used for read-only queries (getInventory, lookupBatch).
   * @param {string} action
   * @param {Object} params  key/value pairs appended as query params
   */
  async get(action, params = {}) {
    if (API_URL === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') {
      return { success: false, error: 'API not configured — update API_URL in js/config.js' };
    }
    try {
      const url = new URL(API_URL);
      url.searchParams.set('action', action);
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      const resp = await fetch(url.toString(), { redirect: 'follow' });
      return await resp.json();
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  /**
   * POST request — used for all write operations (scanIn, scanOut, reconcile).
   * Body is sent as plain text (no Content-Type: application/json) to avoid
   * triggering a CORS preflight request, which Apps Script does not handle.
   * @param {string} action
   * @param {Object} data  merged with { action } in the JSON body
   */
  async post(action, data = {}) {
    if (API_URL === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') {
      return { success: false, error: 'API not configured — update API_URL in js/config.js' };
    }
    try {
      const resp = await fetch(API_URL, {
        method:   'POST',
        redirect: 'follow',
        body:     JSON.stringify({ action, ...data })
        // No Content-Type header → browser defaults to text/plain, avoids OPTIONS preflight
      });
      return await resp.json();
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
