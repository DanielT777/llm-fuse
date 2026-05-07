import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { runLlmfuseCommand } from "@/lib/sandbox-runner";

export const maxDuration = 300;

const SYSTEM_PROMPT = [
  "You are an LLM agent that has been given a virtual filesystem mounted on top of an HTTP API.",
  "Use the `llmfuse` tool to navigate. The available commands are:",
  "  llmfuse ls <path>",
  "  llmfuse cat <path>",
  "  llmfuse stat <path>",
  "  llmfuse tree <path> --depth N",
  "  llmfuse invoke <path> --input <json>",
  "",
  "The mount point is /api. Start by calling `llmfuse ls /` to discover providers, then drill in.",
  "Trailing / marks directories. Trailing ! marks invokable actions.",
  "Be efficient: prefer `tree` over many `ls`, and only `cat` files you actually need.",
].join("\n");

export async function POST(req: Request): Promise<Response> {
  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: "anthropic/claude-sonnet-4.6",
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools: {
      llmfuse: tool({
        description:
          "Run an llmfuse shell command in a sandbox. The command should be one of: ls, cat, stat, tree, invoke.",
        inputSchema: z.object({
          command: z
            .string()
            .describe(
              "The shell command, e.g. 'ls /api/users' or 'cat /api/users/1/metadata.json'",
            ),
        }),
        execute: async ({ command }) => {
          const result = await runLlmfuseCommand(command);
          return {
            mode: result.mode,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr || undefined,
          };
        },
      }),
    },
    stopWhen: stepCountIs(12),
  });

  return result.toUIMessageStreamResponse();
}
