/** The synchronous SQLite-backed KV API actually exercised by the pinned workerd runtime. */
export interface PushKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list<T = unknown>(options: { prefix: string; limit?: number }): Iterable<[string, T]>;
}
export interface PushStorage {
  readonly kv: PushKv;
  transactionSync<T>(operation: () => T): T;
  sync(): Promise<void>;
}
export interface LimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
}
export interface PushEnv {
  LIMITER?: LimiterNamespace;
  PUSH_AUDIENCE?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
}
