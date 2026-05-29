import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("apps/web/src/styles.css", "utf8");

describe("matrix styles", () => {
  it("keeps disabled checklist cells visually neutral", () => {
    expect(styles).toContain(".matrix-check:disabled");
    expect(styles).toContain(".matrix-check:disabled {\n  cursor: default;\n  background: #ffffff;");
  });
});
