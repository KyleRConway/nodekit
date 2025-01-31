////////////////////////////////////////////////////////////
//
// NodeKit
//
// Copyright ⓒ 2021-present, Aral Balkan
// Small Technology Foundation
//
// License: AGPL version 3.0.
//
////////////////////////////////////////////////////////////

// Conditional logging.
console.verbose = process.env.VERBOSE ? function () { console.log(...arguments) } : () => {}
console.profileTime = process.env.PROFILE ? function () { console.time(...arguments) } : () => {}
console.profileTimeEnd = process.env.PROFILE ? function () { console.timeEnd(...arguments) } : () => {}

console.verbose('--- MAIN PROCESS START ---')

import os from 'os'
import vm from 'vm'
import esbuild from 'esbuild'
import { _findPath } from 'module'
import fs from 'fs'
import path from 'path'

import chokidar from 'chokidar'
import polka from 'polka'

import { fetch } from 'undici'

// Temporarily using my own fork where sirv only responds to GET requests that
// are not WebSocket requests (so as not to mask POST, WebSocket, etc., requests
// that may be on the same path).
import serveStaticMiddleware from '@small-tech/sirv'

import https from '@small-tech/https'

import { tinyws } from 'tinyws'
import WebSocketRoute from './lib/WebSocketRoute'

import { ensurePrivilegedPortsAreDisabled, classNameFromRoute, routeFromFilePath, HTTP_METHODS } from './lib/Utils'
import { renderPage } from './page-template'

import { URL } from 'url'

import JSDB from '@small-tech/jsdb'

import { BroadcastChannel } from 'worker_threads'

class CustomEvent extends Event {
  detail

  constructor (type, eventInitDict) {
    super (type, eventInitDict)
    this.detail = eventInitDict.detail
  }
}

export default class NodeKit extends EventTarget {
  app
  server
  context
  basePath
  watcher
  filesByExtension
  hostname
  options
  routes
  dependencyMap
  initialised = false
  notifyChangeListeners = false

  broadcastChannel

  static timeCounter = 0

  constructor (basePath = process.cwd()) {
    super()

    // Ensure database is ready
    // TODO: Keep the database elsewhere outside of the project folder structure. It’s too easy
    // ===== to accidentally upload it somewhere otherwise by messing up your .gitignore (security).
    globalThis.db = JSDB.open(path.join(basePath, '.db'))

    // Save a reference to the app in the global scope also.
    globalThis.app = this

    this.routes = {}
    this.previousVersionsOfRoutes = {}
    this.filesByExtension = {}

    this.hostname = os.hostname()

    // TODO: Remove + implement proper logic to decide localhost vs hostname usage.
    // DEBUG: hardcode to localhost for now.
    this.hostname = 'localhost'

    this.options = { domains: [this.hostname] }

    // We use a regular broadcast channel to communicate with the ESM Loader,
    // which is really just another worker process.
    this.broadcastChannel = new BroadcastChannel('loader-and-main-process')

    this.broadcastChannel.onmessage = event => {

      if (!process.env.PRODUCTION) {
        // Store the dependencyMap.
        // (Is sending it over like this efficient?)
        if (event.data.type === 'dependencyMap') {
          // console.log('[Main process broadcast channel] Received dependency map')
          this.dependencyMap = event.data.dependencyMap
          return
        }
        
        this.dependencyMap = event.data.dependencyMap
        this.previousVersionsOfRoutes[event.data.route] = this.routes[event.data.route]
      }

      this.routes[event.data.route] = event.data.contents
    }

    // You can place your source files either in the project
    // folder directly or in a subfolder called src.
    const srcFolder = path.join(basePath, 'src')
    this.basePath = fs.existsSync(srcFolder) ? srcFolder : basePath

    // Set the basePath as an environment variable so the ESM Module Loader
    // can access it also. It can use it to ensure that it saves the route
    // cache for compiled Svelte files using the same route key that we’re
    // using. (The loader otherwise cannot know what basePath was supplied.)
    process.env.basePath = this.basePath

    // Disable privileged ports on Linux (because we don’t need security
    // theatre to trip us up.)
    ensurePrivilegedPortsAreDisabled()

    // Create the app.
    const errorTemplate = `
      <h1>{CODE}</h1>
      <h2>{ERROR}</h2>
      <pre><code>{STACK}</code></pre>
      <style>
        body { font-family: sans-serif; font-size: 1.5em; padding: 1em 2em; }
        h1 { color: red; font-size: 3em; margin-bottom: 0; }
        h2 { margin-top: 0; }
        pre { background-color: #ccc; border-radius: 1em; padding: 1em; margin-left: -1em; margin-right: -1em; overflow: auto;} 
      </style>
    `
    this.app = polka({
      onError: (error, request, response, next) => {

        // console.log('Polka onError', error)

        if (this.socket) {
          // A development socket exists so the client should be able to handle
          // a json response and display it in an error modal.
          response.statusCode = error.code || error.status || 500
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({
            status: response.statusCode,
            message: error.toString(),
            stack: error.stack
          }))
          return
        }

        if (error.status === 404) {
          const errorPage = errorTemplate
          .replace('{CODE}', error.status)
          .replace('{ERROR}', 'Page not found.')
          .replace('{STACK}', 'Sorry, that page does not exist.')
          response.end(errorPage)
          return
        }

        // If we’re here, the error occured while page was initially loading
        // so display the basic error template.
        response.statusCode = error.code || error.status || 500

        const errorPage = errorTemplate
          .replace('{CODE}', response.statusCode)
          .replace('{ERROR}', error.toString())
          .replace('{STACK}', error.stack)
        response.end(errorPage)
      }
    })

    // Add the WebSocket server.
    this.app.use(tinyws())

    // Create context to be used by the route handler when running NodeScript.
    this.context = vm.createContext({
      // NodeKit globals.
      db: globalThis.db,
      // The app itself for advanced uses.
      app: globalThis.app,
      // Node.js globals.
      console, URLSearchParams, URL, process,
      // (Fetch is part of undici right now but slated to be part
      // of Node 16 under an experimental flag and Node 18 without.
      // Once that lands, we can replace this with the standard
      // implementation.)
      fetch
    })
  }

  async initialise () {
    return new Promise((resolve, reject) => {
      const watcherGlob = `${this.basePath}/**/*.@(page|component|socket|${HTTP_METHODS.join('|')})`
      const watcherOptions = {
        // Emit events when initially discovering files.
        ignoreInitial: false,
        ignored: /(^|[\/\\])\..|node_modules|#static/ // ignore dotfiles/dotfolders as well as the node_modules and #static folders
      }

      this.watcher =
      chokidar
        .watch(watcherGlob, watcherOptions)
        .on('ready', async () => {
          // For now.
          await this.createRoutes()

          // Create development socket.
          if (!process.env.PRODUCTION) {
            this.createDevelopmentSocket()
          }

          this.initialised = true

          resolve(this.filesByExtension)
        })
        .on('add', (filePath, stats) => {

          console.verbose('Chokidar add:', filePath)

          this.handleFileChange('file', 'added', filePath)

          const extension = path.extname(filePath).replace('.', '')
          if (!this.filesByExtension[extension]) {
            this.filesByExtension[extension] = []
          }
          this.filesByExtension[extension].push(filePath)
        })
        .on('change', filePath => { this.handleFileChange('file', 'changed', filePath) })
        .on('unlink', filePath => { this.handleFileChange('file', 'unlinked', filePath) })
        .on('addDir', filePath => { this.handleFileChange('directory', 'added', filePath)})
        .on('unlinkDir', filePath => { this.handleFileChange('directory', 'unlinked', filePath) })
        .on('error', async error => {
          await this.watcher.close()
          reject(error)
        })
    })
  }


  notifyAllAffectedPagesOfChangeIn (itemPath) {
    // Dependencies can be N levels deep. We follow dependencies
    // up until we find a page and then notify it that it should reload itself.
    const dependencies = this.dependencyMap.get(itemPath)

    for (const dependency of dependencies) {
      if (!dependency.endsWith('.page')) {
        // Recurse until we hit a page.
        this.notifyAllAffectedPagesOfChangeIn(dependency)
      } else {
        // Notify page.
        this.dispatchEvent(new CustomEvent('hotReload', {
          detail: {
            type: 'reload',
            path: dependency,
            dueToDependencyChange: true,
          }
        }))  
      }
    }
  }


  async handleFileChange(itemType, eventType, itemPath) {
    if (this.initialised) {
      if (process.env.PRODUCTION) {
        // In production, simply exit (systemd will handle the restart).
        console.log(`${itemType.charAt(0).toUpperCase()+itemType.slice(1)} ${eventType} (${itemPath}), exiting to trigger auto-restart in production.`)
        process.exit(1)
      } else {
        // In development, we implement hot replacement for CSS
        // and live reload for everything else. 
        console.verbose('[handleFileChange]', itemPath, eventType, itemPath)

        if (itemType === 'file' && eventType === 'changed' && itemPath.endsWith('.page')) {
          this.dispatchEvent(new CustomEvent('hotReload', {
            detail: {
              type: 'reload',
              path: itemPath  
            }
          }))
        } else {
          this.notifyAllAffectedPagesOfChangeIn(itemPath)
        }
      }
    } else {
      console.verbose('[handleFileChange]', itemPath, 'ignoring', 'not initialised')
    }
  }

  async close() {
    await this.watcher.close()
  }


  // Creates a WebSocket at /.well-known/dev used for hot module reloading, etc., during
  // development time.
  createDevelopmentSocket () {
    const self = this
    const devSocket = new WebSocketRoute((socket, request, response) => {
      console.verbose('[DEV SOCKET] New connection')
      self.socket = socket
    })

    this.app.get('/.well-known/dev', devSocket.handler.bind(devSocket))

    // Because of Firefox’s ridiculous automatic fallback/retry on WebSocket 
    // connection failures, we can’t simply manually retry failed connections.
    // Instead, implement an HTTP ping route that we can fall separately to
    // test if the server is up and use that.
    this.app.get('/.well-known/ping', (request, response) => {
      response.end()
    })
  }

  async createRoute (filePath) {
    const self = this
    const routes = this.routes
    const previousVersionsOfRoutes = this.previousVersionsOfRoutes
    const basePath = this.basePath
    const context = this.context

    const route = routeFromFilePath(filePath)
    const extension = path.extname(filePath).replace('.', '')
    const httpMethod = HTTP_METHODS.includes(extension) ? extension : 'get'

    console.verbose('[FILES] Creating route', route, extension)

    const handlerThisObject = {}

    // Handlers lazy-load their content the first time they are hit so
    // what we really have is one meta-handler for every route that decides
    // what to load at runtime.
    const handler = (async function (request, response) {

      // Development-time live reload listener.
      if (!process.env.PRODUCTION) {
        if (!this.hotReloadListener) {
          if (filePath.endsWith('.page')) {
            const reloadListener = async event => {
              if (event.detail.path === filePath) {
                // Reload the page.
                if (event.detail.dueToDependencyChange) {
                  self.reloadDueToDependencyChange = true
                }
                this._handler = await self.loadHttpRoute(routes, route, basePath, filePath, context)
  
                // If we don’t have a development socket, then there’s no one to notify yet.
                if (!self.socket) {
                  return
                }  
  
                // Now that we know the new handler exists, let’s notify the
                // necessary pages.
  
                const previousVersion = previousVersionsOfRoutes[route]
                if (previousVersion !== undefined) {
                  const currentVersion = routes[route]
                  
                  const jsIsTheSame = currentVersion.js === previousVersion.js
                  const cssIsTheSame = currentVersion.css === previousVersion.css
                  const onlyCssHasChanged = jsIsTheSame && !cssIsTheSame
          
                  if (onlyCssHasChanged) {
                    console.verbose('((( Requesting CSS injection. )))')
                    // The CSS class name/hash will have changed in the new CSS,
                    // replace it with the old one.
                    // TODO: Error check for non-existence (shouldn’t happen but still).
                    const classHashRegExp = /svelte-(.*?)[\s\{]/
                    const oldClassHash = classHashRegExp.exec(previousVersion.css)[1]
                    const newClassHash = classHashRegExp.exec(currentVersion.css)[1]
                    const newCssCode = currentVersion.css.replace(new RegExp(newClassHash, 'g'), oldClassHash)
  
                    currentVersion.css = newCssCode
          
                    self.socket.all(JSON.stringify({
                      type: 'css',
                      code: newCssCode
                    }))
                  } else if (!jsIsTheSame || self.reloadDueToDependencyChange) {
                    console.verbose('<<< Requesting live reload. >>>')
                    self.reloadDueToDependencyChange = false
                    self.socket.all(JSON.stringify({type: 'reload'}))
                  }  
                }
              }
            }  
            self.addEventListener('hotReload', reloadListener)  
          }
          this.hotReloadListener = true
        }
      }

      if (extension === 'socket') {
        //
        // WebSocket route.
        //
        if (this._handler === undefined) {
          console.verbose('[Handler] Lazy loading WebSocket route', route)
          const webSocketHandler = (await import(filePath)).default
          const webSocketRoute = new WebSocketRoute(webSocketHandler)
          this._handler = webSocketRoute.handler.bind(webSocketRoute)
        }
        return this._handler (request, response)
      } else {
        //
        // All other routes.
        //
        if (this._handler === undefined) {
          this._handler = await self.loadHttpRoute(routes, route, basePath, filePath, context)
        }
        // Call the cached handler.
        return await this._handler(request,response)
      }
    }).bind(handlerThisObject)

    console.verbose('[FILES] Adding route', httpMethod, route, filePath, handler)

    // Add handler to server.
    this.app[httpMethod](route, handler)

    // Debug: show state of handlers.
    // console.log(this.app.routes.forEach(route => console.log(route.handlers)))
  }


  async loadHttpRoute (routes, route, basePath, filePath, context) {
    const handlerRaw = (await import(filePath)).default

    let handler

    if (handlerRaw.render) {
      
      // This is the same class name that was set by the hydration script compiler
      // in the module loader.
      let className = classNameFromRoute(route)
      
      handler = async (request, response) => {
        // This is a NodeKit page. Create a custom route to serve it.
        const routeCache = routes[route]
        const hydrationScript = routeCache.hydrationScript

        console.verbose('[Page Handler]', route, className)
        console.profileTime('  ╰─ Total')
        console.profileTime('  ╭─ Node script execution (initial data)')

        // Run NodeScript module (if any) in its own V8 Virtual Machine context.
        let data = undefined

        if (routeCache.nodeScript) {
          // Cache the nodeScript.
          // TODO: Update cache if source changes.
          if (!routeCache.nodeScriptHandler) {
            // Using esbuild
            let buildResult
            try {
              buildResult = await esbuild.build({
                stdin: {
                  contents: routeCache.nodeScript,
                  resolveDir: basePath,
                  sourcefile: 'node-script.js',
                  loader: 'js'
                },
                bundle: true,
                format: 'esm',
                platform: 'node',
                write: false
              })
            } catch (error) {
              console.error(error)
              response.statusCode = 500
              response.end(error.stack.toString())
            }
            const bundle = buildResult.outputFiles[0].text
            const module = new vm.SourceTextModule(bundle, { context })

            await module.link(async (specifier, referencingModule) => {
              return new Promise(async (resolve, reject) => {
                console.verbose('Linking: ', specifier)

                const module = await import(specifier)
                const exportNames = Object.keys(module)

                // In order to interoperate with Node’s own ES Module Loader,
                // we have to resort to creating a synthetic module to
                // translate for us.
                //
                // Thanks to László Szirmai for the tactic
                // (https://github.com/nodejs/node/issues/35848).
                const syntheticModule = new vm.SyntheticModule(
                  exportNames,
                  function () {
                    exportNames.forEach(key => {
                      this.setExport(key, module[key])
                  })
                }, { context })

                resolve(syntheticModule)
              })
            })

            // Evaluate the module. After successful completion of this step,
            // the module is available from the module.namespace reference.
            await module.evaluate()

            routeCache.nodeScriptHandler = module.namespace.default
          }

          // Run the nodeScript.
          data = await routeCache.nodeScriptHandler(request, response)
        }

        console.profileTimeEnd('  ╭─ Node script execution (initial data)')

        console.profileTime('  ├─ Page render (html + css)')
        // Render the page, passing the server-side data as a property.
        const { html, css } = handlerRaw.render({data})
        console.profileTimeEnd('  ├─ Page render (html + css)')

        console.profileTime('  ├─ Final HTML render')
        const renderedHtml = renderPage(route, className, html, css.code, hydrationScript, data)
        console.profileTimeEnd('  ├─ Final HTML render')

        console.profileTime('  ├─ Response send')
        response.end(renderedHtml)
        console.profileTimeEnd('  ├─ Response send')
        console.profileTimeEnd('  ╰─ Total')
      }
    } else {
      // This is a non-svelte route. It is expected to export the function
      // itself so we can just use it as the route handler.
      handler = handlerRaw
    }
    return handler
  }


  // Create the routes and add them to the server.
  // The ESM Loaders will automatically handle any processing that needs to
  // happen during the import process.
  async createRoutes () {
    const extensions = Object.keys(this.filesByExtension)
    for await (const extension of extensions) {
      const filesOfType = this.filesByExtension[extension]
      for await (const filePath of filesOfType) {
        this.createRoute(filePath)
      }
    }

    // TODO: Move these elsewhere! This is just to get things up and running for now.
    const staticFolder = path.join(this.basePath, '#static')
    if (fs.existsSync(staticFolder)) {
      this.app.use('/', serveStaticMiddleware(staticFolder, {
        // TODO: Only turn on dev mode if not in PRODUCTION
        dev: true
      }))
    }

    // Get the handler from the Polka instance and create a secure site using it.
    // (Certificates are automatically managed by @small-tech/https).
    const { handler } = this.app

    this.server = https.createServer(this.options, handler)
    this.server.listen(443, () => {
      console.info(`⬢ NodeKit\n\n  💾 ${this.basePath}\n  🌍 https://${this.hostname}\n`)
    })
  }
}
