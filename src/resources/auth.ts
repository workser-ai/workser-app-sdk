/**
 * Project user authentication (Better Auth behind Workser).
 *
 * Read-oriented on purpose. Sign-in, sessions and password handling belong to
 * Better Auth in the app itself; what an app or an agent needs from here is
 * "who are my users" and "is this token real".
 *
 * Requires `infra-auth:read` / `infra-auth:write`.
 */
import type { HttpClient } from '../http.js';

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
  created_at?: string;
  [key: string]: unknown;
}

export class Auth {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
  ) {}

  private base(): string {
    return `/cloud/project/${encodeURIComponent(this.projectId)}/auth`;
  }

  /** Whether auth is provisioned for this project, and how it is configured. */
  status(): Promise<Record<string, unknown>> {
    return this.http.request(this.base(), { auth: 'cloud' });
  }

  users(params: { limit?: number; offset?: number } = {}): Promise<AuthUser[]> {
    return this.http.request<AuthUser[]>(`${this.base()}/users`, {
      auth: 'cloud',
      query: params,
    });
  }
}
