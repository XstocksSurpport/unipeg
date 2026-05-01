import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import JavaScriptObfuscator from 'javascript-obfuscator'

const assetsDir = join(process.cwd(), 'dist', 'assets')

async function obfuscateBuiltJs() {
  const files = await readdir(assetsDir)
  const jsFiles = files.filter((f) => f.endsWith('.js'))
  if (!jsFiles.length) {
    throw new Error('No built JS files found under dist/assets')
  }

  await Promise.all(
    jsFiles.map(async (name) => {
      const fullPath = join(assetsDir, name)
      const code = await readFile(fullPath, 'utf8')
      const result = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.15,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.08,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        rotateStringArray: true,
        simplify: true,
        splitStrings: true,
        splitStringsChunkLength: 8,
        stringArray: true,
        stringArrayThreshold: 0.75,
        unicodeEscapeSequence: false,
      })
      await writeFile(fullPath, result.getObfuscatedCode(), 'utf8')
    }),
  )
}

obfuscateBuiltJs()
  .then(() => {
    console.log('dist JS obfuscation complete.')
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
