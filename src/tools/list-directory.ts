import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export default defineTool({
  name: "list_directory",
  description:
    "List files and directories in a directory. Use this to explore project structure.",
  input: v.object({
    path: v.optional(v.pipe(v.string(), v.minLength(1)), "."),
  }),
  run: async ({ input }) => {
    const resolved = resolve(input.path);
    const entries = await readdir(resolved, { withFileTypes: true });

    const listing = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => {
        const prefix = e.isDirectory() ? "📁" : "📄";
        return `${prefix} ${e.name}`;
      })
      .join("\n");

    return listing || "(empty directory)";
  },
});
