# Using GitHub Copilot as a Claude Code backend (macOS)

This guide sets up [`copilot-api`](https://github.com/ericc-ch/copilot-api) — a
local proxy that translates Anthropic-style requests into GitHub Copilot API
calls — so Claude Code can run against your GitHub Copilot subscription
instead of a direct Anthropic API key.

It uses **lweitzendorf's fork** (https://github.com/lweitzendorf/copilot-api),
which includes two fixes not yet in upstream:

- **Dynamic model-name resolution**: correctly maps Claude Code's dated model
  ids (e.g. `claude-opus-4-6`, `claude-opus-5-5[1m]`) to whatever Copilot
  actually exposes, instead of collapsing them to a hardcoded (and often
  unsupported) id. Fixes `400 model_not_supported` errors.
- **Assistant-message "prefill" fix**: some Copilot-backed models reject any
  request whose conversation ends on an assistant message (a pattern Claude
  Code's compaction/resume flow can produce). This fork appends a synthetic
  continuation prompt so those requests succeed instead of failing with
  `400 invalid_request_body`.
- The fork also fixes packaging so `npm install` from the git repo actually
  works (upstream's `dist/` was never built when installed this way).

## 1. Install the fork

> `npm install -g <user>/<repo>` (installing a **global** package straight
> from a git URL) is unreliable in current npm versions — npm can symlink the
> installed package into its own internal, ephemeral cache folder, which
> silently breaks later. Use a local install plus `npm link` instead; this is
> stable and has been verified to work.

```bash
mkdir -p ~/tools/copilot-api-fork && cd ~/tools/copilot-api-fork
npm init -y
npm install lweitzendorf/copilot-api
cd node_modules/copilot-api
npm link
```

Verify it's on your `PATH` and working:

```bash
copilot-api --help
```

`npm link` puts the command in npm's global bin directory. With the
Homebrew Node installation used in this guide, that is `/opt/homebrew/bin`,
which is why the launchd plist in Step 2 uses
`/opt/homebrew/bin/copilot-api`. Confirm the actual location on your machine
with:

```bash
which copilot-api
npm prefix -g
```

The first time you run `copilot-api start`, it will prompt you to
authenticate with your GitHub account (device-code flow) and cache a token
locally.

```bash
copilot-api start --port 4141
```

Leave it running, open the printed URL, and complete the GitHub login. Once
it says `Listening on: http://localhost:4141/`, stop it with `Ctrl+C` — the
next section sets it up to run automatically instead.

## 2. Run it as a background service (auto-start on login)

Create a `launchd` LaunchAgent so `copilot-api` starts automatically and
restarts if it crashes.

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
```

Create the plist with this block. It discovers the executable and Node
location from Step 1, so it works with Homebrew, Intel Homebrew, nvm, or a
manual Node installation without editing paths or replacing placeholders:

```bash
COPILOT_API_BIN="$(command -v copilot-api)"
NODE_BIN="$(dirname "$(command -v node)")"

cat > "$HOME/Library/LaunchAgents/com.copilot-api.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.copilot-api</string>
  <key>ProgramArguments</key>
  <array>
    <string>${COPILOT_API_BIN}</string>
    <string>start</string>
    <string>--port</string>
    <string>4141</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/copilot-api.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/copilot-api.error.log</string>
  <key>WorkingDirectory</key>
  <string>${HOME}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_BIN}:${HOME}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF
```

The plist uses the exact `copilot-api` and `node` locations selected by your
current shell. If you later switch Node versions, recreate the plist and
reload it so launchd uses the new installation.

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.copilot-api.plist
```

Verify it's running:

```bash
launchctl print gui/$(id -u)/com.copilot-api | head -10
curl -s http://localhost:4141/v1/models | head -c 200
```

Useful commands:

```bash
# Restart after an update/patch
launchctl kickstart -k gui/$(id -u)/com.copilot-api

# Stop and unload entirely
launchctl bootout gui/$(id -u)/com.copilot-api

# Tail logs
tail -f ~/Library/Logs/copilot-api.log
tail -f ~/Library/Logs/copilot-api.error.log
```

It will now start automatically on every login/reboot and auto-restart if it
crashes.

## 3. Configure Claude Code to use it

The only setting that actually matters for routing Claude Code through the
proxy is `ANTHROPIC_BASE_URL`. Edit `~/.claude/settings.json` (create it if
it doesn't exist):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141"
  }
}
```

That's the complete Claude Code configuration required for `copilot-api`.

Verify the model actually being served (don't just trust what the CLI
displays) by checking `modelUsage` in a scripted call:

```bash
claude -p "reply with just the word OK" --output-format json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['modelUsage'])"
```

That's it — run `claude` normally and it will talk to GitHub Copilot via the
local proxy instead of Anthropic directly.

## 4. Add to your shell config (`~/.zshrc`)

`copilot-api` runs as a `launchd` service (Step 2), so you don't need
`copilot-api` on your `PATH` for day-to-day use. If you installed Node via
Homebrew (the common case), `npm link`'s global bin dir (`/opt/homebrew/bin`)
is already on `PATH` automatically via `brew shellenv` in `/etc/zprofile` —
no `~/.zshrc` change needed. (Only if you use `nvm`/a manual Node install and
`which copilot-api` prints nothing would you need to add npm's global bin
dir — `npm config get prefix` — to `PATH` yourself.)

A couple of optional quality-of-life aliases for managing the service:

```bash
alias copilot-api-status='launchctl print gui/$(id -u)/com.copilot-api | grep -i state'
alias copilot-api-restart='launchctl kickstart -k gui/$(id -u)/com.copilot-api'
alias copilot-api-logs='tail -f ~/Library/Logs/copilot-api.log ~/Library/Logs/copilot-api.error.log'
```

**If you use [`cc-copilot-bridge`](https://github.com/FlorianBruniaux/cc-copilot-bridge)'s
`claude-switch`** (see Step 5 below), its model-alias generator gives you the
`ccc-*` shortcuts for free instead of hand-writing them — add this to
`~/.zshrc`:

```bash
eval "$(claude-switch --shell-config)"
```

This defines aliases like `ccc='claude-switch copilot'`,
`ccc-opus='COPILOT_MODEL=claude-opus-4-6 claude-switch copilot'`,
`ccc-sonnet='COPILOT_MODEL=claude-sonnet-4-6 claude-switch copilot'`, etc.
(run `claude-switch --shell-config` yourself to see the full current list —
it changes as the bridge is updated). Note these hardcode specific dated
model ids; this fork's dynamic model resolution will still map them to a
working model, but you may prefer to override the version, e.g.:

```bash
# Always launch plain `claude` through Copilot, pinned to a specific model,
# instead of hitting Anthropic directly
alias claude="COPILOT_MODEL=claude-opus-5.5 claude-switch copilot --model 'opus[1m]'"
```

Reload your shell (`source ~/.zshrc` or open a new terminal) for any of
these to take effect.

## 5. (Optional) Model-switching wrapper (`claude-switch` / `ccc-*` aliases)

If you use a wrapper script that launches Claude Code with a specific
`--model` per invocation (such as the `claude-switch` script from
[`cc-copilot-bridge`](https://github.com/FlorianBruniaux/cc-copilot-bridge)),
be aware:

- **The `--model` flag / the wrapper's model env var always wins** over
  `settings.json`'s `"model"` key and `CLAUDE_CODE_MODEL` — Claude Code's CLI
  flag has the highest precedence. If your alias hardcodes an old model id
  (e.g. `claude-opus-4-6`), that's what actually gets served, even if
  `settings.json` or the UI displays something newer — this fork's dynamic
  resolution will still map it to a working model, but not necessarily the
  latest one you might expect.
- To target a specific model explicitly, set the wrapper's model variable to
  the exact id you want, e.g.:
  ```bash
  COPILOT_MODEL=claude-opus-5.5 claude-switch copilot
  ```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `400 model_not_supported` | Claude Code sent a dated model id Copilot doesn't recognize verbatim | Confirm you're running the fork's `dist/main.js` (not upstream / an old cached global install) |
| `400 ... assistant message prefill ... must end with a user message` | Conversation ends on an assistant turn (compaction/resume) | Same as above — this fork patches around it |
| copilot-api not reachable / connection refused | Service isn't running | `launchctl print gui/$(id -u)/com.copilot-api`, check `~/Library/Logs/copilot-api.error.log` |
| `npm install -g <user>/copilot-api` fails or silently produces a broken binary | Known npm limitation with global git-dependency installs | Use the local install + `npm link` method in Step 1 instead |
