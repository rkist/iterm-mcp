#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import CommandExecutor from "./CommandExecutor.js";
import TtyOutputReader from "./TtyOutputReader.js";
import SendControlCharacter from "./SendControlCharacter.js";
import SessionSelector, { SessionResolutionError, describeSession, formatSessionList } from "./SessionSelector.js";

/**
 * Sent to the client in the initialize response. A client that installs this
 * server sees nothing of this repository, so this is the only place to explain
 * what the server is for and when to reach for it rather than a built-in shell.
 */
const INSTRUCTIONS = `iterm-mcp drives the user's real iTerm2 terminal on this Mac. Commands run in a visible tab that the user is watching and can take over, in a shell that persists across tool calls with its own cwd, environment, history and running processes.

Prefer these tools over a built-in shell tool when:
- the user should see the command and its output in their own terminal, or asked about what is on screen;
- the work is interactive - a REPL, a prompt-driven installer, an ssh login, anything that reads from stdin;
- the work is long-running and worth watching, like a dev server or a build;
- later steps depend on shell state from earlier ones (an activated virtualenv, an exported variable, a directory you cd'd into).

A one-shot non-interactive command whose output only you need is usually better served by a built-in shell tool.

The normal loop is write_to_terminal, then read_terminal_output. write_to_terminal returns only the number of new output lines, never the output itself, so always read afterwards and never assume a command succeeded. Use send_control_character to interrupt or to talk to a REPL.

Tool calls target one local shell session, auto-selected on first use and then reused so the target does not drift when the user clicks other tabs. list_terminal_sessions shows every session and which one is targeted; open_terminal_session makes a fresh local tab and targets it; every response opens with a [target: ...] line naming the session actually used. Writes into a session running ssh, mosh or a container shell are refused unless the call passes allowRemote: true, so commands cannot silently execute on another machine.

Requires iTerm2 to be running on macOS. There is no allow-list or safety check on the commands themselves - the user is expected to be watching.`;

const server = new McpServer(
  {
    name: "iterm-mcp",
    version: "1.2.6",
  },
  {
    instructions: INSTRUCTIONS,
  }
);

const selector = new SessionSelector();

const sessionIdSchema = z.string()
  .optional()
  .describe("iTerm session unique id (from list_terminal_sessions). Optional: by default the server picks a local shell session and keeps using it. Passing this switches the target.");

const allowRemoteSchema = z.boolean()
  .optional()
  .describe("Set true to deliberately write into a session that is running ssh/mosh or a container shell. Without it such writes are refused so commands never run on the wrong machine.");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * Session resolution failures are expected outcomes with actionable messages
 * (which sessions exist, how to target one), so they are reported as tool
 * errors rather than thrown as protocol errors.
 */
async function withSessionErrors(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof SessionResolutionError) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    throw error;
  }
}

server.registerTool(
  "write_to_terminal",
  {
    title: "Write to terminal",
    description: "Writes text to an iTerm2 terminal session on this Mac - usually a command to run. Prefer this over a plain shell tool when the user should watch the command and its output in their own terminal, when the work is interactive (a REPL, a prompt-driven installer, an ssh login) or long-running (a dev server, a build worth watching), or when later calls need the same live shell with its state and history. Requires iTerm2 to be running. Returns only the number of new output lines, not the output itself - follow up with read_terminal_output to see what happened, and never assume the command succeeded. Targets a local shell session (auto-selected, then reused by later calls); refuses sessions running ssh or a container shell unless allowRemote is true.",
    inputSchema: {
      command: z.string().describe("The command to run or text to write to the terminal"),
      sessionId: sessionIdSchema,
      allowRemote: allowRemoteSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ command, sessionId, allowRemote }) => withSessionErrors(async () => {
    const session = await selector.resolve({
      sessionId: optionalString(sessionId),
      allowRemote: allowRemote === true,
      forWrite: true,
    });
    const header = `[target: ${describeSession(session)}]`;

    const executor = new CommandExecutor();
    const beforeCommandBuffer = await TtyOutputReader.retrieveBuffer(session.id);
    const beforeCommandBufferLines = beforeCommandBuffer.split("\n").length;

    await executor.executeCommand(command, session.id);

    const afterCommandBuffer = await TtyOutputReader.retrieveBuffer(session.id);
    const afterCommandBufferLines = afterCommandBuffer.split("\n").length;
    const outputLines = afterCommandBufferLines - beforeCommandBufferLines;

    return {
      content: [{
        type: "text",
        text: `${header}\n${outputLines} lines were output after sending the command to the terminal. Read the last ${outputLines} lines of terminal contents to orient yourself. Never assume that the command was executed or that it was successful.`
      }]
    };
  })
);

server.registerTool(
  "read_terminal_output",
  {
    title: "Read terminal output",
    description: "Reads the tail of the scrollback from the targeted iTerm2 session (the same session write_to_terminal uses). Use it after write_to_terminal to see a command's output, and to poll a long-running process while it prints.",
    inputSchema: {
      linesOfOutput: z.number().int().positive()
        .describe("How many lines to read, counted back from the bottom of the scrollback. The line count returned by write_to_terminal is a good value."),
      sessionId: sessionIdSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ linesOfOutput, sessionId }) => withSessionErrors(async () => {
    const session = await selector.resolve({
      sessionId: optionalString(sessionId),
      forWrite: false,
    });
    const output = await TtyOutputReader.call(linesOfOutput, session.id);

    return {
      content: [{
        type: "text",
        text: `[target: ${describeSession(session)}]\n${output}`
      }]
    };
  })
);

server.registerTool(
  "send_control_character",
  {
    title: "Send control character",
    description: "Sends a control character to the targeted iTerm2 session (the same one write_to_terminal uses) - Control-C to interrupt a running command, Control-D to end input, Control-Z to suspend, or a special sequence like ']' for the telnet escape.",
    inputSchema: {
      letter: z.string()
        .describe("The letter corresponding to the control character (e.g., 'C' for Control-C, ']' for telnet escape)"),
      sessionId: sessionIdSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ letter, sessionId }) => withSessionErrors(async () => {
    const session = await selector.resolve({
      sessionId: optionalString(sessionId),
      forWrite: false,
    });
    const ttyControl = new SendControlCharacter();
    await ttyControl.send(letter, session.id);

    return {
      content: [{
        type: "text",
        text: `[target: ${describeSession(session)}]\nSent control character: Control-${letter.toUpperCase()}`
      }]
    };
  })
);

server.registerTool(
  "list_terminal_sessions",
  {
    title: "List terminal sessions",
    description: "Lists all iTerm2 sessions with their id, tty, what is running in the foreground (local shell, ssh/remote, container, tmux, busy), which one is focused, and which one this server currently targets. Use it to pick a sessionId, or to check where commands will land before writing. Requires iTerm2 to be running.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async () => withSessionErrors(async () => {
    const sessions = await selector.listSessions();
    return {
      content: [{
        type: "text",
        text: formatSessionList(sessions, selector.pinnedSessionId)
      }]
    };
  })
);

server.registerTool(
  "open_terminal_session",
  {
    title: "Open terminal session",
    description: "Opens a new local iTerm2 tab (or a window if iTerm2 has none), waits for its shell prompt, and makes it the target for subsequent tool calls. Use when every existing session is remote, in a container or busy, or when you want a clean shell that no other work is using.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async () => withSessionErrors(async () => {
    const session = await selector.openNewSession();
    return {
      content: [{
        type: "text",
        text: `[target: ${describeSession(session)}]\nOpened a new iTerm tab. Subsequent calls target session ${session.id} unless a sessionId is passed.`
      }]
    };
  })
);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
