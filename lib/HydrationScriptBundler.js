// Compile, link, and return (using esbuild) the
// client-side hydration script for a page.

// Adapted from:
// https://esbuild.github.io/plugins/#svelte-plugin
import path from 'path'
import fs from 'fs'
import { compile } from 'svelte/compiler'
import esbuild from 'esbuild'
import { loaderPaths, parseSource } from './Utils.js'

const { nodekitAppPath, svelteExports } = await loaderPaths()

import { classNameFromRoute } from './Utils'

export async function createHydrationScriptBundle (relativePagePath, route) {
  console.verbose('  • Compiling hydration script for', relativePagePath)
  console.profileTime(`  • Hydration script compiled: ${relativePagePath}`)
  let result
  try {
    result = await esbuild.build({
      entryPoints: [relativePagePath],
      // Pass the NodeKit apps own node_modules path to node paths so that
      // projects don’t have to install Svelte themselves (so we can be sure
      // only one version is used and to simplify authoring). Unlike Node.js
      // itself, esbuild knows how to handle node paths. For Node, we implement
      // the same thing by overriding module resolution in the loader.
      // nodePaths: [path.join(process.cwd(), 'node_modules')],
      bundle: true,
      format: 'esm',
      // Do not write out, we will consume the generated source from here.
      write: false,
      plugins: [
        {
          name: 'Resolve Svelte routes',
          setup(build) {
            // Ensure we only ever use the version of Svelte that comes bundled
            // with NodeKit. This is also what we do in the ES Module Loader.
            // TODO: Refactor to remove redundancy (both between the various rules and
            // between here and the SSR module resolution in loader.js.)
            build.onResolve({filter: /^svelte$/}, args => {
              const importPath = path.resolve(path.join(nodekitAppPath, 'node_modules', 'svelte'), svelteExports['.'].browser.import)
              const resolved = { path: importPath }
              return resolved
            })

            build.onResolve({filter: /^svelte\//}, args => {
              const svelteExport = args.path.replace('svelte', '.')
              const pathToExport = svelteExports[svelteExport]

              if (pathToExport === undefined) {
                console.error('[HYDRATION SCRIPT COMPILER] Could not resolve Svelte export', svelteExport)
                process.exit(1)
              }
              const importPath = path.resolve(path.join(nodekitAppPath, 'node_modules', 'svelte'), pathToExport.import)
              const resolved = { path: importPath }
              return resolved
            })

            build.onResolve({filter: /.*/}, args => {
              if (args.importer.includes('/node_modules/svelte/')) {
                const importPath = path.resolve(path.join(nodekitAppPath, 'node_modules', 'svelte'), args.path.replace('..', '.'))
                const resolved = { path: importPath }
                return resolved
              } else {
                return
              }
            })
          }
        },
        sveltePlugin(route),
      ],
    })
  } catch (error) {
    console.error('esbuild error', error)
    process.exit(1)
  }

  const code = new TextDecoder().decode(result.outputFiles[0].contents)
  console.profileTimeEnd(`  • Hydration script compiled: ${relativePagePath}`)
  return code
}

// Private

const sveltePlugin = function (route) {
  console.verbose('[HYDRATION SCRIPT COMPILER] Svelte plugin running for route', route)
  return {
    name: 'NodeScript',
    setup(build) {
      build.onLoad({ filter: /(\.svelte|\.component|\.page|\.layout)$/ }, async (args) => {
        // This converts a message in Svelte's format to esbuild's format
        let convertMessage = ({ message, start, end }) => {
          let location
          if (start && end) {
            let lineText = source.split(/\r\n|\r|\n/g)[start.line - 1]
            let lineEnd = start.line === end.line ? end.column : lineText.length
            location = {
              file: filename,
              line: start.line,
              column: start.column,
              length: lineEnd - start.column,
              lineText,
            }
          }
          return { text: message, location }
        }

        // Load the file from the file system
        let source = await fs.promises.readFile(args.path, 'utf8')
        let filename = path.relative(process.cwd(), args.path)

        const { normalisedSource } = parseSource(source)

        try {
          console.verbose('[HYDRATION SCRIPT COMPILER] Compiling Svelte:', filename)

          const compilerOptions = {
            filename,
            hydratable: true,
            // CSS is injected into the template. We don’t want to duplicate it in the
            // hydration script.
            css: !args.path.endsWith('.page')
          }
          if (args.path.endsWith('.page')) {
            // This is what the class will be named in the page. By hardcoding it,
            // we can write the code in the page wrapper to initialise it.
            compilerOptions.name = classNameFromRoute(route)
          }
          let { js, warnings } = compile(normalisedSource, compilerOptions)
          let contents = js.code + `//# sourceMappingURL=` + js.map.toUrl()

          return { contents, warnings: warnings.map(convertMessage) }
        } catch (e) {
          return { errors: [convertMessage(e)] }
        }
      })
    }
  }
}
