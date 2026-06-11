import type { ReactNode } from "react";

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; lines: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

const inlinePattern = /(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;

export function BoardNoteMarkdown({ value }: { value: string }) {
  const blocks = parseMarkdownBlocks(value);

  if (blocks.length === 0) {
    return <p className="board-note-markdown-empty">메모</p>;
  }

  return (
    <>
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </>
  );
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === "heading") {
    const children = renderInlineMarkdown(block.text, `h-${index}`);
    if (block.level === 1) return <h3 key={index}>{children}</h3>;
    if (block.level === 2) return <h4 key={index}>{children}</h4>;
    return <h5 key={index}>{children}</h5>;
  }

  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineMarkdown(item, `li-${index}-${itemIndex}`)}</li>
        ))}
      </Tag>
    );
  }

  if (block.type === "table") {
    return (
      <div className="board-note-markdown-table-wrap" key={index}>
        <table>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={headerIndex}>{renderInlineMarkdown(header, `th-${index}-${headerIndex}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.headers.map((_, cellIndex) => (
                  <td key={cellIndex}>{renderInlineMarkdown(row[cellIndex] ?? "", `td-${index}-${rowIndex}-${cellIndex}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <p key={index}>
      {block.lines.flatMap((line, lineIndex) => [
        ...(lineIndex === 0 ? [] : [<br key={`br-${index}-${lineIndex}`} />]),
        ...renderInlineMarkdown(line, `p-${index}-${lineIndex}`)
      ])}
    </p>
  );
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const marks = heading[1] ?? "#";
      const text = heading[2] ?? "";
      blocks.push({ type: "heading", level: marks.length as 1 | 2 | 3, text: text.trim() });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index] ?? "");
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isLikelyTableRow(lines[index] ?? "")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^\s*[-*+]\s+(.+)$/.exec(lines[index] ?? "");
        if (!match) break;
        items.push((match[1] ?? "").trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^\s*\d+\.\s+(.+)$/.exec(lines[index] ?? "");
        if (!match) break;
        items.push((match[1] ?? "").trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim()) break;
      if (paragraphLines.length > 0 && (isTableStart(lines, index) || /^(#{1,3})\s+/.test(current) || /^\s*[-*+]\s+/.test(current) || /^\s*\d+\.\s+/.test(current))) {
        break;
      }
      paragraphLines.push(current.trimEnd());
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? "";
  const divider = lines[index + 1] ?? "";
  if (!isLikelyTableRow(header) || !isLikelyTableRow(divider)) return false;
  const headers = splitTableRow(header);
  const dividers = splitTableRow(divider);
  return headers.length > 0 && headers.length === dividers.length && dividers.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isLikelyTableRow(line: string): boolean {
  return line.includes("|") && splitTableRow(line).length > 1;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaping = false;

  for (const character of trimmed) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  cells.push(current.trim());
  return cells;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  inlinePattern.lastIndex = 0;

  for (const match of text.matchAll(inlinePattern)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[2]) {
      nodes.push(<code key={`${keyPrefix}-${nodes.length}`}>{match[2]}</code>);
    } else if (match[4] && match[5]) {
      const href = getSafeMarkdownHref(match[5]);
      nodes.push(
        href ? (
          <a href={href} key={`${keyPrefix}-${nodes.length}`} rel="noreferrer" target="_blank">
            {match[4]}
          </a>
        ) : (
          match[4]
        )
      );
    } else if (match[7]) {
      nodes.push(<strong key={`${keyPrefix}-${nodes.length}`}>{match[7]}</strong>);
    } else if (match[9]) {
      nodes.push(<em key={`${keyPrefix}-${nodes.length}`}>{match[9]}</em>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function getSafeMarkdownHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return null;
}
