# OpenCode Plugin Examples

Practical plugin implementations for common use cases.

## Shell Environment Injection

Inject environment variables into all shell executions (tools, `!command`, PTY).

```javascript
// .opencode/plugins/inject-env.js
export const InjectEnvPlugin = async () => {
  return {
    "shell.env": async (input, output) => {
      output.env.MY_API_KEY = process.env.MY_API_KEY;
      output.env.PROJECT_ROOT = input.cwd;
    },
  };
};
```

## .env File Protection

Block reading sensitive `.env` files.

```javascript
// .opencode/plugins/env-protection.js
export const EnvProtection = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" && output.args.filePath.includes(".env")) {
        throw new Error("Do not read .env files");
      }
    },
  };
};
```

## Session Notifications

Send notifications when sessions complete.

```javascript
// .opencode/plugins/notification.js
export const NotificationPlugin = async ({ $ }) => {
  return {
    "session.idle": async () => {
      await $`osascript -e 'display notification "Session completed!" with title "opencode"'`;
    },
  };
};
```

## Custom Tool

Add new capabilities to OpenCode.

```typescript
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

// .opencode/plugins/custom-tools.ts

export const CustomToolsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      currentGitBranch: tool({
        description: "Get current git branch name",
        args: {},
        async execute(_args, { directory }) {
          const result = await ctx.$`git -C ${directory} branch --show-current`;
          return result.stdout.trim();
        },
      }),
    },
  };
};
```

## Command Escaping

Escape shell commands using external package.

```javascript
// .opencode/plugins/safe-commands.js
import { escape } from "shescape";

export const SafeCommandsPlugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        output.args.command = escape(output.args.command);
      }
    },
  };
};
```

## Structured Logging

Use SDK client for proper logging.

```typescript
// .opencode/plugins/logging.ts
export const LoggingPlugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "my-plugin",
      level: "info",
      message: "Plugin initialized",
    },
  });

  return {
    "tool.execute.after": async (input, output) => {
      await client.app.log({
        body: {
          service: "my-plugin",
          level: "debug",
          message: `Tool ${input.tool} executed`,
          extra: { success: !output.error },
        },
      });
    },
  };
};
```

## Session Compaction Customization

Add context to session compaction.

```typescript
// .opencode/plugins/compaction.ts
import type { Plugin } from "@opencode-ai/plugin";

export const CompactionPlugin: Plugin = async () => {
  return {
    "experimental.session.compacting": async (input, output) => {
      output.context.push(`## Custom Context
Current task status and important decisions should persist.`);
    },
  };
};
```

## File Watcher Integration

React to file changes.

```javascript
// .opencode/plugins/file-watcher.js
export const FileWatcherPlugin = async ({ client }) => {
  return {
    "file.watcher.updated": async (input) => {
      if (input.path.endsWith(".test.ts")) {
        await client.app.log({
          body: {
            service: "test-watcher",
            level: "info",
            message: `Test file changed: ${input.path}`,
          },
        });
      }
    },
  };
};
```

## Permission Audit

Log all permission requests.

```javascript
// .opencode/plugins/permission-audit.js
export const PermissionAuditPlugin = async ({ client }) => {
  return {
    "permission.asked": async (input) => {
      await client.app.log({
        body: {
          service: "audit",
          level: "warn",
          message: `Permission requested: ${input.permission}`,
          extra: { tool: input.tool, args: input.args },
        },
      });
    },
  };
};
```

## Todo Auto-Tracker

Track todo items automatically.

```javascript
// .opencode/plugins/todo-tracker.js
export const TodoTrackerPlugin = async ({ client }) => {
  const todoHistory = [];

  return {
    "todo.updated": async (input) => {
      todoHistory.push({
        timestamp: Date.now(),
        todos: input.todos,
      });

      const incomplete = input.todos.filter(
        (t) => t.status === "in_progress",
      ).length;
      if (incomplete > 5) {
        await client.app.log({
          body: {
            service: "todo-tracker",
            level: "warn",
            message: `High number of incomplete todos: ${incomplete}`,
          },
        });
      }
    },
  };
};
```

## Complete Multi-Hook Example

```typescript
// .opencode/plugins/comprehensive.ts
import type { Plugin } from "@opencode-ai/plugin";

export const ComprehensivePlugin: Plugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}) => {
  const startTime = Date.now();

  await client.app.log({
    body: {
      service: "comprehensive-plugin",
      level: "info",
      message: "Initialized",
      extra: { project: project.name, directory },
    },
  });

  return {
    "session.created": async (input) => {
      console.log(`New session: ${input.session.id}`);
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && output.args.command.includes("rm -rf")) {
        throw new Error("Destructive commands blocked");
      }
    },

    "tool.execute.after": async (input, output) => {
      if (output.error) {
        await client.app.log({
          body: {
            service: "comprehensive-plugin",
            level: "error",
            message: `Tool ${input.tool} failed`,
            extra: { error: output.error },
          },
        });
      }
    },

    "shell.env": async (input, output) => {
      output.env.PLUGIN_ACTIVE = "true";
      output.env.PLUGIN_START_TIME = String(startTime);
      output.env.PLUGIN_CWD = input.cwd;
    },

    "session.idle": async () => {
      const duration = Date.now() - startTime;
      await client.app.log({
        body: {
          service: "comprehensive-plugin",
          level: "info",
          message: `Session completed after ${duration}ms`,
        },
      });
    },
  };
};
```
