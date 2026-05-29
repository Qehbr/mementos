/**
 * Find class methods with no references outside their declaring file.
 *
 * Uses the TypeScript compiler's findReferences API — semantic, not text-grep — so it
 * disambiguates `KeychainKeyProvider.clear()` from `Map.clear()`. Knip doesn't analyze
 * class members and ESLint's `no-unused-private-class-members` only sees `private` ones,
 * leaving public/static methods on used classes (e.g. `KeychainKeyProvider.clear`) invisible.
 *
 * Run with: `npm run dead:methods`
 *
 * Caveats — heuristics, not proof:
 *   - Static factories called via dynamic `import()` and reflection (the auto-discovery
 *     pattern) ARE seen by findReferences as long as the caller types the import.
 *   - Methods passed by value (callback, event handler) and dispatched dynamically are
 *     correctly counted. But methods reached only via `obj['method']()` indexed access
 *     can be missed.
 *   - We exclude self-references inside the same file — those don't prove external use.
 */
import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import ts from 'typescript'

const TSCONFIG = './tsconfig.json'
const ROOT = process.cwd()

// Skip these — they're never genuine "unused" signals:
//   - constructor: declared by every class
//   - setupAtInit: when this exists as a class method, the module-level `setupAtInit`
//     export delegates to it (auto-discovery contract). The script counts the delegating
//     export as a same-file caller and would flag the method as "no external references."
//   - test files: not part of production surface; their "unused" methods are scaffold
const SKIP_NAMES = new Set(['constructor', 'setupAtInit'])
const SKIP_FILE_RE = /\/__tests__\//

function loadProgram(): ts.Program {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, TSCONFIG)
  if (!configPath) throw new Error('tsconfig.json not found')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath))
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
}

interface MethodFinding {
  file: string
  className: string
  methodName: string
  isStatic: boolean
  visibility: 'public' | 'private' | 'protected'
  line: number
}

function findClassMethods(program: ts.Program): MethodFinding[] {
  const findings: MethodFinding[] = []

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    if (SKIP_FILE_RE.test(sourceFile.fileName)) continue
    if (!sourceFile.fileName.startsWith(ROOT)) continue

    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || !member.name) continue
          if (!ts.isIdentifier(member.name)) continue
          const methodName = member.name.text
          if (SKIP_NAMES.has(methodName)) continue

          const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) ?? [] : []
          const isStatic = modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword)
          const isPrivate = modifiers.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)
          const isProtected = modifiers.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword)
          const visibility = isPrivate ? 'private' : isProtected ? 'protected' : 'public'

          const { line } = sourceFile.getLineAndCharacterOfPosition(member.name.getStart(sourceFile))
          findings.push({
            file: sourceFile.fileName,
            className,
            methodName,
            isStatic,
            visibility,
            line: line + 1,
          })
        }
      }
      ts.forEachChild(node, visit)
    })
  }

  return findings
}

interface RefCounts {
  /** All references including the declaration. -1 on lookup failure. */
  total: number
  /** References from files other than the declaring file. */
  external: number
}

/**
 * Count references to a class member, both total and external. Uses tsserver's
 * findReferences (not the lower-level checker.getSymbolAtLocation) — gives us the same
 * "find all references" data IDEs show, semantically aware.
 *
 * `total` includes the declaration site itself (TS's findReferences returns it). So a
 * method declared but never called has total === 1; external === 0 doesn't necessarily
 * mean unused (could be called from the same file).
 */
function countReferences(
  service: ts.LanguageService,
  finding: MethodFinding,
): RefCounts {
  const program = service.getProgram()!
  const source = program.getSourceFile(finding.file)
  if (!source) return { total: -1, external: -1 }

  const text = readFileSync(finding.file, 'utf8')
  const lines = text.split('\n')
  const lineText = lines[finding.line - 1]
  const col = lineText.indexOf(finding.methodName)
  if (col < 0) return { total: -1, external: -1 }
  const pos = source.getPositionOfLineAndCharacter(finding.line - 1, col)

  const refs = service.getReferencesAtPosition(finding.file, pos)
  if (!refs) return { total: 0, external: 0 }

  let external = 0
  for (const ref of refs) {
    if (ref.fileName === finding.file) continue
    external++
  }
  return { total: refs.length, external }
}

function main() {
  const program = loadProgram()
  const compilerOptions = program.getCompilerOptions()
  const rootFileNames = program.getRootFileNames()

  // Build a LanguageService from the same files.
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...rootFileNames],
    getScriptVersion: () => '0',
    getScriptSnapshot: (name) => {
      try { return ts.ScriptSnapshot.fromString(readFileSync(name, 'utf8')) }
      catch { return undefined }
    },
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())

  const findings = findClassMethods(program).map(f => ({ ...f, refs: countReferences(service, f) }))

  // (1) Public methods with no external use — could be private (or dead).
  // ESLint's `no-unused-private-class-members` only catches `#`-syntax private members,
  // NOT TypeScript's `private` keyword (which is a type-system-only access modifier),
  // so this script complements it by catching public methods that have no outside callers.
  const publicNoExternal = findings.filter(f => f.visibility === 'public' && f.refs.external === 0)

  // (2) Private/protected methods with refs.total === 1 — truly dead. The single reference
  // is the declaration itself; nothing in the same file calls it.
  const privateUnused = findings.filter(f => f.visibility !== 'public' && f.refs.total === 1)

  if (publicNoExternal.length === 0 && privateUnused.length === 0) {
    console.log('No suspicious methods detected.')
    return
  }

  if (publicNoExternal.length > 0) {
    console.log(`Found ${publicNoExternal.length} public method(s) with no external references — could be private (or dead):\n`)
    for (const f of publicNoExternal) {
      const rel = relative(ROOT, f.file)
      const tag = f.isStatic ? 'static public' : 'public'
      const internal = f.refs.total - 1  // total includes the declaration
      const useTag = internal === 0 ? 'NO INTERNAL CALLERS — DEAD' : `${internal} internal caller(s)`
      console.log(`  ${rel}:${f.line}  ${f.className}.${f.methodName}  [${tag}]  (${useTag})`)
    }
    console.log('')
  }

  if (privateUnused.length > 0) {
    console.log(`Found ${privateUnused.length} private/protected method(s) with no callers — dead:\n`)
    for (const f of privateUnused) {
      const rel = relative(ROOT, f.file)
      const tag = `${f.isStatic ? 'static ' : ''}${f.visibility}`
      console.log(`  ${rel}:${f.line}  ${f.className}.${f.methodName}  [${tag}]`)
    }
  }
}

main()
