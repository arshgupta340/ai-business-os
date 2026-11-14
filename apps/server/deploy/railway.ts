// Railway Infrastructure as Code for the AI Business OS server. OPTIONAL.
//
// Railway's older per-service file (railway.json / railway.toml, "Config as
// Code") is deprecated: new services cannot opt into it, and it stops working
// for existing services on 2026-12-01 (docs.railway.com/reference/config-as-code,
// checked 2026-11-13). Its replacement is this TypeScript file.
//
// The simplest path is the dashboard (docs/DEPLOY.md, Part 2). Use this file
// only if you want the settings in code. To use it:
//   1. Copy it to .railway/railway.ts at the repo root (Railway reads it there).
//   2. npm install railway   (the SDK that provides "railway/iac"; not a repo dependency yet)
//   3. railway login, railway link, then railway config plan, then railway config apply.
//
// Documented options used below: source github(...), start, healthcheck,
// healthcheckTimeout, env with preserve() (keep the value already set in
// Railway, so no secret is written here). The Dockerfile path is set with the
// RAILWAY_DOCKERFILE_PATH service variable (docs.railway.com/builds/dockerfiles).
// The IaC reference does not document a builder or restart-policy option, so
// none is set here. Not verified with a real `railway config plan` run.
//
// DATABASE_ADMIN_URL is deliberately absent. The owner connection is for
// migrations and the reset script only and must never be set on the host (D-10).

import { defineRailway, github, preserve, project, service } from 'railway/iac';

export default defineRailway(() => {
  const server = service('abos-server', {
    // Repo root is the source: the server imports packages/ (npm workspaces).
    source: github('arshgupta340/ai-business-os', { branch: 'main' }),
    start: 'npm run start -w @abos/server',
    healthcheck: '/health',
    healthcheckTimeout: 60,
    env: {
      RAILWAY_DOCKERFILE_PATH: '/apps/server/deploy/Dockerfile',
      PORT: '4000',
      SQUARE_ENVIRONMENT: 'sandbox',

      // Database (restricted abos_app login through the Supabase session pooler)
      DATABASE_URL: preserve(),
      SUPABASE_URL: preserve(),
      SUPABASE_ANON_KEY: preserve(),
      SUPABASE_SERVICE_ROLE_KEY: preserve(),

      // OpenAI
      OPENAI_API_KEY: preserve(),
      OPENAI_BUILDER_MODEL: preserve(),
      OPENAI_REALTIME_MODEL: preserve(),

      // Square sandbox
      SQUARE_ACCESS_TOKEN: preserve(),
      SQUARE_LOCATION_ID: preserve(),
      SQUARE_WEBHOOK_SIGNATURE_KEY: preserve(),
      SQUARE_WEBHOOK_URL: preserve(),

      // Twilio voice
      TWILIO_ACCOUNT_SID: preserve(),
      TWILIO_AUTH_TOKEN: preserve(),
      TWILIO_PHONE_NUMBER: preserve(),

      // Message channel: set MESSAGE_CHANNEL and only that channel's keys
      MESSAGE_CHANNEL: preserve(),
      SURGE_API_KEY: preserve(),
      ANDROID_GATEWAY_URL: preserve(),
      ANDROID_GATEWAY_API_KEY: preserve(),
      TWILIO_WHATSAPP_FROM: preserve(),

      // Google
      GOOGLE_SERVICE_ACCOUNT_JSON: preserve(),
      GOOGLE_CALENDAR_ID: preserve(),
      GOOGLE_SHEET_ID: preserve(),

      // This service's own https address (Settings, Networking, Generate Domain)
      PUBLIC_SERVER_URL: preserve(),
    },
  });

  return project('ai-business-os', { resources: [server] });
});
