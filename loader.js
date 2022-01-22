console.time('Loader initialisation')
console.log('================== LOADER PROCESS START =====================')
import path from 'path'
import fs from 'fs'
import { compile } from 'svelte/compiler'
import { hydrationScriptCompiler } from './lib/HydrationScriptCompiler.js'
import { routeFromFilePath } from './lib/Utils.js'

import { BroadcastChannel } from 'worker_threads'

import { fileURLToPath } from 'url'
const __dirname = fileURLToPath(new URL('.', import.meta.url))

function truthyHashmapFromArray(array) {
  return array.reduce((obj, key) => { obj[key] = true; return obj}, {})
}

const _svelteAliases = [
  '.page',
  '.data',
  '.component',
  '.svelte'
]

const _javaScriptAliases = [
  '.get',
  '.head',
  '.patch',
  '.options',
  '.connect',
  '.delete',
  '.trace',
  '.post',
  '.put',
  '.socket'
]

const _allAliases = _svelteAliases.concat(_javaScriptAliases)

const svelteAliases = truthyHashmapFromArray(_svelteAliases)
const javaScriptAliases = truthyHashmapFromArray(_javaScriptAliases)
const allAliases = truthyHashmapFromArray(_allAliases)

const scriptRegExp = /\<script\>.*?\<\/script\>/s
const nodeScriptRegExp = /\<data\>(.*?)\<\/data\>/s
const styleRegExp = /\<style\>.*?\<\/style\>/s

const fileUrlExtensionRegExp = /.+?(?<extension>\..*?$)/

const broadcastChannel = new BroadcastChannel('loader-and-main-process')

function extensionOf(urlString) {
  const result = urlString.match(fileUrlExtensionRegExp)
  return result ? result.groups.extension : null
}

export async function resolve(specifier, context, defaultResolve) {
  // Since we don’t want every NodeKit project to have to npm install Svelte
  // to work, we resolve Svelte URLs to the version of Svelte that we’ve
  // installed with NodeKit. This will also ensure that both the hydration
  // script run by esbuild in the loader and the Svelte SSR compiler in the
  // main worker use the same version of Svelte so we don’t run into any
  // versioning issues either.

  const nodekitAppPath = process.argv[1].replace('nodekit-bundle.js', '')

  // See if this is a Svelte request and, if so, map to the instance of Svelte
  // that we have installed NodeKit.
  if (specifier === 'svelte' || specifier.startsWith('svelte/') || (context.parentURL && context.parentURL.includes('/node_modules/svelte/'))) {
    // Let Node’s resolver do all the hard work so we don’t have to replicate it.
    const packageLocationInProject = defaultResolve(specifier, context, defaultResolve).url
    const packageLocationInNodeKitApp = packageLocationInProject.replace(/^.*(?=node_modules)/, `file://${nodekitAppPath}`)

    console.log('[LOADER]', 'Svelte resolution override', packageLocationInNodeKitApp)
    return {
      url: packageLocationInNodeKitApp
    }
  }

  // Handle NodeKit assets.
  if (allAliases[path.extname(specifier)]) {
    const parentURL = new URL(context.parentURL)
    const parentPath = path.dirname(parentURL.pathname)
    const absolutePath = path.resolve(parentPath, specifier)

    return {
      url: `file://${absolutePath}`
    }
  }

  // For anything else, let Node do its own magic.
  const resolved = defaultResolve(specifier, context, defaultResolve)
  console.log('default resolve:', resolved)
  return resolved
}

// Node version 16.x: in 14.x, this call was split between three separate hooks, two of
// which we were using (getFormat and getSource), which are now deprecated.
// (See https://nodejs.org/docs/latest-v16.x/api/esm.html#loaders)
//
// Note: .component is just a (semantically more accurate, given our use case) alias
// ===== for .svelte and is treated in exactly the same way. On the other hand,
//       .page and .layout are supersets of Svelte and can include a script block
//       with a context of 'node' that gets executed in Node before every render. The data
//       returned is injected into the page as it is being rendered. Additionally,
//       .layout files get special treatment in that they are injected into every page
//       within the same directory and any subdirectories (TODO) unless a reset.layout file
//       is present (TODO).

export async function load(url /* string */, context, defaultLoad) {
  const _url = new URL(url)

  // console.log(`[LOADER] Loading ${_url}`)

  if (_url.protocol === 'file:') {
    const format = 'module'
    if (svelteAliases[extensionOf(url)]) {
      // Svelte route.
      const source = await compileSource(_url.pathname)
      return { format, source }
    } else if (javaScriptAliases[extensionOf(url)]) {
      // JavaScript route.
      const source = fs.readFileSync(_url.pathname)
      return { format, source }
    }
  }

  return defaultLoad(url, context, defaultLoad)
}

async function compileSource(filePath) {

  const source = fs.readFileSync(filePath, 'utf8')
  const routeRelativePath = path.relative(__dirname, filePath)

  // TODO: Refactor – pull these out into the shared route calculation method.
  // Transform an absolute file system path to a web server route.
  const route = routeFromFilePath(filePath)

  console.log(`[LOADER] Compiling ${route}`)

  let svelteSource = source
  let nodeScript

  const nodeScriptResult = nodeScriptRegExp.exec(source)
  if (nodeScriptResult) {
    console.log('  • Route has NodeScript.')
    // Contains a Node script. Svelte knows nothing about this, so we
    // strip it out and persist it for use during server-side rendering.
    svelteSource = source.replace(nodeScriptResult[0], '')

    // Wrap the  request into the script so its available
    // to the script without making people wrap their script
    // in an async function.
    nodeScript = nodeScriptResult[1]
  }

  // Layout (TODO) and hydration script support.
  if (filePath.endsWith('.page')) {
    let script = scriptRegExp.exec(svelteSource)
    script = script ? script[0] : ''
    const markup = svelteSource.replace(scriptRegExp, '').replace(styleRegExp, '').trim()

        // TODO: Implement layout support properly based on the list of layout
        // ===== pages that have already been compiled (the commented-out code is
        //       from the hardcoded spike).
        const scriptWithLayoutImport = script
        const markupWithLayout = markup

        // const scriptWithLayoutImport = script.replace('<script>', "<script>\n  import PageLayout from './Page.layout'\n")
        // const markupWithLayout = `<PageLayout>\n${markup}\n</PageLayout>`

    svelteSource = svelteSource.replace(script, scriptWithLayoutImport).replace(markup, markupWithLayout)

    // Client-side hydration script.
    const hydrationCode = await hydrationScriptCompiler(routeRelativePath, route)
    const hydrationScript = hydrationCode

    const routeDetails = {
      route,
      contents: {
        routeRelativePath,
        nodeScript,
        hydrationScript
      }
    }

    console.log('[LOADER] New route!', route)

    // Update the route cache with the material for this route.
    broadcastChannel.postMessage(routeDetails)
  }

  const compilerOptions = {
    generate: 'ssr',
    format: 'esm',
    hydratable: true,
  }

  const output = compile(svelteSource, compilerOptions)

  return output.js.code
}

console.timeEnd('Loader initialisation')
