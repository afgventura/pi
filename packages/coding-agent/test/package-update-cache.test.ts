import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const CACHE_FILE = "package-update-check.json";

function poisonedUpdate(name: string) {
	return { source: `npm:${name}`, displayName: name, type: "npm" as const, scope: "user" as const };
}

describe("package update check cache", () => {
	let tempDir: string;
	let agentDir: string;
	let manager: DefaultPackageManager;
	let previousOffline: string | undefined;

	beforeEach(() => {
		// The vitest config sets PI_OFFLINE=1 for the whole suite, which makes the check return
		// before it reaches the cache. Clear it so this test exercises the real path.
		previousOffline = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;

		tempDir = mkdtempSync(join(tmpdir(), "pi-update-cache-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		manager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: ["npm:cc-my-pi"] }),
		});
	});

	afterEach(() => {
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function cachePath(): string {
		return join(agentDir, CACHE_FILE);
	}

	/**
	 * Run the check once so the manager writes a cache holding the real canonical source list, then
	 * return that list. The package is not installed in the temp agent dir, so no npm process is
	 * spawned and this is fast.
	 */
	async function realSources(): Promise<string[]> {
		await manager.checkForAvailableUpdates();
		return JSON.parse(readFileSync(cachePath(), "utf8")).sources;
	}

	// The check spawns one npm process per configured package - 2.85 s for eight packages - and ran
	// on every startup. A cached answer must be reused rather than recomputed.
	it("reuses a cached result", async () => {
		const sources = await realSources();
		const cached = [poisonedUpdate("cached-pkg")];
		writeFileSync(cachePath(), JSON.stringify({ checkedAt: Date.now(), sources, updates: cached }));

		// The real check can never produce this, so seeing it proves the cache was used.
		expect(await manager.checkForAvailableUpdates()).toEqual(cached);
	});

	it("ignores a cache older than a day", async () => {
		const sources = await realSources();
		const stale = [poisonedUpdate("stale-pkg")];
		writeFileSync(
			cachePath(),
			JSON.stringify({ checkedAt: Date.now() - 25 * 60 * 60 * 1000, sources, updates: stale }),
		);

		expect(await manager.checkForAvailableUpdates()).not.toEqual(stale);
	});

	// Adding or removing a package must not hide its update for a day.
	it("ignores a cache computed for a different package set", async () => {
		const stale = [poisonedUpdate("other-pkg")];
		writeFileSync(
			cachePath(),
			JSON.stringify({ checkedAt: Date.now(), sources: ["npm:some-other-package"], updates: stale }),
		);

		expect(await manager.checkForAvailableUpdates()).not.toEqual(stale);
	});

	it("ignores a corrupt cache", async () => {
		writeFileSync(cachePath(), "{ not json");

		await expect(manager.checkForAvailableUpdates()).resolves.toBeInstanceOf(Array);
	});
});
