# `workser.neon` — the project's own Neon backend

S3-compatible object storage and Node.js HTTP functions on the project's own Neon
branch — they branch with the database. **Additive** infrastructure, not a
replacement for `workser.storage`.

## Check `status()` first — always

```ts
const s = await workser.neon.status();
// { dedicated, neonBackendStorageEnabled, neonBackendFunctionsEnabled,
//   regionId, regionSupportsNeonBackend, supportedRegions }
```

Three things must all be true: **dedicated tenancy**, the capability **enabled**, and
a **supported region**.

- `regionSupportsNeonBackend: false` is a **hard stop**. Region is fixed when the
  project is created, so this is permanent — not something to retry. Say so and fall
  back to `workser.storage`.
- `regionId: null` means **not yet resolved**, which is not the same as unsupported.

## Storage

```ts
await workser.neon.listBuckets();
await workser.neon.createBucket('exports', 'private');   // or 'public_read'
await workser.neon.listObjects('exports', 'q3/');
await workser.neon.presign('exports', 'q3/report.pdf', {
  operation: 'upload',            // or 'download' (default)
  contentType: 'application/pdf',
  expiresInSeconds: 900,
});
await workser.neon.deleteObject('exports', key);
await workser.neon.deleteBucket('exports');   // deletes EVERYTHING in it, not reversible
```

Prefer `presign` to moving bytes through Workser — the client transfers directly
against Neon, so a large file never occupies a request body.

## Functions

```ts
await workser.neon.listFunctions();
await workser.neon.deployFunction('resize', zipBase64, {
  runtime: 'nodejs',
  environment: { SHARP_CONCURRENCY: '2' },
});
await workser.neon.deleteFunction('resize');
```

The bundle is base64 rather than multipart, so this works identically from a server,
an edge runtime, or an agent shelling out.

## Notes that matter

- **Most apps don't need this.** If the user just wants somewhere to put uploads,
  `workser.storage` is the answer.
- **A file here is not visible in `workser.storage`.** Different stores. Pick one per
  use case and be explicit about which.
- Requires `infra-storage:*` / `infra-functions:*`.
