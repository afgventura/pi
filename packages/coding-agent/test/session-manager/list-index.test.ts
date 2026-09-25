import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const CWD = process.cwd();
const SEARCH_TEXT_CAP = 4096;

function sessionFile(id: string, firstUserText: string): string {
	const header = { type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00Z", cwd: CWD };
	const message = {
		type: "message",
		id: `${id}-m1`,
		parentId: null,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: "user", content: [{ type: "text", text: firstUserText }] },
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`;
}

describe("session list index", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `pi-session-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reuses indexed info for unchanged files and reparses changed ones", async () => {
		writeFileSync(join(dir, "a.jsonl"), sessionFile("a", "alpha request"));
		writeFileSync(join(dir, "b.jsonl"), sessionFile("b", "beta request"));

		const first = await SessionManager.list(CWD, dir);
		expect(first.map((session) => session.firstMessage).sort()).toEqual(["alpha request", "beta request"]);

		// Rewrite the cached value for one file. A second listing that returns it proves the entry
		// was reused rather than re-read from disk.
		const indexPath = join(dir, ".session-index.json");
		const index = JSON.parse(readFileSync(indexPath, "utf8"));
		expect(Object.keys(index.entries).sort()).toEqual(["a.jsonl", "b.jsonl"]);
		index.entries["a.jsonl"].info.firstMessage = "from the index";
		writeFileSync(indexPath, JSON.stringify(index));

		const second = await SessionManager.list(CWD, dir);
		const secondById = new Map(second.map((session) => [session.id, session]));
		expect(secondById.get("a")?.firstMessage).toBe("from the index");
		expect(secondById.get("b")?.firstMessage).toBe("beta request");

		// Rewrite b with a different length, so the (size, mtimeMs) check fails even if the write
		// lands in the same millisecond.
		writeFileSync(join(dir, "b.jsonl"), sessionFile("b", "beta rewritten"));
		const third = await SessionManager.list(CWD, dir);
		const thirdById = new Map(third.map((session) => [session.id, session]));
		expect(thirdById.get("b")?.firstMessage).toBe("beta rewritten");
		expect(thirdById.get("a")?.firstMessage).toBe("from the index");
	});

	it("ignores a corrupt index and still lists sessions", async () => {
		writeFileSync(join(dir, "a.jsonl"), sessionFile("a", "alpha request"));
		writeFileSync(join(dir, ".session-index.json"), "{ not json");

		const sessions = await SessionManager.list(CWD, dir);
		expect(sessions.map((session) => session.firstMessage)).toEqual(["alpha request"]);
	});

	it("caps the search text it keeps and stores", async () => {
		writeFileSync(join(dir, "a.jsonl"), sessionFile("a", "x".repeat(50_000)));

		const sessions = await SessionManager.list(CWD, dir);
		expect(sessions[0]?.allMessagesText.length).toBe(SEARCH_TEXT_CAP);

		const index = JSON.parse(readFileSync(join(dir, ".session-index.json"), "utf8"));
		expect(index.entries["a.jsonl"].info.allMessagesText.length).toBe(SEARCH_TEXT_CAP);
	});

	// Listing is abortable and a first pass over a large project takes seconds, so an aborted
	// open must still leave the work it did behind.
	it("writes the index incrementally so an aborted listing keeps its progress", async () => {
		const files = 80;
		for (let i = 0; i < files; i++) {
			writeFileSync(join(dir, `${i}.jsonl`), sessionFile(`s${i}`, `request number ${i}`));
		}

		const controller = new AbortController();
		await SessionManager.list(
			CWD,
			dir,
			(loaded) => {
				if (loaded >= 40) controller.abort();
			},
			controller.signal,
		).catch(() => []);

		const index = JSON.parse(readFileSync(join(dir, ".session-index.json"), "utf8"));
		const written = Object.keys(index.entries).length;
		expect(written).toBeGreaterThan(0);
		expect(written).toBeLessThan(files);
	});
});
