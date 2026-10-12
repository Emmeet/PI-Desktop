import { describe, expect, it } from "vitest";
import { ompPhasesToTodos, ompQueueEntryId, parseOmpQueueEntryId } from "./service.js";
import { resolveOmpBinary } from "./binary.js";

describe("omp todo projection", () => {
  it("flattens phases and maps omp statuses onto the desktop's", () => {
    expect(ompPhasesToTodos([
      { name: "A", tasks: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }] },
      { name: "B", tasks: [{ content: "three", status: "abandoned" }, { content: "four", status: "blocked" }, { content: " " }] },
    ])).toEqual([
      { content: "A: one", status: "completed", priority: "medium" },
      { content: "A: two", status: "in_progress", priority: "medium" },
      { content: "B: three", status: "cancelled", priority: "medium" },
      { content: "B: four", status: "pending", priority: "medium" },
    ]);
    expect(ompPhasesToTodos([{ name: "Only", tasks: [{ content: "x", status: "pending" }] }])).toEqual([
      { content: "x", status: "pending", priority: "medium" },
    ]);
    expect(ompPhasesToTodos(undefined)).toEqual([]);
  });
});

describe("omp queue ids", () => {
  it("round-trips the queue kind and message text", () => {
    const id = ompQueueEntryId("followUp", "hello: 世界\nline");
    expect(id.startsWith("ompq:followUp:")).toBe(true);
    expect(parseOmpQueueEntryId(id)).toEqual({ queue: "followUp", message: "hello: 世界\nline" });
    expect(parseOmpQueueEntryId("turn-1")).toBeUndefined();
  });
});

describe("omp binary lookup on Windows", () => {
  it("searches Bun and npm shims and never the extensionless script", () => {
    let error: Error | undefined;
    try {
      resolveOmpBinary({ USERPROFILE: "C:\\Users\\me", APPDATA: "C:\\Users\\me\\AppData\\Roaming", PATH: "C:\\nope" }, "win32");
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toContain("C:\\Users\\me\\.bun\\bin\\omp.exe");
    expect(error?.message).toContain("C:\\Users\\me\\AppData\\Roaming\\npm\\omp.cmd");
    expect(error?.message).not.toMatch(/npm\\omp(,|$| )/);
  });
});
