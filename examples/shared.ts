import OpenAI from "openai";
import { OpenAIChatCompletionsModel } from "../src/openai.js";
import type { LanguageModel } from "../src/index.js";

export interface ExampleModel {
  model: LanguageModel;
  modelId: string;
}

export function createExampleModel(modelId = process.env.REIN_MODEL): ExampleModel {
  const baseURL = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error("Set OPENAI_BASE_URL and OPENAI_API_KEY before running an example.");
  }
  if (!modelId) {
    throw new Error("Set REIN_MODEL to a model id served by your gateway.");
  }
  return {
    modelId,
    model: new OpenAIChatCompletionsModel({
      client: new OpenAI({ baseURL, apiKey }),
      model: modelId,
    }),
  };
}

export function describeSettings(): string {
  return [
    `base_url=${process.env.OPENAI_BASE_URL ?? "(unset)"}`,
    `model=${process.env.REIN_MODEL ?? "(unset)"}`,
  ].join(" ");
}

export function printEventSummary(event: { type: string }): void {
  process.stdout.write(`\n[event] ${event.type}\n`);
}
