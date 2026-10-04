# Home Flow 3.0 Production Data Model

Family -> Members -> Accounts / Projects / Transactions

Transaction:
- id UUID
- family_id
- created_by
- occurred_at
- amount
- category: 食/衣/住/行/育/樂/其他
- nature
- account_id
- project_id
- note
- one_off
- updated_at
- deleted_at

Sync rules:
- local-first write
- IndexedDB outbox
- server revision + updated_at
- tombstone deletes
- deterministic merge by transaction id
- backup snapshots are separate from live sync

Security:
- no database service-role secret in browser
- family access must be authorized server-side
- AI receives analytics summaries, not unrestricted database credentials
