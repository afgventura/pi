/**
 * A shell command that outlives `shellBackgroundAfterSeconds` must stop blocking
 * the turn and wake the session when it exits, with its exit code and output.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("shell background threshold in a session", () => {
	it("returns early and reports the exit as a session message", async () => {
		harness = await createHarness({ settings: { shellBackgroundAfterSeconds: 1 } });
		const session = harness.session;
		harness.setResponses([fauxAssistantMessage("acknowledged")]);

		const tool = session.getToolDefinition("bash");
		expect(tool).toBeDefined();
		const ctx = session.extensionRunner.createCommandContext();

		const result = await tool?.execute(
			"call-bg-session",
			{ command: "echo first; sleep 2.2; echo second" } as never,
			undefined,
			undefined,
			ctx,
		);
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("moved to the background");

		await waitFor(() =>
			session.messages.some((message) => message.role === "custom" && message.customType === "shell-background"),
		);
		const notification = session.messages.find(
			(message) => message.role === "custom" && message.customType === "shell-background",
		);
		const notificationText = getMessageText(notification);
		expect(notificationText).toContain("[background shell command finished]");
		expect(notificationText).toContain("call-bg-session");
		expect(notificationText).toContain("second");

		await session.waitForIdle();
	}, 20_000);
});
