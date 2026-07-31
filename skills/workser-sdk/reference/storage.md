# `workser.storage` — project file storage

The project's default bucket (Cloudflare R2 behind Workser).

```ts
import { workser } from '@workser/app';

await workser.storage.list({ prefix: 'invoices/', limit: 100 });  // StoredFile[]
await workser.storage.stats();
await workser.storage.remove(key);
```

## Uploading: pick the right one

**Anything sizeable — a presigned URL.** The client PUTs straight to storage, so a
big file never occupies a request slot or a timeout budget:

```ts
// server: mint the URL
const { url, key } = await workser.storage.presignedUploadUrl({
  filename: file.name,
  folder: 'invoices',
  contentType: file.type,
});
// browser: PUT the bytes directly to `url`, then tell your server about `key`
```

**Small files only — direct upload.** Base64, without a `data:` prefix:

```ts
await workser.storage.upload({
  filename: 'receipt.pdf',
  folder: 'receipts',
  dataBase64: buf.toString('base64'),
});
```

Base64 inflates the payload by a third and the whole file sits in memory on both
ends. Streaming a user's upload through your server this way is the wrong default.

## Notes that matter

- **One bucket per project, shared by its apps.** Namespace keys by app or feature
  (`invoices/2026/…`); don't treat the root as yours.
- **`remove(key)` is permanent.** No versioning, no undo.
- Requires `infra-storage:read` / `infra-storage:write`.

## Not the same as `workser.neon`

`storage` is the default bucket every project has. `workser.neon` is additive
infrastructure on the project's own Neon branch, available only on dedicated tenancy
in a supported region. Different stores — a file written to one is not visible in the
other. See `reference/neon.md`.
