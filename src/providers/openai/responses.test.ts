import { expect, test } from "bun:test";
import type OpenAI from "openai";
import { z } from "zod";
import { Agent, defineTool } from "../../index.js";
import { OpenAIResponsesModel } from "./responses.js";

function scriptedClient(turns: readonly (readonly unknown[])[]) {
  const requests: OpenAI.Responses.ResponseCreateParamsStreaming[] = [];
  const client = {
    responses: {
      create: async (request: OpenAI.Responses.ResponseCreateParamsStreaming) => {
        const events = turns[requests.length];
        requests.push(request);
        if (!events) throw new Error("Unexpected model request.");
        return (async function* () {
          yield* events;
        })();
      },
    },
  } as unknown as OpenAI;
  return { client, requests };
}

const answer = [
  { type: "response.output_text.delta", delta: "Found it." },
  { type: "response.completed", response: { id: "resp_2", output: [] } },
];

test("replays completed Responses items in order alongside the tool result with storage disabled", async () => {
  const streamedReasoning = {
    type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ciphertext_item",
  } satisfies OpenAI.Responses.ResponseReasoningItem;
  const assistant = {
    type: "message", id: "msg_1", role: "assistant", status: "completed", phase: "commentary",
    content: [{ type: "output_text", text: "Looking it up.", annotations: [] }],
  } satisfies OpenAI.Responses.ResponseOutputMessage;
  const finalReasoning = {
    type: "reasoning", id: "rs_2", summary: [], encrypted_content: "ciphertext_response",
  } satisfies OpenAI.Responses.ResponseReasoningItem;
  const call = {
    type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{ "key": "one" }',
  } satisfies OpenAI.Responses.ResponseFunctionToolCall;
  const { client, requests } = scriptedClient([
    [
      { type: "response.output_item.added", output_index: 0, item: { ...streamedReasoning, encrypted_content: "partial" } },
      { type: "response.reasoning_summary_text.delta", delta: "Check the record." },
      { type: "response.output_item.done", output_index: 0, item: streamedReasoning },
      { type: "response.output_text.delta", delta: "Looking it up." },
      { type: "response.output_item.done", output_index: 1, item: assistant },
      { type: "response.output_item.done", output_index: 2, item: { ...finalReasoning, encrypted_content: null } },
      { type: "response.output_item.done", output_index: 3, item: call },
      { type: "response.completed", response: { id: "resp_1", output: [
        { ...streamedReasoning, encrypted_content: null }, assistant, finalReasoning, call,
      ] } },
    ],
    answer,
  ]);
  const reasoning = { effort: "medium", summary: "auto" } as const;
  const agent = new Agent({
    model: new OpenAIResponsesModel({ client, model: "test-model", store: false, reasoning }),
    tools: [defineTool({
      name: "lookup",
      description: "Look up a record.",
      input: z.object({ key: z.string() }),
      annotations: { readOnly: true },
      execute: ({ key }) => ({ key, found: true }),
    })],
  });
  const question = { role: "user", content: "Look it up." } as const;

  const events = await Array.fromAsync(agent.stream({ messages: [question] }));

  expect(events).toContainEqual(expect.objectContaining({
    type: "message.delta",
    delta: { type: "reasoning", text: "Check the record." },
  }));
  expect(events.at(-1)).toMatchObject({ type: "agent.completed", message: { content: "Found it." } });
  expect(requests[0]).toMatchObject({ store: false, reasoning, include: ["reasoning.encrypted_content"] });
  expect(requests[1]?.input).toEqual([
    question,
    streamedReasoning,
    assistant,
    finalReasoning,
    call,
    { type: "function_call_output", call_id: "call_1", output: '{"key":"one","found":true}' },
  ]);
});

test("sends ordered text, URL and base64 images, and a PDF to OpenAI Responses", async () => {
  const { client, requests } = scriptedClient([answer]);
  const model = new OpenAIResponsesModel({ client, model: "test-model" });
  const imageData = btoa("image");
  const pdfData = btoa("pdf");
  await Array.fromAsync(model.stream({ messages: [{ role: "user", content: [
    { type: "text", text: "Compare these." },
    { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
    { type: "file", mediaType: "application/pdf", filename: "report.pdf", data: pdfData },
    { type: "image", source: { type: "base64", mediaType: "image/png", data: imageData } },
  ] }] }));

  expect(requests[0]?.input).toEqual([{ role: "user", content: [
    { type: "input_text", text: "Compare these." },
    { type: "input_image", image_url: "https://example.com/image.png", detail: "auto" },
    { type: "input_file", filename: "report.pdf", file_data: `data:application/pdf;base64,${pdfData}` },
    { type: "input_image", image_url: `data:image/png;base64,${imageData}`, detail: "auto" },
  ] }]);
});
