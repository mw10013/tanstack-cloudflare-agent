# Agents callable decorators in Vite SSR

## Issue

Calling `bang()` on `UserAgent` via `useAgent` results in `RPC error: Method bang is not callable`. The `@callable()` decorator also shows a TypeScript error about incompatible decorator signatures when `experimentalDecorators` is enabled.

## Analysis

### Agents uses standard decorators

The Agents SDK implements `callable()` using the stage-3 decorator signature (`ClassMethodDecoratorContext`), not the legacy `experimentalDecorators` signature:

```
export function callable(metadata: CallableMetadata = {}) {
  return function callableDecorator<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext
  ) {
    if (!callableMetadata.has(target)) {
      callableMetadata.set(target, metadata);
    }
    return target;
  };
}
```

Source: `refs/agents/packages/agents/src/index.ts`

This means `experimentalDecorators` should be disabled; legacy decorators break the callable metadata registration.

### Agents examples do not enable experimentalDecorators

The Agents repo base tsconfig has `experimentalDecorators` commented out. Examples use the Cloudflare Vite plugin without extra decorator config.

Sources:

- `refs/agents/tsconfig.base.json`
- `refs/agents/examples/playground/vite.config.ts`

### Runtime error path

The error is thrown by Agents runtime when a method is not marked callable:

```
if (!this._isCallable(method)) throw new Error(`Method ${method} is not callable`);
```

Source: `node_modules/agents/dist/src-C_iKczoR.js`

This implies the decorator did not run or did not register metadata at runtime.

### Workers RPC is enabled

`wrangler.jsonc` uses `compatibility_date: "2025-09-17"`, which satisfies the Workers RPC requirement (`>= 2024-04-03`).

Source: `wrangler.jsonc`

## What was tried (did not resolve)

1. Enabling `experimentalDecorators` in `tsconfig.json`.
   - This fixes the parse error in dev but causes a type mismatch with the Agents decorator signature.
   - It still results in `Method bang is not callable` at runtime.

2. Manually simulating the decorator registration.
   - Attempted to invoke `callable()(method, {})` manually.
   - This bypasses the decorator system but is not acceptable as a long-term fix.

3. Searching Vite SSR output for decorator transformation.
   - No clear evidence that `@callable` or `UserAgent` is transformed in `node_modules/.vite/deps_ssr`.
   - Matches found were unrelated (Mermaid “bang” node).

## Open question

Why do the Agents examples work with the Cloudflare Vite plugin and standard decorators, while this app fails to register callable metadata? The likely gap is in how decorators are transformed (or not transformed) in the SSR pipeline for this app.
