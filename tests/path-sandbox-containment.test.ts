import { mkdtemp, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { PathSandbox, validateRepoPath } from "../src/services/path-sandbox.js";

/**
 * Containment regressions for model-supplied paths.
 *
 * Every case here failed, or could fail, before the guard was tightened:
 * a drive-relative path was accepted, a NUL byte passed through, and - most
 * seriously - a path on a different Windows drive was reported as *inside* the
 * repository, because `relative()` returns an absolute path when the two sides
 * share no root and that string contains no "..".
 */
describe("validateRepoPath containment", () => {
  test("rejects POSIX absolute paths", () => {
    expect(() => validateRepoPath("/etc/passwd")).toThrowError(
      expect.objectContaining({ code: "ABSOLUTE_PATH_REJECTED" })
    );
  });

  test("rejects Windows absolute paths on every platform", () => {
    for (const candidate of ["C:\\Windows\\System32\\config\\SAM", "C:/Windows/System32", "\\\\server\\share\\file"]) {
      expect(() => validateRepoPath(candidate), candidate).toThrowError(
        expect.objectContaining({ code: "ABSOLUTE_PATH_REJECTED" })
      );
    }
  });

  /**
   * "C:file" has no separator, so `win32.isAbsolute` reports false, yet Windows
   * resolves it against that drive's current directory - which is not the
   * repository. The bare drive-letter check exists for exactly this form.
   */
  test("rejects drive-relative paths that win32.isAbsolute calls relative", () => {
    for (const candidate of ["C:file.txt", "D:notes", "c:"]) {
      expect(() => validateRepoPath(candidate), candidate).toThrowError(
        expect.objectContaining({ code: "ABSOLUTE_PATH_REJECTED" })
      );
    }
  });

  test("rejects paths containing NUL", () => {
    expect(() => validateRepoPath("notes.txt\0.png")).toThrowError(
      expect.objectContaining({ code: "ABSOLUTE_PATH_REJECTED" })
    );
  });

  test("rejects traversal", () => {
    for (const candidate of ["../outside.txt", "a/../../outside.txt"]) {
      expect(() => validateRepoPath(candidate), candidate).toThrowError(
        expect.objectContaining({ code: "PATH_TRAVERSAL_REJECTED" })
      );
    }
  });

  test("still accepts ordinary relative paths", () => {
    expect(validateRepoPath("src/index.ts")).toBe("src/index.ts");
    expect(validateRepoPath("./src/index.ts")).toBe("src/index.ts");
    expect(validateRepoPath("")).toBe(".");
  });

  /**
   * A dotted filename is not traversal. The previous `startsWith("..")` check
   * rejected it, which is a correctness bug rather than a security one.
   */
  test("accepts filenames that merely begin with dots", () => {
    expect(validateRepoPath("..config")).toBe("..config");
    expect(validateRepoPath("src/..keep")).toBe("src/..keep");
  });
});

describe("PathSandbox containment", () => {
  test("resolves a contained path", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-contain-"));
    await writeFile(join(root, "inside.txt"), "ok");
    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("inside.txt")).resolves.toMatchObject({
      repoPath: "inside.txt"
    });
  });

  /**
   * The cross-root case. On Windows this is a different drive letter; on POSIX
   * there is only one root, so the equivalent escape is expressed as traversal.
   * Either way the sandbox must refuse, and must not report containment.
   */
  test("refuses a path on a different filesystem root", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-root-"));
    const sandbox = new PathSandbox(root);

    const otherRoot = process.platform === "win32"
      ? (parse(root).root.toUpperCase().startsWith("C") ? "D:\\elsewhere\\file.txt" : "C:\\elsewhere\\file.txt")
      : "/elsewhere/file.txt";

    await expect(sandbox.resolve(otherRoot)).rejects.toMatchObject({
      code: "ABSOLUTE_PATH_REJECTED"
    });
  });
});
