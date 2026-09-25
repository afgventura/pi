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

function create(maxViewportRows: number, viewport: Component) {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TuiScrollback(terminal, false, "/tmp/pi-tui-scrollback-test");
	tui.setViewport(viewport, maxViewportRows);
	tui.start();
	return { terminal, tui };
}

describe("scrollback renderer", () => {
	it("sizes the viewport from its content and pins it to the bottom", async () => {
		const viewport = new Lines();
		viewport.lines = ["editor", "footer"];
		const { terminal, tui } = create(4, viewport);

		tui.renderNow();
		await terminal.flush();
		const screen = terminal.getViewport();

		assert.strictEqual(screen.length, ROWS);
		// Two content lines, so two viewport rows at the bottom; everything above is the terminal's.
		assert.deepStrictEqual(screen.slice(-2), ["editor", "footer"]);
		assert.deepStrictEqual(screen.slice(0, ROWS - 2), Array(ROWS - 2).fill(""));

		tui.stop();
	});

	it("never grows past the row budget, and follows the end when the tail overflows", async () => {
		const viewport = new Lines();
		viewport.lines = ["one", "two", "three", "four", "five"];
		const { terminal, tui } = create(2, viewport);

		tui.renderNow();
		await terminal.flush();

		assert.strictEqual(tui.viewportRows, 2);
		// A live tail taller than the viewport shows its newest lines, which are the ones being
		// watched, rather than its oldest.
		assert.deepStrictEqual(terminal.getViewport().slice(-2), ["four", "five"]);

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
		assert.deepStrictEqual(screen.slice(-3), ["one", "two", "EDITOR"]);

		tui.stop();
	});

	it("scrolls the oldest committed lines into the terminal's scrollback", async () => {
		const viewport = new Lines();
		viewport.lines = ["EDITOR"];
		const { terminal, tui } = create(2, viewport);

		tui.renderNow();
		for (let i = 0; i < 20; i++) {
			tui.commit([`line ${i}`]);
		}
		await terminal.flush();

		const screen = terminal.getViewport();
		const scrollback = terminal.getScrollBuffer();

		assert.strictEqual(screen[ROWS - 1], "EDITOR");
		assert.ok(scrollback.length > ROWS, `expected scrollback to grow, got ${scrollback.length} rows`);
		assert.ok(
			scrollback.some((line) => line === "line 0"),
			"expected the first committed line to be retained in scrollback",
		);
		assert.ok(
			screen.some((line) => line === "line 19"),
			"expected the newest committed line to be visible",
		);

		tui.stop();
	});

	// Growing the viewport takes rows the scroll region was using. Those rows may hold committed
	// lines that have not scrolled off yet, so they must be scrolled into scrollback rather than
	// painted over.
	it("keeps committed lines when the viewport grows", async () => {
		const viewport = new Lines();
		viewport.lines = ["EDITOR"];
		const { terminal, tui } = create(6, viewport);

		tui.renderNow();
		for (let i = 0; i < 4; i++) {
			tui.commit([`kept ${i}`]);
		}
		await terminal.flush();
		const beforeGrow = terminal.getScrollBuffer().length;

		// The live tail grows, so the viewport claims more rows.
		viewport.lines = ["EDITOR", "tail a", "tail b", "tail c"];
		tui.renderNow();
		await terminal.flush();

		const scrollback = terminal.getScrollBuffer();
		assert.strictEqual(tui.viewportRows, 4);
		// Every committed line survives the growth.
		for (let i = 0; i < 4; i++) {
			assert.ok(
				scrollback.some((line) => line === `kept ${i}`),
				`committed line "kept ${i}" was lost when the viewport grew`,
			);
		}
		assert.ok(
			scrollback.length >= beforeGrow,
			`scrollback shrank from ${beforeGrow} to ${scrollback.length} when the viewport grew`,
		);
		// And the viewport is at the bottom with its new content.
		assert.deepStrictEqual(terminal.getViewport().slice(-4), ["EDITOR", "tail a", "tail b", "tail c"]);

		tui.stop();
	});

	// Rebuild paths re-create every item from the session entries. Without discarding the previous
	// copy first, the transcript is committed twice - which is what a startup did, because session
	// start rebuilds the chat after the initial load.
	it("discards committed history on reset so a rebuild replaces rather than doubles it", async () => {
		const viewport = new Lines();
		viewport.lines = ["EDITOR"];
		const { terminal, tui } = create(ROWS - 1, viewport);

		tui.renderNow();
		for (let i = 0; i < 10; i++) {
			tui.commit([`line ${i}`]);
		}
		await terminal.flush();
		assert.ok(terminal.getScrollBuffer().length > ROWS, "expected history before the reset");

		tui.resetScrollback();
		await terminal.flush();

		assert.strictEqual(terminal.getScrollBuffer().length, ROWS, "history should be gone after a reset");
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
		assert.strictEqual(terminal.getViewport()[ROWS - 1], "EDITOR");

		tui.stop();
	});
});
