# OpenCode Shell Environment Plugin

Injects `PORT` from `.env` into all shell executions.

## Files

```
.opencode/
  plugins/
    inject-env.js    # Plugin implementation
```

## How It Works

The plugin uses OpenCode's `shell.env` hook to inject environment variables into all shell executions (bash tool, `!command`, PTY).

At startup:

1. Sources `.env` file using Bun's `$` shell helper
2. Extracts `PORT` value
3. Throws if PORT not found
4. Logs success message via structured logging
5. Injects PORT into all subsequent shell executions

## Plugin Code

```javascript
export const InjectEnvPlugin = async ({ $, directory, client }) => {
  const result = await $`source ${directory}/.env && echo $PORT`.text();
  const port = result.trim();

  if (!port) {
    throw new Error(`PORT not found in .env at ${directory}/.env`);
  }

  await client.app.log({
    body: {
      service: "inject-env",
      level: "info",
      message: `Injecting PORT=${port} into shell env`,
    },
  });

  return {
    "shell.env": async (_input, output) => {
      output.env.PORT = port;
    },
  };
};
```

## Key Design Decisions

- **Auto-loading**: Plugins in `.opencode/plugins/` are automatically discovered and loaded at startup (no config needed)
- **Caching**: PORT is read once at plugin init and cached in closure
- **Error handling**: Throws immediately if PORT not found in `.env`
- **Logging**: Single structured log on successful initialization
- **No dependencies**: Pure JavaScript, no TypeScript types package needed

## References

- OpenCode Plugin Docs: https://opencode.ai/docs/plugins/
- Bun Shell API: https://bun.com/docs/runtime/shell
