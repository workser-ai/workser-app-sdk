/**
 * Business data — the project's commerce and content records.
 *
 * These are the SAME rows the Workser dashboard and the cloud AI employees
 * read and write. An app built on Workser is not integrating with a separate
 * system; it is reading its own business.
 *
 * Requires `business:read` / `business:write` on the key.
 */
import type { HttpClient } from '../http.js';

export interface ListParams {
  limit?: number;
  offset?: number;
  [key: string]: string | number | boolean | undefined;
}

/**
 * One REST resource under `/v1/projects/:projectId/<name>`.
 *
 * Every business resource in Core API follows the same shape, so rather than
 * hand-writing eight near-identical classes this is generated per name. New
 * resources become one line, and none of them can drift from the others.
 */
export class BusinessResource<T = Record<string, unknown>> {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
    private readonly name: string,
  ) {}

  private base(): string {
    return `/v1/projects/${encodeURIComponent(this.projectId)}/${this.name}`;
  }

  /**
   * Every method takes an optional row type, defaulting to the resource's own.
   *
   * Without this a caller had to reach for `business.resource<Order>('orders')`
   * just to type a response from the NAMED `business.orders` accessor, which
   * reads as a mistake and makes the named accessors feel second-class.
   * `orders.list<Order>()` is the obvious thing to try, so it works.
   */
  list<R = T>(params: ListParams = {}): Promise<R[]> {
    return this.http.request<R[]>(this.base(), { query: params });
  }

  get<R = T>(id: string): Promise<R> {
    return this.http.request<R>(`${this.base()}/${encodeURIComponent(id)}`);
  }

  /**
   * `idempotencyKey` is strongly recommended on creates. Without one, a retry
   * after a network timeout can produce a second order — the SDK retries
   * automatically, so this is a real path, not a hypothetical.
   */
  create<R = T>(
    body: Partial<R> | Record<string, unknown>,
    opts: { idempotencyKey?: string } = {},
  ): Promise<R> {
    return this.http.request<R>(this.base(), {
      method: 'POST',
      body,
      idempotencyKey: opts.idempotencyKey,
    });
  }

  update<R = T>(
    id: string,
    body: Partial<R> | Record<string, unknown>,
  ): Promise<R> {
    return this.http.request<R>(`${this.base()}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    });
  }

  remove(id: string): Promise<void> {
    return this.http.request<void>(`${this.base()}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
}

export class Business {
  readonly orders: BusinessResource;
  readonly sales: BusinessResource;
  readonly fulfillments: BusinessResource;
  readonly pages: BusinessResource;
  readonly carts: BusinessResource;

  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
  ) {
    this.orders = this.resource('orders');
    this.sales = this.resource('sales');
    this.fulfillments = this.resource('fulfillments');
    this.pages = this.resource('pages');
    this.carts = this.resource('carts');
  }

  /**
   * Reach a business resource this SDK version does not name yet.
   *
   * Core API adds resources faster than the SDK is republished, and an app
   * being blocked on an npm release to read a table it already owns would be
   * an absurd failure mode. Typed via the caller's generic.
   */
  resource<T = Record<string, unknown>>(name: string): BusinessResource<T> {
    return new BusinessResource<T>(this.http, this.projectId, name);
  }
}
