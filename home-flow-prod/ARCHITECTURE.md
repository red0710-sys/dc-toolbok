# Home Flow 3.0 Production Architecture

## Decision

Home Flow remains a **web app**. The production stack is intentionally one-platform:

- Cloudflare Workers Static Assets — serves the website/PWA
- Cloudflare Worker API — same-origin sync API
- Cloudflare D1 — encrypted snapshot metadata/chunks
- Browser local copy — immediate/offline use
- AES-GCM + gzip — client-side encryption/compression
- TinyFish — QA/browser operation only; never a runtime dependency

No Vercel, Supabase, Firebase, login provider, or realtime WebSocket is required for the household use case.

## Why encrypted snapshots instead of row-per-transaction SQL

The server should not need to read financial details. Splitting encrypted finance data into thousands of relational rows increases sync/conflict logic without improving the product.

The browser owns the usable data model:

- settings
- transaction overrides/new entries
- tombstones
- analysis engine state

The cloud stores an opaque encrypted snapshot.

The bundled 2019–2026 historical ledger remains encrypted static data; the cloud snapshot stores additions/edits/deletes and settings. This keeps sync payloads small.

## Sync protocol

1. User action updates local in-memory/local browser copy immediately.
2. Before a cloud write, the client pulls the latest snapshot.
3. Local and remote data are deterministically merged by entry id / updatedAt / tombstones.
4. The merged JSON is gzip-compressed when supported.
5. The compressed bytes are AES-GCM encrypted in the browser.
6. The encrypted envelope is split into chunks below D1's single-row size limit.
7. Client writes with baseVersion.
8. Worker accepts only when baseVersion equals the current family version.
9. A 409 conflict causes pull → merge → retry.
10. Foreground/visibility sync runs periodically; no WebSocket dependency.

## Family access

The Worker creates:

- familyId — non-secret identifier
- accessToken — authorization secret; server stores only SHA-256(token)
- encryptionKey — generated in the browser and never sent to the server

A family invite URL stores the access token and encryption key in the URL fragment. Fragments are not sent in HTTP requests.

The two devices access the same family snapshot.

## Backup

Sync and backup are separate concepts.

- Current snapshot: latest family state
- Daily backup: first previous state retained each Taiwan calendar day
- Retention: 30 days
- D1 Time Travel: additional platform-level recovery
- Local JSON/CSV export remains available

A scheduled Worker cleans backups older than 30 days and orphaned conflict snapshots.

## Security boundaries

- No finance plaintext is written to D1.
- No encryption key is written to D1.
- No third-party script is required by the production web app.
- CSP restricts scripts/network access to same-origin.
- API and static app share one origin.
- AI calculations use decrypted browser data; a future external LLM should receive aggregates, not unrestricted raw ledger data.

## Migration strategy

The existing GitHub Pages Home Flow stays untouched until production passes all checks.

Cutover sequence:

1. Deploy Cloudflare production in parallel.
2. Verify PWA/static assets/API/D1/backups.
3. Add one-click migration bridge to the old Home Flow.
4. Transfer history unlock key plus local overrides through a user-initiated browser flow.
5. Compare counts and totals between old and new.
6. Run both in parallel for a short verification period.
7. Make the new URL canonical only after reconciliation passes.

Rollback is always possible because the existing Home Flow remains unchanged during migration.
