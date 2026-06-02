/**
 * Detect language, framework, package manager, and the test/lint/build commands
 * for the project at `cwd`.
 */
import * as fs from "fs";
import * as path from "path";
import fg from "fast-glob";
import type { RepoInfo } from "../types";
import { IGNORE } from "../tools/fileTools";
import { isRepo, isDirty } from "../tools/gitTools";

const exists = (cwd: string, f: string) => fs.existsSync(path.join(cwd, f));

interface Detector {
  language: string;
  marker: (cwd: string) => boolean;
  pm?: (cwd: string) => string | undefined;
  testCommand?: string;
  lintCommand?: string;
  buildCommand?: string;
  framework?: (cwd: string) => string | undefined;
}

const DETECTORS: Detector[] = [
  {
    language: "JavaScript/TypeScript",
    marker: (c) => exists(c, "package.json"),
    pm: (c) =>
      exists(c, "pnpm-lock.yaml")
        ? "pnpm"
        : exists(c, "yarn.lock")
        ? "yarn"
        : exists(c, "bun.lockb")
        ? "bun"
        : "npm",
    testCommand: "test",
    lintCommand: "lint",
    buildCommand: "build",
    framework: (c) => {
      const pkg = readPkg(c);
      const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
      if (deps?.next) return "Next.js";
      if (deps?.react) return "React";
      if (deps?.vue) return "Vue";
      if (deps?.express) return "Express";
      if (deps?.fastify) return "Fastify";
      return undefined;
    },
  },
  {
    language: "Python",
    marker: (c) => exists(c, "pyproject.toml") || exists(c, "requirements.txt") || exists(c, "setup.py"),
    pm: (c) => (exists(c, "poetry.lock") ? "poetry" : exists(c, "uv.lock") ? "uv" : "pip"),
    testCommand: "pytest",
    framework: (c) => {
      if (exists(c, "manage.py")) return "Django";
      const req = safeRead(c, "requirements.txt") + safeRead(c, "pyproject.toml");
      if (/fastapi/i.test(req)) return "FastAPI";
      if (/flask/i.test(req)) return "Flask";
      return undefined;
    },
  },
  {
    language: "Rust",
    marker: (c) => exists(c, "Cargo.toml"),
    pm: () => "cargo",
    testCommand: "cargo test",
    buildCommand: "cargo build",
    lintCommand: "cargo clippy",
  },
  {
    language: "Go",
    marker: (c) => exists(c, "go.mod"),
    pm: () => "go",
    testCommand: "go test ./...",
    buildCommand: "go build ./...",
    lintCommand: "go vet ./...",
  },
  {
    language: "Java",
    marker: (c) => exists(c, "pom.xml") || exists(c, "build.gradle") || exists(c, "build.gradle.kts"),
    pm: (c) => (exists(c, "pom.xml") ? "maven" : "gradle"),
    testCommand: undefined,
    framework: (c) => (exists(c, "pom.xml") ? "Maven" : "Gradle"),
  },
  {
    language: "C#",
    marker: (c) => fg.sync("**/*.csproj", { cwd: c, ignore: IGNORE, suppressErrors: true }).length > 0,
    pm: () => "dotnet",
    testCommand: "dotnet test",
    buildCommand: "dotnet build",
  },
  {
    language: "PHP",
    marker: (c) => exists(c, "composer.json"),
    pm: () => "composer",
    testCommand: "vendor/bin/phpunit",
  },
  {
    language: "Ruby",
    marker: (c) => exists(c, "Gemfile"),
    pm: () => "bundler",
    testCommand: "bundle exec rspec",
  },
];

function readPkg(cwd: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
  } catch {
    return undefined;
  }
}

function safeRead(cwd: string, f: string): string {
  try {
    return fs.readFileSync(path.join(cwd, f), "utf-8");
  } catch {
    return "";
  }
}

/** Resolve the node test/lint/build script into a runnable command. */
function nodeScript(cwd: string, pm: string, scriptName?: string): string | undefined {
  if (!scriptName) return undefined;
  const pkg = readPkg(cwd);
  if (!pkg?.scripts?.[scriptName]) return undefined;
  return pm === "npm" ? `npm run ${scriptName}` : `${pm} ${scriptName}`;
}

export async function scanRepo(cwd: string): Promise<RepoInfo> {
  const languages: string[] = [];
  let framework: string | undefined;
  let packageManager: string | undefined;
  let testCommand: string | undefined;
  let lintCommand: string | undefined;
  let buildCommand: string | undefined;

  for (const d of DETECTORS) {
    if (!d.marker(cwd)) continue;
    languages.push(d.language);
    if (!framework && d.framework) framework = d.framework(cwd);
    const pm = d.pm?.(cwd);
    if (!packageManager && pm) packageManager = pm;

    if (d.language.startsWith("JavaScript") && pm) {
      testCommand = testCommand ?? nodeScript(cwd, pm, d.testCommand);
      lintCommand = lintCommand ?? nodeScript(cwd, pm, d.lintCommand);
      buildCommand = buildCommand ?? nodeScript(cwd, pm, d.buildCommand);
    } else {
      testCommand = testCommand ?? d.testCommand;
      lintCommand = lintCommand ?? d.lintCommand;
      buildCommand = buildCommand ?? d.buildCommand;
    }
  }

  const allFiles = await fg("**/*", {
    cwd,
    ignore: IGNORE,
    onlyFiles: true,
    followSymbolicLinks: false,
    // Skip directories we can't read (e.g. Windows' protected
    // "Application Data" junction) instead of throwing EPERM.
    suppressErrors: true,
  });

  const entrypoints = allFiles.filter((f) =>
    /(^|\/)(index|main|app|cli|server)\.(ts|js|py|go|rs)$/i.test(f)
  );
  const keyFiles = allFiles
    .filter((f) =>
      /(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|README|tsconfig\.json)/i.test(f)
    )
    .slice(0, 20);

  return {
    root: cwd,
    languages: languages.length ? languages : ["unknown"],
    framework,
    packageManager,
    testCommand,
    lintCommand,
    buildCommand,
    entrypoints: entrypoints.slice(0, 10),
    keyFiles,
    fileCount: allFiles.length,
    hasGit: await isRepo(cwd),
    dirty: await isDirty(cwd),
  };
}

/** A compact text summary of the repo for prompt context. */
export function summarizeRepo(info: RepoInfo): string {
  const lines = [
    `Languages: ${info.languages.join(", ")}`,
    info.framework ? `Framework: ${info.framework}` : "",
    info.packageManager ? `Package manager: ${info.packageManager}` : "",
    info.testCommand ? `Test command: ${info.testCommand}` : "Test command: (none detected)",
    `Files: ${info.fileCount}`,
    info.entrypoints.length ? `Entrypoints: ${info.entrypoints.join(", ")}` : "",
    `Git: ${info.hasGit ? (info.dirty ? "dirty" : "clean") : "not a repo"}`,
  ];
  return lines.filter(Boolean).join("\n");
}
