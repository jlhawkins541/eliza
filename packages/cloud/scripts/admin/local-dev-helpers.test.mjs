/** Prove cloud startup helpers load env overlays without hoisted npm dependencies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("isolated helper import preserves inherited values and applies local overrides", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cloud-env-helper-"));
  try {
    copyFileSync(
      new URL("./local-dev-helpers.ts", import.meta.url),
      path.join(directory, "local-dev-helpers.ts"),
    );
    writeFileSync(
      path.join(directory, ".env"),
      'CLOUD_ENV_TEST_EXISTING=base\nCLOUD_ENV_TEST_LOCAL=base\nexport CLOUD_ENV_TEST_QUOTED="quoted # value"\n',
    );
    writeFileSync(
      path.join(directory, ".env.local"),
      "CLOUD_ENV_TEST_LOCAL=local\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {loadEnvFiles} from './local-dev-helpers.ts';
      process.env.CLOUD_ENV_TEST_EXISTING = 'inherited';
      delete process.env.CLOUD_ENV_TEST_LOCAL;
      delete process.env.CLOUD_ENV_TEST_QUOTED;
      loadEnvFiles();
      loadEnvFiles(['missing.env']);
      console.log(JSON.stringify([
        process.env.CLOUD_ENV_TEST_EXISTING,
        process.env.CLOUD_ENV_TEST_LOCAL,
        process.env.CLOUD_ENV_TEST_QUOTED,
      ]));
    `,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      "inherited",
      "local",
      "quoted # value",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
