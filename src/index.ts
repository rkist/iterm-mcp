#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import CommandExecutor from "./CommandExecutor.js";
import TtyOutputReader from "./TtyOutputReader.js";
import SendControlCharacter from "./SendControlCharacter.js";
import SessionSelector, { SessionResolutionError, describeSession, formatSessionList } from "./SessionSelector.js";

const server = new Server(
  {
    name: "iterm-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const selector = new SessionSelector();

const sessionIdProperty = {
  type: "string",
  description: "iTerm session unique id (from list_terminal_sessions). Optional: by default the server picks a local shell session and keeps using it. Passing this switches the target."
};

const allowRemoteProperty = {
  type: "boolean",
  description: "Set true to deliberately write into a session that is running ssh/mosh or a container shell. Without it such writes are refused so commands never run on the wrong machine."
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "write_to_terminal",
        description: "Writes text to an iTerm terminal - often used to run a command in the terminal. Targets a local shell session (auto-selected and then pinned); refuses sessions running ssh or container shells unless allowRemote is true.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The command to run or text to write to the terminal"
            },
            sessionId: sessionIdProperty,
            allowRemote: allowRemoteProperty,
          },
          required: ["command"]
        }
      },
      {
        name: "read_terminal_output",
        description: "Reads the output from the targeted iTerm terminal (the same session write_to_terminal uses)",
        inputSchema: {
          type: "object",
          properties: {
            linesOfOutput: {
              type: "integer",
              description: "The number of lines of output to read."
            },
            sessionId: sessionIdProperty,
          },
          required: ["linesOfOutput"]
        }
      },
      {
        name: "send_control_character",
        description: "Sends a control character to the targeted iTerm terminal (e.g., Control-C, or special sequences like ']' for telnet escape)",
        inputSchema: {
          type: "object",
          properties: {
            letter: {
              type: "string",
              description: "The letter corresponding to the control character (e.g., 'C' for Control-C, ']' for telnet escape)"
            },
            sessionId: sessionIdProperty,
          },
          required: ["letter"]
        }
      },
      {
        name: "list_terminal_sessions",
        description: "Lists all iTerm sessions with their id, tty, what is running in the foreground (local shell, ssh/remote, container, tmux, busy), which one is focused, and which one this server currently targets. Use it to pick a sessionId.",
        inputSchema: {
          type: "object",
          properties: {},
        }
      },
      {
        name: "open_terminal_session",
        description: "Opens a new local iTerm tab (or window if none exists), waits for its shell prompt, and makes it the target for subsequent tool calls. Use when every existing session is remote or busy, or when you want a clean shell.",
        inputSchema: {
          type: "object",
          properties: {},
        }
      }
    ]
  };
});

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  try {
    switch (request.params.name) {
      case "write_to_terminal": {
        const session = await selector.resolve({
          sessionId: optionalString(args.sessionId),
          allowRemote: args.allowRemote === true,
          forWrite: true,
        });
        const header = `[target: ${describeSession(session)}]`;

        let executor = new CommandExecutor();
        const command = String(args.command);
        const beforeCommandBuffer = await TtyOutputReader.retrieveBuffer(session.id);
        const beforeCommandBufferLines = beforeCommandBuffer.split("\n").length;

        await executor.executeCommand(command, session.id);

        const afterCommandBuffer = await TtyOutputReader.retrieveBuffer(session.id);
        const afterCommandBufferLines = afterCommandBuffer.split("\n").length;
        const outputLines = afterCommandBufferLines - beforeCommandBufferLines

        return {
          content: [{
            type: "text",
            text: `${header}\n${outputLines} lines were output after sending the command to the terminal. Read the last ${outputLines} lines of terminal contents to orient yourself. Never assume that the command was executed or that it was successful.`
          }]
        };
      }
      case "read_terminal_output": {
        const session = await selector.resolve({
          sessionId: optionalString(args.sessionId),
          forWrite: false,
        });
        const linesOfOutput = Number(args.linesOfOutput) || 25
        const output = await TtyOutputReader.call(linesOfOutput, session.id)

        return {
          content: [{
            type: "text",
            text: `[target: ${describeSession(session)}]\n${output}`
          }]
        };
      }
      case "send_control_character": {
        const session = await selector.resolve({
          sessionId: optionalString(args.sessionId),
          forWrite: false,
        });
        const ttyControl = new SendControlCharacter();
        const letter = String(args.letter);
        await ttyControl.send(letter, session.id);

        return {
          content: [{
            type: "text",
            text: `[target: ${describeSession(session)}]\nSent control character: Control-${letter.toUpperCase()}`
          }]
        };
      }
      case "list_terminal_sessions": {
        const sessions = await selector.listSessions();
        return {
          content: [{
            type: "text",
            text: formatSessionList(sessions, selector.pinnedSessionId)
          }]
        };
      }
      case "open_terminal_session": {
        const session = await selector.openNewSession();
        return {
          content: [{
            type: "text",
            text: `[target: ${describeSession(session)}]\nOpened a new iTerm tab. Subsequent calls target session ${session.id} unless a sessionId is passed.`
          }]
        };
      }
      default:
        throw new Error("Unknown tool");
    }
  } catch (error: unknown) {
    if (error instanceof SessionResolutionError) {
      return {
        isError: true,
        content: [{ type: "text", text: error.message }]
      };
    }
    throw error;
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
