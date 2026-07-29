/**
 * Project file storage (Cloudflare R2 behind Workser).
 *
 * Uses the CLOUD key (`x-api-key`), not the business bearer key — the two
 * carry different scope families. The SDK holds both so callers never have to
 * know which route needs which.
 *
 * Requires `infra-storage:read` / `infra-storage:write`.
 */
import type { HttpClient } from '../http.js';

export interface StoredFile {
  key?: string;
  name?: string;
  size?: number;
  url?: string;
  [key: string]: unknown;
}

export class Storage {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
  ) {}

  private base(): string {
    return `/cloud/project/${encodeURIComponent(this.projectId)}/storage`;
  }

  list(params: { prefix?: string; limit?: number } = {}): Promise<StoredFile[]> {
    return this.http.request<StoredFile[]>(`${this.base()}/files`, {
      auth: 'cloud',
      query: params,
    });
  }

  stats(): Promise<Record<string, unknown>> {
    return this.http.request(`${this.base()}/stats`, { auth: 'cloud' });
  }

  /**
   * A short-lived direct-upload URL.
   *
   * Prefer this over streaming bytes through Workser for anything large: the
   * client PUTs straight to storage, so a big file never occupies a request
   * slot or a timeout budget.
   */
  presignedUploadUrl(input: {
    filename: string;
    folder?: string;
    contentType?: string;
  }): Promise<{ url: string; key?: string; [key: string]: unknown }> {
    return this.http.request(`${this.base()}/presigned-upload-url`, {
      method: 'POST',
      auth: 'cloud',
      body: {
        filename: input.filename,
        folder: input.folder,
        content_type: input.contentType,
      },
    });
  }

  /** Small files only. Anything sizeable should use `presignedUploadUrl`. */
  upload(input: {
    filename: string;
    folder?: string;
    /** base64, without a data: prefix. */
    dataBase64: string;
  }): Promise<StoredFile> {
    return this.http.request<StoredFile>(`${this.base()}/upload`, {
      method: 'POST',
      auth: 'cloud',
      body: {
        filename: input.filename,
        folder: input.folder,
        dataBase64: input.dataBase64,
      },
    });
  }

  remove(key: string): Promise<void> {
    return this.http.request<void>(`${this.base()}/file`, {
      method: 'DELETE',
      auth: 'cloud',
      query: { key },
    });
  }
}
