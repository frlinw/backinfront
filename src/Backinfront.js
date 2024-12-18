import {
  has,
  deduplicateArray,
  getDeepValue,
  isAfterDate,
  mergeObject,
  stringifySearchParams,
  typecheck,
  waitUntil
} from 'bibliotech'
import {
  openDB,
  deleteDB,
  createStore,
  createIndex,
  deleteIndex,
  deleteStore
} from './services/database.js'
import CustomError from './CustomError.js'
import QueryLanguage from './QueryLanguage.js'
import Router from './Router.js'
import Store from './Store.js'


export default class Backinfront {
  #metadataStoreName = '__Metadata'
  #syncQueueStoreName = '__SyncQueue'
  #syncInProgress = false
  #databaseConfigurationStarted = false
  #databaseConfigurationEnded = false
  #databaseSchema = {
    [this.#metadataStoreName]: {
      keyPath: null,
      indexes: {} // must be defined to prevent Object.entries() error
    },
    [this.#syncQueueStoreName]: {
      keyPath: 'id',
      indexes: {
        createdAt: 'createdAt'
      }
    }
  }

  collectionCountKey = 'count'
  collectionDataKey = 'rows'
  databaseName = ''
  stores = {}
  routes = {}
  populateUrl = ''
  syncUrl = ''
  headers = () => {}
  getSession = () => null
  formatRouteSearchParam = (value) => value
  formatRoutePathParam = (value) => value
  formatDataBeforeSave = (data) => JSON.parse(JSON.stringify(data)) // by default, easiest way to convert Date to json & clean an object
  onRequest = () => null

  /**
   * @constructor
   * @param {object} options
   * @param {string} options.databaseName
   * @param {Array<object>} options.stores list of store's configurations
   * @param {Array<object>} options.router list of store's configurations
   * @param {string} options.populateUrl part of url corresponding to the populate endpoint
   * @param {string} options.syncUrl part of url corresponding to the sync endpoint
   * @param {function} [options.headers]
   * @param {function} [options.collectionCountKey]
   * @param {function} [options.collectionDataKey]
   * @param {function} [options.getSession] must return an object with data available on every offline handled requests
   * @param {function} [options.formatDataBeforeSave] format data before insertion into indexeddb
   * @param {function} [options.formatRouteSearchParam] format Request's search params (example: transform comma separated string into array)
   * @param {function} [options.formatRoutePathParam] format Route's customs params
   * @param {function} [options.onRequest]
   */
  constructor (options = {}) {
    // Throw an error if user input does not match the spec
    typecheck({
      options: {
        value: options,
        type: ['object', {
          collectionCountKey: { type: 'string' },
          collectionDataKey: { type: 'string' },
          databaseName: { type: 'string', required: true },
          stores: { type: 'array', required: true },
          routers: { type: 'array', required: true },
          syncUrl: { type: 'string', required: true },
          populateUrl: { type: 'string', required: true },
          headers: { type: 'function' },
          getSession: { type: 'function' },
          formatDataBeforeSave: { type: 'function' },
          formatRouteSearchParam: { type: 'function' },
          formatRoutePathParam: { type: 'function' },
          onRequest: { type: 'function' }
        }]
      }
    })

    mergeObject({
      source: options,
      target: this,
      exceptions: {
        routers: ({ value }) => this.addRouters(value),
        stores: ({ value }) => this.addStores(value)
      }
    })

    // Handle routes
    self.addEventListener('fetch', (event) => {
      const request = event.request
      const route = this.#findRouteFromRequest(request)

      if (route) {
        // event.respondWith MUST be called synchronously with async processing inside
        // to prevent others handlers to trigger
        event.respondWith(
          this.#getRouteResponse(route, request)
        )
      }
    })
  }

  /*****************************************************************
  * Routing process on offline fetch
  *****************************************************************/

  /**
   * Find a route in the global list
   * @param {Request} request
   * @return {object | undefined}
   */
  #findRouteFromRequest (request) {
    const url = new URL(request.url)
    const routeLocation = this.routes[url.origin]?.[request.method]?.[url.pathname.match(/[^/]+/g).length]
    return routeLocation?.find(route => route.regexp.test(`${url.origin}${url.pathname}`))
  }

  /**
   * Route handler inside service worker fetch
   * @param {object} route
   * @param {Request} request
   * @return {Promise<Response>}
   */
  async #getRouteResponse (route, request) {
    const ctx = {
      request,
      session: {},
      searchParams: {},
      pathParams: {},
      body: null,
      transaction: null
    }

    const url = new URL(request.url)

    // Add search params to the context
    for (const [key, value] of url.searchParams.entries()) {
      ctx.searchParams[key] = this.formatRouteSearchParam(value)
    }

    // Find params
    const matchs = `${url.origin}${url.pathname}`.match(route.regexp) // .match() return an Array or null
    if (matchs) {
      // Remove the first match (the url itself)
      matchs.shift()
      // Map route params
      for (const [idx, value] of matchs.entries()) {
        ctx.pathParams[route.pathParams[idx]] = this.formatRoutePathParam(value)
      }
    }

    // Merge session with user data
    ctx.session = { ...ctx.session, ...this.getSession(request) }

    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      ctx.body = await (request.clone()).json()
    }

    // Provide a global transaction
    ctx.transaction = await this._openTransaction()

    // Try to execute the route action
    let routeHandlerResult
    let routeHandlerError
    let response

    try {
      routeHandlerResult = await route.handler(ctx, this.stores)
    } catch (error) {
      routeHandlerError = error
    }

    if (routeHandlerError) {
      // Force the abortion
      // throw an error if the transaction has been completed prematurely
      try { ctx.transaction.abort() } catch {}
      response = new Response(undefined, {
        status: 500,
        statustext: `Route handler error: ${routeHandlerError.message}`
      })
    } else {
      // Force the commit
      // throw an error if the transaction has been completed prematurely
      try { ctx.transaction.commit() } catch {}
      response = new Response(JSON.stringify(routeHandlerResult))
    }

    this.onRequest({ route, result: routeHandlerResult, error: routeHandlerError })

    return response
  }

  /*****************************************************************
  * Process stores & routers
  *****************************************************************/

  /**
   * Add multiple stores in a single call
   * @param {Array<object>} storesOptions
   */
  addStores (storesOptions) {
    for (const storeOptions of storesOptions) {
      this.addStore(storeOptions)
    }
  }

  /**
   * Add a store
   * @param {object} storeOptions
   * @return {object}
   */
  addStore (storeOptions) {
    const store = new Store(this, storeOptions)
    // Add the store to the hashtable
    this.stores[store.storeName] = store
    // Add the store to the database schema
    this.#databaseSchema[store.storeName] = {
      keyPath: store.primaryKey ?? null,
      indexes: store.indexes ?? {} // must be defined to prevent Object.entries() error
    }

    return store
  }

  /**
   * Add multiple routers in a single call
   * @param {Array<object>} routersOptions
   */
  addRouters (routersOptions) {
    for (const routerOptions of routersOptions) {
      this.addRouter(routerOptions)
    }
  }

  /**
   * Add a router
   * @param {object} routerOptions
   * @return {object}
   */
  addRouter (routerOptions) {
    const router = new Router(routerOptions)

    // Add routes to the list
    for (const route of router.routes) {
      const target = getDeepValue(this.routes, [route.url.origin, route.method, route.length], [])
      // Add the route
      target.push(route)
      // Reorder
      target.sort((a, b) => b.specificity - a.specificity)
    }

    return router
  }

  /**
   * Add a new operator to the query language
   * @param {string} operatorName
   * @param {function} operatorAction
   */
  addQueryOperator (operatorName, operatorAction) {
    QueryLanguage.addOperator(operatorName, operatorAction)
  }

  /*****************************************************************
  * Indexeddb management
  *****************************************************************/
  /**
   * Discover and apply database's migrations
   */
  async #configureDatabase () {
    const databaseMigrations = []
    const currentDatabaseSchema = {}
    const newDatabaseSchema = this.#databaseSchema

    // Parse the current database schema
    const db = await openDB(this.databaseName)
    // The version of a non existing database is always 1
    const databaseVersion = db.version
    // db.objectStoreNames & store.indexNames are DOMStringList
    // https://developer.mozilla.org/fr/docs/Web/API/DOMStringList
    if (db.objectStoreNames.length) {
      const transaction = db.transaction(db.objectStoreNames, 'readonly')
      for (const storeName of db.objectStoreNames) {
        const store = transaction.objectStore(storeName)
        currentDatabaseSchema[storeName] = {
          keyPath: store.keyPath,
          indexes: Object.fromEntries(store.indexNames.map(indexName => [indexName, store.index(indexName).keyPath]))
        }
      }
    }
    db.close()

    // Delete stores, [Delete, Update, Create] indexes
    for (const [storeName, currentStoreSchema] of Object.entries(currentDatabaseSchema)) {
      if (has(newDatabaseSchema, storeName)) {
        const newStoreSchema = newDatabaseSchema[storeName]

        // [Delete, Update] indexes
        for (const [indexName, currentIndexKeyPath] of Object.entries(currentStoreSchema.indexes)) {
          // Update index
          if (has(newStoreSchema.indexes, indexName)) {
            const newIndexKeyPath = newStoreSchema.indexes[indexName]
            if (
              (Array.isArray(currentIndexKeyPath) && Array.isArray(newIndexKeyPath) && !currentIndexKeyPath.every((item, position) => item === newIndexKeyPath[position])) ||
              currentIndexKeyPath !== newIndexKeyPath
            ) {
              databaseMigrations.push(
                (t) => deleteIndex(t, storeName, indexName),
                (t) => createIndex(t, storeName, indexName, newIndexKeyPath)
              )
            }
          // Delete index
          } else {
            databaseMigrations.push((t) => deleteIndex(t, storeName, indexName))
          }
        }

        // Create indexes
        for (const [indexName, indexKeyPath] of Object.entries(newStoreSchema.indexes)) {
          if (!has(currentStoreSchema.indexes, indexName)) {
            databaseMigrations.push((t) => createIndex(t, storeName, indexName, indexKeyPath))
          }
        }
      // Delete store
      } else {
        databaseMigrations.push(
          (t) => deleteStore(t, { storeName })
        )
      }
    }

    // Create stores
    for (const [storeName, newStoreSchema] of Object.entries(newDatabaseSchema)) {
      if (!has(currentDatabaseSchema, storeName)) {
        databaseMigrations.push((t) => createStore(t, storeName, newStoreSchema.keyPath))

        for (const [indexName, indexKeyPath] of Object.entries(newStoreSchema.indexes)) {
          databaseMigrations.push((t) => createIndex(t, storeName, indexName, indexKeyPath))
        }
      }
    }

    // Apply migrations immediately if necessary
    if (databaseMigrations.length) {
      const dbUpgrade = await openDB(this.databaseName, databaseVersion + 1, {
        upgrade: (db, oldVersion, newVersion, transaction) => {
          for (const migration of databaseMigrations) {
            migration(transaction)
          }
        }
      })
      dbUpgrade.close()
    }
  }

  /**
   * Wait until the database is ready to handle requests
   */
  async #databaseReady () {
    // Configure database only on the very first call
    if (!this.#databaseConfigurationStarted) {
      this.#databaseConfigurationStarted = true
      await this.#configureDatabase()
      this.#databaseConfigurationEnded = true
    }

    return waitUntil(() => this.#databaseConfigurationEnded, {
      timeout: 10000,
      interval: 20
    })
  }

  /**
   * Get a transaction
   * @param  {Array<string> | null} [storeNames=null]
   * @param  {'readonly' | 'readwrite'} [mode='readwrite']
   */
  async _openTransaction (storeNames = null, mode = 'readwrite') {
    await this.#databaseReady()
    const db = await openDB(this.databaseName)
    const transaction = db.transaction(storeNames || db.objectStoreNames, mode, { durability: 'relaxed' })
    // The connection is not actually closed until all transactions
    // created using this connection are complete
    // https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/close
    db.close()
    return transaction
  }

  /**
   * Open a store
   * @param  {string} storeName
   * @param  {IDBTransaction | 'readonly' | 'readwrite'} mode
   */
  async _openStore (storeName, mode) {
    const transaction = mode instanceof IDBTransaction
      ? mode
      : await this._openTransaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    return store
  }

  /**
   * Delete the database
   * @example Can be useful to clean a user profile on logout for example
   */
  async destroy () {
    await deleteDB(this.databaseName)
    this.#databaseConfigurationStarted = false
    this.#databaseConfigurationEnded = false
  }

  /*****************************************************************
  * Fetch management
  *****************************************************************/

  /**
   * Fetch online data
   * @param {object} options
   * @param {string} options.method
   * @param {string} options.url
   * @param {object} [options.searchParams]
   * @param {object} [options.body]
   * @return {object}
   */
  async #fetch ({ method, url, searchParams, body }) {
    // Get user defined headers
    const headers = await this.headers()

    // Build request init
    const requestInit = {
      method,
      mode: 'cors',
      headers: {
        ...headers,
        'content-type': 'application/json'
      }
    }

    // Set body
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      requestInit.body = JSON.stringify(body)
    }

    const requestUrl = `${url}${stringifySearchParams(searchParams)}`
    const fetchRequest = new Request(requestUrl, requestInit)
    let fetchResponse

    try {
      fetchResponse = await fetch(fetchRequest)

      if (!fetchResponse.ok) {
        throw new Error('Response status is not ok')
      }
    } catch (error) {
      throw new CustomError(`fetch: ${error.message}`)
    }

    return fetchResponse.json()
  }

  /*****************************************************************
  * Sync management
  *****************************************************************/

  /**
   * Add a new item to the queue store owned by the lib
   * @param {object} options
   * @param {string} options.storeName
   * @param {string} options.primaryKey
   * @param {IDBTransaction} transaction
   */
  async _addToSyncQueue ({ storeName, primaryKey }, transaction) {
    const store = await this._openStore(this.#syncQueueStoreName, transaction)
    await store.add({
      id: crypto.randomUUID(),
      createdAt: new Date().toJSON(),
      storeName,
      primaryKey
    })
  }

  /**
   * Fill the database with initial data
   * @param {Array<string>} stores
   */
  async populate (stores = []) {
    // Process filter options
    const storeNames = Object.keys(this.stores).filter(storeName => stores.includes(storeName))

    const response = await this.#fetch({
      method: 'GET',
      url: this.populateUrl,
      searchParams: {
        storeNames
      }
    })

    await Promise.all(
      Object.entries(response).map(async ([storeName, rows]) => {
        // Here we use one transaction per store instead of a global one
        // because high number of inserts on the same transaction can be slow
        const store = await this._openStore(storeName, 'readwrite')

        return Promise.all(
          rows.map(element => store.put(element))
        )
      })
    )
  }

  /**
   * Sync the database
   */
  async sync () {
    if (this.#syncInProgress) {
      return
    }

    try {
      this.#syncInProgress = true

      // Start a new transaction
      let transaction = await this._openTransaction([this.#metadataStoreName, this.#syncQueueStoreName], 'readonly')
      let metadataStore = await this._openStore(this.#metadataStoreName, transaction)
      let syncQueueStore = await this._openStore(this.#syncQueueStoreName, transaction)

      // Init lastChangeAt
      let currentLastChangeAt = await metadataStore.get('lastChangeAt')
      let nextLastChangeAt = null

      if (!currentLastChangeAt) {
        nextLastChangeAt = currentLastChangeAt = new Date()
      }

      // Retrieve local data to sync
      const syncQueueItems = []
      let cursor = await syncQueueStore.index('createdAt').openCursor(null, 'prev')
      while (cursor) {
        syncQueueItems.push(cursor.value)
        cursor = await cursor.continue()
      }

      // Deduplicate & retrieve fresh data
      const clientData = await Promise.all(
        deduplicateArray(syncQueueItems, ['storeName', 'primaryKey']).map(async ({ createdAt, storeName, primaryKey }) => ({
          createdAt,
          storeName,
          primaryKey,
          data: await this.stores[storeName].findOne(primaryKey, transaction)
        }))
      )

      // Sync local data with the server
      const serverData = await this.#fetch({
        method: 'POST',
        url: this.syncUrl,
        searchParams: {
          lastChangeAt: currentLastChangeAt
        },
        body: clientData
      })

      // Refresh the transaction (the previous one has been terminated because of fetch)
      transaction = await this._openTransaction()
      metadataStore = await this._openStore(this.#metadataStoreName, transaction)
      syncQueueStore = await this._openStore(this.#syncQueueStoreName, transaction)

      // Sync server data locally
      for (const { createdAt, storeName, data } of serverData) {
        const store = await this._openStore(storeName, transaction)
        await store.put(data)

        const createdDate = new Date(createdAt)
        if (!nextLastChangeAt || isAfterDate(createdDate, nextLastChangeAt)) {
          nextLastChangeAt = createdDate
        }
      }

      // Save the last sync date
      if (nextLastChangeAt) {
        await metadataStore.put('lastChangeAt', nextLastChangeAt.toJSON())
      }

      // Clear the queue if not empty
      if (clientData.length) {
        await syncQueueStore.clear()
      }
    } catch (error) {
      throw error
    } finally {
      this.#syncInProgress = false
    }
  }
}
