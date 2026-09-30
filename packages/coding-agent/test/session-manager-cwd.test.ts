import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

/** SessionManager only persists once it has seen an assistant message. */
function appendAssistantMessage(manager: SessionManager, text: string): void {
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function readHeaderCwd(sessionFile: string): string {
	const firstLine = readFileSync(sessionFile, "utf8").split("\n")[0] ?? "";
	const header = JSON.parse(firstLine) as { cwd?: string };
	return header.cwd ?? "";
}

describe("SessionManager.setCwd", () => {
	let tempRoot: string;
	let agentDir: string;
	let projectA: string;
	let projectB: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-session-cwd-"));
		agentDir = join(tempRoot, "agent");
		projectA = join(tempRoot, "project-a");
		projectB = join(tempRoot, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("moves the session file into the target cwd's session directory and rewrites the header", () => {
		const manager = SessionManager.create(projectA);
		appendAssistantMessage(manager, "first");
		const previousFile = manager.getSessionFile();
		if (!previousFile) throw new Error("expected a session file");
		expect(existsSync(previousFile)).toBe(true);
		expect(readHeaderCwd(previousFile)).toBe(projectA);

		const change = manager.setCwd(projectB);

		expect(change.previousCwd).toBe(projectA);
		expect(change.cwd).toBe(projectB);
		expect(change.relocated).toBe(true);
		expect(existsSync(previousFile)).toBe(false);
		expect(change.sessionFile).not.toBe(previousFile);
		expect(change.sessionFile).toBe(manager.getSessionFile());
		if (!change.sessionFile) throw new Error("expected a session file");
		expect(existsSync(change.sessionFile)).toBe(true);
		expect(change.sessionFile).toContain(`--${projectB.replace(/^\//, "").replace(/\//g, "-")}--`);
		expect(readHeaderCwd(change.sessionFile)).toBe(projectB);
		expect(manager.getCwd()).toBe(projectB);

		// Later entries land in the moved file.
		appendAssistantMessage(manager, "second");
		expect(readFileSync(change.sessionFile, "utf8")).toContain("second");
	});

	it("keeps the session file when a custom session directory is configured", () => {
		const sessionDir = join(tempRoot, "custom-sessions");
		const manager = SessionManager.create(projectA, sessionDir);
		appendAssistantMessage(manager, "first");
		const previousFile = manager.getSessionFile();
		if (!previousFile) throw new Error("expected a session file");

		const change = manager.setCwd(projectB);

		expect(change.relocated).toBe(false);
		expect(change.sessionFile).toBe(previousFile);
		expect(existsSync(previousFile)).toBe(true);
		expect(readHeaderCwd(previousFile)).toBe(projectB);
		expect(manager.getSessionDir()).toBe(sessionDir);
	});

	it("re-points a session that has not written its file yet", () => {
		const manager = SessionManager.create(projectA);
		const previousFile = manager.getSessionFile();
		if (!previousFile) throw new Error("expected a session file");
		expect(existsSync(previousFile)).toBe(false);

		const change = manager.setCwd(projectB);

		expect(change.relocated).toBe(true);
		if (!change.sessionFile) throw new Error("expected a session file");
		expect(change.sessionFile).not.toBe(previousFile);

		// The first flush creates the file in the target directory.
		appendAssistantMessage(manager, "first");
		expect(existsSync(change.sessionFile)).toBe(true);
		expect(readHeaderCwd(change.sessionFile)).toBe(projectB);
	});

	it("is a no-op for the current directory", () => {
		const manager = SessionManager.create(projectA);
		appendAssistantMessage(manager, "first");
		const previousFile = manager.getSessionFile();

		const change = manager.setCwd(projectA);

		expect(change.relocated).toBe(false);
		expect(change.previousCwd).toBe(projectA);
		expect(change.cwd).toBe(projectA);
		expect(manager.getSessionFile()).toBe(previousFile);
		expect(previousFile && readHeaderCwd(previousFile)).toBe(projectA);
	});

	it("refuses a missing or non-directory target without changing state", () => {
		const manager = SessionManager.create(projectA);
		appendAssistantMessage(manager, "first");
		const previousFile = manager.getSessionFile();
		const fileTarget = join(projectB, "a-file");
		mkdirSync(projectB, { recursive: true });
		writeFileSync(fileTarget, "x");

		expect(() => manager.setCwd(join(tempRoot, "does-not-exist"))).toThrow(/does not exist/);
		expect(() => manager.setCwd(fileTarget)).toThrow(/is not a directory/);

		expect(manager.getCwd()).toBe(projectA);
		expect(manager.getSessionFile()).toBe(previousFile);
		expect(previousFile && existsSync(previousFile)).toBe(true);
		expect(previousFile && readHeaderCwd(previousFile)).toBe(projectA);
	});
});
