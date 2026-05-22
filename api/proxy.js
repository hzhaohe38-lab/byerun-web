// Edge Function — runs on Vercel Edge Network (Cloudflare), different IP from
// the Express serverless function (AWS). This might bypass Alibaba WAF.
export const config = {
  runtime: 'edge',
};

export default async (req) => {
  const url = new URL(req.url);
  // Original path comes from ?path query param (set by vercel.json rewrite)
  const pathname = url.searchParams.get('path') || url.pathname;

  // Only proxy API paths, not static files
  if (pathname.startsWith('/assets/') || pathname === '/' || pathname === '/favicon.ico' || pathname === '/logo.png') {
    return new Response('Not found', { status: 404 });
  }

  // Remove our ?path= param from the query string before forwarding
  const qs = url.search.replace(/[?&]path=[^&]*/, '').replace(/^&/, '?');
  const backendUrl = 'https://run-lb.tanmasports.com/v1' + pathname + qs;

  // Forward relevant headers
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

    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Credentials': 'true',
    };
    // Copy content-type from backend response
    const contentType = response.headers.get('content-type');
    if (contentType) responseHeaders['content-type'] = contentType;

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return new Response(JSON.stringify({ code: 1, msg: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
};
