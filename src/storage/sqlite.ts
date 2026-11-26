export interface SQLiteStatement<Row = unknown> {
  run(...params: any[]): unknown;
  get(...params: any[]): Row | null;
  all(...params: any[]): Row[];
}

export interface SQLiteDatabase {
  run(sql: string): unknown;
  query<Row = unknown>(sql: string): SQLiteStatement<Row>;
  transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void;
}
