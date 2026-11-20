declare module "bun" {
  export interface SQLRows<T> extends Array<T> {
    count: number;
    affectedRows: number;
    command: string | null;
  }

  export interface ReservedSQL {
    unsafe<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      values?: unknown[]
    ): Promise<SQLRows<T>>;
    release(): void;
    close(): void;
  }

  export class SQL {
    constructor(options: {
      url: string;
      max?: number;
      idleTimeout?: number;
      prepare?: boolean;
    });
    unsafe<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      values?: unknown[]
    ): Promise<SQLRows<T>>;
    reserve(): Promise<ReservedSQL>;
    close(options?: { timeout?: number }): Promise<void>;
  }
}
