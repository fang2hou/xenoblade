import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Minimal D1-compatible facade over node:sqlite for unit tests.
 *
 * Implements the surface the worker actually uses — `prepare().bind()
 * .first() / .all() / .run()` — with real SQL semantics, so aggregation and
 * claim queries are evaluated by SQLite itself rather than a hand-rolled mock.
 */
export function createTestD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readMigrations());
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test facade bridging D1Database to node:sqlite
  return new D1Facade(sqlite) as unknown as D1Database;
}

function readMigrations(): string {
  const url = new URL("../../migrations/0001_initial.sql", import.meta.url);
  return readFileSync(url, "utf8");
}

type BindParams = readonly SQLInputValue[];

class D1Facade {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(query: string): D1Statement {
    return new D1Statement(this.sqlite, query, []);
  }
}

class D1Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly query: string,
    private readonly params: BindParams,
  ) {}

  bind(...params: SQLInputValue[]): D1Statement {
    return new D1Statement(this.sqlite, this.query, params);
  }

  async first(): Promise<unknown> {
    return this.select()[0] ?? null;
  }

  async all(): Promise<{ results: unknown[] }> {
    return { results: this.select() };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    const info = this.sqlite.prepare(this.query).run(...this.params);
    return {
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }

  private select(): unknown[] {
    return this.sqlite.prepare(this.query).all(...this.params);
  }
}
