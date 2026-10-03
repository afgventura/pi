import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { TranscriptWindow } from "../src/modes/interactive/transcript-window.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** A child that renders `lines` identical lines labelled `id`, so the tail stays identifiable. */
function block(id: string, lines: number): Component {
	return {
		render: () => Array.from({ length: lines }, () => id),
		invalidate: () => {},
	};
}

function contentLines(window: TranscriptWindow): string[] {
	return window
		.render(80)
		.map(stripAnsi)
		.filter((line) => !line.includes("hidden"));
}

describe("TranscriptWindow", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps the whole transcript while it fits the budget", () => {
		const window = new TranscriptWindow(() => 10);
		window.addChild(block("a", 3));
		window.addChild(block("b", 3));

		expect(window.render(80)).toEqual(["a", "a", "a", "b", "b", "b"]);
		expect(window.droppedItems).toBe(0);
	});

	test("drops the oldest items until the transcript fits the budget", () => {
		const window = new TranscriptWindow(() => 4);
		window.addChild(block("a", 2));
		window.addChild(block("b", 2));
		window.addChild(block("c", 2));

		const rendered = window.render(80).map(stripAnsi);
		// "a" is dropped, and the notice replaces it at the top; the notice is not part of the budget.
		expect(rendered).toEqual([expect.stringContaining("earlier transcript items hidden"), "b", "b", "c", "c"]);
		expect(window.droppedItems).toBe(1);

		// Rendering again does not drop more.
		expect(window.render(80).map(stripAnsi)).toEqual(rendered);
		expect(window.droppedItems).toBe(1);
	});

	test("keeps the tail contiguous as new items arrive", () => {
		const window = new TranscriptWindow(() => 3);
		for (const id of ["a", "b", "c", "d"]) {
			window.addChild(block(id, 1));
		}
		expect(contentLines(window)).toEqual(["b", "c", "d"]);

		window.addChild(block("e", 1));
		expect(contentLines(window)).toEqual(["c", "d", "e"]);
		expect(window.droppedItems).toBe(2);
	});

	test("keeps every item when the budget is disabled", () => {
		const window = new TranscriptWindow(() => 0);
		window.addChild(block("a", 5));
		window.addChild(block("b", 5));

		expect(contentLines(window)).toEqual([...Array<string>(5).fill("a"), ...Array<string>(5).fill("b")]);
		expect(window.droppedItems).toBe(0);
	});

	test("keeps the last item even when it alone exceeds the budget", () => {
		const window = new TranscriptWindow(() => 2);
		window.addChild(block("a", 3));
		window.addChild(block("b", 5));

		expect(contentLines(window)).toEqual(Array<string>(5).fill("b"));
		expect(window.droppedItems).toBe(1);
	});

	test("clear resets the dropped count and the notice", () => {
		const window = new TranscriptWindow(() => 2);
		window.addChild(block("a", 2));
		window.addChild(block("b", 2));
		window.render(80);
		expect(window.droppedItems).toBe(1);

		window.clear();
		expect(window.droppedItems).toBe(0);
		expect(window.render(80)).toEqual([]);
	});
});
