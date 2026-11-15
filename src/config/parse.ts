/**
 * The built-in reader for YAML and JSON policy files.
 *
 * The CLI and the Action carry no YAML library. Governance configs are
 * structured YAML with a predictable schema, and this reader handles them;
 * for anything richer, operators supply JSON.
 */

/**
 * Parse the config file text. Supports YAML (via a hand-rolled subset adequate
 * for governance configs — flat string/bool/number scalars, nested objects, and
 * string arrays) and JSON.
 *
 * The package has no YAML library dependency. Governance configs are structured
 * YAML with a predictable schema: the hand-rolled parser handles the real cases.
 * For truly complex YAML, operators can supply JSON instead.
 */
export function parseConfigFile(filePath: string, text: string): unknown {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) {
    return JSON.parse(text);
  }
  // YAML or ambiguous extension: delegate to the hand-rolled YAML parser.
  return parseSimpleYaml(text);
}

/**
 * Minimal YAML parser for governance config files.
 *
 * Handles:
 *   - Nested mappings (indented with 2 spaces).
 *   - String, boolean, and integer scalars.
 *   - Sequences of scalars (- item) and mappings (- key: val).
 *   - Comments (#) and blank lines.
 *
 * Does NOT handle:
 *   - Flow style ({ } / [ ]).
 *   - Multi-line scalars (| / >).
 *   - Anchors / aliases (* / &).
 *   - Quoted keys.
 *
 * Governance configs are authored with this tool and are unlikely to use those
 * features. If they do, operators should use JSON.
 */
function parseSimpleYaml(text: string): unknown {
  const lines = text.split("\n");
  const root = parseYamlBlock(lines, 0, 0);
  return root.value;
}

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function parseYamlBlock(lines: string[], startLine: number, indent: number): ParseResult {
  // Collect lines at this indent level, building a mapping or sequence.
  let i = startLine;
  const result: Record<string, unknown> = {};
  const seq: unknown[] = [];
  let isSequence = false;
  let isMapping = false;

  while (i < lines.length) {
    const raw = lines[i];
    const stripped = raw.replace(/#.*$/, "").trimEnd();

    if (stripped.trim() === "") {
      i++;
      continue;
    }

    const lineIndent = stripped.length - stripped.trimStart().length;

    // Dedent: this line belongs to a parent block.
    if (lineIndent < indent) break;

    // Deeper indent: should have been consumed by a recursive call.
    if (lineIndent > indent) {
      i++;
      continue;
    }

    const content = stripped.trimStart();

    // Sequence item.
    if (content.startsWith("- ")) {
      isSequence = true;
      const rest = content.slice(2).trim();
      // Inline mapping: "- key: value"
      if (/^[^:]+:\s/.test(rest) || /^[^:]+:$/.test(rest)) {
        // Parse as a mini-mapping starting from the same line.
        const itemMap = parseInlineSequenceMappingItem(lines, i, lineIndent + 2);
        seq.push(itemMap.value);
        i = itemMap.nextLine;
      } else {
        seq.push(parseScalar(rest));
        i++;
      }
      continue;
    }

    // Mapping entry: "key: value" or "key:".
    const colonIdx = content.indexOf(": ");
    const bareColon = content.endsWith(":") && !content.includes(": ");
    if (colonIdx !== -1 || bareColon) {
      isMapping = true;
      const key = colonIdx !== -1 ? content.slice(0, colonIdx).trim() : content.slice(0, -1).trim();
      const valueStr = colonIdx !== -1 ? content.slice(colonIdx + 2).trim() : "";

      i++;

      if (valueStr !== "" && valueStr !== "|" && valueStr !== ">") {
        // Inline scalar value.
        result[key] = parseScalar(valueStr);
      } else {
        // Value is on subsequent lines — recurse.
        // Find the indent of the next non-blank, non-comment line.
        let nextNonBlank = i;
        while (nextNonBlank < lines.length) {
          const candidate = lines[nextNonBlank].replace(/#.*$/, "").trimEnd();
          if (candidate.trim() !== "") break;
          nextNonBlank++;
        }
        if (nextNonBlank >= lines.length) {
          result[key] = null;
        } else {
          const childIndent =
            lines[nextNonBlank].length - lines[nextNonBlank].trimStart().length;
          if (childIndent <= indent) {
            result[key] = null;
          } else {
            const child = parseYamlBlock(lines, nextNonBlank, childIndent);
            result[key] = child.value;
            i = child.nextLine;
          }
        }
      }
      continue;
    }

    // Unrecognized line at this indent — skip.
    i++;
  }

  if (isSequence) return { value: seq, nextLine: i };
  if (isMapping) return { value: result, nextLine: i };
  return { value: null, nextLine: i };
}

/**
 * Parse a sequence item that starts a mapping at `startLine`.
 * E.g.:
 *   - pattern: main
 *     requirePullRequestReviews: true
 */
function parseInlineSequenceMappingItem(
  lines: string[],
  startLine: number,
  childIndent: number,
): ParseResult {
  const raw = lines[startLine];
  const stripped = raw.replace(/#.*$/, "").trimEnd();
  const lineIndent = stripped.length - stripped.trimStart().length;
  const content = stripped.trimStart().slice(2).trim(); // strip "- "

  const colonIdx = content.indexOf(": ");
  const bareColon = content.endsWith(":") && !content.includes(": ");
  const result: Record<string, unknown> = {};

  if (colonIdx !== -1 || bareColon) {
    const key = colonIdx !== -1 ? content.slice(0, colonIdx).trim() : content.slice(0, -1).trim();
    const valueStr = colonIdx !== -1 ? content.slice(colonIdx + 2).trim() : "";
    if (valueStr !== "") {
      result[key] = parseScalar(valueStr);
    } else {
      // value is on child lines
      let nextNonBlank = startLine + 1;
      while (nextNonBlank < lines.length) {
        const candidate = lines[nextNonBlank].replace(/#.*$/, "").trimEnd();
        if (candidate.trim() !== "") break;
        nextNonBlank++;
      }
      if (nextNonBlank < lines.length) {
        const ci = lines[nextNonBlank].length - lines[nextNonBlank].trimStart().length;
        if (ci > lineIndent) {
          const child = parseYamlBlock(lines, nextNonBlank, ci);
          result[key] = child.value;
          // Continue collecting sibling keys at childIndent.
          const rest = parseYamlBlock(lines, child.nextLine, childIndent);
          if (rest.value && typeof rest.value === "object" && !Array.isArray(rest.value)) {
            Object.assign(result, rest.value as object);
            return { value: result, nextLine: rest.nextLine };
          }
          return { value: result, nextLine: child.nextLine };
        }
      }
    }
  }

  // Collect sibling keys at `childIndent`.
  const rest = parseYamlBlock(lines, startLine + 1, childIndent);
  if (rest.value && typeof rest.value === "object" && !Array.isArray(rest.value)) {
    Object.assign(result, rest.value as object);
    return { value: result, nextLine: rest.nextLine };
  }
  return { value: result, nextLine: startLine + 1 };
}

function parseScalar(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  // Strip optional quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  const n = Number(s);
  if (!isNaN(n) && s.trim() !== "") return n;
  return s;
}
