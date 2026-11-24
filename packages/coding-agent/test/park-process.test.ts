import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = resolve(__dirname, "../src/cli.ts");
const resolver = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const extension = resolve(__dirname, "fixtures/park-extension.ts");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pi-park-"));
	dirs.push(dir);
	mkdirSync(join(dir, "agent"));
	const session = join(dir, "session.jsonl");
	const args = [
		"--mode",
		"json",
		"--session",
		session,
		"-e",
		extension,
		"--provider",
		"park-test",
		"--model",
		"park-model",
	];
	return { dir, session, args };
}

async function run(dir: string, args: string[], extra: Record<string, string> = {}) {
	const child = spawn(process.execPath, ["--import", resolver, cli, "--no-context-files", ...args], {
		cwd: dir,
		env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", PARK_TEST_DIR: dir, ...extra },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const code = await new Promise<number | null>((done, reject) => {
		child.on("error", reject);
		child.on("close", done);
	});
	return { code, stdout, stderr };
}

function lines(path: string): unknown[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
}

function events(stdout: string): Array<{ type: string }> {
	return stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

function savedToolResults(session: string): unknown[] {
	return (lines(session) as Array<{ message?: { role: string } }>).filter(
		(entry) => entry.message?.role === "toolResult",
	);
}

describe("parked calls in print processes", () => {
	it.each(["none", "append", "wake"])(
		"parks, replays once before a promptless request with startup %s, then refuses another opening",
		async (startup) => {
			const { dir, session, args } = setup();
			const first = await run(dir, [...args, "start"]);
			expect(first.code, first.stderr).toBe(0);
			const firstEvents = events(first.stdout);
			expect(firstEvents).toContainEqual({ type: "parked", toolCallId: "park-call", toolName: "park_test" });
			expect(firstEvents.map((event) => event.type)).not.toContain("agent_settled");
			const parkedAt = firstEvents.findIndex((event) => event.type === "parked");
			expect(firstEvents.slice(parkedAt).map((event) => event.type)).toContain("agent_end");
			expect(savedToolResults(session)).toHaveLength(0);
			expect(lines(join(dir, "requests"))).toHaveLength(1);
			expect(existsSync(join(dir, "settles"))).toBe(false);

			writeFileSync(join(dir, "answer"), "answer");
			const second = await run(dir, args, startup === "none" ? {} : { PARK_STARTUP: startup });
			expect(second.code, second.stderr || second.stdout).toBe(0);
			expect(lines(join(dir, "calls"))).toEqual([
				{ id: "park-call", args: { value: "one" } },
				{ id: "park-call", args: { value: "one" } },
			]);
			const requests = lines(join(dir, "requests")) as Array<Array<{ role: string; toolCallId?: string }>>;
			expect(requests).toHaveLength(2);
			expect(requests[1].map((message) => message.role)).not.toContain(undefined);
			expect(requests[1].filter((message) => message.role === "user")).toHaveLength(startup === "none" ? 1 : 2);
			if (startup !== "none") expect(JSON.stringify(requests[1])).toContain("startup");
			const assistant = requests[1].findIndex((message) => message.role === "assistant");
			expect(requests[1][assistant + 1]).toMatchObject({ role: "toolResult", toolCallId: "park-call" });
			expect(savedToolResults(session)).toHaveLength(1);
			expect(events(second.stdout).map((event) => event.type)).toContain("agent_settled");

			const third = await run(dir, args);
			expect(third.code).not.toBe(0);
			expect(events(third.stdout)).toContainEqual({
				type: "error",
				message: "No unanswered tool call or trailing tool result to continue",
			});
			expect(lines(join(dir, "requests"))).toHaveLength(2);
			expect(lines(join(dir, "calls"))).toHaveLength(2);
		},
		60_000,
	);

	it.each(["none", "append", "wake"])(
		"parks again, then continues from a saved result with startup %s without rerunning the tool",
		async (startup) => {
			const { dir, session, args } = setup();
			const extra: Record<string, string> = startup === "none" ? {} : { PARK_STARTUP: startup };
			expect((await run(dir, [...args, "start"])).code).toBe(0);
			const again = await run(dir, args, extra);
			expect(again.code, again.stderr || again.stdout).toBe(0);
			expect(again.stdout).toContain('"type":"parked"');
			expect(lines(join(dir, "requests"))).toHaveLength(1);
			expect(existsSync(join(dir, "settles"))).toBe(false);

			writeFileSync(join(dir, "answer"), "answer");
			expect((await run(dir, args)).code).toBe(0);
			// Cut the transcript back to the saved result, as if the process died after saving it.
			const sessionLines = readFileSync(session, "utf8").trim().split("\n");
			const resultIndex = sessionLines.findLastIndex((line) => JSON.parse(line).message?.role === "toolResult");
			expect(resultIndex).toBeGreaterThanOrEqual(0);
			writeFileSync(session, `${sessionLines.slice(0, resultIndex + 1).join("\n")}\n`);
			const calls = lines(join(dir, "calls"));
			const resumed = await run(dir, args, extra);
			expect(resumed.code, resumed.stderr || resumed.stdout).toBe(0);
			expect(lines(join(dir, "calls"))).toEqual(calls);
			expect(lines(join(dir, "requests"))).toHaveLength(3);
		},
		60_000,
	);
});
