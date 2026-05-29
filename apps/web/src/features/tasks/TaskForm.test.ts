import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskForm } from "./TaskForm";

describe("TaskForm", () => {
  it("does not repeat the modal title inside the form", () => {
    const html = renderToStaticMarkup(createElement(TaskForm));

    expect(html).not.toContain("<h2");
  });
});
