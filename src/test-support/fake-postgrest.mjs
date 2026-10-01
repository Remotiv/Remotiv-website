/**
 * A minimal PostgREST-builder impersonator for tests.
 *
 * Every chained call (`select`, `eq`, `in`, `insert`, ...) is recorded on the
 * query and returns the same query; awaiting it resolves to whatever
 * `respond(table, calls)` returns, so a test decides each answer from what was
 * actually asked. Every query is also appended to `service.queries`, which is
 * how a test asserts what was written.
 *
 * Filters are recorded, not applied. A responder that wants a filter honoured
 * reads it from `calls`; one that ignores it is testing what the CODE does with
 * rows the database would not have returned.
 *
 * Test-only. Nothing in the application imports this.
 */
export function fakeService(respond) {
  const queries = [];
  return {
    queries,
    from(table) {
      const calls = [];
      queries.push({ table, calls });
      const q = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (resolve, reject) =>
                Promise.resolve()
                  .then(() => respond(table, calls))
                  .then(resolve, reject);
            }
            return (...args) => {
              calls.push([prop, ...args]);
              return q;
            };
          },
        },
      );
      return q;
    },
  };
}

/** The first recorded call with this method name, or undefined. */
export function call(calls, method) {
  return calls.find((c) => c[0] === method);
}
