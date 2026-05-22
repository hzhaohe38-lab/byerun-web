// Edge Function — runs on Vercel Edge Network (Cloudflare)
export const config = {
  runtime: 'edge',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Credentials': 'true',
};

function corsResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export default async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const pathname = url.searchParams.get('path') || url.pathname;

  // ================================================================
  // Diagnostic endpoint — test what TanMasports actually returns
  // Returns HTML so security software doesn't block it.
  // ================================================================
  if (pathname === '/api/check') {
    const testUrl = 'https://run-lb.tanmasports.com/v1/auth/login/password';
    const testBody = {
      appVersion: '1.8.3',
      password: 'e10adc3949ba59abbe56e057f20f883e',
      userPhone: '13800138000',
      brand: 'Apple',
      deviceToken: '',
      deviceType: '2',
      mobileType: 'iPhone',
      sysVersion: '18.6',
    };

    async function doTest(extraHeaders) {
      const start = Date.now();
      try {
        const r = await fetch(testUrl, {
          method: 'POST',
          headers: {
            'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; SM-S918B Build/UP1A.230905.011)',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'appkey': '389885588s0648fa',
            'sign': 'test123',
            ...extraHeaders,
          },
          body: JSON.stringify(testBody),
        });
        const body = await r.text();
        const hdrs = {};
        r.headers.forEach((v, k) => { hdrs[k] = v; });
        return { status: r.status, statusText: r.statusText, headers: hdrs, bodyPreview: body.substring(0, 1000), timeMs: Date.now() - start, ok: true };
      } catch (e) {
        return { error: e.message, timeMs: Date.now() - start, ok: false };
      }
    }

    const t1 = await doTest({});
    const t2 = await doTest({ 'Accept-Encoding': 'identity' });
    const t3 = await doTest({ 'Origin': 'https://example.com' });
    const t4 = await doTest({ 'Accept': '*/*' });

    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Proxy Diagnostic</title>
<style>body{font-family:monospace;white-space:pre-wrap;background:#1e1e1e;color:#d4d4d4;padding:20px}
.good{color:#4ec9b0}.bad{color:#f44747}.info{color:#9cdcfe}
pre{background:#2d2d2d;padding:10px;border-radius:4px;overflow:auto;max-height:300px}
hr{border-color:#333}</style></head><body>
<h2>Vercel Edge Proxy Diagnostic</h2>
<p class="info">Testing TanMasports connectivity from Vercel Edge network...</p>
<hr>
<h3>Test 1: Standard headers (same as curl)</h3>
<pre>${escapeHtml(JSON.stringify(t1, null, 2))}</pre>
${t1.ok && t1.status === 200 ? '<p class="good">PASS: Got 200 OK</p>' : '<p class="bad">FAIL: Expected 200</p>'}

<h3>Test 2: With Accept-Encoding: identity</h3>
<pre>${escapeHtml(JSON.stringify(t2, null, 2))}</pre>

<h3>Test 3: With explicit Origin header</h3>
<pre>${escapeHtml(JSON.stringify(t3, null, 2))}</pre>

<h3>Test 4: With Accept: */*</h3>
<pre>${escapeHtml(JSON.stringify(t4, null, 2))}</pre>

<hr>
<p class="info">If all tests show status !== 200, Vercel IP is likely blocked by WAF.</p>
<p class="info">If some tests show 200, the headers difference tells us what WAF is checking.</p>
</body></html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ================================================================
  // Static file guard
  // ================================================================
  if (pathname.startsWith('/assets/') || pathname === '/' || pathname === '/favicon.ico' || pathname === '/logo.png') {
    return corsResponse(JSON.stringify({ error: 'not found' }), 404);
  }

  // ================================================================
  // Normal proxy
  // ================================================================
  const qs = url.search.replace(/[?&]path=[^&]*/, '').replace(/^&/, '?');
  const backendUrl = 'https://run-lb.tanmasports.com/v1' + pathname + qs;

  const forwardHeaders = {
    'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; SM-S918B Build/UP1A.230905.011)',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const passthrough = ['content-type', 'appkey', 'sign', 'token'];
  for (const key of passthrough) {
    const val = req.headers.get(key);
    if (val) forwardHeaders[key] = val;
  }

  const body = req.method === 'GET' ? null : await req.text();

  try {
    const response = await fetch(backendUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });

    const responseHeaders = { ...CORS_HEADERS };
    const contentType = response.headers.get('content-type');
    if (contentType) responseHeaders['content-type'] = contentType;

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return corsResponse(JSON.stringify({ code: 1, msg: error.message }), 500);
  }
};
