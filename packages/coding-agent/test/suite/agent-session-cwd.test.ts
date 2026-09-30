import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession working directory changes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("exposes set_cwd by default", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toContain("set_cwd");
		expect(harness.session.systemPrompt).toContain("set_cwd");
	});

	it("runs later tool calls in the new directory within the same turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const target = join(harness.tempDir, "nested", "work");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "note.txt"), "moved-note", "utf8");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("set_cwd", { path: target })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("work in the nested directory");

		expect(harness.session.cwd).toBe(target);
		expect(harness.session.systemPrompt).toContain(target);

		const cwdChanges = harness.eventsOfType("cwd_change");
		expect(cwdChanges).toHaveLength(1);
		expect(cwdChanges[0]?.previousCwd).toBe(harness.tempDir);
		expect(cwdChanges[0]?.cwd).toBe(target);

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		const readResult = toolResults.find((message) => message.toolName === "read");
		expect(getMessageText(readResult)).toContain("moved-note");

		const bashResult = toolResults.find((message) => message.toolName === "bash");
		expect(getMessageText(bashResult).trim()).toBe(realpathSync(target));
	});

	it("applies to tool calls batched into the same step", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const target = join(harness.tempDir, "same-step");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "note.txt"), "same-step-note", "utf8");

		// One assistant message, so the runtime's tool objects predate the change.
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("set_cwd", { path: target }),
					fauxToolCall("read", { path: "note.txt" }),
					fauxToolCall("bash", { command: "pwd" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("move and inspect in one step");

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		const readResult = toolResults.find((message) => message.toolName === "read");
		expect(getMessageText(readResult)).toContain("same-step-note");
		const bashResult = toolResults.find((message) => message.toolName === "bash");
		expect(getMessageText(bashResult).trim()).toBe(realpathSync(target));
	});

	it("keeps the current directory when the target is missing", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(harness.session.setCwd(join(harness.tempDir, "nope"))).rejects.toThrow(/does not exist/);
		expect(harness.session.cwd).toBe(harness.tempDir);
		expect(harness.eventsOfType("cwd_change")).toHaveLength(0);
	});

	it("is a no-op when the target is the current directory", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const change = await harness.session.setCwd(harness.tempDir);

		expect(change.relocated).toBe(false);
		expect(change.cwd).toBe(harness.tempDir);
		expect(harness.eventsOfType("cwd_change")).toHaveLength(0);
	});
});
