import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JDOC_BASE = "https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7";
const JDOC_API  = "https://sandboxapi.deere.com/platform";
const REDIRECT_URI = "https://agrimaxv30.netlify.app/";
const SCOPES = "ag1 ag2 ag3 files offline_access openid profile";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const clientId     = Deno.env.get("JDOC_CLIENT_ID") ?? "";
    const clientSecret = Deno.env.get("JDOC_CLIENT_SECRET") ?? "";
    const supabaseUrl  = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const { action, code, state, org_id, user_id } = await req.json();
    console.log("jdoc_auth action:", action);

    // ── ACTION: get_auth_url ──────────────────────────────────────────
    // Returns the John Deere authorization URL for the browser to redirect to.
    if (action === "get_auth_url") {
      const stateParam = btoa(JSON.stringify({ org_id, user_id, ts: Date.now() }));
      const params = new URLSearchParams({
        response_type: "code",
        client_id:     clientId,
        redirect_uri:  REDIRECT_URI,
        scope:         SCOPES,
        state:         stateParam,
      });
      const url = `${JDOC_BASE}/v1/authorize?${params.toString()}`;
      return new Response(JSON.stringify({ url, state: stateParam }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ACTION: exchange_code ─────────────────────────────────────────
    // Exchanges the authorization code for tokens and stores them in Supabase.
    if (action === "exchange_code") {
      if (!code) {
        return new Response(JSON.stringify({ error: "No code provided" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Decode state to get org_id and user_id
      let stateData: any = {};
      try { stateData = JSON.parse(atob(state)); } catch(_) {}

      // Exchange code for tokens
      const tokenRes = await fetch(`${JDOC_BASE}/v1/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
        },
        body: new URLSearchParams({
          grant_type:   "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        console.error("Token exchange failed:", err);
        return new Response(JSON.stringify({ error: "Token exchange failed: " + err }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tokens = await tokenRes.json();
      console.log("Tokens received, expires_in:", tokens.expires_in);

      // Store tokens in Supabase
      const supa = createClient(supabaseUrl, serviceKey);
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      const { error: upsertErr } = await supa
        .from("jdoc_connections")
        .upsert({
          org_id:        stateData.org_id || org_id,
          user_id:       stateData.user_id || user_id,
          access_token:  tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at:    expiresAt,
          scope:         tokens.scope,
          updated_at:    new Date().toISOString(),
        }, { onConflict: "org_id" });

      if (upsertErr) {
        console.error("Store tokens failed:", upsertErr.message);
        return new Response(JSON.stringify({ error: "Failed to store tokens: " + upsertErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ACTION: refresh_token ─────────────────────────────────────────
    if (action === "refresh_token") {
      const supa = createClient(supabaseUrl, serviceKey);
      const { data: conn, error: connErr } = await supa
        .from("jdoc_connections")
        .select("*")
        .eq("org_id", org_id)
        .single();

      if (connErr || !conn) {
        return new Response(JSON.stringify({ error: "No John Deere connection found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tokenRes = await fetch(`${JDOC_BASE}/v1/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
        },
        body: new URLSearchParams({
          grant_type:    "refresh_token",
          refresh_token: conn.refresh_token,
          redirect_uri:  REDIRECT_URI,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        return new Response(JSON.stringify({ error: "Refresh failed: " + err }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tokens = await tokenRes.json();
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      await supa.from("jdoc_connections").update({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token || conn.refresh_token,
        expires_at:    expiresAt,
        updated_at:    new Date().toISOString(),
      }).eq("org_id", org_id);

      return new Response(JSON.stringify({ success: true, access_token: tokens.access_token }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ACTION: get_status ────────────────────────────────────────────
    if (action === "get_status") {
      const supa = createClient(supabaseUrl, serviceKey);
      const { data: conn } = await supa
        .from("jdoc_connections")
        .select("org_id, expires_at, scope, updated_at")
        .eq("org_id", org_id)
        .single();

      return new Response(JSON.stringify({ connected: !!conn, connection: conn || null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ACTION: disconnect ────────────────────────────────────────────
    if (action === "disconnect") {
      const supa = createClient(supabaseUrl, serviceKey);
      await supa.from("jdoc_connections").delete().eq("org_id", org_id);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("jdoc_auth error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
