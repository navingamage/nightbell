/**
 * OpenRouter adapter tests, against a fake OpenRouter.
 *
 * A real HTTP server rather than a stubbed fetch, because the two things most
 * likely to be wrong here are both wire-level: whether the request we build is
 * one the chat-completions schema will accept, and whether the SSE decoder
 * survives events arriving split across network chunks. Neither shows up if the
 * transport is mocked away.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenRouterModel } from "./openrouter.js";
import type { ConversationTurn, ToolDefinition } from "./types.js";

interface WireRequest {
  model: string;
  messages: Array<{
    role: string;
    content: unknown;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }>;
  tools?: Array<{ type: string; function: { name: string; parameters: unknown } }>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "record_details",
    description: "Record facts the caller gave you.",
    input_schema: { type: "object", properties: { caller_name: { type: "string" } } },
  },
];

/** One SSE frame, as OpenRouter writes them. */
function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textChunk(content: string): string {
  return sse({ choices: [{ delta: { content } }] });
}

let server: Server;
let baseUrl: string;
let received: WireRequest[];
/** Bytes the fake server writes, in the order and grouping given. */
let script: string[];

beforeEach(async () => {
  received = [];
  script = [textChunk("Okay."), "data: [DONE]\n\n"];

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push(JSON.parse(raw) as WireRequest);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of script) res.write(piece);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function newModel(model = "openai/gpt-test"): OpenRouterModel {
  return new OpenRouterModel({ apiKey: "test-key", model, baseUrl });
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function ask(
  model: OpenRouterModel,
  history: ConversationTurn[],
  context = "",
  signal = new AbortController().signal,
) {
  return model.respond({ system: "SYSTEM", context, history, tools: TOOLS, signal });
}

describe("OpenRouterModel: streaming", () => {
  it("yields sentences as they complete", async () => {
    script = [
      textChunk("Okay, Dana. "),
      textChunk("What's the address"),
      textChunk(" of the property?"),
      "data: [DONE]\n\n",
    ];
    const response = ask(newModel(), [{ role: "user", content: "hello" }]);
    expect(await collect(response.sentences)).toEqual([
      "Okay, Dana.",
      "What's the address of the property?",
    ]);
  });

  it("decodes events split across network chunks", async () => {
    // A frame arriving in three writes is normal, not exotic: the decoder has to
    // carry a partial line into the next chunk or it drops the whole event.
    const frame = textChunk("Got it.");
    script = [frame.slice(0, 12), frame.slice(12, 30), frame.slice(30), "data: [DONE]\n\n"];
    const response = ask(newModel(), [{ role: "user", content: "hello" }]);
    expect(await collect(response.sentences)).toEqual(["Got it."]);
  });

  it("skips the keep-alive comments OpenRouter sends while upstream warms up", async () => {
    script = [": OPENROUTER PROCESSING\n\n", textChunk("Got it."), "data: [DONE]\n\n"];
    const response = ask(newModel(), [{ role: "user", content: "hello" }]);
    expect(await collect(response.sentences)).toEqual(["Got it."]);
  });

  it("assembles tool calls from their fragments", async () => {
    // The id and name arrive once, the arguments a few characters at a time.
    script = [
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "record_details", arguments: '{"call' } },
              ],
            },
          },
        ],
      }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'er_name":' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Dana"}' } }] } }] }),
      "data: [DONE]\n\n",
    ];
    const response = ask(newModel(), [{ role: "user", content: "Dana" }]);
    await collect(response.sentences);
    expect(await response.toolCalls).toEqual([
      { id: "call_1", name: "record_details", input: { caller_name: "Dana" } },
    ]);
  });

  it("treats unparseable tool arguments as an empty filing rather than a failed turn", async () => {
    script = [
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "record_details", arguments: "{trunc" } },
              ],
            },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];
    const response = ask(newModel(), [{ role: "user", content: "Dana" }]);
    await collect(response.sentences);
    expect(await response.toolCalls).toEqual([
      { id: "call_1", name: "record_details", input: {} },
    ]);
  });

  it("reports an HTTP failure through the sentence stream", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    const response = ask(newModel(), [{ role: "user", content: "hello" }]);
    await expect(collect(response.sentences)).rejects.toThrow(/429/);
    await expect(response.toolCalls).rejects.toThrow(/429/);
  });

  it("does not leave the tool-call rejection unhandled when only the sentences are read", async () => {
    // The session reads the sentences, the iterator throws, its catch ends the
    // turn, and nobody ever awaits the tool calls. An unhandled rejection at
    // that point takes the whole process down and every other live call with it.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer((_req, res) => {
      res.writeHead(500).end("upstream exploded");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const response = ask(newModel(), [{ role: "user", content: "hello" }]);
      await expect(collect(response.sentences)).rejects.toThrow(/500/);
      // Two ticks, which is when an unhandled rejection would be reported.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("treats an abort as a barge-in, not an error", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = ask(newModel(), [{ role: "user", content: "hello" }], "", controller.signal);
    expect(await collect(response.sentences)).toEqual([]);
    expect(await response.toolCalls).toEqual([]);
  });
});

describe("OpenRouterModel: request shape", () => {
  it("sends the system prompt first and the per-turn state last", async () => {
    const response = ask(newModel(), [{ role: "user", content: "hello" }], "STATE");
    await collect(response.sentences);

    const messages = received[0]!.messages;
    expect(messages[0]).toEqual({ role: "system", content: "SYSTEM" });
    // Last, and in the system role: delivered as a user message, a cheap model
    // answers it as though the caller had said it, and reads the state block
    // down the phone line.
    expect(messages[messages.length - 1]).toEqual({ role: "system", content: "STATE" });
  });

  it("converts tools into the chat-completions function shape", async () => {
    const response = ask(newModel(), [{ role: "user", content: "hello" }]);
    await collect(response.sentences);

    expect(received[0]!.tools).toEqual([
      {
        type: "function",
        function: {
          name: "record_details",
          description: TOOLS[0]!.description,
          parameters: TOOLS[0]!.input_schema,
        },
      },
    ]);
  });

  it("reattaches a tool result to the assistant turn that made the call", async () => {
    // The transcript carries the id a result answers and nothing else, because
    // the name and arguments were the model's own. A `tool` message is only
    // legal after an assistant message that made the matching call, so the
    // adapter has to put the call back.
    const model = newModel();
    script = [
      textChunk("Got it."),
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "record_details", arguments: '{"caller_name":"Dana"}' },
                },
              ],
            },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];

    const first = ask(model, [{ role: "user", content: "Dana" }]);
    await collect(first.sentences);
    await first.toolCalls;

    const second = ask(model, [
      { role: "user", content: "Dana" },
      { role: "assistant", content: "Got it." },
      { role: "tool_result", toolUseId: "call_1", content: '{"recorded":["caller_name"]}' },
      { role: "user", content: "the basement is flooded" },
    ]);
    await collect(second.sentences);

    const messages = received[1]!.messages;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "record_details", arguments: '{"caller_name":"Dana"}' },
      },
    ]);
    const toolMessage = messages[messages.indexOf(assistant) + 1]!;
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.tool_call_id).toBe("call_1");
  });

  it("invents an assistant turn when the model called a tool and said nothing", async () => {
    const model = newModel();
    script = [
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_9", function: { name: "record_details", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];
    const first = ask(model, [{ role: "user", content: "Dana" }]);
    await collect(first.sentences);
    await first.toolCalls;

    const second = ask(model, [
      { role: "user", content: "Dana" },
      { role: "tool_result", toolUseId: "call_9", content: "{}" },
    ]);
    await collect(second.sentences);

    const messages = received[1]!.messages;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("");
    expect(assistant.tool_calls).toHaveLength(1);
    expect(messages[messages.indexOf(assistant) + 1]!.role).toBe("tool");
  });

  it("degrades a result whose call it never made to plain text", async () => {
    // Rather than sending a `tool` message the API will reject outright.
    const response = ask(newModel(), [
      { role: "user", content: "Dana" },
      { role: "tool_result", toolUseId: "call_from_elsewhere", content: '{"recorded":[]}' },
    ]);
    await collect(response.sentences);

    const messages = received[0]!.messages;
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    expect(messages.some((m) => typeof m.content === "string" && m.content.startsWith("Tool result:"))).toBe(true);
  });

  it("marks a cache breakpoint for Anthropic models and nobody else", async () => {
    const anthropic = ask(newModel("anthropic/claude-haiku-4.5"), [
      { role: "user", content: "hello" },
    ], "STATE");
    await collect(anthropic.sentences);

    const system = received[0]!.messages[0]!;
    expect(system.content).toEqual([
      { type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } },
    ]);
    // The breakpoint goes before the per-turn state, never on it: the clock
    // reading changes every turn, so a prefix that includes it never matches.
    expect(received[0]!.messages[received[0]!.messages.length - 1]).toEqual({
      role: "system",
      content: "STATE",
    });

    const other = ask(newModel(), [{ role: "user", content: "hello" }], "STATE");
    await collect(other.sentences);
    expect(received[1]!.messages[0]).toEqual({ role: "system", content: "SYSTEM" });
  });
});
