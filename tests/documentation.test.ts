import { describe, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const documentationRoots = [
  "README.md",
  "DESIGN.md",
  "benchmarks",
  "compiler",
  "docs",
  "examples",
];

function markdownFiles(path: string): string[] {
  const absolute = resolve(projectRoot, path);
  if (extname(absolute) === ".md") return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".z-cache" || entry.name === "build") return [];
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) return markdownFiles(child);
    return entry.isFile() && entry.name.endsWith(".md") ? [child] : [];
  });
}

function localLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim())
    .filter((target) => (
      target.length > 0
      && !target.startsWith("#")
      && !/^[a-z][a-z0-9+.-]*:/i.test(target)
    ))
    .map((target) => decodeURIComponent(target.split("#", 1)[0]));
}

describe("documentation", () => {
  test("all local Markdown links resolve", () => {
    const failures: string[] = [];
    const files = documentationRoots.flatMap(markdownFiles);
    for (const file of files) {
      const markdown = readFileSync(file, "utf8");
      for (const target of localLinkTargets(markdown)) {
        const destination = resolve(dirname(file), target);
        if (!existsSync(destination)) {
          failures.push(`${file.slice(projectRoot.length + 1)} -> ${target}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`broken local documentation links:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
    }
  });
});
