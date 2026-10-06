# `workser.storage` — project file storage

The project's default bucket (Cloudflare R2 behind Workser).

```ts
import { workser } from '@workser/app';

await workser.storage.list({ prefix: 'invoices/', limit: 100 });  // StoredFile[]
await workser.storage.stats();
await workser.storage.remove(key);
```

## Where a file may go — and where it may not

`workser.storage` is the project's default file store. An owner who asked for
their own S3 or Cloudinary gets that instead; that choice is theirs, not yours to
make quietly.

**The app's own filesystem is not one of the choices.** Not `public/`, not
`assets/`, not `fs.writeFile` anywhere under the app, whichever provider is in
use. Two different things break, and the first one is silent:

- **The host is serverless.** A file written during a request is gone when the
  request ends — it works once on your machine and never in production, which is
  the worst shape a bug can have.
- **Anything under `public/` is committed.** Publishing bundles the whole app
  folder, so user uploads and generated art enter the repository's history, ship
  in every deploy against a 25MB cap, and cannot be changed without a redeploy.

The owner's Files screen lists this bucket. A file that is not in it is one they
cannot find, replace or delete.

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
