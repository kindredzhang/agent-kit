import { expect, test } from "bun:test";
import type OpenAI from "openai";
import { OpenAIChatCompletionsModel } from "./chat-completions.js";
import type { ModelRequest, ModelStreamEvent } from "../../core/types.js";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return { id: "chatcmpl-1", choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function modelFrom(
  chunks: readonly unknown[],
  requests: OpenAI.Chat.ChatCompletionCreateParamsStreaming[] = [],
): OpenAIChatCompletionsModel {
  const client = {
    chat: {
      completions: {
        create: async (request: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
          requests.push(request);
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  } as unknown as OpenAI;
  return new OpenAIChatCompletionsModel({ client, model: "test-model" });
}

async function collect(model: OpenAIChatCompletionsModel, request: ModelRequest = { messages: [] }) {
  const events: ModelStreamEvent[] = [];
  for await (const event of model.stream(request)) events.push(event);
  return events;
}

test("forwards reasoning_content as reasoning deltas", async () => {
  const events = await collect(modelFrom([
    chunk({ role: "assistant" }),
    chunk({ reasoning_content: "Think " }),
    chunk({ reasoning_content: "first." }),
    chunk({ content: "Answer." }, "stop"),
  ]));

  expect(events.filter((event) => event.type === "reasoning.delta")).toEqual([
    { type: "reasoning.delta", delta: "Think " },
    { type: "reasoning.delta", delta: "first." },
  ]);
  expect(events.filter((event) => event.type === "text.delta")).toEqual([
    { type: "text.delta", delta: "Answer." },
  ]);
});

test("emits text and refusals without inventing reasoning", async () => {
  const events = await collect(modelFrom([chunk({ content: "Hi." }, "stop")]));
  expect(events.some((event) => event.type === "reasoning.delta")).toBe(false);
  expect(events.at(-1)).toEqual({ type: "finish", finishReason: "stop", responseId: "chatcmpl-1" });
});

test("reports usage from the final chunk", async () => {
  const events = await collect(modelFrom([
    chunk({ content: "Hi." }, "stop"),
    { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ]));
  expect(events.filter((event) => event.type === "usage")).toEqual([
    { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  ]);
});

test("assembles streamed tool call arguments into one completed call", async () => {
  const events = await collect(modelFrom([
    chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"key\":" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "\"v\"}" } }] }),
    chunk({}, "tool_calls"),
    { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]));

  expect(events.filter((event) => event.type === "tool.call.completed")).toEqual([
    { type: "tool.call.completed", toolCall: { id: "call_1", name: "lookup", input: { key: "v" } } },
  ]);
  const argumentDeltas = events
    .filter((event) => event.type === "tool.call.arguments.delta")
    .map((event) => event.delta)
    .join("");
  expect(argumentDeltas).toBe("{\"key\":\"v\"}");
  expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool_calls" });
});

test("maps content_filter to a refusal finish reason", async () => {
  const events = await collect(modelFrom([chunk({ content: "" }, "content_filter")]));
  expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "refusal" });
});

test("sends ordered text, URL and base64 images, and a PDF to Chat Completions", async () => {
  const requests: OpenAI.Chat.ChatCompletionCreateParamsStreaming[] = [];
  const model = modelFrom([chunk({ content: "Done." }, "stop")], requests);
  const imageData = btoa("image");
  const pdfData = btoa("pdf");
  await collect(model, { messages: [{ role: "user", content: [
    { type: "text", text: "Compare these." },
    { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
    { type: "file", mediaType: "application/pdf", filename: "report.pdf", data: pdfData },
    { type: "image", source: { type: "base64", mediaType: "image/png", data: imageData } },
  ] }] });

  expect(requests[0]?.messages).toEqual([{ role: "user", content: [
    { type: "text", text: "Compare these." },
    { type: "image_url", image_url: { url: "https://example.com/image.png" } },
    { type: "file", file: { filename: "report.pdf", file_data: `data:application/pdf;base64,${pdfData}` } },
    { type: "image_url", image_url: { url: `data:image/png;base64,${imageData}` } },
  ] }]);
});
