# Home Flow 3.0 Deployment Checklist

This file is for deployment automation/maintenance, not normal users.

1. Create Cloudflare D1 database named `home-flow`.
2. Replace `REPLACE_AFTER_D1_CREATE` in `wrangler.jsonc` with the returned database id.
3. Run `npm install`.
4. Run `npm run db:init:remote`.
5. Run `npm run deploy`.
6. Open `/api/health` and confirm `{"ok":true}`.
7. Load the web app; confirm a Family is created and an encrypted snapshot is stored.
8. Open on a second browser using the invite URL and verify two-way changes.
9. Verify offline entry → reconnect → automatic sync.
10. Verify Backups API and restore on test data.
11. Only after all checks pass, add the one-click migration bridge to the current GitHub Pages app.

Never put the family access token or encryption key in source code, D1 schema, logs, or build-time environment variables.
