import pg from 'pg';

/** A pool pointed at the integration/e2e database. Caller owns shutdown. */
export function testPool(): pg.Pool {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL must be set for integration tests');
  return new pg.Pool({ connectionString, max: 8 });
}

/** Deferred promise, for pinning one task open while another races it. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
