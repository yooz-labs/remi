/**
 * The module specifiers of a TypeScript source, read from real syntax with the
 * TypeScript compiler, so a comment or a string literal can never match. Shared
 * by the two import-boundary tests (`license-boundary.test.ts` and
 * `harness/harness-boundary.test.ts`), which differ only in what they do with
 * the specifiers.
 */
import ts from 'typescript';

export function literalText(node: ts.Node | undefined): string | null {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return null;
}

export interface Specifier {
  readonly text: string;
  /** `import type` / `export type` / a type-position `import()`: erased at build time. */
  readonly typeOnly: boolean;
}

export interface ModuleSpecifierOptions {
  /**
   * Also count `require.resolve('x')`. Off by default: `harness-boundary.test.ts`
   * has never counted it, and the license boundary turns it on.
   */
  readonly requireResolve?: boolean;
}

/** Every statically known module specifier in `source`, from real syntax only. */
export function moduleSpecifiers(
  fileName: string,
  source: string,
  options: ModuleSpecifierOptions = {},
): Specifier[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: Specifier[] = [];
  const add = (node: ts.Node | undefined, typeOnly = false) => {
    const text = literalText(node);
    if (text !== null) found.push({ text, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isRequireResolve =
        options.requireResolve === true &&
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'require' &&
        callee.name.text === 'resolve';
      if (isDynamicImport || isRequire || isRequireResolve) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
