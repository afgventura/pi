import assert from "node:assert";
import { describe, it } from "node:test";
import { captureForeignOutput, sanitizeForeignLine, writeTtyOutput } from "../src/foreign-output.ts";

interface CaptureHarness {
	readonly lines: string[];
	/** Text that reached the terminal through the writer installed before the capture. */
	readonly writes: string[];
}

/**
 * Install a fake tty writer, capture over it, and always restore both. writeTtyOutput() must land in
 * `writes` (bypassing the capture), while anything else written to stdout/stderr becomes a line.
 */
function withCapture(run: (harness: CaptureHarness) => void | Promise<void>): Promise<void> {
	return (async () => {
		const realStdoutWrite = process.stdout.write;
		const realStderrWrite = process.stderr.write;
		const harness: CaptureHarness = { lines: [], writes: [] };
		const ttyWrite = ((chunk: string | Uint8Array) => {
			harness.writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdout.write = ttyWrite;
		process.stderr.write = ttyWrite;
		const capture = captureForeignOutput((line) => harness.lines.push(line));
		try {
			await run(harness);
		} finally {
			capture.release();
			process.stdout.write = realStdoutWrite;
			process.stderr.write = realStderrWrite;
		}
	})();
}

describe("captureForeignOutput", () => {
	it("turns stdout and stderr writes into lines", async () => {
		await withCapture(({ lines }) => {
			process.stdout.write("MCP Auth: open this URL\n");
			process.stderr.write("failed to open browser\nhttps://example.test/auth\n");
			assert.deepEqual(lines, ["MCP Auth: open this URL", "failed to open browser", "https://example.test/auth"]);
		});
	});

	it("keeps the tty writer for TUI output only", async () => {
		await withCapture(({ lines, writes }) => {
			writeTtyOutput("\x1b[2Jframe");
			process.stdout.write("foreign\n");
			assert.deepEqual(writes, ["\x1b[2Jframe"]);
			assert.deepEqual(lines, ["foreign"]);
		});
	});

	it("restores the original writers on release", async () => {
		const realStdoutWrite = process.stdout.write;
		const realStderrWrite = process.stderr.write;
		const ttyWrite = (() => true) as unknown as typeof process.stdout.write;
		process.stdout.write = ttyWrite;
		process.stderr.write = ttyWrite;
		const capture = captureForeignOutput(() => {});
		capture.release();
		try {
			assert.equal(process.stdout.write, ttyWrite);
			assert.equal(process.stderr.write, ttyWrite);
		} finally {
			process.stdout.write = realStdoutWrite;
			process.stderr.write = realStderrWrite;
		}
	});

	it("flushes a partial line on release", async () => {
		await withCapture(({ lines }) => {
			// No newline: the line is still shown rather than dropped.
			process.stdout.write("partial line without newline");
			assert.deepEqual(lines, []);
		});
	});

	it("flushes a partial line after the flush delay", async () => {
		await withCapture(async ({ lines }) => {
			process.stdout.write("partial line without newline");
			await new Promise((resolve) => setTimeout(resolve, 150));
			// The capture also swallows the test runner's reporter output while it is installed, which
			// is the behavior under test, so assert on the prefix instead of on the whole buffer.
			assert.ok(
				lines.some((line) => line.startsWith("partial line without newline")),
				`expected the partial line to be flushed, got ${JSON.stringify(lines.slice(0, 3))}`,
			);
		});
	});

	it("splits carriage-return progress lines", async () => {
		await withCapture(({ lines }) => {
			process.stdout.write("progress 1/3\rprogress 2/3\r\n");
			assert.deepEqual(lines, ["progress 1/3", "progress 2/3"]);
		});
	});

	it("drops blank lines and keeps indentation", async () => {
		await withCapture(({ lines }) => {
			process.stdout.write("\n   indented\n\n");
			assert.deepEqual(lines, ["   indented"]);
		});
	});

	it("sanitizes control sequences and control characters", async () => {
		await withCapture(({ lines }) => {
			process.stdout.write("\x1b[2Jwiped\x1b[1;1H\x07bell\x1b[31mred\x1b[0m\n");
			assert.deepEqual(lines, ["wipedbell\x1b[31mred\x1b[0m"]);
		});
	});

	it("ignores a nested capture instead of feeding frames back into it", async () => {
		await withCapture(({ lines, writes }) => {
			const nested = captureForeignOutput((line) => lines.push(`nested:${line}`));
			try {
				writeTtyOutput("frame");
				process.stdout.write("foreign\n");
				assert.deepEqual(writes, ["frame"]);
				assert.deepEqual(lines, ["foreign"]);
			} finally {
				nested.release();
			}
		});
	});
});

describe("sanitizeForeignLine", () => {
	it("keeps SGR sequences so colored output stays readable", () => {
		assert.equal(sanitizeForeignLine("\x1b[1mbold\x1b[22m plain"), "\x1b[1mbold\x1b[22m plain");
	});

	it("removes cursor movement, screen clearing, OSC, and other control characters", () => {
		assert.equal(sanitizeForeignLine("a\x1b[2Jb\x1b[10;1Hc"), "abc");
		assert.equal(sanitizeForeignLine("a\x1b]0;title\x07b"), "ab");
		// An unknown two-character escape is consumed whole, exactly as a terminal consumes it.
		assert.equal(sanitizeForeignLine("a\x1bb"), "a");
		assert.equal(sanitizeForeignLine("a\x00\x07b"), "ab");
	});

	it("keeps tabs that the renderer measures", () => {
		assert.equal(sanitizeForeignLine("a\tb"), "a\tb");
	});
});
