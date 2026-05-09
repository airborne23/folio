# Folio CLI — Installation Guide for AI Agents

> **Audience:** This document is designed for AI agents (Claude Code, Codex, etc.) to read and execute step-by-step. Each step includes the exact shell commands to run, expected outcomes, and error handling.

## One-Line Instruction for Users

Give this instruction to your AI agent:

```
Fetch https://github.com/folio-ai/folio/blob/main/CLI_INSTALL.md and follow the instructions to install Folio CLI, log in, and start the daemon on this machine.
```

---

## Step 1: Check if Folio CLI is already installed

Run:

```bash
folio version
```

- **If it prints a version string** (e.g. `folio v0.x.x`): skip to **Step 3**.
- **If command not found**: continue to **Step 2**.

---

## Step 2: Install the Folio CLI

> **Windows users:** Skip to [Option C: Windows (PowerShell)](#option-c-windows-powershell) below.

### Option A: Homebrew (preferred — macOS/Linux)

Check if Homebrew is available:

```bash
which brew
```

If `brew` is found, install via Homebrew:

```bash
brew install folio-ai/tap/folio
```

Then verify:

```bash
folio version
```

If the version prints successfully, skip to **Step 3**.

To upgrade later, run:

```bash
brew upgrade folio-ai/tap/folio
```

### Option B: Download from GitHub Releases (macOS/Linux, no Homebrew)

If Homebrew is not available, download the binary directly.

Detect OS and architecture, then download the correct archive:

```bash
OS=$(uname -s | tr '[:upper:]' '[:lower:]')   # "darwin" or "linux"
ARCH=$(uname -m)                                # "x86_64" or "arm64"

# Normalize architecture name
if [ "$ARCH" = "x86_64" ]; then
  ARCH="amd64"
fi

# Get the latest release tag from GitHub
LATEST=$(curl -sI https://github.com/folio-ai/folio/releases/latest | grep -i '^location:' | sed 's/.*tag\///' | tr -d '\r\n')

# Download and extract
VERSION="${LATEST#v}"
curl -sL "https://github.com/folio-ai/folio/releases/download/${LATEST}/folio-cli-${VERSION}-${OS}-${ARCH}.tar.gz" -o /tmp/folio.tar.gz
tar -xzf /tmp/folio.tar.gz -C /tmp folio
sudo mv /tmp/folio /usr/local/bin/folio
rm /tmp/folio.tar.gz
```

Verify:

```bash
folio version
```

**If this fails:**
- Check that `/usr/local/bin` is in `$PATH`.
- On Linux, you may need `chmod +x /usr/local/bin/folio`.
- If `sudo` is not available, install to a user-writable directory: `mv /tmp/folio ~/.local/bin/folio` and ensure `~/.local/bin` is in `$PATH`.

### Option C: Windows (PowerShell)

Run in PowerShell (no admin required):

```powershell
irm https://raw.githubusercontent.com/folio-ai/folio/main/scripts/install.ps1 | iex
```

This downloads the latest Windows binary from GitHub Releases, installs it to `%USERPROFILE%\.folio\bin\`, and adds it to your user PATH.

Verify:

```powershell
folio version
```

**If this fails:**
- Restart your terminal so the updated PATH takes effect.
- If you use Scoop, the installer will use it automatically: `scoop bucket add folio https://github.com/folio-ai/scoop-bucket.git && scoop install folio`
- If your execution policy blocks the script: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` then re-run.

---

## Step 3: Log in

Run:

```bash
folio login
```

**Important:** This command opens a browser window for OAuth authentication. Tell the user:

> "A browser window will open for Folio login. Please complete the authentication in your browser, then come back here."

Wait for the command to complete. It will automatically discover and watch all workspaces the user belongs to.

Verify:

```bash
folio auth status
```

Expected output should show the authenticated user and server URL.

**If login fails:**
- If no browser is available (headless environment), the user can generate a Personal Access Token at `https://app.folio.ai/settings` and run: `folio login --token <fol_...>` (use `--token=` with an empty value to be prompted interactively).
- For self-hosted setups, `folio setup self-host --server-url <URL> --app-url <URL> --token <fol_...>` does config + login + daemon start in one command — useful for fleet provisioning where every node skips the browser flow.
- If the server URL needs to be customized: `folio config set server_url <url>` before logging in.

---

## Step 4: Start the daemon

First, check if the daemon is already running:

```bash
folio daemon status
```

- **If status is "running"**: skip to **Step 5**.
- **If status is "stopped"**: start it:

```bash
folio daemon start
```

Wait 3 seconds, then verify:

```bash
folio daemon status
```

Expected output should show `running` status with detected agents (e.g. `claude`, `codex`, `copilot`, `opencode`, `openclaw`, `hermes`, `gemini`, `pi`, `cursor-agent`).

**If daemon fails to start:**
- Check logs: `folio daemon logs`
- If a port conflict occurs, the daemon may already be running under a different profile.
- If no agents are detected, ensure at least one AI CLI (`claude`, `codex`, `copilot`, `opencode`, `openclaw`, `hermes`, `gemini`, `pi`, or `cursor-agent`) is installed and on the `$PATH`.

---

## Step 5: Verify everything is working

Run:

```bash
folio daemon status
```

Confirm:
1. Status is `running`
2. At least one agent is listed (e.g. `claude`, `codex`, `copilot`, `opencode`, `openclaw`, `hermes`, `gemini`, `pi`, or `cursor-agent`)
3. At least one workspace is being watched

If the agents list is empty, tell the user:

> "The Folio daemon is running but no AI agent CLIs were detected. Please install at least one supported CLI (`claude`, `codex`, `copilot`, `opencode`, `openclaw`, `hermes`, `gemini`, `pi`, or `cursor-agent`), then restart the daemon with `folio daemon stop && folio daemon start`."

---

## Summary

When all steps are complete, inform the user:

> "Folio CLI is installed and the daemon is running. Agents in your workspaces can now execute tasks on this machine. You can manage workspaces with `folio workspace list` and view daemon logs with `folio daemon logs -f`."
