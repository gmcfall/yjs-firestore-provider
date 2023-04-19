import { FirebaseApp } from "@firebase/app";
import { Bytes, collection, deleteDoc, doc, Firestore, getDoc, getDocs, getFirestore, onSnapshot, query, runTransaction, serverTimestamp, setDoc, Timestamp, Unsubscribe, writeBatch } from "@firebase/firestore";
import { Observable } from "lib0/observable";
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { currentTime, timeSinceEpoch } from "./time";
import { getTimePath } from "./y-common";
import { FirestoreWebrtcProvider } from "./y-webrtc";

const SHUTDOWN = "shutdown";
const YJS_HISTORY_UPDATES = "/yjs/history/updates";
const YJS_HISTORY = "/yjs/history";

interface DocUpdate {
    /** A timestamp when the update was saved */
    createdAt: Timestamp | null;

    /** The binary encoding of the update */
    update: Bytes;
}

async function getUpdates(db: Firestore, path: string) {
    const set = new Set<string>();


    const ref = collection(db, path);
    const snapshot = await getDocs(ref);
    snapshot.forEach( document => set.add(document.id));

    return set;
}

export async function deleteYjsData(firebaseApp: FirebaseApp, path: string[], updateSet?: Set<string>) {

    // Save a "shutdown" message for all running providers.
    // This is accomplished by adding an empty document whose `id` is "shutdown" to the
    // "updates" collection.

    const db = getFirestore(firebaseApp);

    const basePath = path.join('/');
    const collectionPath = basePath + YJS_HISTORY_UPDATES;
    const shutdownPath = collectionPath + '/' + SHUTDOWN;
    const shutdownRef = doc(db, shutdownPath);
    await setDoc(shutdownRef, {});

    const baselineRef = doc(db, basePath + YJS_HISTORY);
    
    // If the `updateSet` was not provided, get it via a query

    if (!updateSet) {
        updateSet = await getUpdates(db, collectionPath);
    }

    const batch = writeBatch(db);
    batch.delete(baselineRef);
    // Delete all the updates in the set (except for the "shutdown" message)
    updateSet.forEach( docId => {
        if (docId !== SHUTDOWN) {
            const docPath = collectionPath + '/' + docId;
            const docRef = doc(db, docPath);
            batch.delete(docRef);
        }
    })
    await batch.commit();

    // Finally, delete the shutdown message
    await deleteDoc(shutdownRef);
}

interface UpdateWithTimestamp {
    time: number;
    update?: Uint8Array;
}

/**
 * Optional configuration settings for FirestoreProvider
 */
export interface FirestoreProviderConfig {

    /**
     * The maximum number of update events allowed in a blob, set to 20 by default.
     * You can decrease latency by setting this parameter to a lower value. Setting it to 1 will 
     * cause the FirestoreProvider to emit every single update event immediately, at the penalty of
     * increased cost due to more frequent writes.
     */
    maxUpdatesPerBlob?: number;

    /**
     * The maximum amount of time in milliseconds that the user may pause in making 
     * changes before a blob is emitted, set to 600 ms by default.  Setting this parameter to a smaller 
     * value will reduce latency, but again, at the penalty of increased cost due to more frequent writes.
     * Setting it to a higher value will increase latency and reduce cost.
     */
    maxUpdatePause?: number;

    /**
     * The maximum amount of time in milliseconds that a blob of updates can live in Firestore
     * before it is removed and merged into the consolidated history. By default, this parameter is set to
     * 10000 (i.e. 10 seconds).  As a best practice, applications should stick with this default.
     */
    blobTimeToLive?: number;

    /**
     * A flag that determines whether awareness should be disabled. The default value is `false`.
     */
    disableAwareness?: boolean;
}


/**
 * A Yjs Provider that stores document updates in a Firestore collection.
 */
export class FirestoreProvider extends Observable<any> {
    readonly doc: Y.Doc;
    error?: Error;
    awareness: awarenessProtocol.Awareness | null = null;
    private firebaseApp: FirebaseApp;
    private unsubscribe?: Unsubscribe;
    private clock = 0;
    private basePath: string;

    private cache?: Uint8Array;
    private maxUpdatePause = 600;
    private maxUpdatesPerBlob = 20;

    /**
     * The amount of time that an individual update is allowed to live in the 
     * "updates" collection until it is merged into "yjs/baseline"
     */
    private blobTimeToLive = 10000; // 10 seconds
    private updateCount = 0;

    /**
     * The id for a timer that will save pending updates after an elapsed time
     */
    private saveTimeoutId?: ReturnType<typeof setTimeout>;
    private compressIntervalId?: ReturnType<typeof setInterval>;

    private updateHandler: (update: Uint8Array, origin: any) => void;
    private destroyHandler: () => void;
    private updateMap = new Map<string, UpdateWithTimestamp>();
    private isStopped = false;

    private webrtcProvider: FirestoreWebrtcProvider | null = null;

    constructor(firebaseApp: FirebaseApp, ydoc: Y.Doc, path: string[], config?: FirestoreProviderConfig) {
        super();
        this.firebaseApp = firebaseApp;
        this.basePath = path.join('/');
        this.doc = ydoc;

        this.maxUpdatePause =       config?.maxUpdatePause === undefined ? 600   : config.maxUpdatePause;
        this.maxUpdatesPerBlob = config?.maxUpdatesPerBlob === undefined ? 20    : config.maxUpdatesPerBlob;
        this.blobTimeToLive =       config?.blobTimeToLive === undefined ? 10000 : config.blobTimeToLive;

        const enableAwareness = !Boolean(config?.disableAwareness);
        if (enableAwareness) {
            this.webrtcProvider = new FirestoreWebrtcProvider(firebaseApp, this.basePath, ydoc)
            this.awareness = this.webrtcProvider.awareness;
        }

        const db = getFirestore(firebaseApp);
        const self = this;

        const extra = Math.floor(2000 * Math.random());
        this.compressIntervalId = setInterval(() => {
            self.compress();
        }, this.blobTimeToLive + extra)

       

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
                
                self.cache = self.cache ? Y.mergeUpdates([self.cache, update]) : update;
                self.updateCount++;

                if (self.updateCount < self.maxUpdatesPerBlob) {
                    if (self.saveTimeoutId) {
                        clearTimeout(self.saveTimeoutId);
                    }
                    self.saveTimeoutId = setTimeout(() => {
                        delete self.saveTimeoutId;
                        self.save();
                    }, self.maxUpdatePause)
                } else {
                    self.save();
                }
            }
        }

        this.destroyHandler = () => this.destroy();

        // Subscribe to the ydoc's update and destroy events
        ydoc.on('update', this.updateHandler)
        ydoc.on('destroy', this.destroyHandler)


        // Start a listener for document updates
        const collectionPath = path.join("/") + YJS_HISTORY_UPDATES;
        const q = query(collection(db, collectionPath));

        const baselinePath = this.basePath + YJS_HISTORY;
        const baseRef = doc(db, baselinePath);
        getDoc(baseRef).then(baseDoc => {
            if (baseDoc.exists()) {
                const bytes = baseDoc.data().update as Bytes;
                const update = bytes.toUint8Array();
                Y.applyUpdate(ydoc, update, self);
            }
        }).then(()=> {
            self.unsubscribe = onSnapshot(q, (snapshot) => {
                let mustShutdown = false;
                snapshot.docChanges().forEach( change => {
                    const document = change.doc;
    
                    switch (change.type) {
                        case "added" :
                        case "modified":
                            if (document.id === SHUTDOWN)  {
                                mustShutdown = true;
                                self.updateMap.set(SHUTDOWN, {time: 0});
                            } else {
                                const data = document.data() as DocUpdate;
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
                                })
                                // Ignore updates that originated from the local Y.Doc
                                if (clientID !== ydoc.clientID) {
                                    Y.applyUpdate(ydoc, update, self);
                                }
                            }
                            break;
                        
                        case "removed" :
                            self.updateMap.delete(document.id);
                            break;
                    }
                    
                })
                if (mustShutdown) {
                    this.destroy();
                }
            }, (error) => {
                console.error(`An error occurred while listening for Yjs updates at "${collectionPath}"`, error);
                this.error = error;
            })
        }).catch(error => {
            console.error(`An error occurred while getting Yjs update at "${baselinePath}"`, error);
        })


    }

    destroy() {
        console.log('destory FirestoreProvider')
        this.save();
        if (this.webrtcProvider) {
            this.webrtcProvider.destroy();
            this.webrtcProvider = null;
        }
        this.shutdown();
        super.destroy();
    }

    /**
     * Destroy this provider, and permanently delete the 
     * Yjs data 
     */
    async deleteYjsData() {
        this.destroy();
        const set = new Set<string>(this.updateMap.keys());
        const path = this.basePath.split('/');
        await deleteYjsData(this.firebaseApp, path, set);
    }

    private async compress() {
        const map = this.updateMap;
        if (this.isStopped || map.size===0) {
            return;
        }
        const baselinePath = this.basePath + YJS_HISTORY;
        const updatesPath = this.basePath + YJS_HISTORY_UPDATES;
        const timePath = getTimePath(this.basePath);
        
        const now = await currentTime(this.firebaseApp, timePath);
        const zombies = new Set<string>();
        let newUpdates: Uint8Array | null = null;
        for (const [key, value] of map) {
            if (value) {
                const update = value.update;
                if (!update) {
                    // Shutting down;
                    return;
                }
                if (now - value.time > this.blobTimeToLive) {
                   zombies.add(key);
                   newUpdates = newUpdates ? Y.mergeUpdates([newUpdates, update]) : update;
                }
            }
        }
        if (!newUpdates) {
            return;
        }
        try {
            const db = getFirestore(this.firebaseApp);
            
            await runTransaction(db, async (txn) => {
                const baselineRef = doc(db, baselinePath);
                const baselineDoc = await txn.get(baselineRef);
                let update: Uint8Array | null = null;
                if (baselineDoc.exists())  {
                    const baselineData = baselineDoc.data() as DocUpdate;
                    update = Y.mergeUpdates(
                        [baselineData.update.toUint8Array(), newUpdates!]
                    );
                } else {
                    update = newUpdates;
                }

                txn.set(baselineRef, {update: Bytes.fromUint8Array(update!)});
                for (const key of zombies) {
                    const ref = doc(db, updatesPath, key);
                    txn.delete(ref);
                }
            })

        } catch (error) {
            console.error("Failed to compress Yjs update", {error, path: baselinePath})
        }

        for (const key of zombies) {
            map.delete(key);
        }
    }

    private shutdown() {
        console.log('shutdown invoked');
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
            this.updateMap = new Map<string, UpdateWithTimestamp>();
            if (this.cache) {
                delete this.cache;
            }
            this.updateCount=0;

            const room  = this.webrtcProvider?.room;
            if (room) {
                room.destroy();
            }
        }
    }

    private async save() {
        if (this.saveTimeoutId) {
            clearTimeout(this.saveTimeoutId);
            delete this.saveTimeoutId;
        }
        
        const update = this.cache;
        delete this.cache;
        this.updateCount=0;

        if (update && !this.isStopped) {
            const data = {
                createdAt: serverTimestamp(),
                update: Bytes.fromUint8Array(update)
            }

            const clock = this.clock++;
            const time = Date.now();
            const updateId = this.doc.clientID.toString(16) + 
                "-" + clock.toString(16) + '-' + time.toString(16);

            const db = getFirestore(this.firebaseApp);
            const path = this.basePath + YJS_HISTORY_UPDATES;
            const docRef = doc(db, path, updateId);
            await setDoc(docRef, data);
        }
    }
}

function parseClientId(updateId: string) {
    const dash = updateId.indexOf('-');
    const value = updateId.substring(0, dash);
    return parseInt(value, 16);
}