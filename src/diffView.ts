import { diffLines, diffWords } from "diff";

// Line-level diff view: changed line pairs are highlighted at the word level, and long unchanged
// stretches collapse into an "N lines folded" marker. Uses only our own CSS classes (grpc-diff-*,
// defined in styles.css) — no dependency on core CSS. Shared by syncHistoryModal.ts and
// fileRecoveryModal.ts.
export function renderDiff(container: HTMLElement, oldText: string, newText: string) {
  container.empty();
  container.addClass("grpc-diff-view");

  const splitPartLines = (value: string): string[] => {
    const lines = value.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  const normalizedOld = oldText.endsWith("\n") || oldText === "" ? oldText : oldText + "\n";
  const normalizedNew = newText.endsWith("\n") || newText === "" ? newText : newText + "\n";
  const lineParts = diffLines(normalizedOld, normalizedNew);

  type Pair = [string | null, string | null];
  const pairs: Pair[] = [];
  for (let i = 0; i < lineParts.length; i++) {
    const part = lineParts[i];
    const next = lineParts[i + 1];
    if (part.removed && next && next.added) {
      const removedLines = splitPartLines(part.value);
      const addedLines = splitPartLines(next.value);
      const max = Math.max(removedLines.length, addedLines.length);
      for (let y = 0; y < max; y++) {
        pairs.push([removedLines[y] ?? null, addedLines[y] ?? null]);
      }
      i++;
    } else {
      for (const line of splitPartLines(part.value)) {
        if (part.added) pairs.push([null, line]);
        else if (part.removed) pairs.push([line, null]);
        else pairs.push([line, line]);
      }
    }
  }

  const makeLine = (text: string, mod: "left" | "right" | null): HTMLElement => {
    const el = createDiv("grpc-diff-line");
    if (mod) el.addClass(`grpc-diff-mod-${mod}`);
    el.appendText(text);
    el.createEl("br");
    return el;
  };

  let equalBuffer: HTMLElement[] = [];
  const flushEqual = (isLast: boolean) => {
    if (equalBuffer.length === 0) return;
    const isFirst = container.childElementCount === 0;
    const threshold = isFirst || isLast ? 5 : 10;
    if (equalBuffer.length > threshold) {
      const before = equalBuffer.slice(0, isFirst ? 0 : 3);
      const after = isLast ? [] : equalBuffer.slice(equalBuffer.length - 3);
      const middle = equalBuffer.slice(before.length, equalBuffer.length - after.length);
      before.forEach((el) => container.appendChild(el));
      if (middle.length > 0) {
        const collapsedEl = container.createDiv("grpc-diff-collapsed");
        collapsedEl.setText(`${middle.length} lines folded`);
        collapsedEl.addEventListener("click", () => {
          middle.forEach((el) => collapsedEl.before(el));
          collapsedEl.detach();
        });
      }
      after.forEach((el) => container.appendChild(el));
    } else {
      equalBuffer.forEach((el) => container.appendChild(el));
    }
    equalBuffer = [];
  };

  for (const [oldLine, newLine] of pairs) {
    if (oldLine !== null && newLine !== null && oldLine === newLine) {
      equalBuffer.push(makeLine(oldLine, null));
      continue;
    }
    flushEqual(false);

    if (oldLine !== null && newLine !== null) {
      const wordParts = diffWords(oldLine, newLine);
      const changedChars = wordParts
        .filter((p) => p.added || p.removed)
        .reduce((sum, p) => sum + p.value.length, 0);
      const maxLen = Math.max(oldLine.length, newLine.length, 1);
      if (wordParts.length > 1 && changedChars < maxLen / 2) {
        const leftEl = createDiv("grpc-diff-line grpc-diff-mod-left");
        const rightEl = createDiv("grpc-diff-line grpc-diff-mod-right");
        for (const part of wordParts) {
          if (part.added) rightEl.createSpan({ cls: "grpc-diff-changed", text: part.value });
          else if (part.removed) leftEl.createSpan({ cls: "grpc-diff-changed", text: part.value });
          else {
            leftEl.createSpan({ text: part.value });
            rightEl.createSpan({ text: part.value });
          }
        }
        leftEl.createEl("br");
        rightEl.createEl("br");
        container.appendChild(leftEl);
        container.appendChild(rightEl);
      } else {
        container.appendChild(makeLine(oldLine, "left"));
        container.appendChild(makeLine(newLine, "right"));
      }
    } else if (oldLine !== null) {
      container.appendChild(makeLine(oldLine, "left"));
    } else if (newLine !== null) {
      container.appendChild(makeLine(newLine, "right"));
    }
  }
  flushEqual(true);
}
