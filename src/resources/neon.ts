/**
 * The project's OWN backend on its Neon branch — S3-compatible object storage
 * and Node.js HTTP functions, both branching with the database.
 *
 * Distinct from `storage` on purpose: that is the default Cloudflare R2 bucket
 * every project gets. This is additive infrastructure that exists only for
 * projects on dedicated tenancy in a supported region. Collapsing the two would
 * leave a caller unable to tell which store a file actually landed in.
 *
 * ALWAYS check `status()` before using either capability. Three things must all
 * be true — dedicated tenancy, the capability enabled, and a supported region —
 * and the region one is not a setting: it is fixed when the project is created,
 * so `regionSupportsNeonBackend: false` is permanent for that project.
 *
 * Uses the CLOUD key (`x-api-key`), like `storage`. Requires
 * `infra-storage:*` / `infra-functions:*` scopes.
 */
import type { HttpClient } from '../http.js';

export interface NeonBackendStatus {
  dedicated: boolean;
  neonBackendStorageEnabled: boolean;
  neonBackendFunctionsEnabled: boolean;
  /** `null` means NOT YET RESOLVED — not "unsupported". */
  regionId: string | null;
  /** False is a hard stop: the region cannot host these capabilities. */
  regionSupportsNeonBackend: boolean;
  supportedRegions: string[];
}

export interface NeonBucket {
  id: string;
  bucket_name: string;
  access_level: 'private' | 'public_read';
  is_active: boolean;
  [key: string]: unknown;
}

export interface NeonBucketObject {
  key?: string;
  size?: number;
  [key: string]: unknown;
}

export interface NeonFunction {
  slug?: string;
  name?: string;
  url?: string;
  [key: string]: unknown;
}

export class Neon {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
  ) {}

  private base(): string {
    return `/cloud/project/${encodeURIComponent(this.projectId)}`;
  }

  /**
   * Whether this project can use Neon storage/functions at all.
   *
   * Check this first. A project outside `supportedRegions` will fail every call
   * below, and no amount of retrying changes that — surface it to the user and
   * fall back to `storage` (the default bucket) instead.
   */
  status(): Promise<NeonBackendStatus> {
    return this.http.request<NeonBackendStatus>(
      `${this.base()}/neon-backend/status`,
      { auth: 'cloud' },
    );
  }

  // ---- object storage -------------------------------------------------------

  listBuckets(): Promise<NeonBucket[]> {
    return this.http.request<NeonBucket[]>(
      `${this.base()}/neon-storage/buckets`,
      { auth: 'cloud' },
    );
  }

  createBucket(
    name: string,
    accessLevel: 'private' | 'public_read' = 'private',
  ): Promise<NeonBucket> {
    return this.http.request<NeonBucket>(`${this.base()}/neon-storage/buckets`, {
      auth: 'cloud',
      method: 'POST',
      body: { name, access_level: accessLevel },
    });
  }

  /** Deletes the bucket AND everything in it. Not reversible. */
  deleteBucket(name: string): Promise<void> {
    return this.http.request<void>(
      `${this.base()}/neon-storage/buckets/${encodeURIComponent(name)}`,
      { auth: 'cloud', method: 'DELETE' },
    );
  }

  listObjects(bucket: string, prefix?: string): Promise<NeonBucketObject[]> {
    return this.http.request<NeonBucketObject[]>(
      `${this.base()}/neon-storage/buckets/${encodeURIComponent(bucket)}/objects`,
      { auth: 'cloud', query: prefix ? { prefix } : {} },
    );
  }

  /**
   * A short-lived URL for one object.
   *
   * Prefer this over moving bytes through Workser: the client transfers
   * directly against Neon, so a large file never occupies a request body.
   */
  presign(
    bucket: string,
    key: string,
    options: {
      operation?: 'upload' | 'download';
      contentType?: string;
      expiresInSeconds?: number;
    } = {},
  ): Promise<{ url: string; headers?: Record<string, string> }> {
    return this.http.request(
      `${this.base()}/neon-storage/buckets/${encodeURIComponent(bucket)}/presign`,
      {
        auth: 'cloud',
        method: 'POST',
        body: { key, operation: options.operation ?? 'download', ...options },
      },
    );
  }

  deleteObject(bucket: string, key: string): Promise<void> {
    return this.http.request<void>(
      `${this.base()}/neon-storage/buckets/${encodeURIComponent(bucket)}/objects`,
      { auth: 'cloud', method: 'DELETE', query: { key } },
    );
  }

  // ---- functions ------------------------------------------------------------

  listFunctions(): Promise<NeonFunction[]> {
    return this.http.request<NeonFunction[]>(`${this.base()}/neon-functions`, {
      auth: 'cloud',
    });
  }

  /**
   * Deploy a function from a zip bundle.
   *
   * `zip` is base64 — the transport is a JSON body rather than multipart so
   * this works identically from a server, an edge runtime, or an agent shelling
   * out, none of which reliably have a multipart encoder to hand.
   */
  deployFunction(
    slug: string,
    zipBase64: string,
    options: {
      zipFilename?: string;
      environment?: Record<string, string>;
      runtime?: string;
      name?: string;
    } = {},
  ): Promise<NeonFunction> {
    return this.http.request<NeonFunction>(`${this.base()}/neon-functions`, {
      auth: 'cloud',
      method: 'POST',
      body: { slug, zipBase64, ...options },
    });
  }

  deleteFunction(slug: string): Promise<void> {
    return this.http.request<void>(
      `${this.base()}/neon-functions/${encodeURIComponent(slug)}`,
      { auth: 'cloud', method: 'DELETE' },
    );
  }
}
