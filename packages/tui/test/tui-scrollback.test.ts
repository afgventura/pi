import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiScrollback } from "../src/tui-scrollback.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	lines: string[] = [];
	renderCount = 0;

	render(_width: number): string[] {
		this.renderCount += 1;
		return this.lines;
	}

	invalidate(): void {}
}

const COLUMNS = 40;
const ROWS = 10;

function create(viewportRows: number, viewport: Component) {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TuiScrollback(terminal, false, "/tmp/pi-tui-scrollback-test");
	tui.setViewport(viewport, viewportRows);
	tui.start();
	return { terminal, tui };
}

describe("scrollback renderer", () => {
	it("draws the viewport in the bottom rows and leaves the rest to the terminal", async () => {
		const viewport = new Lines();
		viewport.lines = ["editor", "footer"];
		const { terminal, tui } = create(3, viewport);

		tui.renderNow();
		await terminal.flush();
		const screen = terminal.getViewport();

		assert.strictEqual(screen.length, ROWS);
		// Viewport occupies the last 3 rows; the row above it is still the terminal's.
		assert.deepStrictEqual(screen.slice(-3), ["editor", "footer", ""]);
		assert.deepStrictEqual(screen.slice(0, ROWS - 3), Array(ROWS - 3).fill(""));

		tui.stop();
	});

	it("puts committed lines above the viewport without disturbing it", async () => {
		const viewport = new Lines();
		viewport.lines = ["EDITOR"];
		const { terminal, tui } = create(2, viewport);

		tui.renderNow();
		tui.commit(["one", "two"]);
		await terminal.flush();
		const screen = terminal.getViewport();

		// Committed lines land directly above the viewport, which has not moved.
		assert.deepStrictEqual(screen.slice(-4), ["one", "two", "EDITOR", ""]);

		tui.stop();
	});

	it("scrolls the oldest committed lines into the terminal's scrollback", async () => {
		const viewport = new Lines();
		viewport.lines = ["EDITOR"];
		const { terminal, tui } = create(2, viewport);

		tui.renderNow();
		// More lines than fit in the scroll region, so the earliest ones must leave the screen.
		for (let i = 0; i < 20; i++) {
			tui.commit([`line ${i}`]);
		}
		await terminal.flush();

		const screen = terminal.getViewport();
		const scrollback = terminal.getScrollBuffer();

		// The viewport is still pinned at the bottom of the screen.
		assert.strictEqual(screen[ROWS - 2], "EDITOR");
		// The buffer is taller than the screen, which means lines went to scrollback rather than
		// being lost.
		assert.ok(scrollback.length > ROWS, `expected scrollback to grow, got ${scrollback.length} rows`);
		// The earliest line survived, in scrollback, which is the whole point.
		assert.ok(
			scrollback.some((line) => line === "line 0"),
			"expected the first committed line to be retained in scrollback",
		);
		// The newest line is the one still on screen.
		assert.ok(
			screen.some((line) => line === "line 19"),
			"expected the newest committed line to be visible",
		);

		tui.stop();
	});

	it("does not render committed content again on later frames", async () => {
		const viewport = new Lines();
		viewport.lines = ["EDITOR"];
		const { terminal, tui } = create(2, viewport);

		tui.renderNow();
		for (let i = 0; i < 50; i++) {
			tui.commit([`line ${i}`]);
		}
		viewport.renderCount = 0;
		for (let frame = 0; frame < 20; frame++) {
			tui.renderNow();
		}
		await terminal.flush();

		// The renderer's per-frame work is the viewport alone, however long the history is. The
		// viewport component is what gets rendered; committed lines are the terminal's problem.
		assert.strictEqual(viewport.renderCount, 20);
		assert.strictEqual(terminal.getViewport()[ROWS - 2], "EDITOR");

		tui.stop();
	});
});
