import { SCRIPT_EXTENSIONS } from "../core/asset-spec";
import { looksLikeWorkflow } from "../workflows/parser";
import type { FileContext } from "./file-context";

export interface MatchFact {
  type: string;
  specificity: number;
  meta?: Record<string, unknown>;
}

export interface MatchContributor {
  name: string;
  classify(ctx: FileContext): MatchFact | null;
}

interface DirTypeRule {
  dir: string;
  type: MatchFact["type"];
  test: (ext: string, fileName: string) => boolean;
}

const DIR_TYPE_MAP: DirTypeRule[] = [
  {
    dir: "scripts",
    type: "script",
    test: (ext) => SCRIPT_EXTENSIONS.has(ext),
  },
  {
    dir: "commands",
    type: "command",
    test: (ext) => ext === ".md",
  },
  {
    dir: "agents",
    type: "agent",
    test: (ext) => ext === ".md",
  },
  {
    dir: "knowledge",
    type: "knowledge",
    test: (ext) => ext === ".md",
  },
  {
    dir: "workflows",
    type: "workflow",
    test: (ext) => ext === ".md",
  },
  {
    dir: "memories",
    type: "memory",
    test: (ext) => ext === ".md",
  },
  {
    dir: "lessons",
    type: "lesson",
    test: (ext) => ext === ".md",
  },
  {
    dir: "vaults",
    type: "vault",
    test: (_, fileName) => fileName === ".env" || fileName.endsWith(".env"),
  },
  {
    dir: "tasks",
    type: "task",
    test: (ext) => ext === ".md",
  },
];

function matchDirectoryHint(dirName: string, ctx: FileContext, specificity: number): MatchFact | null {
  if (dirName === "skills" && ctx.fileName === "SKILL.md") {
    return { type: "skill", specificity };
  }

  for (const rule of DIR_TYPE_MAP) {
    if (rule.dir === dirName && rule.test(ctx.ext, ctx.fileName)) {
      return { type: rule.type, specificity };
    }
  }

  return null;
}

const COMMAND_PLACEHOLDER_RE = /\$ARGUMENTS|\$[123]\b/;

export const extensionContributor: MatchContributor = {
  name: "extension",
  classify(ctx) {
    if (ctx.fileName === "SKILL.md" && !ctx.ancestorDirs.includes("wikis")) {
      return { type: "skill", specificity: 25 };
    }

    if (SCRIPT_EXTENSIONS.has(ctx.ext)) {
      return { type: "script", specificity: 3 };
    }

    return null;
  },
};

export const directoryContributor: MatchContributor = {
  name: "directory",
  classify(ctx) {
    for (const dir of ctx.ancestorDirs) {
      const result = matchDirectoryHint(dir, ctx, 10);
      if (result) return result;
    }
    return null;
  },
};

export const parentDirHintContributor: MatchContributor = {
  name: "parent-dir-hint",
  classify(ctx) {
    const { parentDir, ext, fileName } = ctx;

    if (parentDir === "skills" && (fileName === "SKILL.md" || ext === ".md")) {
      return { type: "skill", specificity: 15 };
    }

    return matchDirectoryHint(parentDir, ctx, 15);
  },
};

export const smartMdContributor: MatchContributor = {
  name: "smart-md",
  classify(ctx) {
    if (ctx.ext !== ".md") return null;

    const body = ctx.content();
    if (looksLikeWorkflow(body)) {
      return { type: "workflow", specificity: 19 };
    }

    const fm = ctx.frontmatter();

    if (fm) {
      if ("toolPolicy" in fm || "tools" in fm) {
        return { type: "agent", specificity: 20 };
      }

      if ("agent" in fm) {
        return { type: "command", specificity: 18 };
      }
    }

    if (COMMAND_PLACEHOLDER_RE.test(body)) {
      return { type: "command", specificity: 18 };
    }

    if (fm && "model" in fm) {
      return { type: "agent", specificity: 8 };
    }

    return { type: "knowledge", specificity: 5 };
  },
};

export const wikiContributor: MatchContributor = {
  name: "wiki",
  classify(ctx) {
    if (ctx.ext !== ".md") return null;
    const idx = ctx.ancestorDirs.indexOf("wikis");
    if (idx < 0) return null;
    if (idx + 1 >= ctx.ancestorDirs.length) return null;
    return { type: "wiki", specificity: 20 };
  },
};

export const builtinMatchContributors: MatchContributor[] = [
  extensionContributor,
  directoryContributor,
  parentDirHintContributor,
  smartMdContributor,
  wikiContributor,
];
