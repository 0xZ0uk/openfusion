import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_FILE_SIZE = 100 * 1024; // 100KB

async function isTextFile(filePath: string): Promise<boolean> {
  try {
    const fd = await import("node:fs/promises").then((m) => m.open(filePath, "r"));
    const buf = Buffer.alloc(8192);
    await fd.read(buf, 0, 8192, 0);
    await fd.close();
    return !buf.includes(0);
  } catch {
    return false;
  }
}

export default defineTool({
  name: "read_file",
  description:
    "Read the contents of a file. Use to inspect source code, config files, docs, etc.",
  input: v.object({
    path: v.pipe(v.string(), v.minLength(1)),
  }),
  run: async ({ input }) => {
    const resolved = resolve(input.path);
    const s = await stat(resolved);

    if (!s.isFile()) {
      return `Error: not a file: ${input.path}`;
    }

    if (s.size > MAX_FILE_SIZE) {
      return `Error: file too large (${(s.size / 1024).toFixed(0)} KB). Max: ${MAX_FILE_SIZE / 1024} KB.`;
    }

    if (!(await isTextFile(resolved))) {
      return `Error: binary file: ${input.path}. Cannot display contents.`;
    }

    const content = await readFile(resolved, "utf-8");
    return `\`\`\`\n// ${input.path}\n${content}\n\`\`\``;
  },
});
