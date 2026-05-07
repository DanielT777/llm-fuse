import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { runLlmfuseCommand } from "@/lib/sandbox-runner";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

const PRIMARY_MODEL = "openai/gpt-oss-120b:free";

const FALLBACK_MODELS = [
  "z-ai/glm-4.5-air:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

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

const MODEL_ID = process.env.OPENROUTER_MODEL ?? PRIMARY_MODEL;

export async function POST(req: Request): Promise<Response> {
  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const modelMessages = await convertToModelMessages(messages);
  const reqId = Math.random().toString(36).slice(2, 8);

  console.log(`[chat:${reqId}] start model=${MODEL_ID} msgs=${modelMessages.length}`);

  const result = streamText({
    model: openrouter(MODEL_ID, {
      extraBody: { models: [MODEL_ID, ...FALLBACK_MODELS] },
    }),
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
          console.log(`[chat:${reqId}] tool.exec  $ llmfuse ${command}`);
          try {
            const result = await runLlmfuseCommand(command);
            console.log(
              `[chat:${reqId}] tool.done  exit=${result.exitCode} mode=${result.mode} ${result.durationMs}ms ${result.stdout.length}B`,
            );
            return {
              mode: result.mode,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              stdout: result.stdout,
              stderr: result.stderr || undefined,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[chat:${reqId}] tool.fail  ${msg}`);
            return {
              mode: "sandbox",
              exitCode: -1,
              durationMs: 0,
              stdout: "",
              stderr: `runtime error: ${msg}`,
            };
          }
        },
      }),
    },
    stopWhen: stepCountIs(12),
    onStepFinish: ({ text, toolCalls, finishReason, usage }) => {
      console.log(
        `[chat:${reqId}] step.done reason=${finishReason} text=${text.length}B toolCalls=${toolCalls.length} tokens=${usage?.totalTokens ?? "?"}`,
      );
    },
    onFinish: ({ finishReason, usage }) => {
      console.log(
        `[chat:${reqId}] finish reason=${finishReason} totalTokens=${usage?.totalTokens ?? "?"}`,
      );
    },
    onError: ({ error }) => {
      console.error(`[chat:${reqId}] ERROR`, error);
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    onError: (err) => {
      console.error(`[chat:${reqId}] stream error`, err);
      return err instanceof Error ? err.message : String(err);
    },
  });
}
