import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

/**
 * A tool that parks until `$PARK_TEST_DIR/answer` exists, and a fake provider that asks for it
 * once. Calls, model requests and settle boundaries are recorded as JSON lines in that directory.
 * `PARK_STARTUP` makes session_start send a message: `append` without a turn, `wake` with one.
 */
export default function (pi: ExtensionAPI) {
	const dir = process.env.PARK_TEST_DIR!;
	pi.registerTool({
		name: "park_test",
		label: "Park test",
		description: "Park until answered",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (id, args) => {
			appendFileSync(join(dir, "calls"), `${JSON.stringify({ id, args })}\n`);
			return existsSync(join(dir, "answer"))
				? { content: [{ type: "text", text: "answer" }], details: {} }
				: { content: [], details: {}, park: true };
		},
	});
	pi.on("agent_before_settle", () => {
		appendFileSync(join(dir, "settles"), "settle\n");
	});
	pi.on("session_start", () => {
		const startup = process.env.PARK_STARTUP;
		if (startup) {
			pi.sendMessage(
				{ customType: "startup", content: "startup", display: true },
				{ triggerTurn: startup === "wake" },
			);
		}
	});
	pi.registerProvider("park-test", {
		baseUrl: "https://example.invalid",
		apiKey: "fake",
		api: "openai-completions",
		models: [
			{
				id: "park-model",
				name: "Park model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
		streamSimple: (model, context) => {
			appendFileSync(join(dir, "requests"), `${JSON.stringify(context.messages)}\n`);
			const hasResult = context.messages.some((message) => message.role === "toolResult");
			const message = {
				...fauxAssistantMessage(
					hasResult
						? "done"
						: [{ type: "toolCall", id: "park-call", name: "park_test", arguments: { value: "one" } }],
					{ stopReason: hasResult ? "stop" : "toolUse" },
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: hasResult ? "stop" : "toolUse", message });
				stream.end(message);
			});
			return stream;
		},
	});
}
