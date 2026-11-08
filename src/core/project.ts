import { basename, dirname, resolve } from "node:path";
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; code: number }>;
export async function deriveProjectName(
  cwd: string,
  exec: ExecFn,
): Promise<string> {
  try {
    const result = await exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, timeout: 2000 },
    );
    if (result.code === 0 && result.stdout.trim())
      return basename(dirname(resolve(cwd, result.stdout.trim())));
  } catch {}
  return basename(cwd) || "project";
}
