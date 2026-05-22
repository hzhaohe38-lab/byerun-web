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
  // ================================================================
  if (pathname === '/api/proxy-test') {
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

    // Test 1: exact same as working curl
    const t1start = Date.now();
    let t1, t2, t3;
    try {
      const r1 = await fetch(testUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; SM-S918B Build/UP1A.230905.011)',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'appkey': '389885588s0648fa',
          'sign': 'test123',
        },
        body: JSON.stringify(testBody),
      });
      const t1body = await r1.text();
      const t1headers = {};
      r1.headers.forEach((v, k) => { t1headers[k] = v; });
      t1 = { status: r1.status, statusText: r1.statusText, headers: t1headers, bodyPreview: t1body.substring(0, 2000), timeMs: Date.now() - t1start };
    } catch (e) { t1 = { error: e.message, timeMs: Date.now() - t1start }; }

    // Test 2: without Accept header
    const t2start = Date.now();
    try {
      const r2 = await fetch(testUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; SM-S918B Build/UP1A.230905.011)',
          'Content-Type': 'application/json',
          'appkey': '389885588s0648fa',
          'sign': 'test123',
        },
        body: JSON.stringify(testBody),
      });
      const t2body = await r2.text();
      const t2headers = {};
      r2.headers.forEach((v, k) => { t2headers[k] = v; });
      t2 = { status: r2.status, statusText: r2.statusText, headers: t2headers, bodyPreview: t2body.substring(0, 2000), timeMs: Date.now() - t2start };
    } catch (e) { t2 = { error: e.message, timeMs: Date.now() - t2start }; }

    // Test 3: with explicit Accept-Encoding: identity
    const t3start = Date.now();
    try {
      const r3 = await fetch(testUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; SM-S918B Build/UP1A.230905.011)',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'identity',
          'appkey': '389885588s0648fa',
          'sign': 'test123',
        },
        body: JSON.stringify(testBody),
      });
      const t3body = await r3.text();
      const t3headers = {};
      r3.headers.forEach((v, k) => { t3headers[k] = v; });
      t3 = { status: r3.status, statusText: r3.statusText, headers: t3headers, bodyPreview: t3body.substring(0, 2000), timeMs: Date.now() - t3start };
    } catch (e) { t3 = { error: e.message, timeMs: Date.now() - t3start }; }

    return corsResponse(JSON.stringify({ test1: t1, test2: t2, test3: t3 }, null, 2));
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
