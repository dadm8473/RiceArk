import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CharacterCandidateList } from "./CharacterImport";

describe("CharacterCandidateList", () => {
  it("renders column headers and combat power as a plain value", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterCandidateList, {
        candidates: [
          {
            name: "냠수나이스1",
            serverName: "루페온",
            className: "소서리스",
            itemLevel: "1,640.00",
            combatPower: "2,549.41"
          }
        ],
        selected: { "루페온:냠수나이스1": true },
        onToggle: vi.fn()
      })
    );

    for (const header of ["선택", "서버", "닉네임", "직업", "아이템 레벨", "전투력"]) {
      expect(html).toContain(header);
    }
    expect(html).toContain("2,549.41");
    expect(html).not.toContain("전투력 2,549.41");
  });
});
