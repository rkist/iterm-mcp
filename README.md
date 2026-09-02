# iterm-mcp 
A Model Context Protocol server that provides access to your iTerm session.

![Main Image](.github/images/demo.gif)

### Features

**Efficient Token Use:** iterm-mcp gives the model the ability to inspect only the output that the model is interested in. The model typically only wants to see the last few lines of output even for long running commands. 

**Natural Integration:** You share iTerm with the model. You can ask questions about what's on the screen, or delegate a task to the model and watch as it performs each step.

**Full Terminal Control and REPL support:** The model can start and interact with REPL's as well as send control characters like ctrl-c, ctrl-z, etc.

**Easy on the Dependencies:** iterm-mcp is built with minimal dependencies and is runnable via npx. It's designed to be easy to add to Claude Desktop and other MCP clients. It should just work.


## Safety Considerations

* The user is responsible for using the tool safely.
* No built-in restrictions: iterm-mcp makes no attempt to evaluate the safety of commands that are executed.
* Models can behave in unexpected ways. The user is expected to monitor activity and abort when appropriate.
* For multi-step tasks, you may need to interrupt the model if it goes off track. Start with smaller, focused tasks until you're familiar with how the model behaves. 

### Tools
- `write_to_terminal` - Writes to the targeted iTerm terminal, often used to run a command. Returns the number of lines of output produced by the command.
- `read_terminal_output` - Reads the requested number of lines from the targeted iTerm terminal.
- `send_control_character` - Sends a control character to the targeted iTerm terminal.
- `list_terminal_sessions` - Lists every iTerm session with its id, tty, what is running in it, which one is focused and which one is targeted.
- `open_terminal_session` - Opens a new local iTerm tab, waits for its prompt, and targets it.

All tools accept an optional `sessionId` (from `list_terminal_sessions`). `write_to_terminal` also accepts `allowRemote`.

### Which terminal gets used

Commands are not blindly sent to whatever tab happens to be focused. On each call the server inspects every iTerm session (iTerm's job info plus the foreground process group on the tty) and classifies it:

| Kind | Meaning | Auto-selected? | Writable by default? |
|---|---|---|---|
| `local-shell` | shell prompt on this Mac | yes | yes |
| `remote` | `ssh`, `mosh`, `telnet`, ... in the foreground | no | **no** |
| `container` | `docker exec`, `kubectl exec`, ... in the foreground | no | **no** |
| `multiplexer` | `tmux` / `screen` client; contents are not inspectable | no | yes |
| `busy` | some other program (vim, a REPL, a build) | no | yes |

Selection rules:

1. An explicit `sessionId` always wins and becomes the target.
2. Otherwise the previously targeted session is reused while it still exists, so the target does not drift when you click on other tabs.
3. Otherwise a local shell is picked: the focused one if it qualifies, then idle local shells in front-to-back window order.
4. If no local shell exists at all, a new tab is opened in the front window (or a new window if iTerm has none) and targeted. Set `ITERM_MCP_AUTO_NEW_TAB=0` to fail with the session list instead; the model can then call `open_terminal_session` explicitly.
5. Writing into a `remote` or `container` session is refused unless the call passes `allowRemote: true`, or the server runs with `ITERM_MCP_ALLOW_REMOTE=1`. This stops commands from silently running on another machine. Reading and control characters are never refused.

Every tool response starts with a `[target: ...]` line naming the session, tty and classification that was used.

Limitations: an `ssh` running inside a tmux pane is invisible from the outside, so tmux sessions are reported as `multiplexer` and never auto-selected. iTerm's `session.hostname` variable is deliberately not used because it only reflects the remote host when shell integration is installed there.

### Requirements

* iTerm2 must be running
* Node version 18 or greater


## Installation

To use with Claude Desktop, add the server config:

On macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "iterm-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "iterm-mcp"
      ]
    }
  }
}
```

### Installing via Smithery

To install iTerm for Claude Desktop automatically via [Smithery](https://smithery.ai/server/iterm-mcp):

```bash
npx -y @smithery/cli install iterm-mcp --client claude
```
[![smithery badge](https://smithery.ai/badge/iterm-mcp)](https://smithery.ai/server/iterm-mcp)

## Development

Install dependencies:
```bash
yarn install
```

Build the server:
```bash
yarn run build
```

For development with auto-rebuild:
```bash
yarn run watch
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is available as a package script:

```bash
yarn run inspector
yarn debug <command>
```

The Inspector will provide a URL to access debugging tools in your browser.
