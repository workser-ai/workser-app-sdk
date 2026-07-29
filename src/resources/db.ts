/**
 * The project's Postgres database (Neon behind Workser).
 *
 * Two ways in, and the choice matters:
 *
 *  • `query()` — goes through Core API. Scope-gated, audited, and reachable
 *    from anywhere with a key. Right for agents and for occasional access.
 *  • `connectionUri()` — the raw Postgres URI for your own driver/ORM. Right
 *    for an app's hot path, where a round trip through Core API per query
 *    would be absurd.
 *
 * A minted Data API token can only ever assume the project's least-privilege
 * `workser_app_<projectId>` role — never the owner — so it structurally
 * cannot drop the database, regardless of the scope that minted it.
 *
 * Requires `infra-database:read` / `infra-database:write`.
 */
import type { HttpClient } from '../http.js';

export interface TableInfo {
  name?: string;
  schema?: string;
  [key: string]: unknown;
}

export class Db {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
  ) {}

  private cloudBase(): string {
    return `/cloud/project/${encodeURIComponent(this.projectId)}/database`;
  }

  private dataApiBase(): string {
    return `/v1/projects/${encodeURIComponent(this.projectId)}/data-api`;
  }

  tables(): Promise<TableInfo[]> {
    return this.http.request<TableInfo[]>(`${this.cloudBase()}/tables`, {
      auth: 'cloud',
    });
  }

  schema(tableName: string): Promise<unknown> {
    return this.http.request(
      `${this.cloudBase()}/table/${encodeURIComponent(tableName)}/schema`,
      { auth: 'cloud' },
    );
  }

  rows<T = Record<string, unknown>>(
    tableName: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<T[]> {
    return this.http.request<T[]>(
      `${this.cloudBase()}/table/${encodeURIComponent(tableName)}/data`,
      { auth: 'cloud', query: params },
    );
  }

  /**
   * Run SQL.
   *
   * Parameters are sent separately and bound server-side — never interpolate
   * user input into `sql` yourself. This is the single most likely place for
   * an agent-written app to acquire an injection vulnerability, so the
   * parameterised form is the only one offered.
   */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.http.request<T[]>(`${this.cloudBase()}/query`, {
      method: 'POST',
      auth: 'cloud',
      body: { query: sql, params },
    });
  }

  /**
   * The Postgres connection URI, for your own driver.
   *
   * SECURITY: this is a credential. Never return it to a browser, never log
   * it, never put it in an agent's context — the SDK's redaction masks it if
   * it does end up in an error, but that is a backstop, not permission.
   */
  connectionUri(): Promise<{ uri?: string; [key: string]: unknown }> {
    return this.http.request(`${this.cloudBase()}/connection-uri`, { auth: 'cloud' });
  }

  /** Neon Data API status (PostgREST-compatible surface). */
  dataApiStatus(): Promise<Record<string, unknown>> {
    return this.http.request(this.dataApiBase());
  }

  /** Short-lived (≈5 min) least-privilege Data API token. */
  mintDataApiToken(): Promise<{ token: string; expires_in: number }> {
    return this.http.request(`${this.dataApiBase()}/token`, { method: 'POST' });
  }
}
