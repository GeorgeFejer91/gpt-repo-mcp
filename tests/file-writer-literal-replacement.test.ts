import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { FileWriter } from "../src/services/file-writer.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";

/**
 * `String.prototype.replace` given a *string* replacement interprets `$&`,
 * `` $` ``, `$'`, `$1` and `$$` as substitution patterns. A caller asking to
 * replace one literal string with another does not expect that: writing a
 * replacement containing `$&` silently re-inserted the matched text instead of
 * the characters the caller supplied, corrupting the file.
 *
 * Passing a function to `replace` makes the replacement literal, which is what
 * these tests pin down.
 *
 * This fixture deliberately does not use the shared repo fixture: that one
 * creates a symlink, which needs Developer Mode or elevation on Windows, so
 * tests built on it cannot run on an ordinary Windows developer machine.
 */
async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repo-reader-literal-"));
  await mkdir(join(root, "docs"), { recursive: true });
  return root;
}

function createWriter(root: string) {
  return new FileWriter(root, new PathSandbox(root), new WritePolicy({ enabled: true }));
}

describe("FileWriter literal replacement", () => {
  test("treats $& in the replacement as literal text", async () => {
    const root = await createFixture();
    await writeFile(join(root, "docs", "guide.md"), "price: PLACEHOLDER\n");
    const writer = createWriter(root);

    await writer.write({
      path: "docs/guide.md",
      action: "replace",
      find: "PLACEHOLDER",
      replace: "$& and more"
    });

    // Before the fix this produced "price: PLACEHOLDER and more".
    await expect(readFile(join(root, "docs", "guide.md"), "utf8")).resolves.toBe(
      "price: $& and more\n"
    );
  });

  test("treats $`, $' and $1 in the replacement as literal text", async () => {
    const root = await createFixture();
    await writeFile(join(root, "docs", "guide.md"), "start TARGET end\n");
    const writer = createWriter(root);

    await writer.write({
      path: "docs/guide.md",
      action: "replace",
      find: "TARGET",
      replace: "$` $' $1"
    });

    await expect(readFile(join(root, "docs", "guide.md"), "utf8")).resolves.toBe(
      "start $` $' $1 end\n"
    );
  });

  test("treats $$ in the replacement as two literal dollar signs", async () => {
    const root = await createFixture();
    await writeFile(join(root, "docs", "guide.md"), "cost: X\n");
    const writer = createWriter(root);

    await writer.write({
      path: "docs/guide.md",
      action: "replace",
      find: "X",
      replace: "$$"
    });

    await expect(readFile(join(root, "docs", "guide.md"), "utf8")).resolves.toBe("cost: $$\n");
  });

  test("ordinary replacements are unaffected", async () => {
    const root = await createFixture();
    await writeFile(join(root, "docs", "guide.md"), "hello world\n");
    const writer = createWriter(root);

    await writer.write({
      path: "docs/guide.md",
      action: "replace",
      find: "world",
      replace: "there"
    });

    await expect(readFile(join(root, "docs", "guide.md"), "utf8")).resolves.toBe("hello there\n");
  });
});
