import { Cause, Data, Effect, Layer, Schedule, ServiceMap } from "effect";
import { dual } from "effect/Function";
import { CloudflareEnv } from "./effect-services";

export class D1Error extends Data.TaggedError("D1Error")<{
  readonly message: string;
  readonly cause: Error;
}> {}

interface D1Shape {
  readonly prepare: (query: string) => D1PreparedStatement;
  readonly batch: <T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ) => Effect.Effect<D1Result<T>[], D1Error>;
  readonly run: <T = Record<string, unknown>>(
    statement: D1PreparedStatement,
  ) => Effect.Effect<D1Result<T>, D1Error>;
  readonly first: <T>(
    statement: D1PreparedStatement,
  ) => Effect.Effect<T | null, D1Error>;
}

export class D1 extends ServiceMap.Service<D1, D1Shape>()("D1", {
  make: Effect.gen(function* () {
    const { D1: d1 } = yield* CloudflareEnv;
    return {
      prepare: (query: string) => d1.prepare(query),
      batch: <T = Record<string, unknown>>(statements: D1PreparedStatement[]) =>
        tryD1(() => d1.batch<T>(statements)),
      run: <T = Record<string, unknown>>(statement: D1PreparedStatement) =>
        tryD1(() => statement.run<T>()),
      first: <T>(statement: D1PreparedStatement) =>
        tryD1(() => statement.first<T>()),
    } satisfies D1Shape;
  }),
}) {
  static layer = Layer.effect(this, this.make);
}

const NON_RETRYABLE = [
  "SQLITE_CONSTRAINT",
  "SQLITE_ERROR",
  "SQLITE_MISMATCH",
] as const;

const tryD1 = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => {
      const cause =
        Cause.isUnknownError(error) && error.cause instanceof Error
          ? error.cause
          : error instanceof Error
            ? error
            : new Error(String(error));
      return new D1Error({ message: cause.message, cause });
    }),
    Effect.tapError((error) => Effect.log(error)),
    Effect.retry({
      while: (error) => !NON_RETRYABLE.some((p) => error.message.includes(p)),
      times: 2,
      schedule: Schedule.exponential("1 second"),
    }),
  );

export const bind = dual<
  (
    ...values: unknown[]
  ) => <E, R>(
    self: Effect.Effect<D1PreparedStatement, E, R>,
  ) => Effect.Effect<D1PreparedStatement, E, R>,
  <E, R>(
    ...args: [Effect.Effect<D1PreparedStatement, E, R>, ...unknown[]]
  ) => Effect.Effect<D1PreparedStatement, E, R>
>(
  (args) => Effect.isEffect(args[0]),
  (self, ...values) => Effect.map(self, (stmt) => stmt.bind(...values)),
);
