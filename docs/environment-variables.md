# Environment Variables Issue in OpenCode

## Problem Statement

OpenCode's bash tool does not automatically load environment variables from `.env` files, which creates significant limitations for development workflows.

### Current Behavior

- `.env` files are **not** loaded by default in OpenCode sessions
- The bash tool only has access to standard environment variables and OpenCode-specific ones
- Environment variables from `.env` files are **not** available in the bash tool's environment

### Impact

- Cannot run database commands without manual environment setup
- Cannot test API calls that require authentication tokens
- Cannot run scripts that expect configuration from environment variables
- Breaks standard development workflows

## Current Solution

The recommended workaround is to use the `source .env &&` pattern in npm scripts:

```json
{
  "scripts": {
    "dev": "source .env && vite dev --port $PORT --force",
  }
}
```

### How It Works

1. `source .env` loads the environment variables from the `.env` file
2. The variables become available in the current shell session
3. The subsequent command (`vite dev`, etc.) inherits these variables

### Limitations

- Only works for pnpm scripts, not arbitrary bash commands
- Requires manual setup for each script
- Does not solve the core issue for bash tool usage

## GitHub Issues

This is a known limitation being tracked in the OpenCode repository:

- [Issue #9334](https://github.com/anomalyco/opencode/issues/9334): How to make OpenCode load environment variables from a file when executing commands in skills
- [Issue #6936](https://github.com/anomalyco/opencode/issues/6936): Pass agents bash env variables OR pass agents bashrc files

## Alternative Workarounds

### Option 1: Manual Variable Setting

```bash
source .env && npm run dev
# or
export PORT=3000 && npm start
```

### Option 2: Wrapper Script

```bash
#!/bin/bash
set -a
source .env
set +a
exec "$@"
```

### Option 3: Use direnv

```bash
# .envrc
export $(cat .env | xargs)
```

## Future Solution

The ideal solution would be for OpenCode to automatically load `.env` files, similar to how Bun runtime normally handles them. This is tracked in GitHub issue #9334.

## Recommendation

Continue using the `source .env &&` pattern for npm scripts while waiting for the OpenCode feature to be implemented. For bash tool commands, consider creating wrapper scripts or using direnv for automatic environment loading.

---

_Last updated: February 2026_
