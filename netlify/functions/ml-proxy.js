// netlify/functions/ml-proxy.js
// Reverse-proxy for Midwest Labs REST API — CORS fix for AgriMax V30+

const ALLOWED_PATHS = [
  "/rest/auth",
  "/rest/AutoSubmit/LIMS",
];

const UPSTREAM = {
  production : "https://webservices.midwestlabs.com",
  test       : "https://wstest.midwestlabs.com",
};

exports.handler = async (event) => {

  // ── CORS headers on every response ──────────────────────────────────────
  const corsHeaders = {
    "Access-Control-Allow-Origin" : "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ml-env",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // ── Extract API path ─────────────────────────────────────────────────────
  // Netlify can surface the suffix in different places depending on config.
  // Try event.path first, fall back to the "path" query param as a safety net.
  const rawPath = event.path || "";

  // Strip the function prefix if present, leaving e.g. "/rest/auth"
  const apiPath = rawPath
    .replace(/^\/.netlify\/functions\/ml-proxy/, "")  // strip function base
    .replace(/^\/ml-proxy/, "")                        // strip if redirect added it
    || (event.queryStringParameters?.path ?? "");

  if (!ALLOWED_PATHS.includes(apiPath)) {
    return {
      statusCode: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: `Path not allowed: "${apiPath}". Allowed: ${ALLOWED_PATHS.join(", ")}` }),
    };
  }

  // ── Pick upstream based on x-ml-env header ───────────────────────────────
  const env     = ((event.headers || {})["x-ml-env"] || "test").toLowerCase();
  const baseUrl = UPSTREAM[env] || UPSTREAM.test;
  const upstream = baseUrl + apiPath;

  // ── Forward headers ──────────────────────────────────────────────────────
  const forwardHeaders = { "Content-Type": "application/json" };
  const auth = (event.headers || {})["authorization"];
  if (auth) forwardHeaders["Authorization"] = auth;

  // ── Call Midwest Labs ────────────────────────────────────────────────────
  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, {
      method  : "POST",
      headers : forwardHeaders,
      body    : event.body,
    });
  } catch (networkErr) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Upstream network error: " + networkErr.message }),
    };
  }

  const responseBody = await upstreamRes.text();

  return {
    statusCode : upstreamRes.status,
    headers    : {
      ...corsHeaders,
      "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
    },
    body: responseBody,
  };
};
