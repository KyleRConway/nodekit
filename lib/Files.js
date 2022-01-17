////////////////////////////////////////////////////////////
//
// Files
//
// File system controller. Handles all aspects pertaining to
// the file system, including initial route creation and
// file system watching for updates.
//
////////////////////////////////////////////////////////////

console.log('------------------- MAIN PROCESS START ----------------------')

import os from 'os'
import fs from 'fs'
import path from 'path'
import childProcess from 'child_process'

import chokidar from 'chokidar'
import polka from 'polka'

// Temporarily using my own fork where sirv only responds to GET requests that
// are not WebSocket requests (so as not to mask POST, WebSocket, etc., requests
// that may be on the same path).
import serveStaticMiddleware from '@small-tech/sirv'

import https from '@small-tech/https'

import { tinyws } from 'tinyws'
import WebSocketRoute from './WebSocketRoute'

import { classNameFromRoute } from './Utils'

import { fileURLToPath, URL } from 'url'
const __dirname = fileURLToPath(new URL('.', import.meta.url))

import JSDB from '@small-tech/jsdb'

import { BroadcastChannel } from 'worker_threads'

export default class Files {
  app
  server
  basePath
  watcher
  filesByExtension
  hostname
  options
  routes

  broadcastChannel

  static HTTP_METHODS = ['get', 'head', 'patch', 'options', 'connect', 'delete', 'trace', 'post', 'put']
  static timeCounter = 0

  constructor (basePath = process.cwd()) {

    // Ensure database is ready
    // TODO: Keep the database elsewhere outside of the project folder structure. It’s too easy
    // ===== to accidentally upload it somewhere otherwise by messing up your .gitignore (security).
    globalThis.db = JSDB.open(path.join(basePath, '.db'))

    this.routes = {}
    this.filesByExtension = {}

    this.hostname = os.hostname()

    // TODO: Remove + implement proper logic to decide localhost vs hostname usage.
    // DEBUG: hardcode to localhost for now.
    this.hostname = 'localhost'

    this.options = { domains: [this.hostname] }

    this.broadcastChannel = new BroadcastChannel('loader-and-main-process')
    this.broadcastChannel.onmessage = event => {
      console.log(`[Main process broadcast channel] Received contents of route`, event.data.route)
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
    this.ensurePrivilegedPortsAreDisabled()

    // Create the app.
    this.app = polka()

    // Add the WebSocket server.
    this.app.use(tinyws())
  }

  async initialise () {
    return new Promise((resolve, reject) => {
      // console.time(`Files ${++Files.timeCounter}`)

      const watcherGlob = `${this.basePath}/**/*.@(page|socket|${Files.HTTP_METHODS.join('|')})`
      const watcherOptions = {
        // Emit events when initially discovering files.
        ignoreInitial: false,
        ignored: /(^|[\/\\])\..|node_modules|#static/ // ignore dotfiles/dotfolders as well as the node_modules and #static folders
      }

      this.watcher =
      chokidar
        .watch(watcherGlob, watcherOptions)
        .on('ready', async () => {
          // console.timeEnd(`Files ${Files.timeCounter}`)

          // For now.
          await this.createRoutes()

          resolve(this.filesByExtension)
        })
        .on('add', (filePath, stats) => {
          const extension = path.extname(filePath).replace('.', '')
          if (!this.filesByExtension[extension]) {
            this.filesByExtension[extension] = []
          }
          this.filesByExtension[extension].push(filePath)
        })
        .on('error', async error => {
          await this.watcher.close()
          reject(error)
        })
    })
  }

  async close() {
    await this.watcher.close()
  }

  // Linux has an archaic security restriction dating from the mainframe/dumb-terminal era where
  // ports < 1024 are “privileged” and can only be connected to by the root process. This has no
  // practical security advantage today (and actually can lead to security issues). Instead of
  // bending over backwards and adding more complexity to accommodate this, we use a feature that’s
  // been in the Linux kernel since version 4.11 to disable privileged ports.
  //
  // As this change is not persisted between reboots and takes a trivial amount of time to
  // execute, we carry it out every time.
  //
  // For more details, see: https://source.small-tech.org/site.js/app/-/issues/169
  ensurePrivilegedPortsAreDisabled () {
    if (os.platform() === 'linux') {
      try {
        console.log('   😇    ❨NodeKit❩ Linux: about to disable privileged ports so we can bind to ports < 1024.')
        console.log('         ❨NodeKit❩ For details, see: https://source.small-tech.org/site.js/app/-/issues/169')

        childProcess.execSync('sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0', {env: process.env})
      } catch (error) {
        console.log(`\n   ❌    ❨NodeKit❩ Error: Could not disable privileged ports. Cannot bind to port 80 and 443. Exiting.`, error)
        process.exit(1)
      }
    }
  }

  // Create the routes and add them to the server.
  // The ESM Loaders will automatically handle any processing that needs to
  // happen during the import process.
  async createRoutes () {

    const supportedExtensions = `\.(page|socket|${Files.HTTP_METHODS.join('|')})$`
    const indexWithExtensionRegExp = new RegExp(`index${supportedExtensions}`)
    const extensionRegExp = new RegExp(supportedExtensions)

    Object.keys(this.filesByExtension).forEach(extension => {
      const filesOfType = this.filesByExtension[extension]
      // // HTTP methods
      // if (Files.HTTP_METHODS.includes(extension)) {
        filesOfType.forEach(async filePath => {
          // TODO: Move this into a shared utility class that’s imported
          // both here and in the loader.
          // Transform an absolute file system path to a web server route.
          const route = filePath
            .replace(this.basePath, '')             // Remove the base path.
            .replace(/_/g, '/')                     // Replace underscores with slashes.
            .replace(/\[(.*?)\]/g, ':$1')           // Replace properties. e.g., [prop] becomes :prop
            .replace(indexWithExtensionRegExp, '')  // Remove index path fragments (and their extensions)
            .replace(extensionRegExp, '')           // Remove extension.

            if (extension === 'socket') {
              //
              // WebSocket route.
              //
              console.log('[FILES] Adding WebSocket route', route, filePath)
              const webSocketHandler = (await import(filePath)).default
              const webSocketRoute = new WebSocketRoute(webSocketHandler)
              // Add the handler as middleware to the server
              this.app.use(route, webSocketRoute.handler.bind(webSocketRoute))
            } else {
              //
              // All other routes.
              //
              const httpMethod = Files.HTTP_METHODS.includes(extension) ? extension : 'get'
              const handlerRaw = (await import(filePath)).default

              let handler
              if (handlerRaw.render) {
                // This is a svelte page. Create a custom route to serve it.

                console.log('[FILES] Attempting to get route cache for route', route)
                const routeCache = this.routes[route]
                const hydrationScript = routeCache.hydrationScript

                // This is the same class name that was set by the hydration script compiler
                // in the module loader.
                let className = classNameFromRoute(route)

                console.log('[FILES] Class name', className)

                handler = async (request, response) => {

                  console.log('[PAGE HANDLER]', route, className)

                  // Load the node script for the route and write it into a temporary file
                  // so we can import it.
                  // NOTE: We can just build a loader for this to load it from string. No need
                  // to write to filesystem… but what about imports in the script, etc.?
                  let nodeScript
                  if (routeCache.nodeScript) {
                    const dynamicModule = path.join(this.basePath, '.script.tmp.js')
                    const relativePathToDynamicModule = path.relative(__dirname, dynamicModule)

                    fs.writeFileSync(dynamicModule, routeCache.nodeScript)
                    nodeScript = (await import(relativePathToDynamicModule)).default
                    fs.unlinkSync(dynamicModule)
                  }

                  console.time('  ╰─ Total')
                  console.time('  ╭─ Node script execution (initial data)')
                  // Run the nodeScript if it exists
                  const data = nodeScript ? await nodeScript(request) : undefined

                  console.timeEnd('  ╭─ Node script execution (initial data)')

                  console.time('  ├─ Page render (html + css)')
                  // Render the page, passing the server-side data as a property.
                  const { html, css } = handlerRaw.render({data})
                  console.timeEnd('  ├─ Page render (html + css)')

                  console.time('  ├─ Final HTML render')
                  const finalHtml = `
                  <!DOCTYPE html>
                    <html lang='en'>
                    <head>
                      <meta charset='UTF-8'>
                      <meta http-equiv='X-UA-Compatible' content='IE=edge'>
                      <meta name='viewport' content='width=device-width, initial-scale=1.0'>
                      <link rel="icon" href="data:,">
                      <title>Document</title>
                      <style>${css.code}</style>
                    </head>
                    <body>
                        <div id='application'>
                          ${html}
                        </div>
                        <script type='module'>
                        ${hydrationScript}

                        new ${className}({
                          target: document.getElementById('application'),
                          hydrate: true,
                          props: {
                            data: ${JSON.stringify(data)}
                          }
                        })
                    </script>
                    </body>
                    </html>
                  `
                  console.timeEnd('  ├─ Final HTML render')

                  console.time('  ├─ Response send')
                  response.end(finalHtml)
                  console.timeEnd('  ├─ Response send')

                  console.timeEnd('  ╰─ Total')
                }
              } else {
                // This is a non-svelte route. It is expected to export the function
                // itself so we can just use it as the route handler.
                handler = handlerRaw
              }
              // TODO: Handle error condition where neither is the case.

              console.log('[FILES] Adding route', httpMethod, route, filePath, handler)

              // Add handler to server.
              this.app[httpMethod](route, handler)

              // Debug: show state of handlers.
              // console.log(this.app.routes.forEach(route => console.log(route.handlers)))

            }
        })
      // }
    })

    // TODO: Move these elsewhere! This is just to get things up and running for now.
    const staticFolder = path.join(this.basePath, '#static')
    if (fs.existsSync(staticFolder)) {
      this.app.use('/', serveStaticMiddleware(staticFolder))
    }

    // TODO: LEFT OFF HERE. Implement WebSocket support with all the nice things
    // that exist in Site.js.



    // Get the handler from the Polka instance and create a secure site using it.
    // (Certificates are automatically managed by @small-tech/https).
    const { handler } = this.app
    this.server = https.createServer(this.options, handler)
    this.server.listen(443, () => {
      console.log(` 🎉 Server running at https://${this.hostname}.`)
    })
  }
}
