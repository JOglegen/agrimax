import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const JDOC_API  = "https://api.deere.com/platform";
const JDOC_BASE = "https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7";
const REDIRECT_URI = "https://agrimaxv30.netlify.app/";

async function getValidToken(supa: any, orgId: string, clientId: string, clientSecret: string): Promise<string | null> {
  const { data: conn } = await supa
    .from("jdoc_connections")
    .select("*")
    .eq("org_id", orgId)
    .single();
  if (!conn) return null;

  const expiresAt = new Date(conn.expires_at).getTime();
  if (expiresAt - Date.now() < 300000) {
    console.log("Token expiring soon — refreshing...");
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
      console.warn("Token refresh failed — using existing token");
      return conn.access_token;
    }
    const tokens = await tokenRes.json();
    await supa.from("jdoc_connections").update({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || conn.refresh_token,
      expires_at:    new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      updated_at:    new Date().toISOString(),
    }).eq("org_id", orgId);
    return tokens.access_token;
  }
  return conn.access_token;
}

async function jdFetch(url: string, token: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.deere.axiom.v3+json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`JD API ${res.status} at ${url}: ${body}`);
  }
  return res.json();
}

// Follow nextPage links — JD defaults to 10 items/page
async function jdFetchAll(firstUrl: string, token: string): Promise<any[]> {
  const allValues: any[] = [];
  let url: string | null = firstUrl;
  let pageCount = 0;
  while (url && pageCount < 50) {
    pageCount++;
    const data = await jdFetch(url, token);
    const values = data.values || [];
    allValues.push(...values);
    const nextLink = (data.links || []).find((l: any) => l.rel === "nextPage");
    url = nextLink?.uri || null;
  }
  return allValues;
}

function findLink(links: any[], rel: string): string | null {
  if (!Array.isArray(links)) return null;
  const link = links.find((l: any) => l.rel === rel);
  return link?.uri || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const clientId     = Deno.env.get("JDOC_CLIENT_ID") ?? "";
    const clientSecret = Deno.env.get("JDOC_CLIENT_SECRET") ?? "";
    const supabaseUrl  = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const body = await req.json();
    const { action, org_id, field_id, jd_org_id } = body;
    console.log("jdoc_data action:", action, "org_id:", org_id);

    const supa = createClient(supabaseUrl, serviceKey);
    const token = await getValidToken(supa, org_id, clientId, clientSecret);
    if (!token) {
      return new Response(JSON.stringify({ error: "No valid John Deere token. Please reconnect." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── list_organizations ────────────────────────────────────────────
    if (action === "list_organizations") {
      const orgs = await jdFetchAll(`${JDOC_API}/organizations`, token);
      return new Response(JSON.stringify({
        organizations: orgs.map((o: any) => ({
          id: o.id, name: o.name, type: o.type, member: o.member, links: o.links,
        }))
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── list_fields ───────────────────────────────────────────────────
    // Strategy: org → farms → fields per farm (captures farm name).
    // Falls back to org → fields directly if farms endpoint fails or
    // returns nothing (some orgs don't use farms).
    if (action === "list_fields") {
      const allOrgs = await jdFetchAll(`${JDOC_API}/organizations`, token);
      console.log(`Found ${allOrgs.length} total orgs`);

      const allFields: any[] = [];
      const errors: string[] = [];

      for (const org of allOrgs) {
        console.log(`Org: ${org.name} (${org.id})`);

        // ── Try farms endpoint first ──────────────────────────────────
        const farmsUrl =
          findLink(org.links, "farms") ||
          `${JDOC_API}/organizations/${org.id}/farms`;

        let farms: any[] = [];
        try {
          farms = await jdFetchAll(farmsUrl, token);
          console.log(`  -> ${farms.length} farms`);
        } catch (e: any) {
          console.warn(`  Farms endpoint failed for org ${org.id}: ${e.message} — will try flat fields`);
        }

        if (farms.length > 0) {
          // ── Fields via farms (preferred — gives farm name) ──────────
          for (const farm of farms) {
            const farmFieldsUrl =
              findLink(farm.links, "fields") ||
              `${JDOC_API}/organizations/${org.id}/farms/${farm.id}/fields`;

            let farmFields: any[] = [];
            try {
              farmFields = await jdFetchAll(farmFieldsUrl, token);
            } catch (e: any) {
              console.warn(`  Fields failed for farm ${farm.id}: ${e.message}`);
              errors.push(`${org.name} / ${farm.name}: ${e.message}`);
              continue;
            }

            console.log(`    Farm "${farm.name}": ${farmFields.length} fields`);

            for (const field of farmFields) {
              allFields.push({
                jd_org_id:        org.id,
                jd_org_name:      org.name,
                jd_farm_id:       farm.id,
                farm_name:        farm.name,
                jd_field_id:      field.id,
                field_name:       field.name,
                acres:            field.area?.valueAsDouble || null,
                boundary_geojson: null,
                links:            field.links,
              });
            }
          }
        } else {
          // ── Fallback: flat fields list (no farm grouping) ───────────
          // Farm name falls back to org name in jdImportSelected.
          const fieldsUrl =
            findLink(org.links, "fields") ||
            `${JDOC_API}/organizations/${org.id}/fields`;

          let fields: any[] = [];
          try {
            fields = await jdFetchAll(fieldsUrl, token);
          } catch (e: any) {
            console.warn(`  Fields failed for org ${org.id}: ${e.message}`);
            errors.push(`${org.name}: ${e.message}`);
            continue;
          }

          console.log(`  -> ${fields.length} fields (flat, no farm)`);

          for (const field of fields) {
            allFields.push({
              jd_org_id:        org.id,
              jd_org_name:      org.name,
              jd_farm_id:       null,
              farm_name:        null,   // will fall back to org name on import
              jd_field_id:      field.id,
              field_name:       field.name,
              acres:            field.area?.valueAsDouble || null,
              boundary_geojson: null,
              links:            field.links,
            });
          }
        }
      }

      console.log(`Total fields across all orgs: ${allFields.length}`);
      return new Response(JSON.stringify({
        fields: allFields,
        count:  allFields.length,
        errors: errors.length > 0 ? errors : undefined,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── get_field_boundary ────────────────────────────────────────────
    if (action === "get_field_boundary") {
      if (!jd_org_id || !field_id) {
        return new Response(JSON.stringify({ error: "jd_org_id and field_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      try {
        const boundaryUrl = `${JDOC_API}/organizations/${jd_org_id}/fields/${field_id}/boundaries`;
        const boundaryData = await jdFetch(boundaryUrl, token);
        const boundaries = boundaryData.values || [];
        const active = boundaries.find((b: any) => b.active) || boundaries[0];
        const geojson = active?.multipolygons?.[0] || null;
        return new Response(JSON.stringify({ boundary_geojson: geojson }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("jdoc_data error:", String(err));
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
