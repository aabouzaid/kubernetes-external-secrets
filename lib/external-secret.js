'use strict'

const JSONStream = require('json-stream')

/**
 * Creates an FIFO queue which you can put to and take from.
 * If theres nothing to take it will wait with resolving until
 * something is put to the queue.
 * @returns {Object} Queue instance with put and take methods
 */
function createEventQueue () {
  const queuedEvents = []
  const waitingResolvers = []

  return {
    take: () => queuedEvents.length > 0
      ? Promise.resolve(queuedEvents.shift())
      : new Promise(resolve => waitingResolvers.push(resolve)),
    put: (msg) => waitingResolvers.length > 0
      ? waitingResolvers.shift()(msg)
      : queuedEvents.push(msg)
  }
}

async function startWatcher ({
  kubeClient,
  watchedNamespaces,
  customResourceManifest,
  logger,
  eventQueue
}) {
  const deathQueue = createEventQueue()

  try {
    while (true) {
      logger.debug('Starting watch stream')

      const jsonStream = new JSONStream()

      // If the watchedNamespaces is an empty array (i.e. no scoped access),
      // add an empty element so all ExternalSecret resources in all namespaces will be watched.
      const namespacesStreams = watchedNamespaces && watchedNamespaces.length ? watchedNamespaces : ['']

      // Create a namespace stream per namespace and add it to the JSON stream.
      namespacesStreams.map(namespace => {
        return kubeClient
          .apis[customResourceManifest.spec.group]
          .v1.watch
          .namespaces(namespace)[customResourceManifest.spec.names.plural]
          .getStream()
          .pipe(jsonStream)
      })

      jsonStream.on('data', eventQueue.put)

      jsonStream.on('error', (err) => {
        logger.warn(err, 'Got error on stream')
        deathQueue.put('ERROR')
      })

      jsonStream.on('end', () => {
        deathQueue.put('END')
      })

      await deathQueue.take()

      logger.debug('Stopping watch stream')
      eventQueue.put({ type: 'DELETED_ALL' })

      namespacesStreams.forEach(namespaceStream => {
        namespaceStream.abort()
      })
    }
  } catch (err) {
    logger.error(err, 'Watcher crashed')
  }
}

/**
 * Get a stream of external secret events. This implementation uses
 * watch and yields as a stream of events.
 * @param {Object} kubeClient - Client for interacting with kubernetes cluster.
 * @param {Array} watchedNamespaces - List of scoped namespaces.
 * @param {Object} customResourceManifest - Custom resource manifest.
 * @returns {Object} An async generator that yields externalsecret events.
 */
function getExternalSecretEvents ({
  kubeClient,
  watchedNamespaces,
  customResourceManifest,
  logger
}) {
  return (async function * () {
    const eventQueue = createEventQueue()

    startWatcher({
      kubeClient,
      watchedNamespaces,
      customResourceManifest,
      logger,
      eventQueue
    })

    while (true) {
      yield await eventQueue.take()
    }
  }())
}

module.exports = {
  getExternalSecretEvents
}
