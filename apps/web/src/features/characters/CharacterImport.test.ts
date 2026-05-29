import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CharacterCandidateList, CharacterImportPanel } from "./CharacterImport";

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

describe("CharacterImportPanel", () => {
  it("keeps the save button beside search when characters exist", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterImportPanel, {
        name: "냠수나이스1",
        candidates: [
          {
            name: "냠수나이스1",
            serverName: "아만",
            className: "브레이커",
            itemLevel: "1,778.33",
            combatPower: "4,679.33"
          }
        ],
        selected: { "아만:냠수나이스1": true },
        onNameChange: vi.fn(),
        onSearch: vi.fn(),
        onSave: vi.fn(),
        onToggle: vi.fn()
      })
    );

    expect(html.indexOf("검색")).toBeLessThan(html.indexOf("선택 캐릭터 등록"));
    expect(html.indexOf("선택 캐릭터 등록")).toBeLessThan(html.indexOf("서버"));
  });

  it("shows a message when a search returns no characters", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterImportPanel, {
        name: "없는캐릭터",
        candidates: [],
        selected: {},
        message: "검색 결과가 없습니다.",
        onNameChange: vi.fn(),
        onSearch: vi.fn(),
        onSave: vi.fn(),
        onToggle: vi.fn()
      })
    );

    expect(html).toContain("검색 결과가 없습니다.");
  });

  it("does not repeat the modal title inside the panel", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterImportPanel, {
        name: "",
        candidates: [],
        selected: {},
        onNameChange: vi.fn(),
        onSearch: vi.fn(),
        onSave: vi.fn(),
        onToggle: vi.fn()
      })
    );

    expect(html).not.toContain("<h2");
  });
});
