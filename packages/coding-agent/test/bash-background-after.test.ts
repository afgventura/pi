import { describe, expect, it } from "vitest";
import {
	type BashBackgroundJobEvent,
	createBashTool,
	DEFAULT_SHELL_BACKGROUND_AFTER_SECONDS,
	setBackgroundShellJobReporter,
} from "../src/core/tools/bash.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("shell tool background threshold", () => {
	it("moves a long-running command to the background and reports its exit", async () => {
		const events: BashBackgroundJobEvent[] = [];
		const tool = createBashTool(process.cwd(), {
			backgroundAfterSeconds: 0.3,
			onBackgroundJob: (event) => events.push(event),
		});

		const result = await tool.execute("call-bg", {
			command: "printf 'partial\\n'; sleep 0.8; printf 'done\\n'; exit 3",
		} as never);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("partial");
		expect(text).toContain("moved to the background (job call-bg");
		expect(text).toContain("Do not poll it and do not run it again");
		expect(result.details?.backgroundJob?.id).toBe("call-bg");

		await waitFor(() => events.length === 2);
		const backgrounded = events[0];
		const exited = events[1];
		expect(backgrounded?.type).toBe("backgrounded");
		expect(backgrounded?.job.id).toBe("call-bg");
		expect(backgrounded?.job.pid).toBeGreaterThan(0);
		if (exited?.type !== "exited") throw new Error("expected an exit event");
		expect(exited.exitCode).toBe(3);
		expect(exited.error).toBeUndefined();
		expect(exited.output).toContain("done");
		expect(exited.durationMs).toBeGreaterThanOrEqual(300);
	});

	it("keeps commands that finish in time on the blocking path", async () => {
		const events: BashBackgroundJobEvent[] = [];
		const tool = createBashTool(process.cwd(), {
			backgroundAfterSeconds: 2,
			onBackgroundJob: (event) => events.push(event),
		});

		const result = await tool.execute("call-fast", { command: "printf 'quick\\n'" } as never);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.trim()).toBe("quick");
		expect(result.details?.backgroundJob).toBeUndefined();
		expect(events).toHaveLength(0);
	});

	it("does not background a command that the caller bounded with a timeout", async () => {
		const events: BashBackgroundJobEvent[] = [];
		const tool = createBashTool(process.cwd(), {
			backgroundAfterSeconds: 0.3,
			onBackgroundJob: (event) => events.push(event),
		});

		await expect(tool.execute("call-timeout", { command: "sleep 5", timeout: 0.5 } as never)).rejects.toThrow(
			/timed out after 0\.5 seconds/,
		);
		expect(events).toHaveLength(0);
	});

	it("blocks when the background threshold is disabled", async () => {
		const events: BashBackgroundJobEvent[] = [];
		const tool = createBashTool(process.cwd(), {
			backgroundAfterSeconds: 0,
			onBackgroundJob: (event) => events.push(event),
		});

		const result = await tool.execute("call-blocking", { command: "sleep 0.4; printf 'blocked\\n'" } as never);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.trim()).toBe("blocked");
		expect(events).toHaveLength(0);
	});

	it("backgrounds by default and falls back to the process reporter without an onBackgroundJob option", async () => {
		expect(DEFAULT_SHELL_BACKGROUND_AFTER_SECONDS).toBe(60);
		expect(createBashTool(process.cwd()).description).toContain("still running after 60s is moved to the background");

		const events: BashBackgroundJobEvent[] = [];
		const unregister = setBackgroundShellJobReporter((event) => events.push(event));
		try {
			const tool = createBashTool(process.cwd(), { backgroundAfterSeconds: 0.3 });
			await tool.execute("call-reported", { command: "sleep 0.8; printf 'reported\\n'" } as never);
			await waitFor(() => events.length === 2);
		} finally {
			unregister();
		}

		const exited = events[1];
		if (exited?.type !== "exited") throw new Error("expected an exit event");
		expect(exited.job.id).toBe("call-reported");
		expect(exited.output).toContain("reported");
	});
});
