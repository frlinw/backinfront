![Logo](/static/logo.png?raw=true)

# Backinfront

1. [What is this useful for ?](#what-is-this-useful-for-)
3. [Browser support](#browser-support)
4. [Installation](#installation)
2. [Changes](#changes)
5. [API](#api)
    1. [Backinfront](#api)
    2. [Router](#router)
    3. [Store](#store)
6. [Example](#example)


# What is this useful for ?

Backinfront is both the manager of your browser database and a router which handles requests locally. If you are building an offline first web app which needs sync capabilities, Backinfront may be the tool your are looking for.

# Browser support

This library targets modern browsers, as in Chrome, Firefox, Safari, and other browsers that use those engines, such as Edge. If you have to target much older versions of those browsers, use a transpiler.

# Changes

See the [CHANGELOG](CHANGELOG.md) to be the first to use the new features and to stay up to date with breaking changes

# Installation

> ⚠️ Backinfront is designed to work inside a [Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) make sure to NOT use it in a window context. ⚠️

```sh
npm install backinfront
```

# API

## Backinfront

### Usage

```js
const backinfront: BackinfrontAPI = new Backinfront(options: BackinfrontOptions)
```

### Interfaces

```js
interface RoutePresetOptions {
  // Name of a store
  storeName: string,
  // Preset routes
  presets: Array<'create' | 'list' | 'retrieve' | 'update'>
}

interface RouteOptions {
  // Method of the request
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  // Part of the url after the `baseUrl`
  // You can specify a `pathParam` by prefixing part of the url with `:`
  pathname: string,
  // Action performed locally
  handler(context: RouteHandlerContext, stores: { [storeName: string]: Store }): any
}

interface RouterOptions {
  baseUrl: string,
  routes: Array<RouteOptions | RoutePresetOptions>
}

interface StoreOptions {
  // Name of the store
  storeName: string,
  // Name of the primaryKey
  primaryKey: string,
  // List of indexes
  indexes: {
    [indexName: string]: string | Array<string>
  }
}

interface BackinfrontOptions {
  // Name of the indexedDB database
  databaseName: string,
  // List of stores
  stores: Array<StoreOptions>,
  // List of routers
  routers: Array<RouterOptions>,
  // URL used for database population
  populateUrl: string,
  // URL used for database synchronization
  syncUrl: string,
  // Set headers to your requests
  // Example: add authorization header to authenticate a request
  headers?(): Promise<Object>,
  // Key to use when the result contains count & data
  collectionCountKey?: string,
  collectionDataKey?: string,
  // Add data available in routes handlers
  getSession?(request: Request): object,
  // Formats data just before the insertion
  formatDataBeforeSave?(data: object): object,
  // Format a search param of a request handled offline
  // Example: convert date string to Date, comma separated list to Array, ...
  formatRouteSearchParam?(searchParam: string): any,
  // Format path params of a request handled offline
  formatRoutePathParam?(pathParam: string): any,
  // Hook triggered after a successful offline request
  onRequest?({ route: Route, result: Record<string, unknown> | Array<Record<string, unknown>> | null, error: Error | undefined }): void,
}

interface BackinfrontAPI {
  stores: { [storeName: string]: Store },
  routes: {
    [urlOrigin: string]: {
      [urlMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE']: {
        [pathNameLength: number]: Array<Route>
      }
    }
  },
  // Add a routers after initialization
  addRouters(routers: Array<RouterOptions>): void,
  addRouter(options: RouterOptions): void,
  /*
    Perform a fetch request to the `populateUrl`
    Request
    {
      method: 'GET',
      searchParams: {
        storeNames: ['storename1', ... , 'storeNameX']
      }
    }
    Response expected from the server
    {
      storeName1: [item1, ..., itemX],
      ...,
      storeNameX: [item1, ..., itemX],
    }
  */
  populate(storeNames: Array<string>): Promise<void>,
  /*
    Perform a fetch request to the `syncUrl`
    Request
    {
      method: 'POST',
      searchParams: {
        lastChangeAt // date of the last object returned by the server
      },
      body: [
        {
          createdAt,
          storeName,
          primaryKey,
          data
        }, ...
      ]
    }
    Response
    [
      {
        createdAt,
        storeName,
        primaryKey,
        data
      }, ...
    ]
    Note:
    The recommended way to use the sync capability is to send a message periodically
    from the window context which will trigger this function
  */
  sync(): Promise<void>,
  /*
    Destroy the local database
    Sometimes, it can be convenient to clear the local data (on user logout for example).
    The database will be destroyed so you must ensure to stop your sync loop
    and manually call the sync function a last time before calling destroy.
  */
  destroy(): Promise<void>
}
```

## Router

### Usage

Router is processed on [Backinfront](#api) instantiation and you can't access it after.
However, you can get the full list of registered routes but be careful, the structure is optimized for fast search on http request.
```js
const routes = backinfront.routes
```

### Interfaces
```js
interface RouteHandlerContext {
  request: Request,
  transaction: IDBTransaction,
  // Date returned by `getSession` function
  session: { [globalData: string]: any },
  // Search param after being formatted by `formatRouteSearchParam`
  searchParams: { [searchParams: string]: string | any },
  // Path param after being formatted by `formatRoutePathParam`
  pathParams: { [pathParam: string]: string | any },
  // Body of the request (null if the request's method is GET)
  body: null | object | Array<object>
}

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: URL,
  pathParams: Array<string>,
  handler(context: RouteHandlerContext, stores: { [storeName: string]: StoreAPI }): any,
  // Params used for filtering
  regexp: RegExp,
  specificity: string,
  length: number,
}
```

## Store

### Usage

A Store is accessible via the `stores` property of the Backinfront interface

```js
const store = backinfront.stores[storeName]
```
But also provided as the second parameter of the `handler` property of a [RouteOptions](#api)
```js
{
  method: 'GET',
  pathname: '/',
  handler (context, { Store1, Store2 }) {
    return Store1.findMany()
  }
}
```

### Interfaces

```js

interface FindQuery {
  where: object,
  limit: number,
  offset: number,
  order: Array<string>
}

interface StoreAPI {
  // Delete all elements from the store
  clear(transaction?: IDBTransaction): Promise<void>,
  // Count the total of items in the store
  count(transaction?: IDBTransaction): Promise<number>,
  // Add a new item to the store
  create(data: object, transaction?: IDBTransaction): Promise<object>,
  // Delete the elements matching the condition
  deleteMany(condition?: FindQuery, transaction?: IDBTransaction): Promise<void>,
  // Delete the element matching the primaryKey value from the store
  deleteOne(primaryKeyValue: unknown, transaction?: IDBTransaction): Promise<void>,
  // Find a list of items matching the provided condition
  findMany(condition?: FindQuery, transaction?: IDBTransaction): Promise<Array<object>>,
  findManyAndCount(condition?: FindQuery, transaction?: IDBTransaction): Promise<object>,
  // Find an item by it's primaryKey value
  findOne(primaryKeyValue: unknown | FindQuery, transaction?: IDBTransaction): Promise<object>,
  // Update an existing item from the store
  update(primaryKeyValue: unknown, data: object, transaction?: IDBTransaction): Promise<object>,
}
```

### Query language

Backinfront provides a powerful API to ease the filtering of database records.
You can make good use of it in the `where` property of the `FindQuery` interface.

```js
await store.findManyAndCount({
  where: {
    //
    // Logical operators
    //
    $or: [],
    $and: [],
    // Logical operators can be nested
    $and: [
      { $or: [] },
      { $and: [] },
    ],

    //
    // $and shorthands
    //

    // $and can be implicit in 2 cases
    // 1 - multiple filters side by side
    // this:
    property1: value1,
    property2: value2,
    // is equivalent to this:
    $and: [
      { property1: value1 },
      { property2: value2 },
    ],
    // 2 - multiple filters for the same property
    // this:
    property: {
      $gt: value,
      $lt: value,
    },
    // is equivalent to this:
    $and: [
      { property: { $gt: value } },
      { property: { $lt: value } },
    ],

    //
    // Dot notation
    //

    // Allow to filter deeeeeep properties
    'grandma.mum.me': value,

    //
    // Available filters (open an issue if you need more)
    //

    property: { $equal: value }, // equivalent to `property: value`
    property: { $gt: value },
    property: { $gte: value },
    property: { $lt: value },
    property: { $lte: value },
    property: { $in: [value1, ...,  valueX] },
    property: { $notin: [value1, ..., valueX] },
    property: { $like: [normalize, value] }, // use normalize function to apply a transformation to value & store value
    property: { $some: (element) => element === value }, // will always return false if the store value is not an array
    property: { $function: (storeValue) => storeValue === value } // This example reproduce $equal condition
  },
  limit: number,
  offset: number,
  // You can only order by an existing index
  order: ['indexName', 'DESC']
})
```

# Example

Something is still unclear? What is better than [a real example](/example) to show you the best way to use Backinfront!
