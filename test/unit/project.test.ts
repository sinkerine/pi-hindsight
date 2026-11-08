import { expect, it, vi } from "vitest";
import { deriveProjectName, type ExecFn } from "../../src/core/project.js";

it("uses git common dir to share a project across worktrees", async () => {
  const exec = vi.fn<ExecFn>(async () => ({
    stdout: "/home/dev/main-repo/.git\n",
    code: 0,
  }));
  expect(await deriveProjectName("/tmp/other-worktree", exec)).toBe(
    "main-repo",
  );
  expect(exec).toHaveBeenCalledWith(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: "/tmp/other-worktree", timeout: 2000 },
  );
});
it("supports relative git output", async () =>
  expect(
    await deriveProjectName("/tmp/repo", async () => ({
      stdout: ".git\n",
      code: 0,
    })),
  ).toBe("repo"));
it.each(["error", "nonzero", "empty"])(
  "falls back to cwd basename on %s",
  async (kind) => {
    const exec: ExecFn = async () => {
      if (kind === "error") throw Error("missing git");
      return { code: kind === "nonzero" ? 1 : 0, stdout: "" };
    };
    expect(await deriveProjectName("/tmp/my-project", exec)).toBe("my-project");
  },
);
