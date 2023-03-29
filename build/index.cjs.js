'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var firestore = require('@firebase/firestore');
var Y = require('yjs');

function _interopNamespace(e) {
    if (e && e.__esModule) return e;
    var n = Object.create(null);
    if (e) {
        Object.keys(e).forEach(function (k) {
            if (k !== 'default') {
                var d = Object.getOwnPropertyDescriptor(e, k);
                Object.defineProperty(n, k, d.get ? d : {
                    enumerable: true,
                    get: function () { return e[k]; }
                });
            }
        });
    }
    n["default"] = e;
    return Object.freeze(n);
}

var Y__namespace = /*#__PURE__*/_interopNamespace(Y);

/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */

function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
}

/**
 * Utility module to work with key-value stores.
 *
 * @module map
 */

/**
 * Creates a new Map instance.
 *
 * @function
 * @return {Map<any, any>}
 *
 * @function
 */
const create$1 = () => new Map();

/**
 * Get map property. Create T if property is undefined and set T on map.
 *
 * ```js
 * const listeners = map.setIfUndefined(events, 'eventName', set.create)
 * listeners.add(listener)
 * ```
 *
 * @function
 * @template V,K
 * @template {Map<K,V>} MAP
 * @param {MAP} map
 * @param {K} key
 * @param {function():V} createT
 * @return {V}
 */
const setIfUndefined = (map, key, createT) => {
  let set = map.get(key);
  if (set === undefined) {
    map.set(key, set = createT());
  }
  return set
};

/**
 * Utility module to work with sets.
 *
 * @module set
 */

const create = () => new Set();

/**
 * Utility module to work with Arrays.
 *
 * @module array
 */

/**
 * Transforms something array-like to an actual Array.
 *
 * @function
 * @template T
 * @param {ArrayLike<T>|Iterable<T>} arraylike
 * @return {T}
 */
const from = Array.from;

/**
 * Observable class prototype.
 *
 * @module observable
 */

/**
 * Handles named events.
 *
 * @template N
 */
class Observable {
  constructor () {
    /**
     * Some desc.
     * @type {Map<N, any>}
     */
    this._observers = create$1();
  }

  /**
   * @param {N} name
   * @param {function} f
   */
  on (name, f) {
    setIfUndefined(this._observers, name, create).add(f);
  }

  /**
   * @param {N} name
   * @param {function} f
   */
  once (name, f) {
    /**
     * @param  {...any} args
     */
    const _f = (...args) => {
      this.off(name, _f);
      f(...args);
    };
    this.on(name, _f);
  }

  /**
   * @param {N} name
   * @param {function} f
   */
  off (name, f) {
    const observers = this._observers.get(name);
    if (observers !== undefined) {
      observers.delete(f);
      if (observers.size === 0) {
        this._observers.delete(name);
      }
    }
  }

  /**
   * Emit a named event. All registered event listeners that listen to the
   * specified name will receive the event.
   *
   * @todo This should catch exceptions
   *
   * @param {N} name The event name.
   * @param {Array<any>} args The arguments that are applied to the event listener.
   */
  emit (name, args) {
    // copy all listeners to an array first to make sure that no event is emitted to listeners that are subscribed while the event handler is called.
    return from((this._observers.get(name) || create$1()).values()).forEach(f => f(...args))
  }

  destroy () {
    this._observers = create$1();
  }
}

/**
 * An estimate for the difference in milliseconds between the local clock
 * and the server's clock
 */
let delta = null;
/**
 * Get an approximation of the current server time.
 * @param firebaseApp The FirebaseApp
 * @param path The path to a document that can be used to get the server time
 * @returns An approximation of the current server time
 */
function currentTime(firebaseApp, path) {
    return __awaiter(this, void 0, void 0, function* () {
        if (delta !== null) {
            return Date.now() + delta;
        }
        try {
            const db = firestore.getFirestore(firebaseApp);
            const ref = firestore.doc(db, path);
            const before = Date.now();
            yield firestore.setDoc(ref, { now: firestore.serverTimestamp() });
            const after = Date.now();
            const avg = Math.floor((before + after) / 2);
            const nowDoc = yield firestore.getDoc(ref);
            if (nowDoc.exists()) {
                const serverNow = nowDoc.data().now;
                const serverUnixTime = serverNow.seconds * 1000 +
                    Math.floor(serverNow.nanoseconds / 1000000);
                delta = serverUnixTime - avg;
                yield firestore.deleteDoc(ref);
                return Date.now() + delta;
            }
        }
        catch (error) {
            console.log("An error occurred while getting the current time", { error, path });
        }
        // In theory we should never get here, but just in case, fallback
        // to the client time.
        return Date.now();
    });
}
/**
 * Convert a Firestore Timestamp into the number of milliseconds since the
 * Unix epoch in UTC time.
 * @param timestamp A Firestore Timestamp
 * @returns The number of milliseconds since the Unix epoch
 */
function timeSinceEpoch(timestamp) {
    return timestamp.seconds * 1000 + Math.floor(timestamp.nanoseconds / 1000000);
}

const SHUTDOWN = "shutdown";
const YJS_HISTORY_UPDATES = "/yjs/history/updates";
const YJS_HISTORY = "/yjs/history";
const YJS_TIME = "/yjs/time";
function getUpdates(db, path) {
    return __awaiter(this, void 0, void 0, function* () {
        const set = new Set();
        const ref = firestore.collection(db, path);
        const snapshot = yield firestore.getDocs(ref);
        snapshot.forEach(document => set.add(document.id));
        return set;
    });
}
function deleteYjsData(firebaseApp, path, updateSet) {
    return __awaiter(this, void 0, void 0, function* () {
        // Save a "shutdown" message for all running providers.
        // This is accomplished by adding an empty document whose `id` is "shutdown" to the
        // "updates" collection.
        const db = firestore.getFirestore(firebaseApp);
        const basePath = path.join('/');
        const collectionPath = basePath + YJS_HISTORY_UPDATES;
        const shutdownPath = collectionPath + '/' + SHUTDOWN;
        const shutdownRef = firestore.doc(db, shutdownPath);
        yield firestore.setDoc(shutdownRef, {});
        const baselineRef = firestore.doc(db, basePath + YJS_HISTORY);
        // If the `updateSet` was not provided, get it via a query
        if (!updateSet) {
            updateSet = yield getUpdates(db, collectionPath);
        }
        const batch = firestore.writeBatch(db);
        batch.delete(baselineRef);
        // Delete all the updates in the set (except for the "shutdown" message)
        updateSet.forEach(docId => {
            if (docId !== SHUTDOWN) {
                const docPath = collectionPath + '/' + docId;
                const docRef = firestore.doc(db, docPath);
                batch.delete(docRef);
            }
        });
        yield batch.commit();
        // Finally, delete the shutdown message
        yield firestore.deleteDoc(shutdownRef);
    });
}
/**
 * A Yjs Provider that stores document updates in a Firestore collection.
 */
class FirestoreProvider extends Observable {
    constructor(firebaseApp, ydoc, path, config) {
        super();
        this.clock = 0;
        this.maxUpdatePause = 600;
        this.maxUpdatesPerBlob = 20;
        /**
         * The amount of time that an individual update is allowed to live in the
         * "updates" collection until it is merged into "yjs/baseline"
         */
        this.blobTimeToLive = 10000; // 10 seconds
        this.updateCount = 0;
        this.updateMap = new Map();
        this.isStopped = false;
        this.firebaseApp = firebaseApp;
        this.basePath = path.join('/');
        this.doc = ydoc;
        this.maxUpdatePause = (config === null || config === void 0 ? void 0 : config.maxUpdatePause) === undefined ? 600 : config.maxUpdatePause;
        this.maxUpdatesPerBlob = (config === null || config === void 0 ? void 0 : config.maxUpdatesPerBlob) === undefined ? 20 : config.maxUpdatesPerBlob;
        this.blobTimeToLive = (config === null || config === void 0 ? void 0 : config.blobTimeToLive) === undefined ? 10000 : config.blobTimeToLive;
        const db = firestore.getFirestore(firebaseApp);
        const self = this;
        const extra = Math.floor(2000 * Math.random());
        this.compressIntervalId = setInterval(() => {
            self.compress();
        }, this.blobTimeToLive + extra);
        this.updateHandler = (update, origin) => {
            if (this.isStopped) {
                return;
            }
            // Ignore updates applied by this provider
            if (origin !== self) {
                // The update was produced either locally or by another provider.
                //
                // Don't persist every single update. Instead, merge updates until there are 
                // at least 20 changes or there is a pause in updates greater than 600 ms.
                // Merged updates are stored in `this.cache`
                if (self.saveTimeoutId) {
                    clearTimeout(self.saveTimeoutId);
                    delete self.saveTimeoutId;
                }
                self.cache = self.cache ? Y__namespace.mergeUpdates([self.cache, update]) : update;
                self.updateCount++;
                if (self.updateCount < self.maxUpdatesPerBlob) {
                    if (self.saveTimeoutId) {
                        clearTimeout(self.saveTimeoutId);
                    }
                    self.saveTimeoutId = setTimeout(() => {
                        delete self.saveTimeoutId;
                        self.save();
                    }, self.maxUpdatePause);
                }
                else {
                    self.save();
                }
            }
        };
        this.destroyHandler = () => this.destroy();
        // Subscribe to the ydoc's update and destroy events
        ydoc.on('update', this.updateHandler);
        ydoc.on('destroy', this.destroyHandler);
        // Start a listener for document updates
        const collectionPath = path.join("/") + YJS_HISTORY_UPDATES;
        const q = firestore.query(firestore.collection(db, collectionPath));
        const baselinePath = this.basePath + YJS_HISTORY;
        const baseRef = firestore.doc(db, baselinePath);
        firestore.getDoc(baseRef).then(baseDoc => {
            if (baseDoc.exists()) {
                const bytes = baseDoc.data().update;
                const update = bytes.toUint8Array();
                Y__namespace.applyUpdate(ydoc, update, self);
            }
        }).then(() => {
            self.unsubscribe = firestore.onSnapshot(q, (snapshot) => {
                let mustShutdown = false;
                snapshot.docChanges().forEach(change => {
                    const document = change.doc;
                    switch (change.type) {
                        case "added":
                        case "modified":
                            if (document.id === SHUTDOWN) {
                                mustShutdown = true;
                                self.updateMap.set(SHUTDOWN, { time: 0 });
                            }
                            else {
                                const data = document.data();
                                const createdAt = data.createdAt;
                                if (!createdAt) {
                                    break;
                                }
                                const update = data.update.toUint8Array();
                                const clientID = parseClientId(document.id);
                                const time = timeSinceEpoch(createdAt);
                                self.updateMap.set(document.id, {
                                    time,
                                    update
                                });
                                // Ignore updates that originated from the local Y.Doc
                                if (clientID !== ydoc.clientID) {
                                    Y__namespace.applyUpdate(ydoc, update, self);
                                }
                            }
                            break;
                        case "removed":
                            self.updateMap.delete(document.id);
                            break;
                    }
                });
                if (mustShutdown) {
                    this.shutdown();
                }
            }, (error) => {
                console.error(`An error occurred while listening for Yjs updates at "${collectionPath}"`, error);
                this.error = error;
            });
        }).catch(error => {
            console.error(`An error occurred while getting Yjs update at "${baselinePath}"`, error);
        });
    }
    destroy() {
        this.save();
        this.shutdown();
        super.destroy();
    }
    /**
     * Shutdown this provider, and permanently delete the
     * Yjs data
     */
    deleteYjsData() {
        return __awaiter(this, void 0, void 0, function* () {
            this.shutdown();
            const set = new Set(this.updateMap.keys());
            const path = this.basePath.split('/');
            yield deleteYjsData(this.firebaseApp, path, set);
        });
    }
    compress() {
        return __awaiter(this, void 0, void 0, function* () {
            const map = this.updateMap;
            if (this.isStopped || map.size === 0) {
                return;
            }
            const baselinePath = this.basePath + YJS_HISTORY;
            const updatesPath = this.basePath + YJS_HISTORY_UPDATES;
            const timePath = this.basePath + YJS_TIME;
            const now = yield currentTime(this.firebaseApp, timePath);
            const zombies = new Set();
            let newUpdates = null;
            for (const [key, value] of map) {
                if (value) {
                    const update = value.update;
                    if (!update) {
                        // Shutting down;
                        return;
                    }
                    if (now - value.time > this.blobTimeToLive) {
                        zombies.add(key);
                        newUpdates = newUpdates ? Y__namespace.mergeUpdates([newUpdates, update]) : update;
                    }
                }
            }
            if (!newUpdates) {
                return;
            }
            try {
                const db = firestore.getFirestore(this.firebaseApp);
                yield firestore.runTransaction(db, (txn) => __awaiter(this, void 0, void 0, function* () {
                    const baselineRef = firestore.doc(db, baselinePath);
                    const baselineDoc = yield txn.get(baselineRef);
                    let update = null;
                    if (baselineDoc.exists()) {
                        const baselineData = baselineDoc.data();
                        update = Y__namespace.mergeUpdates([baselineData.update.toUint8Array(), newUpdates]);
                    }
                    else {
                        update = newUpdates;
                    }
                    txn.set(baselineRef, { update: firestore.Bytes.fromUint8Array(update) });
                    for (const key of zombies) {
                        const ref = firestore.doc(db, updatesPath, key);
                        txn.delete(ref);
                    }
                }));
            }
            catch (error) {
                console.error("Failed to compress Yjs update", { error, path: baselinePath });
            }
            for (const key of zombies) {
                map.delete(key);
            }
        });
    }
    shutdown() {
        if (!this.isStopped) {
            this.isStopped = true;
            this.doc.off("update", this.updateHandler);
            this.doc.off("destroy", this.destroyHandler);
            if (this.compressIntervalId) {
                clearInterval(this.compressIntervalId);
                delete this.compressIntervalId;
            }
            if (this.saveTimeoutId) {
                clearTimeout(this.saveTimeoutId);
                delete this.saveTimeoutId;
            }
            if (this.unsubscribe) {
                this.unsubscribe();
                delete this.unsubscribe;
            }
            this.updateMap = new Map();
            if (this.cache) {
                delete this.cache;
            }
            this.updateCount = 0;
        }
    }
    save() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.saveTimeoutId) {
                clearTimeout(this.saveTimeoutId);
                delete this.saveTimeoutId;
            }
            const update = this.cache;
            delete this.cache;
            this.updateCount = 0;
            if (update && !this.isStopped) {
                const data = {
                    createdAt: firestore.serverTimestamp(),
                    update: firestore.Bytes.fromUint8Array(update)
                };
                const clock = this.clock++;
                const time = Date.now();
                const updateId = this.doc.clientID.toString(16) +
                    "-" + clock.toString(16) + '-' + time.toString(16);
                const db = firestore.getFirestore(this.firebaseApp);
                const path = this.basePath + YJS_HISTORY_UPDATES;
                const docRef = firestore.doc(db, path, updateId);
                yield firestore.setDoc(docRef, data);
            }
        });
    }
}
function parseClientId(updateId) {
    const dash = updateId.indexOf('-');
    const value = updateId.substring(0, dash);
    return parseInt(value, 16);
}

exports.FirestoreProvider = FirestoreProvider;
exports.deleteYjsData = deleteYjsData;
//# sourceMappingURL=index.cjs.js.map
