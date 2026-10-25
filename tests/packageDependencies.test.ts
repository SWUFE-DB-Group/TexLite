import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

describe("npm runtime dependencies", () => {
  it("ships the fixed agent instructions as a package runtime asset", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toContain("templates/agents/AGENTS.md");
    const template = fs.readFileSync(path.join(repositoryRoot, "templates/agents/AGENTS.md"), "utf8");
    expect(template).toContain("TexLite");
    expect(template).toContain("../output");
    expect(template).toContain("TEXLITE_PROJECT_CONTEXT");
  });

  it("declares every server and shared runtime import as a production dependency", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const missing: string[] = [];

    for (const directory of ["src/server", "src/shared"]) {
      const root = path.join(repositoryRoot, directory);
      for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
        if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
        const file = path.join(root, entry);
        // Inspect emitted imports: type-only uses of development dependencies
        // must not require those packages in the published installation.
        const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
        });
        const source = ts.createSourceFile(file, outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

        function checkSpecifier(specifier: ts.Expression | undefined): void {
          if (!specifier || !ts.isStringLiteralLike(specifier)) return;
          const name = specifier.text;
          if (name.startsWith(".") || isBuiltin(name)) return;
          const packageName = name.split("/").slice(0, name.startsWith("@") ? 2 : 1).join("/");
          if (!Object.hasOwn(manifest.dependencies, packageName) && !Object.hasOwn(manifest.optionalDependencies ?? {}, packageName)) {
            missing.push(`${path.relative(repositoryRoot, file)}: ${name}`);
          }
        }

        function visit(node: ts.Node): void {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            checkSpecifier(node.moduleSpecifier);
          } else if (ts.isCallExpression(node) && (
            node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === "require")
          )) {
            checkSpecifier(node.arguments[0]);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }

    expect(missing, "Runtime imports must be installed by npm install --omit=dev").toEqual([]);
  });
});
