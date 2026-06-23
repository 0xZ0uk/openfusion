import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

export default defineTool({
  name: "search_text",
  description:
    "Search for text or regex patterns within files. Use to find imports, function definitions, references, etc.",
  input: v.object({
    pattern: v.pipe(v.string(), v.minLength(1)),
    path: v.optional(v.pipe(v.string(), v.minLength(1)), "."),
    file_glob: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  run: async ({ input }) => {
    const base = resolve(input.path);
    const escapedPattern = input.pattern.replace(/'/g, "'\\''");

    try {
      let cmd: string;
      if (input.file_glob) {
        cmd = `rg -l --no-heading '${escapedPattern}' -g '${input.file_glob}' ${base} 2>/dev/null | head -30`;
      } else {
        cmd = `rg -l --no-heading '${escapedPattern}' ${base} 2>/dev/null | head -30`;
      }

      const result = execSync(cmd, { encoding: "utf-8", timeout: 15_000 });
      const lines = result.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return "No matches found.";
      return lines.join("\n");
    } catch {
      return "Search failed or no matches found.";
    }
  },
});
