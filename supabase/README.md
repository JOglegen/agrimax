# AgriMax — Deployment Guide

## Repo structure

```
AgriMax_V34.html                        ← Main app (deployed to Netlify)
supabase/
  config.toml                           ← Supabase project config
  functions/
    jdoc_auth/
      index.ts                          ← John Deere OAuth Edge Function
```

## Netlify (frontend)

Netlify watches your GitHub repo and auto-deploys on every push.
Your live URL: https://agrimaxv30.netlify.app/

No build step needed — Netlify serves the HTML file directly.

## Supabase Edge Functions

Edge Functions are NOT auto-deployed from GitHub by default.
You need the Supabase CLI to deploy them.

### One-time CLI setup

```bash
npm install -g supabase
supabase login
```

### Deploy jdoc_auth after any change

```bash
supabase functions deploy jdoc_auth --project-ref dkmfjtfdfuuouhcuhoer
```

### Environment variables (set once in Supabase dashboard)

Go to: supabase.com/dashboard → your project → Edge Functions → Manage secrets

Required secrets for jdoc_auth:
  JDOC_CLIENT_ID       — from John Deere Developer Console
  JDOC_CLIENT_SECRET   — from John Deere Developer Console
  SUPABASE_URL         — auto-set by Supabase
  SUPABASE_SERVICE_ROLE_KEY — auto-set by Supabase

## John Deere Developer Console

App ID: 0oaubxrjowaXbAtqz5d7
Redirect URI must be set to: https://agrimaxv30.netlify.app/

To update: developer.deere.com → your app → Redirect URIs
