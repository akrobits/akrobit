# Akrobit Credit Cash — Security Specification

## 1. Data Invariants
1. **Authentication & Verification:** Every read/write operation requires `request.auth != null` and `request.auth.token.email_verified == true`.
2. **RBAC / No Self-Admin Escalation:** Only `akrobits@gmail.com` (verified) or UIDs present in `/admins/{uid}` have administrator privileges. Standard registration at `/users/{uid}` is strictly locked to `role == 'employee'` and `active == true`; users cannot escalate their own `role` or `active` status.
3. **PII Isolation:** User email addresses are isolated in `/users/{userId}/private/{docId}` readable only by the owner or an administrator.
4. **Path & Size Hardening:** All document IDs are validated by `isValidId(id)` (`^[a-zA-Z0-9_-]+$`, `<= 128`). All strings have strict `.size()` bounds.
5. **Temporal Integrity:** `createdAt` and `updatedAt` must match `request.time` on creation/update; `createdAt` and `createdBy` are immutable after creation.
6. **Employee Modification Gate:** Employees cannot directly overwrite existing `credits` amounts/rates or alter `transactions`; they can only submit a `ModificationRequest` (`status == 'pending'`, `requestedBy == request.auth.uid`). Only an administrator can approve, reject, or directly correct records.
7. **Ledger Immutability:** `transactions` documents are append-only for employees (`allow update, delete: if isAdmin();`).

8. **Client Portal Key Isolation & Anti-Enumeration:** `/clientPortals/{portalKey}` forbids `list` queries (`allow list: if false;`), excludes PII (`phone`, `email`, `notes`), requires exact 64-char SHA-256 hex `portalKey` for single-document `get`, and restricts all writes/deletes strictly to active verified members (`isActiveMember()`).

## 2. Dirty Dozen+ Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read:** Unauthenticated `GET /clients/c1` -> `PERMISSION_DENIED`.
2. **Unverified email write:** Signed-in user with `email_verified: false` creating `/clients/c1` -> `PERMISSION_DENIED`.
3. **Self-admin privilege escalation:** Employee creating `/users/{uid}` with `role: "admin"` -> `PERMISSION_DENIED`.
4. **Role tampering on update:** Employee updating `/users/{uid}` to set `role: "admin"` -> `PERMISSION_DENIED`.
5. **Shadow field injection:** Client payload on `/clients/c1` including extra ghost key `isVerified: true` -> `PERMISSION_DENIED`.
6. **Admin registry spoofing:** Non-admin creating `/admins/{uid}` -> `PERMISSION_DENIED`.
7. **PII cross-read:** Employee reading another user's `/users/{otherUid}/private/info` -> `PERMISSION_DENIED`.
8. **ID poisoning:** Creating `/clients/` with a 300-character ID or invalid characters `../admin` -> `PERMISSION_DENIED`.
9. **Credit tampering by employee:** Employee updating `/credits/{creditId}` `principal` or `interestRate` directly -> `PERMISSION_DENIED`.
10. **Transaction deletion/tampering by employee:** Employee updating or deleting `/transactions/{txId}` -> `PERMISSION_DENIED`.
11. **Modification request auto-approval:** Employee creating `/modificationRequests/{reqId}` with `status: "approved"` -> `PERMISSION_DENIED`.
12. **Client-supplied timestamp spoofing:** Creating `/credits/{creditId}` with a forged past `createdAt` not equal to `request.time` -> `PERMISSION_DENIED`.
13. **Client portal enumeration:** Unauthenticated or authenticated `LIST /clientPortals` -> `PERMISSION_DENIED`.
14. **Client portal public write:** Unauthenticated user attempting `CREATE` or `UPDATE` on `/clientPortals/{64hex}` -> `PERMISSION_DENIED`.
15. **Client portal short/forged ID:** Attempting `GET /clientPortals/shortid` (not 64-char hex) -> `PERMISSION_DENIED`.
