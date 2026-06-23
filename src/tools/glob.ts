import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

export default defineTool({
  name: "find_files",
  description:
    "Find files matching a glob pattern. Use this to locate specific file types or config files.",
  input: v.object({
    pattern: v.pipe(v.string(), v.minLength(1)),
    path: v.optional(v.pipe(v.string(), v.minLength(1)), "."),
  }),
  run: async ({ input }) => {
    const base = resolve(input.path);

    try {
      const result = execSync(
        `find ${base} -path '*/node_modules' -prune -o -path '*/.git' -prune -o -name '${input.pattern}' -print 2>/dev/null | head -50`,
        { encoding: "utf-8", timeout: 10_000 },
      );

      const lines = result.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return "No matching files found.";
      return lines.join("\n");
    } catch {
      return "Search failed or no matching files found.";
    }
  },
});
