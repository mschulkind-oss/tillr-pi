import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("parked tool calls in a session", () => {
	it("ends a parked run without the settle boundary, then replays the call before the next prompt", async () => {
		let answered = false;
		const settles: string[] = [];
		const extensionAgentEnds: number[] = [];
		const harness = await createHarness({
			tools: [
				{
					name: "park",
					label: "Park",
					description: "Park",
					parameters: Type.Object({}),
					execute: async () =>
						answered
							? { content: [{ type: "text", text: "answer" }], details: {} }
							: { content: [], details: {}, park: true },
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						settles.push("before_settle");
					});
					pi.on("agent_end", (event) => {
						extensionAgentEnds.push(event.messages.length);
					});
				},
			],
		});
		try {
			const call = fauxToolCall("park", {});
			harness.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" })]);
			await harness.session.prompt("start");
			expect(harness.session.parked).toBe(true);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.eventsOfType("parked")).toEqual([{ type: "parked", toolCallId: call.id, toolName: "park" }]);
			expect(harness.eventsOfType("agent_end")).toHaveLength(1);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
			expect(settles).toEqual([]);
			expect(extensionAgentEnds).toEqual([]);
			expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
			await harness.session.waitForIdle();

			answered = true;
			harness.setResponses([fauxAssistantMessage("continued")]);
			await harness.session.prompt("continue");
			expect(harness.session.parked).toBe(false);
			expect(harness.session.getLastAssistantText()).toBe("continued");
			// The replay settles on its own, then the prompt's run settles.
			expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
			const roles = harness.session.messages.map((message) => message.role);
			expect(roles.slice(roles.indexOf("assistant"))).toEqual(["assistant", "toolResult", "user", "assistant"]);
		} finally {
			harness.cleanup();
		}
	});

	it("drops the prompt when the replayed call parks again", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "park",
					label: "Park",
					description: "Park",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {}, park: true }),
				},
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage([fauxToolCall("park", {})], { stopReason: "toolUse" })]);
			await harness.session.prompt("start");
			await harness.session.prompt("again");
			expect(harness.session.parked).toBe(true);
			expect(harness.eventsOfType("parked")).toHaveLength(2);
			expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("resumes without a prompt from an unanswered call or a trailing result, and refuses otherwise", async () => {
		let answered = false;
		const harness = await createHarness({
			tools: [
				{
					name: "park",
					label: "Park",
					description: "Park",
					parameters: Type.Object({}),
					execute: async () =>
						answered
							? { content: [{ type: "text", text: "answer" }], details: {} }
							: { content: [], details: {}, park: true },
				},
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage([fauxToolCall("park", {})], { stopReason: "toolUse" })]);
			await harness.session.prompt("start");
			await harness.session.resumeWithoutPrompt();
			expect(harness.session.parked).toBe(true);
			expect(harness.eventsOfType("parked")).toHaveLength(2);

			answered = true;
			harness.setResponses([fauxAssistantMessage("resumed")]);
			await harness.session.resumeWithoutPrompt();
			expect(harness.session.parked).toBe(false);
			expect(harness.session.getLastAssistantText()).toBe("resumed");
			expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);

			await expect(harness.session.resumeWithoutPrompt()).rejects.toThrow(
				"No unanswered tool call or trailing tool result to continue",
			);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
