// Copy this module into the existing Cloudflare Worker. See TURN_SETUP.md.
const ALLOWED_ORIGINS = [
  'https://synccopypaste.app',
  'https://joeltre.github.io',
  'http://localhost:8004',
];
const FALLBACK = [{urls: 'stun:stun.l.google.com:19302'}];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
      ...(allowed ? {'Access-Control-Allow-Origin': origin} : {}),
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: {...headers, 'Content-Type': 'application/json'},
    });
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
    if (!allowed) return json({error: 'Forbidden'}, 403);
    if (new URL(request.url).pathname === '/analytics/history' && request.method === 'GET') {
      if (!env.ANALYTICS_DB) return json({error:'Analytics unavailable'}, 503);
      if (env.TURN_RATE_LIMITER) {
        try { const ip = request.headers.get('CF-Connecting-IP'); if (!ip || !(await env.TURN_RATE_LIMITER.limit({key:'analytics-read:' + ip})).success) return json({error:'Too many requests'}, 429); }
        catch { return json({error:'Service unavailable'}, 503); }
      }
      try {
        const result = await env.ANALYTICS_DB.prepare("SELECT day, metric, value FROM analytics_daily WHERE day >= date('now', '-89 days') AND day <= date('now') ORDER BY day, metric").all();
        return json({rows: result.results});
      } catch { return json({error:'Analytics unavailable'}, 503); }
    }
    if (new URL(request.url).pathname === '/analytics/summary' && request.method === 'GET') {
      if (!env.ANALYTICS_DB) return json({error:'Analytics unavailable'}, 503);
      if (env.TURN_RATE_LIMITER) {
        try { const ip = request.headers.get('CF-Connecting-IP'); if (!ip || !(await env.TURN_RATE_LIMITER.limit({key:'analytics-read:' + ip})).success) return json({error:'Too many requests'}, 429); }
        catch { return json({error:'Service unavailable'}, 503); }
      }
      try {
        const result = await env.ANALYTICS_DB.prepare('SELECT metric, SUM(value) AS value FROM analytics_daily GROUP BY metric').all();
        const metrics = Object.fromEntries(result.results.map(row => [row.metric, row.value]));
        return json({metrics});
      } catch { return json({error:'Analytics unavailable'}, 503); }
    }
    if (new URL(request.url).pathname === '/analytics' && request.method === 'POST') {
      if (!env.ANALYTICS_DB) return json({error:'Analytics unavailable'}, 503);
      if (Number(request.headers.get('Content-Length') || 0) > 4096) return json({error:'Too large'}, 413);
      if (env.TURN_RATE_LIMITER) {
        try { const ip = request.headers.get('CF-Connecting-IP'); if (!ip || !(await env.TURN_RATE_LIMITER.limit({key:'analytics:' + ip})).success) return json({error:'Too many requests'}, 429); }
        catch { return json({error:'Service unavailable'}, 503); }
      }
      try {
        const raw = await request.text();
        if (raw.length > 4096) return json({error:'Too large'}, 413);
        const body = JSON.parse(raw);
        const metrics = new Set(['pairs','connection_attempts','connections','opt_outs','rtt_sum_ms','rtt_samples', ...['shared','explorer','clipboard'].flatMap(c => [`${c}_files`,`${c}_bytes`,`${c}_timed_bytes`,`${c}_milliseconds`])]);
        if (!body || !/^[0-9a-f-]{36}$/i.test(body.id) || !body.counters || typeof body.counters !== 'object' || Array.isArray(body.counters) || !Object.keys(body.counters).length || Object.entries(body.counters).some(([k,v]) => !metrics.has(k) || !Number.isFinite(v) || v < 0 || v > 1e15)) return json({error:'Invalid report'}, 400);
        await env.ANALYTICS_DB.prepare('INSERT OR IGNORE INTO analytics_batches (id, counters) VALUES (?, ?)').bind(body.id, JSON.stringify(body.counters)).run();
        return json({ok:true});
      } catch { return json({error:'Analytics unavailable'}, 503); }
    }
    if (request.method !== 'GET') return json({error: 'Forbidden'}, 403);

    // Optional binding: configure TURN_RATE_LIMITER in Cloudflare (see TURN_SETUP.md).
    // IP-based limits are approximate and can affect users sharing a network.
    if (env.TURN_RATE_LIMITER) {
      try {
        const ip = request.headers.get('CF-Connecting-IP');
        if (!ip || !(await env.TURN_RATE_LIMITER.limit({key: ip})).success) {
          console.warn(JSON.stringify({event: 'turn_rate_limited'}));
          return json({error: 'Too many requests'}, 429);
        }
      } catch {
        console.error(JSON.stringify({event: 'turn_rate_limiter_error'}));
        return json({error: 'Service unavailable'}, 503);
      }
    } else {
      console.warn(JSON.stringify({event: 'turn_rate_limiter_not_configured'}));
    }

    try {
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) throw new Error('turn_not_configured');
      const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({ttl: 86400}),
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) throw new Error(`upstream_status_${response.status}`);
      const {iceServers} = await response.json();
      const hasTurn = Array.isArray(iceServers) && iceServers.some(server =>
        (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url =>
          typeof url === 'string' && /^turns?:/i.test(url)));
      if (!hasTurn) throw new Error('invalid_or_missing_turn_servers');
      console.log(JSON.stringify({event: 'turn_credentials_success'}));
      return json({iceServers, turnAvailable: true});
    } catch (error) {
      // Do not log the request URL, TURN key token, response body, or TURN credentials.
      const reason = /^upstream_status_\d+$/.test(error.message) ? error.message :
        ['invalid_or_missing_turn_servers', 'turn_not_configured'].includes(error.message) ? error.message : 'upstream_unavailable';
      console.error(JSON.stringify({event: 'turn_credentials_fallback', reason}));
      return json({iceServers: FALLBACK, turnAvailable: false});
    }
  },
};
