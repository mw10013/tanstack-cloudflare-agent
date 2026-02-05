# OpenCode Plugins, Hooks & Events

Comprehensive guide to OpenCode's plugin architecture.

## Mental Model

```
┌─────────────────────────────────────────────────────────────┐
│                    OPENCODE CORE                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Session   │  │    Tool     │  │   File Operations   │  │
│  │   Engine    │  │   System    │  │                     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                    │             │
│         ▼                ▼                    ▼             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              EVENT BUS / HOOK DISPATCHER            │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                         │                                   │
│         ┌───────────────┼───────────────┐                   │
│         ▼               ▼               ▼                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Plugin A   │  │  Plugin B   │  │  Plugin C   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

## Core Concepts

| Concept    | Definition                                       | Analogy                     |
| ---------- | ------------------------------------------------ | --------------------------- |
| **Plugin** | JavaScript/TypeScript module exporting functions | Container for functionality |
| **Hook**   | Event handler function in a plugin               | Event listener              |
| **Event**  | Named lifecycle point in OpenCode                | Trigger signal              |

## Plugin Structure

```javascript
// .opencode/plugins/my-plugin.js
export const MyPlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    "session.created": async (input, output) => {
      /* ... */
    },
    "tool.execute.before": async (input, output) => {
      /* ... */
    },
  };
};
```

### Context Parameters

| Parameter   | Description                 |
| ----------- | --------------------------- |
| `project`   | Current project information |
| `directory` | Current working directory   |
| `worktree`  | Git worktree path           |
| `client`    | OpenCode SDK client         |
| `$`         | Bun's shell API             |

## Loading Plugins

### Local Files

```
.opencode/plugins/*.js       # Project-level
~/.config/opencode/plugins/*.js  # Global
```

### NPM Packages

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-helicone-session", "@org/custom-plugin"]
}
```

### Load Order

1. Global config (`~/.config/opencode/opencode.json`)
2. Project config (`opencode.json`)
3. Global plugin directory
4. Project plugin directory

## Available Events

### Session Events

- `session.created`, `session.updated`, `session.deleted`
- `session.idle`, `session.compacted`, `session.error`
- `session.diff`, `session.status`

### Tool Events

- `tool.execute.before` - Modify or block tool execution
- `tool.execute.after` - Transform results

### Shell Events

- `shell.env` - Inject environment variables

### File Events

- `file.edited`, `file.watcher.updated`

### Message Events

- `message.updated`, `message.removed`
- `message.part.updated`, `message.part.removed`

### Permission Events

- `permission.asked`, `permission.replied`

### TUI Events

- `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`

### LSP Events

- `lsp.client.diagnostics`, `lsp.updated`

### Todo Events

- `todo.updated`

### Server Events

- `server.connected`

### Command Events

- `command.executed`

## Hook Pattern

Every hook receives `(input, output)`:

```javascript
"hook.name": async (input, output) => {
  // input: Read-only trigger data
  // output: Mutable control object
}
```

| Hook                  | Input                    | Output                | Purpose                 |
| --------------------- | ------------------------ | --------------------- | ----------------------- |
| `tool.execute.before` | `{ tool, args }`         | `{ args }`            | Modify before execution |
| `tool.execute.after`  | `{ tool, args, result }` | `{ result }`          | Transform results       |
| `shell.env`           | `{ cwd }`                | `{ env }`             | Inject env vars         |
| `session.compacted`   | `{ session }`            | `{ context, prompt }` | Control compaction      |

## Dependencies

For local plugins needing npm packages:

```json
// .opencode/package.json
{
  "dependencies": {
    "shescape": "^2.1.0"
  }
}
```

OpenCode runs `bun install` at startup.

## TypeScript Support

```typescript
import type { Plugin } from "@opencode-ai/plugin";

export const MyPlugin: Plugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        output.args.command = escape(output.args.command);
      }
    },
  };
};
```

## Execution Flow

```
User Request → OpenCode Core → EVENT FIRED
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              Plugin A          Plugin B          Plugin C
              (validate)        (log)             (block?)
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
                           Execute Tool
                                    │
                                    ▼
                           EVENT FIRED (after)
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        Transform Result      Audit Log             Cleanup
```
