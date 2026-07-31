import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CHARACTER_SEARCH_NAME_ERROR,
  CharacterCandidateList,
  CharacterImportPanel,
  ManualCharacterCreatePanel,
  buildCharacterCandidateSelection,
  getCharacterSearchNameError
} from "./CharacterImport";

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

  it("builds bulk selection maps for every searched character", () => {
    const candidates = [
      {
        name: "냠수나이스1",
        serverName: "루페온",
        className: "소서리스",
        itemLevel: "1,640.00",
        combatPower: "2,549.41"
      },
      {
        name: "냠수나이스2",
        serverName: "아만",
        className: "도화가",
        itemLevel: "1,620.00",
        combatPower: null
      }
    ];

    expect(buildCharacterCandidateSelection(candidates, true)).toEqual({
      "루페온:냠수나이스1": true,
      "아만:냠수나이스2": true
    });
    expect(buildCharacterCandidateSelection(candidates, false)).toEqual({
      "루페온:냠수나이스1": false,
      "아만:냠수나이스2": false
    });
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

  it("shows bulk selection controls and a prominent save button after search results", () => {
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
          },
          {
            name: "냠수나이스2",
            serverName: "루페온",
            className: "바드",
            itemLevel: "1,640.00",
            combatPower: null
          }
        ],
        selected: { "아만:냠수나이스1": true },
        onNameChange: vi.fn(),
        onSearch: vi.fn(),
        onSave: vi.fn(),
        onSelectAll: vi.fn(),
        onClearSelection: vi.fn(),
        onToggle: vi.fn()
      })
    );

    expect(html).toContain('class="primary-button character-import-save-button"');
    expect(html).toContain("1/2 선택됨");
    expect(html).toContain("전체 선택");
    expect(html).toContain("선택 해제");
    expect(html.indexOf("전체 선택")).toBeLessThan(html.indexOf("서버"));
  });

  it("limits search input to Lost Ark character name length", () => {
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

    expect(html).toContain('maxLength="12"');
  });

  it("uses a submit form so Enter can trigger character search", () => {
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

    expect(html).toContain('<form class="inline-form"');
    expect(html).toContain('type="submit"');
  });

  it("shows a compact searching indicator", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterImportPanel, {
        name: "냠수나이스1",
        candidates: [],
        selected: {},
        searching: true,
        onNameChange: vi.fn(),
        onSearch: vi.fn(),
        onSave: vi.fn(),
        onToggle: vi.fn()
      })
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("spin-icon");
    expect(html).toContain("검색 중...");
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
    expect(html).toContain('class="status-text notice-text"');
    expect(html).toContain('role="status"');
  });

  it("renders failure messages with alert styling", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterImportPanel, {
        name: "냠수나이스1",
        candidates: [],
        selected: {},
        message: "캐릭터 정보를 불러오지 못했습니다. 대표 캐릭터명을 확인하거나 잠시 후 다시 시도해주세요.",
        messageTone: "error",
        onNameChange: vi.fn(),
        onSearch: vi.fn(),
        onSave: vi.fn(),
        onToggle: vi.fn()
      })
    );

    expect(html).toContain("캐릭터 정보를 불러오지 못했습니다.");
    expect(html).toContain('class="status-text error-text"');
    expect(html).toContain('role="alert"');
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

  it("does not edit existing character display names inside the import panel", () => {
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

    expect(html).not.toContain("축약 이름");
    expect(html).not.toContain("냠1");
  });
});

describe("ManualCharacterCreatePanel", () => {
  it("renders nickname as required and other character details as optional", () => {
    const html = renderToStaticMarkup(
      createElement(ManualCharacterCreatePanel, {
        manualCharacter: {
          name: "",
          serverName: "",
          className: "",
          itemLevel: "",
          combatPower: ""
        },
        saving: false,
        onChange: vi.fn(),
        onSave: vi.fn()
      })
    );

    expect(html).toContain("직접 추가");
    expect(html).toContain("닉네임");
    expect(html).toContain("서버");
    expect(html).toContain("직업");
    expect(html).toContain("아이템 레벨");
    expect(html).toContain("전투력");
    expect(html).toContain("disabled");
  });
});

describe("getCharacterSearchNameError", () => {
  it("allows valid Lost Ark character names", () => {
    expect(getCharacterSearchNameError("냠수나이스1")).toBeNull();
    expect(getCharacterSearchNameError("RiceArk123")).toBeNull();
  });

  it("explains names that are too long or contain unsupported characters", () => {
    expect(getCharacterSearchNameError("가나다라마바사아자차카타파")).toBe(CHARACTER_SEARCH_NAME_ERROR);
    expect(getCharacterSearchNameError("냠수 나이스1")).toBe(CHARACTER_SEARCH_NAME_ERROR);
    expect(getCharacterSearchNameError("냠수-나이스1")).toBe(CHARACTER_SEARCH_NAME_ERROR);
  });
});

describe("CharacterImport search integration", () => {
  it("uses the injected client for search, roster import, and manual creation", () => {
    const source = readFileSync(new URL("./CharacterImport.tsx", import.meta.url), "utf8");

    expect(source).toContain("apiClient?: ApiClient");
    expect(source).toContain("apiClient = defaultApiClient");
    expect(source).toMatch(/apiClient\.get<\{ characters: CharacterCandidate\[\] \}>/);
    expect(source).toMatch(/await apiClient\.post\(tableId \? `\/api\/board\/tables\/\$\{encodeURIComponent\(tableId\)\}\/characters\/import`/);
    expect(source).toMatch(/await apiClient\.post\(tableId \? `\/api\/board\/tables\/\$\{encodeURIComponent\(tableId\)\}\/characters\/manual`/);
    expect(source).not.toMatch(/\bapi(?:Get|Post)\(/);
  });

  it("uses the bounded browser cache while keeping successful results fully selected", () => {
    const source = readFileSync(new URL("./CharacterImport.tsx", import.meta.url), "utf8");

    expect(source).toContain("searchCharactersCached");
    expect(source).toMatch(/setSelected\(buildCharacterCandidateSelection\(result, true\)\)/);
  });
});
