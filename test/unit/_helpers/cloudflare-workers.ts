/** Minimal Node/Vitest stand-in for the runtime-only cloudflare:workers base class. */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * Minimal Node/Vitest stand-in for capnweb's RPC base class.
 *
 * The workspace room subclasses it to hand the gadget a broadcast target, so
 * any suite whose imports reach `workers/api/src/index.ts` — which is most of
 * the product suite, through the route table — died at import with "Class
 * extends value undefined". Nothing here is called: the base contributes no
 * behaviour of its own, and a test that wants the bridge builds one and reads
 * what it delivered.
 */
export class RpcTarget {}

/** Stand-in for `RpcStub as NativeRpcStub` from cloudflare:workers. */
export class RpcStub<T = unknown> {
  constructor(readonly value: T) {}
}

/** Minimal Node/Vitest stand-in for runtime-only service entrypoints. */
export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx?: ExecutionContext;
  protected readonly env: Env;

  constructor(ctx: ExecutionContext | undefined, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

class TestSpan {
  readonly isTraced = false;

  setAttribute(_key: string, _value?: string | number | boolean): void {}

  end(): void {}
}

/** Execute span callbacks in Node tests without emitting telemetry. */
export const tracing = {
  enterSpan<T, A extends unknown[]>(_name: string, callback: (span: TestSpan, ...args: A) => T, ...args: A): T {
    return callback(new TestSpan(), ...args);
  },
  startActiveSpan<T, A extends unknown[]>(_name: string, callback: (span: TestSpan, ...args: A) => T, ...args: A): T {
    return callback(new TestSpan(), ...args);
  },
  Span: TestSpan
};
