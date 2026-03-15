const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const CACHE_TTL_MS = (process.env.CACHE_TTL || 300) * 1000; // default 5 minutes
const MAX_CACHE_SIZE = process.env.MAX_CACHE_SIZE || 100; // max cached responses

// --- In-memory cache ---
const cache = new Map();

function getCacheKey(method, url) {
  return crypto.createHash("sha256").update(`${method}:${url}`).digest("hex");
}

function getCachedResponse(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCachedResponse(key, statusCode, headers, body) {
  // Evict oldest entry if cache is full
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, {
    statusCode,
    headers,
    body,
    timestamp: Date.now(),
  });
}

function isCacheable(method, statusCode) {
  return method === "GET" && statusCode >= 200 && statusCode < 400;
}

// --- Proxy handler ---
function handleRequest(clientReq, clientRes) {
  const targetUrl = clientReq.url;

  // Health check endpoint
  if (targetUrl === "/health") {
    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ status: "ok", cached: cache.size }));
    return;
  }

  // Cache stats endpoint
  if (targetUrl === "/stats") {
    const entries = [];
    for (const [key, val] of cache) {
      const age = Math.round((Date.now() - val.timestamp) / 1000);
      entries.push({ key: key.slice(0, 12) + "...", age_seconds: age });
    }
    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ total: cache.size, entries }));
    return;
  }

  // Validate target URL
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Bad Request: invalid target URL. Use full URL like http://example.com/path");
    return;
  }

  const method = clientReq.method;
  const cacheKey = getCacheKey(method, targetUrl);

  // Check cache for GET requests
  if (method === "GET") {
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT]  ${method} ${targetUrl}`);
      const headers = { ...cached.headers, "X-Prozy-Cache": "HIT" };
      clientRes.writeHead(cached.statusCode, headers);
      clientRes.end(cached.body);
      return;
    }
  }

  console.log(`[CACHE MISS] ${method} ${targetUrl}`);

  // Choose http or https
  const transport = parsed.protocol === "https:" ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: method,
    headers: {
      ...clientReq.headers,
      host: parsed.host,
    },
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    const chunks = [];

    proxyRes.on("data", (chunk) => chunks.push(chunk));

    proxyRes.on("end", () => {
      const body = Buffer.concat(chunks);

      // Cache the response if eligible
      if (isCacheable(method, proxyRes.statusCode)) {
        setCachedResponse(cacheKey, proxyRes.statusCode, proxyRes.headers, body);
      }

      const headers = { ...proxyRes.headers, "X-Prozy-Cache": "MISS" };
      clientRes.writeHead(proxyRes.statusCode, headers);
      clientRes.end(body);
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[ERROR] ${method} ${targetUrl} - ${err.message}`);
    clientRes.writeHead(502, { "Content-Type": "text/plain" });
    clientRes.end(`Bad Gateway: ${err.message}`);
  });

  // Forward request body for POST/PUT etc.
  clientReq.pipe(proxyReq);
}

// --- Start server ---
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║          PROZY - Caching Proxy        ║
  ╠═══════════════════════════════════════╣
  ║  Listening on port: ${String(PORT).padEnd(17)}║
  ║  Cache TTL:         ${String(CACHE_TTL_MS / 1000 + "s").padEnd(17)}║
  ║  Max cache size:    ${String(MAX_CACHE_SIZE).padEnd(17)}║
  ╠═══════════════════════════════════════╣
  ║  Endpoints:                           ║
  ║    /health  - Health check            ║
  ║    /stats   - Cache statistics         ║
  ╚═══════════════════════════════════════╝
  `);
});
