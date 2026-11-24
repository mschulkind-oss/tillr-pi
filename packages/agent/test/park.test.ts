import { fauxAssistantMessage, fauxToolCall, type Message, type Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "../src/index.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

/** Answer each request with the next message, recording the context each request saw. */
function scriptedStream(responses: ReturnType<typeof fauxAssistantMessage>[]) {
	const contexts: Message[][] = [];
	const stream = vi.fn<StreamFn>((_model, context) => {
		contexts.push(context.messages);
		const message = responses.shift() ?? fauxAssistantMessage("unexpected request");
		const events = createAssistantMessageEventStream();
		queueMicrotask(() => {
			events.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			events.end(message);
		});
		return events;
	});
	return { stream, contexts };
}

function tool(name: string, execute: AgentTool["execute"]): AgentTool {
	return { name, label: name, description: name, parameters: obj({}, { open: true }), execute };
}

describe("parked tool calls", () => {
	it.each(["sequential", "parallel"] as const)(
		"keeps a %s call unanswered and finishes siblings without another request or turn hook",
		async (toolExecution) => {
			const calls = [fauxToolCall("park", {}), fauxToolCall("sibling", {})];
			const { stream } = scriptedStream([
				fauxAssistantMessage(calls, { stopReason: "toolUse" }),
				fauxAssistantMessage("must not be requested"),
			]);
			const agent = new Agent({
				streamFn: stream,
				toolExecution,
				initialState: {
					model,
					tools: [
						tool("park", async () => ({ content: [], details: {}, park: true })),
						tool("sibling", async () => ({ content: [], details: {} })),
					],
				},
			});
			const events: AgentEvent[] = [];
			agent.subscribe((event) => {
				events.push(event);
			});
			agent.finishTurn = vi.fn();
			agent.afterToolCall = vi.fn();
			await agent.prompt("start");
			expect(stream).toHaveBeenCalledTimes(1);
			expect(agent.finishTurn).not.toHaveBeenCalled();
			expect(agent.afterToolCall).toHaveBeenCalledTimes(1);
			expect(agent.afterToolCall).toHaveBeenCalledWith(
				expect.objectContaining({ toolCall: calls[1] }),
				expect.anything(),
			);
			expect(agent.state.messages.filter((message) => message.role === "toolResult")).toMatchObject([
				{ toolCallId: calls[1].id },
			]);
			expect(events).toContainEqual({ type: "parked", toolCallId: calls[0].id, toolName: "park" });
			expect(events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolCallId)).toEqual(
				[calls[1].id],
			);
			expect(events.filter((event) => event.type === "turn_end")).toHaveLength(0);
			expect(events.at(-1)?.type).toBe("agent_end");
			expect(agent.hasPendingToolCalls()).toBe(true);
		},
	);

	it("replays only the unanswered call with its original id and arguments, then parks again or answers", async () => {
		const answered = fauxToolCall("done", { value: "a" });
		const parked = fauxToolCall("park", { value: "b" });
		const assistant = fauxAssistantMessage([answered, parked], { stopReason: "toolUse" });
		const transcript: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: answered.id,
				toolName: "done",
				content: [{ type: "text", text: "a" }],
				isError: false,
				timestamp: 2,
			},
		];
		let answer = false;
		const park = vi.fn<AgentTool["execute"]>(async () =>
			answer
				? { content: [{ type: "text", text: "answer" }], details: {} }
				: { content: [], details: {}, park: true },
		);
		const done = vi.fn<AgentTool["execute"]>(async () => ({ content: [], details: {} }));
		const { stream } = scriptedStream([]);
		const agent = new Agent({
			streamFn: stream,
			initialState: { model, messages: transcript, tools: [tool("park", park), tool("done", done)] },
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});
		expect(agent.hasPendingToolCalls()).toBe(true);

		await agent.completePendingToolCalls();
		expect(events).toContainEqual({ type: "parked", toolCallId: parked.id, toolName: "park" });
		expect(agent.hasPendingToolCalls()).toBe(true);

		answer = true;
		await agent.completePendingToolCalls();
		expect(stream).not.toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();
		expect(park).toHaveBeenCalledTimes(2);
		expect(park.mock.calls.map(([id, args]) => ({ id, args }))).toEqual([
			{ id: parked.id, args: { value: "b" } },
			{ id: parked.id, args: { value: "b" } },
		]);
		expect(agent.hasPendingToolCalls()).toBe(false);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: parked.id });
	});

	it("sends every result of a call batch right after its assistant message", async () => {
		const call = fauxToolCall("park", {});
		const { stream, contexts } = scriptedStream([fauxAssistantMessage("done")]);
		const agent = new Agent({
			streamFn: stream,
			initialState: {
				model,
				messages: [
					{ role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
					fauxAssistantMessage([call], { stopReason: "toolUse" }),
					// A message appended while the call was unanswered, e.g. by a startup hook.
					{ role: "user", content: [{ type: "text", text: "appended" }], timestamp: 2 },
					{
						role: "toolResult",
						toolCallId: call.id,
						toolName: "park",
						content: [{ type: "text", text: "answer" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
		});
		await agent.continue();
		expect(contexts[0].map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});
});
