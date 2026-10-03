/** Check the transitive runtime dependencies of IR, contracts and the headless kernel. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const forbiddenPackages = /^(?:react(?:-dom)?|zustand|pyodide)(?:\/|$)|^node:/
const forbiddenPaths = /^src\/(?:store|components|canvas|charts)\/|^src\/engine\/(?:backend|client|localClient|engineWorker|graphRunner)\./

function imports(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true)
  const found = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const named = clause?.namedBindings
      const allTypes = !clause?.name && named && ts.isNamedImports(named) && named.elements.every((element) => element.isTypeOnly)
      if (!clause?.isTypeOnly && !allTypes) found.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) throw new Error(`${filename}: 纯逻辑层不能动态计算 import 路径`)
      found.push(node.arguments[0].text)
    } else if (ts.isIdentifier(node) && ['window', 'document', 'localStorage', 'sessionStorage', 'Worker'].includes(node.text)) {
      const parent = node.parent
      const propertyName = parent && (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node)
      )
      if (!propertyName) throw new Error(`${filename}: 纯逻辑层引用浏览器对象 ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function checkGraph(entries, read) {
  const checked = new Set()
  function visit(filename, chain) {
    if (checked.has(filename)) return
    checked.add(filename)
    const nextChain = [...chain, filename]
    for (const source of imports(read(filename), filename)) {
      if (forbiddenPackages.test(source)) throw new Error(`${nextChain.join(' → ')} → ${source}`)
      if (!source.startsWith('.')) continue
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(filename), source))
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => read(candidate, true) !== null)
      if (!target) throw new Error(`${filename}: 找不到运行时依赖 ${source}`)
      if (forbiddenPaths.test(target)) throw new Error(`${nextChain.join(' → ')} → ${target}`)
      visit(target, nextChain)
    }
  }
  entries.forEach((filename) => visit(filename, []))
  return checked.size
}

if (process.argv.includes('--self-test')) {
  assert.deepEqual(imports("import type { Store } from '../store/x'; import { type T, f } from './pure';", 'a.ts'), ['./pure'])
  const graph = { 'src/workflow/a.ts': "export { f } from './b'", 'src/workflow/b.ts': "import { f } from '../store/x'", 'src/store/x.ts': '' }
  assert.throws(() => checkGraph(['src/workflow/a.ts'], (file) => graph[file] ?? null), /a\.ts → src\/workflow\/b\.ts → src\/store/)
  assert.throws(() => imports("const doc = document;", 'a.ts'), /浏览器对象/)
  assert.throws(() => imports("window.localStorage.getItem('x')", 'a.ts'), /浏览器对象/)
  assert.throws(() => imports("new Worker('x')", 'a.ts'), /浏览器对象/)
  assert.throws(() => imports("const x = { browser: document }", 'a.ts'), /浏览器对象/)
  assert.deepEqual(imports("const data = { document: 'text' }; data.document", 'a.ts'), [])
  assert.throws(() => imports("import(target)", 'a.ts'), /动态计算/)
}

const entries = ['workflow', 'contract', 'kernel'].flatMap((directory) => fs.readdirSync(path.join(root, 'src', directory))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => `src/${directory}/${file}`))
entries.push('src/engine/plan.ts')
const count = checkGraph(entries, (relative, optional = false) => {
  const filename = path.join(root, relative)
  if (optional && (!fs.existsSync(filename) || !fs.statSync(filename).isFile())) return null
  return fs.readFileSync(filename, 'utf8')
})
process.stdout.write(`layer checks passed (${count} modules, including transitive dependencies)\n`)
