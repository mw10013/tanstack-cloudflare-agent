# Closing the Loop: LLM-Driven Development with Local Dev Server

## The Problem

When using an LLM to generate code for a local development server, there's a critical gap in the feedback loop:

1. **You** run `pnpm dev` (or similar) in your terminal
2. **The LLM** generates code and writes it to files
3. **The dev server** detects changes, rebuilds, and outputs results (errors, warnings, success) to the terminal
4. **The LLM** has no visibility into whether the code actually works

The terminal output showing build errors, runtime exceptions, or successful compilation is trapped in your terminal session—completely inaccessible to the LLM. This forces you to manually copy-paste error messages back to the LLM, breaking the autonomous workflow.

## The Solution

Stream the dev server output to a log file that the LLM can read on demand:

```bash
mkdir -p logs && pnpm dev 2>&1 | tee logs/server.log
```

This creates a continuous, real-time log file at `logs/server.log` containing everything the dev server outputs.

## How It Works

The closed loop now functions autonomously:

1. **LLM generates code** → Writes to source files
2. **Dev server detects changes** → Hot reloads and outputs results
3. **Output streams to `logs/server.log`** → Via `tee` command
4. **LLM reads `logs/server.log`** → Checks for errors or success
5. **LLM iterates** → Fixes issues based on log content
6. **Repeat** until working

## Usage

### Start the Dev Server with Logging

```bash
# Basic usage
pnpm dev 2>&1 | tee logs/server.log

# With timestamps for easier debugging
pnpm dev 2>&1 | while IFS= read -r line; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $line"
done | tee logs/server.log

# Filter to errors only (in a separate terminal)
tail -f logs/server.log | grep -i error
```

### LLM Access Pattern

The LLM can now autonomously:

```bash
# Check recent errors
tail -50 logs/server.log | grep -i error

# See full context
cat logs/server.log

# Watch real-time during testing
tail -f logs/server.log
```

## Benefits

- **No manual intervention**: LLM sees errors without you copying anything
- **Persistent history**: Full log of all attempts for debugging
- **Real-time feedback**: `tee` captures output immediately as it happens
- **Composable**: Works with any dev server (Vite, Next.js, TanStack Start, etc.)

## Limitations

- Log file grows indefinitely (rotate manually or use `logrotate`)
- Terminal output is still visible to you, but the LLM only sees the file
- If the dev server crashes, the pipe breaks

## Alternative: Named Pipe (FIFO)

For a more sophisticated approach without disk usage:

```bash
# Create pipe
mkfifo logs/server-pipe

# Terminal 1: Write to pipe
pnpm dev 2>&1 > logs/server-pipe

# LLM reads from pipe (blocking until data available)
cat logs/server-pipe
```

Note: This blocks the dev server if nothing is reading the pipe.

## Related Approaches

- **Browser testing**: Use `playwright-cli` to capture runtime errors from the browser
- **Structured logging**: Configure your app to output JSON logs for easier LLM parsing
- **MCP servers**: For IDE-integrated agents, Model Context Protocol servers can expose dev server output as tools
