import * as bc from 'lib0/broadcastchannel'
import * as buffer from 'lib0/buffer'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as error from 'lib0/error'
import * as logging from 'lib0/logging'
import * as map from 'lib0/map'
import * as math from 'lib0/math'
import { createMutex } from 'lib0/mutex'
import { Observable } from 'lib0/observable'
import * as random from 'lib0/random'


import * as Y from 'yjs'; // eslint-disable-line
// import Peer from 'simple-peer/simplepeer.min.js'
import SimplePeer from "simple-peer"

import * as awarenessProtocol from 'y-protocols/awareness'
// import * as syncProtocol from 'y-protocols/sync'

import { FirebaseApp } from 'firebase/app'
import { collection, deleteDoc, doc, getDoc, getFirestore, onSnapshot, query, serverTimestamp, setDoc, Timestamp, Unsubscribe } from 'firebase/firestore'
import * as cryptoutils from './crypto'
import { currentTime } from './time'
import { getTimePath } from './y-common'

const log = logging.createModuleLogger('y-webrtc')

// const messageSync = 0
const messageQueryAwareness = 3
const messageAwareness = 1
const messageBcPeerId = 4

const rooms = new Map<string, Room>()

const checkIsSynced = (room: Room) => {
  let synced = true
  room.webrtcConns.forEach(peer => {
    if (!peer.synced) {
      synced = false
    }
  })
  if ((!synced && room.synced) || (synced && !room.synced)) {
    room.synced = synced
    room.provider.emit('synced', [{ synced }])
    log('synced ', logging.BOLD, room.name, logging.UNBOLD, ' with all peers')
  }
}

const readMessage = (room: Room, buf: Uint8Array, syncedCallback: () => void) => {
  const decoder = decoding.createDecoder(buf)
  const encoder = encoding.createEncoder()
  const messageType = decoding.readVarUint(decoder)
  if (room === undefined) {
    return null
  }

  const awareness = room.awareness
  // const doc = room.doc
  let sendReply = false
  switch (messageType) {
    // case messageSync: {
    //   encoding.writeVarUint(encoder, messageSync)
    //   const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, room)
    //   if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !room.synced) {
    //     syncedCallback()
    //   }
    //   if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
    //     sendReply = true
    //   }
    //   break
    // }
    case messageQueryAwareness:
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys())))
      sendReply = true
      break
    case messageAwareness:
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), room)
      break
    case messageBcPeerId: {
      const add = decoding.readUint8(decoder) === 1
      const peerName = decoding.readVarString(decoder)
      if (peerName !== room.peerId && ((room.bcConns.has(peerName) && !add) || (!room.bcConns.has(peerName) && add))) {
        const removed = []
        const added = []
        if (add) {
          room.bcConns.add(peerName)
          added.push(peerName)
        } else {
          room.bcConns.delete(peerName)
          removed.push(peerName)
        }
        room.provider.emit('peers', [{
          added,
          removed,
          webrtcPeers: Array.from(room.webrtcConns.keys()),
          bcPeers: Array.from(room.bcConns)
        }])
        broadcastBcPeerId(room)
      }
      break
    }
    default:
      console.error('Unable to compute message')
      return encoder
  }
  if (!sendReply) {
    // nothing has been written, no answer created
    return null
  }
  return encoder
}

const readPeerMessage = (peerConn: WebrtcConn, buf: Uint8Array) => {
  const room = peerConn.room
  log('received message from ', logging.BOLD, peerConn.remotePeerId, logging.GREY, ' (', room.name, ')', logging.UNBOLD, logging.UNCOLOR)
  return readMessage(room, buf, () => {
    peerConn.synced = true
    log('synced ', logging.BOLD, room.name, logging.UNBOLD, ' with ', logging.BOLD, peerConn.remotePeerId)
    checkIsSynced(room)
  })
}

const sendWebrtcConn = (webrtcConn: IWebrtcConn, encoder: encoding.Encoder) => {
  log('send message to ', logging.BOLD, webrtcConn.remotePeerId, logging.UNBOLD, logging.GREY, ' (', webrtcConn.room.name, ')', logging.UNCOLOR)
  try {
    webrtcConn.peer.send(encoding.toUint8Array(encoder))
  } catch (e) {}
}

const broadcastWebrtcConn = (room: Room, m: Uint8Array) => {
  log('broadcast message in ', logging.BOLD, room.name, logging.UNBOLD)
  room.webrtcConns.forEach(conn => {
    try {
      conn.peer.send(m)
    } catch (e) {}
  })
}

function getAnnouncePath(basePath: string, peerId: string) {
  return basePath + ANNOUNCE_PATH + peerId;
}

function getSignalPath(basePath: string, to: string, msgId: string) {
  return `${basePath}/yjs/aware/signal/${to}/sig_messages/${msgId}`;
}

  /**
   * The time limit for establishing a connection to the peer. 
   * If the connection is not established within this limit, the peer is deemed to
   * be offline. In that case, the announce document and signal messages will be deleted.
   */
const CONNECTION_TIMEOUT = 5000; // 5 seconds
export class FirestoreWebrtcConn implements IWebrtcConn {
  peer: SimplePeer.Instance;
  connected: boolean;
  remotePeerId: string;
  room: Room;
  closed: boolean;
  synced: boolean;

  /**
   * The list of id values for signal messages sent to the peer via Firestore.
   * If a connection is not established within the CONNECTION_TIMEOUT period,
   * these messages and the peer's `announce` document will be deleted from Firestore.
   */
  private signals: string[] | undefined = [];
  private connectionTimeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor (signalingConn: FirestoreSignalingConn, initiator: boolean, remotePeerId: string, room: Room) {
    this.room = room
    this.remotePeerId = remotePeerId
    this.closed = false
    this.connected = false
    this.synced = false
    this.peer = new SimplePeer({ initiator, ...room.provider.peerOpts });
    this.peer.on('signal', (signal: any) => {
      signalingConn.publishSignal(remotePeerId, signal);
    })
    this.peer.on('connect', () => {
      log('connected to ', logging.BOLD, remotePeerId)
      this.connected = true;
      if (this.connectionTimeoutId) {
        clearTimeout(this.connectionTimeoutId);
        delete this.connectionTimeoutId;
      }
      if (this.signals) {
        delete this.signals;
      }
      // send sync step 1
      // const provider = room.provider
      // const doc = provider.doc
      const awareness = room.awareness
      // const encoder = encoding.createEncoder()
      // encoding.writeVarUint(encoder, messageSync)
      // syncProtocol.writeSyncStep1(encoder, doc)
      // sendWebrtcConn(this, encoder)
      const awarenessStates = awareness.getStates()
      if (awarenessStates.size > 0) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageAwareness)
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys())))
        sendWebrtcConn(this, encoder)
      }
    })
    this.peer.on('close', () => {
      this.connected = false
      this.closed = true
      if (room.webrtcConns.has(this.remotePeerId)) {
        room.webrtcConns.delete(this.remotePeerId)
        room.provider.emit('peers', [{
          removed: [this.remotePeerId],
          added: [],
          webrtcPeers: Array.from(room.webrtcConns.keys()),
          bcPeers: Array.from(room.bcConns)
        }])
      }
      checkIsSynced(room)
      this.peer.destroy()
      console.log(`closed connection to ${remotePeerId}: ${new Date().toUTCString()}` )
      log('closed connection to ', logging.BOLD, remotePeerId)
    })
    this.peer.on('error', err => {
      console.warn(`Error in connection to ${this.room.name}, remotePeerId=${remotePeerId}`, {
        err,
        time: new Date().toUTCString()
      });
    })
    this.peer.on('data', data => {
      const answer = readPeerMessage(this, data)
      if (answer !== null) {
        sendWebrtcConn(this, answer)
      }
    })

    const self = this;
    this.connectionTimeoutId = setTimeout(() => self.abort(), CONNECTION_TIMEOUT)
  }

  abort() {
    console.log(`connection to ${this.remotePeerId} aborted`, {signals: this.signals});
    delete this.connectionTimeoutId;

    this.handleUnresponsivePeer();
  }

  async handleUnresponsivePeer() {
    console.log('handleUnresponsivePeer', {peerId: this.remotePeerId, signals: this.signals})
    const signalingConn = this.room.provider.signalingConn;
    if (signalingConn) {
      const basePath = signalingConn.basePath;
      const announcePath = getAnnouncePath(basePath, this.remotePeerId);
      const db = getFirestore(signalingConn.firebaseApp);
      const announceRef = doc(db, announcePath);
    
      const list: Promise<any>[] = [
        deleteDoc(announceRef)
      ];

      const signals = this.signals;
      if (signals) {
        signals.forEach( msgId => {
          const signalPath = getSignalPath(basePath, this.remotePeerId, msgId);
          const signalRef = doc(db, signalPath);
          list.push(deleteDoc(signalRef));
        })
      }

      await Promise.all(list);
      this.destroy();
      this.room.webrtcConns.delete(this.remotePeerId);
    }
  }


  /**
   * Capture the id of a signal message added to Firestore. 
   * If a connection is not established within the time window, these messages will be removed.
   * 
   * @param signalId The id of the signal added to firestore
   */
  addSignal(signalId: string) {
    if (this.signals) {
      this.signals.push(signalId);
    }
  }

  destroy () {
    this.peer.destroy()
  }
}

interface IWebrtcConn {
  peer: SimplePeer.Instance;
  connected: boolean;
  remotePeerId: string;
  room: Room;
  closed: boolean;
  synced: boolean;

  destroy: () => void;
}

class WebrtcConn implements IWebrtcConn {
  peer: SimplePeer.Instance;
  connected: boolean;
  remotePeerId: string;
  room: Room;
  closed: boolean;
  synced: boolean;

  constructor (initiator: boolean, remotePeerId: string, room: Room) {
    log('establishing connection to ', logging.BOLD, remotePeerId)
    this.room = room
    this.remotePeerId = remotePeerId
    this.closed = false
    this.connected = false
    this.synced = false
    /**
     * @type {any}
     */
    this.peer = new SimplePeer({ initiator, ...room.provider.peerOpts })
    
    this.peer.on('connect', () => {
      log('connected to ', logging.BOLD, remotePeerId)
      this.connected = true
      // send sync step 1
      // const provider = room.provider
      // const doc = provider.doc
      const awareness = room.awareness
      // const encoder = encoding.createEncoder()
      // encoding.writeVarUint(encoder, messageSync)
      // syncProtocol.writeSyncStep1(encoder, doc)
      // sendWebrtcConn(this, encoder)
      const awarenessStates = awareness.getStates()
      if (awarenessStates.size > 0) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageAwareness)
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys())))
        sendWebrtcConn(this, encoder)
      }
    })
    this.peer.on('close', () => {
      this.connected = false
      this.closed = true
      if (room.webrtcConns.has(this.remotePeerId)) {
        room.webrtcConns.delete(this.remotePeerId)
        room.provider.emit('peers', [{
          removed: [this.remotePeerId],
          added: [],
          webrtcPeers: Array.from(room.webrtcConns.keys()),
          bcPeers: Array.from(room.bcConns)
        }])
      }
      checkIsSynced(room)
      this.peer.destroy()
      log('closed connection to ', logging.BOLD, remotePeerId)
    })
    this.peer.on('error', err => {
      log('Error in connection to ', logging.BOLD, remotePeerId, ': ', err)
    })
    this.peer.on('data', data => {
      const answer = readPeerMessage(this, data)
      if (answer !== null) {
        sendWebrtcConn(this, answer)
      }
    })
  }

  destroy () {
    this.peer.destroy()
  }
}

const broadcastBcMessage = (room: Room, m: Uint8Array) => cryptoutils.encrypt(m, room.key!).then(data =>
  room.mux(() =>
    bc.publish(room.name, data)
  )
)

const broadcastRoomMessage = (room: Room, m: Uint8Array) => {
  if (room.bcconnected) {
    broadcastBcMessage(room, m)
  }
  broadcastWebrtcConn(room, m)
}


const broadcastBcPeerId = (room: Room) => {
  if (room.provider.filterBcConns) {
    // broadcast peerId via broadcastchannel
    const encoderPeerIdBc = encoding.createEncoder()
    encoding.writeVarUint(encoderPeerIdBc, messageBcPeerId)
    encoding.writeUint8(encoderPeerIdBc, 1)
    encoding.writeVarString(encoderPeerIdBc, room.peerId)
    broadcastBcMessage(room, encoding.toUint8Array(encoderPeerIdBc))
  }
}

export interface AwarenessChanges {
  added: Array<any>;
  updated: Array<any>;
  removed: Array<any>;
}

export class Room {
  name: string;
  key: CryptoKey | null;
  provider: FirestoreWebrtcProvider;
  peerId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  synced: boolean;
  webrtcConns: Map<string, FirestoreWebrtcConn>;
  
  /** The set of ids for peers connected via the broadcast channel  */
  bcConns: Set<string>;
  mux: ReturnType<typeof createMutex>;
  bcconnected: boolean;
  _bcSubscriber: (data: ArrayBuffer) => any;
  // _docUpdateHandler: (update: Uint8Array, origin: any) => void;
  _awarenessUpdateHandler: (changes: AwarenessChanges, transactionOrigin?: any) => void;
  _beforeUnloadHandler: () => void;

  constructor (doc: Y.Doc, provider: FirestoreWebrtcProvider, name: string, key: CryptoKey | null) {
    /**
     * Do not assume that peerId is unique. This is only meant for sending signaling messages.
     *
     * @type {string}
     */
    this.peerId = random.uuidv4()
    this.doc = doc
    
    this.awareness = provider.awareness
    this.provider = provider
    this.synced = false
    this.name = name
    // @todo make key secret by scoping
    this.key = key
    this.webrtcConns = new Map()
    /**
     * @type {Set<string>}
     */
    this.bcConns = new Set<string>()
    this.mux = createMutex()
    this.bcconnected = false
    
    this._bcSubscriber = (data: ArrayBuffer) =>
      cryptoutils.decrypt(new Uint8Array(data), key!).then(m =>
        this.mux(() => {
          const reply = readMessage(this, m, () => {})
          if (reply) {
            broadcastBcMessage(this, encoding.toUint8Array(reply))
          }
        })
      )
    /**
     * Listens to Yjs updates and sends them to remote peers
     */
    // this._docUpdateHandler = (update: Uint8Array, origin: any) => {
    //   const encoder = encoding.createEncoder()
    //   encoding.writeVarUint(encoder, messageSync)
    //   syncProtocol.writeUpdate(encoder, update)
    //   broadcastRoomMessage(this, encoding.toUint8Array(encoder))
    // }
    /**
     * Listens to Awareness updates and sends them to remote peers
     */
    this._awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated).concat(removed)
      const encoderAwareness = encoding.createEncoder()
      encoding.writeVarUint(encoderAwareness, messageAwareness)
      encoding.writeVarUint8Array(encoderAwareness, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
      broadcastRoomMessage(this, encoding.toUint8Array(encoderAwareness))
    }

    this._beforeUnloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], 'window unload')
      rooms.forEach(room => {
        room.disconnect()
      })
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this._beforeUnloadHandler)
    } else if (typeof process !== 'undefined') {
      process.on('exit', this._beforeUnloadHandler)
    }
  }

  connect () {
    // this.doc.on('update', this._docUpdateHandler)
    this.awareness.on('update', this._awarenessUpdateHandler)
    const signalingConn = this.provider.signalingConn;
    if (signalingConn) {
      signalingConn.publishAnnounce();
    }
    // signal through all available signaling connections
    const roomName = this.name
    bc.subscribe(roomName, this._bcSubscriber)
    this.bcconnected = true
    // broadcast peerId via broadcastchannel
    broadcastBcPeerId(this)
    // write sync step 1
    // const encoderSync = encoding.createEncoder()
    // encoding.writeVarUint(encoderSync, messageSync)
    // syncProtocol.writeSyncStep1(encoderSync, this.doc)
    // broadcastBcMessage(this, encoding.toUint8Array(encoderSync))
    // broadcast local state
    // const encoderState = encoding.createEncoder()
    // encoding.writeVarUint(encoderState, messageSync)
    // syncProtocol.writeSyncStep2(encoderState, this.doc)
    // broadcastBcMessage(this, encoding.toUint8Array(encoderState))
    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness)
    broadcastBcMessage(this, encoding.toUint8Array(encoderAwarenessQuery))
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessState, messageAwareness)
    encoding.writeVarUint8Array(encoderAwarenessState, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
    broadcastBcMessage(this, encoding.toUint8Array(encoderAwarenessState))
  }

  disconnect () {
    // signal through all available signaling connections
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'disconnect');
    
    const signalingConn = this.provider.signalingConn;
    if (signalingConn) {
      signalingConn.deleteAnnounceDoc();
    }

    // broadcast peerId removal via broadcastchannel
    const encoderPeerIdBc = encoding.createEncoder()
    encoding.writeVarUint(encoderPeerIdBc, messageBcPeerId)
    encoding.writeUint8(encoderPeerIdBc, 0) // remove peerId from other bc peers
    encoding.writeVarString(encoderPeerIdBc, this.peerId)
    broadcastBcMessage(this, encoding.toUint8Array(encoderPeerIdBc))

    bc.unsubscribe(this.name, this._bcSubscriber)
    this.bcconnected = false
    this.awareness.off('update', this._awarenessUpdateHandler)
    this.webrtcConns.forEach(conn => conn.destroy())
    this.webrtcConns = new Map<string, FirestoreWebrtcConn>();
  }

  destroy () {
    this.disconnect()
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler)
    } else if (typeof process !== 'undefined') {
      process.off('exit', this._beforeUnloadHandler)
    }
    
  }
}

const openRoom = (doc: Y.Doc, provider: FirestoreWebrtcProvider, name: string, key: CryptoKey|null) => {
  // there must only be one room
  if (rooms.has(name)) {
    throw error.create(`A Yjs Doc connected to room "${name}" already exists!`)
  }
  const room = new Room(doc, provider, name, key)
  rooms.set(name, /** @type {Room} */ (room))
  return room
}



/**
 * @typedef {Object} ProviderOptions
 * @property {Array<string>} [signaling]
 * @property {string} [password]
 * @property {awarenessProtocol.Awareness} [awareness]
 * @property {number} [maxConns]
 * @property {boolean} [filterBcConns]
 * @property {any} [peerOpts]
 */

/**
 * @extends Observable<string>
 */
export class FirestoreWebrtcProvider extends Observable<any> {
  doc: Y.Doc;

  /* The name of the room. This is the `basePath` of the Yjs `FirestoreProvider` */
  roomName: string;
  room: Room | null;
  filterBcConns: boolean;
  awareness: awarenessProtocol.Awareness;
  signalingConn: FirestoreSignalingConn | null;
  maxConns: number;
  peerOpts: any;
  key: Promise<CryptoKey | null>;
  private handleOnline: (() => void) | null = null;


  constructor (
    firebaseApp: FirebaseApp,
    roomName: string,
    doc: Y.Doc,
    {
      password = null,
      awareness = new awarenessProtocol.Awareness(doc),
      maxConns = 20 + math.floor(random.rand() * 15), // the random factor reduces the chance that n clients form a cluster
      filterBcConns = true,
      peerOpts = {} // simple-peer options. See https://github.com/feross/simple-peer#peer--new-peeropts
    } = {}
  ) {
    super()
    this.roomName = roomName
    this.doc = doc
    this.filterBcConns = filterBcConns
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = awareness
    this.signalingConn = null;
    this.maxConns = maxConns
    this.peerOpts = peerOpts
    
    this.key = password ? cryptoutils.deriveKey(password, roomName) : Promise.resolve(null)
    /**
     * @type {Room|null}
     */
    this.room = null
    this.key.then(key => {
      this.room = openRoom(doc, this, roomName, key);      
      this.signalingConn = new FirestoreSignalingConn(firebaseApp, roomName, this.room);
      this.room.connect();
    })
    
    this.handleOnline = () => {
      console.log("online", new Date().toUTCString());
      if (this.signalingConn) {
        this.signalingConn.publishAnnounce();
      }
    }
    window.addEventListener("online", this.handleOnline);
    
    this.destroy = this.destroy.bind(this)
    doc.on('destroy', this.destroy)
  }

  /**
   * @type {boolean}
   */
  get connected () {
    return this.room !== null;
  }

  destroy () {
    this.doc.off('destroy', this.destroy)
    // need to wait for key before deleting room
    this.key.then(() => {
      if (this.room) {
        this.room.destroy()
      }
      rooms.delete(this.roomName)
    })
    if (this.signalingConn) {
      this.signalingConn.destroy();
      this.signalingConn = null;
    }
    if (this.handleOnline) {
        window.removeEventListener("online", this.handleOnline);
        this.handleOnline = null;
    
    }
    super.destroy()
  }
}

/*-----------------------------------------------------------*/
const ANNOUNCE_PATH = "/yjs/aware/announce/";
const AWARE_TTL = 24*60*60*1000; // 24 hours
const ANNOUNCE_INTERVAL = 23*60*60*1000; // 23 hours

interface AnnounceData {
  from: string;
  createdAt: Timestamp;
}

export class FirestoreSignalingConn {
    readonly basePath: string;
    readonly firebaseApp: FirebaseApp;
    private announceCreatedAt: number = 0;
    private announceUnsubscribe: Unsubscribe | null;
    private signalUnsubscribe: Unsubscribe | null;
    private announceIntervalToken: ReturnType<typeof setInterval> | null = null;
    private room: Room;


    constructor(firebaseApp: FirebaseApp, basePath: string, room: Room) {
        this.firebaseApp = firebaseApp;
        this.basePath = basePath;
        this.room = room;

        this.announceUnsubscribe = null;
        this.signalUnsubscribe = this.subscribeSignal();
        
    }

    destroy() {
      this.deleteAnnounceDoc();
      if (this.announceUnsubscribe) {
        this.announceUnsubscribe();
        this.announceUnsubscribe = null;
      }
      if (this.signalUnsubscribe) {
        this.signalUnsubscribe();
        this.signalUnsubscribe = null;
      }
      if (this.announceIntervalToken) {
        clearInterval(this.announceIntervalToken);
        this.announceIntervalToken = null;
      }
    }



    async publishSignal(to: string, signal: any) {
      const msgId = random.uuidv4();
      const path = getSignalPath(this.basePath, to, msgId);

      const conn = this.room.webrtcConns.get(to);
      if (conn) {
        conn.addSignal(msgId);
      }

      const payload = {
        to,
        from: this.room.peerId,
        signal
      }
      await this.save(path, payload)
    }

    /**
     * Create a listener for the room's `announce` messages.
     * @returns The `Unsubscribe` function for the listener
     */
    private subscribeAnnounce() {
      const path = this.basePath + ANNOUNCE_PATH;
      const db = getFirestore(this.firebaseApp);
      const ref = collection(db, path);
      const q = query(ref);

      const room = this.room;

      return onSnapshot(q, snapshot => {

        const queue: AnnounceData[] = [];
        snapshot.docChanges().forEach(async change => {
          const envelope = change.doc.data();
          const payload = envelope.payload;
          const data = await this.decrypt(payload) as AnnounceData;

          switch (change.type) {
            case 'modified' :
              // falls through

            case 'added': {
    
              if (data.from !== room.peerId) {
                
                const webrtcConns = room.webrtcConns;
                if (
                  webrtcConns.size < room.provider.maxConns && 
                  !webrtcConns.has(data.from)
                ) {
                  const remoteCreatedAt = data.createdAt as Timestamp | null;
                  if (remoteCreatedAt) {
                    const remoteMillis = remoteCreatedAt.toMillis();
                    const initiator = this.announceCreatedAt > remoteMillis;
                    webrtcConns.set(data.from, new FirestoreWebrtcConn(this, initiator, data.from, room))
                  }
                }
              }
              break;
            }
            case 'removed':
              if (data.from === room.peerId) {
                // Another peer must have determined that the current peer is offline.  Perhaps the
                // current peer really was offline temporarily, but clearly it is back online so
                // recreate the `announce` document.
                this.publishAnnounce();
              }
              break;
          }
          
          
        }) 
        
        if (!this.announceCreatedAt) {
          console.warn("Ignoring remote announce documents because the local `announceCreatedAt` time is not defined.");
        } else {
          const webrtcConns = room.webrtcConns;
          for (const data of queue) {
            if (
              webrtcConns.size < room.provider.maxConns && 
              !webrtcConns.has(data.from)
            ) {
              const remoteCreatedAt = data.createdAt as Timestamp;
              const remoteMillis = remoteCreatedAt.toMillis();
              const initiator = this.announceCreatedAt > remoteMillis;
              webrtcConns.set(data.from, new FirestoreWebrtcConn(this, initiator, data.from, room))
            }
          }
        }
      })

    }

    subscribeSignal() {
      const peerId = this.room.peerId;
      const path = `${this.basePath}/yjs/aware/signal/${peerId}/sig_messages/`;
      const db = getFirestore(this.firebaseApp);
      const ref = collection(db, path);
      const q = query(ref);

      return onSnapshot(q, snapshot => {
        snapshot.docChanges().forEach( async change => {
          switch (change.type) {
            case 'added':
            case 'modified': {
              const document = change.doc;
              const envelope= document.data();
              const payload = envelope.payload;
              const data = await this.decrypt(payload);
              if (data) {
                const room = this.room;
                const webrtcConns = room.webrtcConns;
                map.setIfUndefined(
                  webrtcConns, 
                  data.from, 
                  () => new FirestoreWebrtcConn(this, false, data.from, room)
                ).peer.signal(data.signal);
                await deleteDoc(document.ref);
              }
              break;
    
            }

          }
        })
      })
    }

    private async decrypt(payload: any) {
      const key = this.room.key;
      return (
        key && (typeof payload==='string') ? 
          await cryptoutils.decryptJson(buffer.fromBase64(payload), key) :
          !key ? payload : null
      )
    }

    async publishAnnounce() {

      if (this.announceIntervalToken) {
        clearInterval(this.announceIntervalToken);
        this.announceIntervalToken = null;
      }

      const room = this.room;
      const data = { from: room.peerId, createdAt: serverTimestamp() }

      const announcePath = this.getAnnouncePath();
      const announceRef = await this.save(announcePath, data);
      if (announceRef) {

        const self = this;
        this.announceIntervalToken = setInterval(() => {
          // Update the `expiresAt` timestamp
          self.save(announcePath, data);
        }, ANNOUNCE_INTERVAL);

        const announceDoc = await getDoc(announceRef);
        if (announceDoc.exists()) {
          const announceData = announceDoc.data();
          const payload = await this.decrypt(announceData.payload) as AnnounceData;
          this.announceCreatedAt = payload.createdAt.toMillis();
          this.announceUnsubscribe = this.subscribeAnnounce();
        } else {
          console.warn("Cannot listen to announce snapshots because local announce document not found", {announcePath})
        }
      }
    }

    getAnnouncePath() {
      return getAnnouncePath(this.basePath, this.room.peerId);
    }

    async deleteAnnounceDoc() {
      const announcePath = this.getAnnouncePath();
      const db = getFirestore(this.firebaseApp);
      const ref = doc(db, announcePath);
      await deleteDoc(ref);
    }

    private async encodeData(data: any) {
      const key = this.room.key;
      return key ? 
        cryptoutils.encryptJson(data, key).then( value => buffer.toBase64(value)):
        data;
    }

    private async save(path: string, data: any) {

      try {
        const timePath = getTimePath(this.basePath);
        const now = await currentTime(this.firebaseApp, timePath);
        const expiresAt = Timestamp.fromMillis(now + AWARE_TTL);
        const payload = await this.encodeData(data);
        const envelope = {
          expiresAt,
          payload
        }
        const db = getFirestore(this.firebaseApp);
        const ref = doc(db, path);
        await setDoc(ref, envelope);
        return ref;
      } catch (error) {
        console.warn("Failed to save awareness data", {path, error, data})
      }
    }
}