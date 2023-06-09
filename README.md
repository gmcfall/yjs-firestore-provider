# yjs-firestore-provider

A Yjs Connection and Database Provider backed by Google Firestore.

# Installation
The `yjs-firestore-provider` library has peer dependencies on `yjs` and `firebase`.

Make sure you have installed these dependencies in your project:
```
npm install yjs firebase
```

If you plan to enable [awareness](#awareness), you must also install two additional dependencies:
```
npm install simple-peer y-protocols
```

Some [editor bindings](https://docs.yjs.dev/ecosystem/editor-bindings), including 
[y-prosemirror](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror),
[TipTap](https://docs.yjs.dev/ecosystem/editor-bindings/tiptap2) and
[y-quill](https://docs.yjs.dev/ecosystem/editor-bindings/quill), have an explicit
dependency on the `y-protocols` module. If you are using one of these bindings, you don't
need to install `y-protocols` separately.

Once you have installed all the dependencies, you can install the `yjs-firestore-provider` library:
```
npm install @gmcfall/yjs-firestore-provider
```

# Usage
The following example shows how to use the *Yjs Firestore Provider* with a 
[Tiptap](https://tiptap.dev/) rich text editor.  Usage with other Yjs 
[editor bindings](https://docs.yjs.dev/ecosystem/editor-bindings) is similar.

This example assumes that the app allows users to edit articles stored in Firestore
under a collection named "articles".

```javascript
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import { FirestoreProvider, getColor } from '@gmcfall/yjs-firestore-provider'

// The app must provide a unique identifier for each article.
const articleId = getArticleIdSomehow();

// To create a FirebaseProvider, you must have a FirebaseApp
const firebaseApp = getFirebaseAppSomehow();

// Get the name or alias for the user if using Awareness
const userName = getUserNameOrAliasSomehow();

const ydoc = new Y.Doc();
const basePath = ["articles", articleId];
const provider = new FirestoreProvider(firebaseApp, ydoc, basePath);

const editor = new Editor({
  extensions: [
    StarterKit.configure({
      // The Collaboration extension comes with its own history handling
      history: false,
    }),
    // Register the document with Tiptap
    Collaboration.configure({
      document: provider.doc,
    })
    // Register the collaboration cursor extension
    CollaborationCursor.configure({
        provider,
        user: {
            name: userName,
            color: getColor(userName)
        }
    })
  ],
})
```
## Firestore paths
The example above uses a base path given by
```javascript
const basePath = ["articles", articleId];
```
where "articles" is the name of a Firestore collection and
`articleId` is the id for a Firestore document within the collection.

That Firestore document might store metadata about the article. Or it might contain
sharing options. Or there might not be any Firestore document at that path at all. 
The *Yjs Firestore Provider* does not care whether there is a document at the given
base path, and it never tries to read or modify that document. It stores all of the
Yjs data under a nested collection at
```
    /articles/{articleId}/yjs
```

See [How it works](#how-it-works) for details about the data stored under the `yjs`
collection.

The *Yjs Firestore Provider* does not care how long the base path might be.
Consider a learning application that hosts flashcards collected within decks.  
The application might store metadata for a given flashard at a path of the form:
```javascript
const basePath = ["decks", deckId, "cards", cardId];
```
In this case, the Yjs data for a given card would be stored under a collection at
```
    /decks/{deckId}/cards/{cardId}/yjs
```

## Awareness

[Awareness and presence](https://docs.yjs.dev/getting-started/adding-awareness)
is often implemented by displaying the cursor and text selection of each user
in a different color. 

As we saw in the [Usage](#usage) section, the TipTap editor enables awareness via the 
`CollaborationCursor` extension:
```javascript
CollaborationCursor.configure({
    provider,
    user: {
        name: userName,
        color: getColor(userName)
    }
})
```

Other editors will expose a different API to enable awareness.

The `getColor` function returns one of 20 visually distinct colors
from a [list published by Sasha Trubestskoy](https://sashamaps.net/docs/resources/20-colors/).
It always returns the same hex color for a given `userName`.

The `getColor` function is provided for convenience. You are certainly free to use a different method
to assign a color to the user.

When awareness is enabled, `FirestoreProvider` persists transient documents in collections at the
following paths:
```
    {basePath}/yjs/aware/announce/
    {basePath}/yjs/aware/signal/${to}/sig_messages/
```

`FirestoreProvider` makes a best effort to remove these transient documents when they are no longer
needed. However, there are some cases (typically on mobile devices) where `FirestoreProvider` 
is unable to remove obsolete documents because the `beforeunload` event never fires. To ensure that
obsolete documents are eventually deleted, you should create 
[data retention policies](https://firebase.google.com/docs/firestore/ttl) for the `announce`
and `sig_messages` collection groups by following the steps listed below:

1. Go to the [Cloud Firestore Time-to-live](https://console.cloud.google.com/firestore/ttl) page
   in the Google Cloud Platform Console.
2. Click **Create Policy**
3. Enter "announce" for the collection group name, and "expiresAt" for the timestamp field name.
4. Click **Create**
5. Click **Create Policy** again.
6. Enter "sig_messages" for the collection group name, and "expiresAt" for the timestamp field name.
7. Click **Create**

If you are NOT using awareness, you should disable it in the `FirestoreProvider` by 
passing a configuration object to the constructor...
```javascript
new FirestoreProvider(firebaseApp, ydoc, basePath, {disableAwareness: true});
```

## Deleting Yjs data
The `FirestoreProvider` stores data under the `yjs` collection to support collaborative 
editing of documents.  If you permanently delete a given document such as an article or
flashcard in the above examples, you must also delete the associated Yjs data.

Assuming `provider` is a `FirestoreProvider`, you can use the following line of code
to delete the Yjs data:
```javascript
    provider.deleteYjsData();
```

Alternatively, you can use the following snippet:
```javascript
import { deleteYjsData } from '@gmcfall/yjs-firestore-provider'

const firebaseApp = getFirebaseAppSomehow();
const articleId = getArticleIdSomehow();
const basePath = ["articles", articleId];

deleteYjsData(firebaseApp, basePath);
```

## Security Rules
Your application must define 
[security rules](https://firebase.google.com/docs/firestore/security/get-started) 
for the Yjs data.

For instance, early in the development lifecycle, the app might define lax security rules
of the form:
```
match /articles/{articleId}/yjs/{document=**} {
    allow read, write: if true;
}
match /decks/{deckId}/cards/{cardId}/yjs/{document=**} {
    allow read, write: if true;
}
```
These rules are probably not appropriate for use in production.
The application should define whatever security rules are appropriate.


# How it works
This section explains how the *Yjs Firestore Provider* works in gory detail.
You don't need to read this section if you plan to use the default configuration, 
but it is helpful if you want to use a custom configuration.

## Key Concepts
1. Each client creates a `FirestoreProvider` for a given Yjs document as illustrated in the
  [Usage](#usage) section.
2. The `FirestoreProvider` subscribes to update events published by the Yjs document.
3. When the `FirestoreProvider` receives an update event, it does NOT persist the event to
   Firestore immediately. Instead, if the user makes a series of changes in rapid succession,
   those update events are merged into a composite blob and cached temporarily.
4. The composite blob is persisted when one of the following conditions is satisifed:
    - The number of changes reaches a threshold, set to 20 by default.
    - The user pauses and makes no more changes for a certain duration, set to 600 ms by default.
5. The `FirestoreProvider` use a Firestore listener to receive blobs persisted by other clients
   in near real-time.
6. When the `FirestoreProvider` receives a blob from another client, it updates the local
   Yjs document.
7. Periodically, the `FirestoreProvider` removes individual blobs from Firestore and
   merges them into a consolidated history that contains all the changes accumulated up to a given
   point in time. That history is stored in Firestore, and it grows over the lifetime of the 
   Yjs document.
8. When awareness is enabled, `FirestoreProvider` persists a Firestore document announcing the presence
   of the current user, and it invokes a listener to receive notifications about other users that have 
   announced their presence. The document announcing the presence of the current user is deleted from
   Firestore when the `FirestoreProvider` is destroyed, or when the browser window unloads.
9. When `FirestoreProvider` is notified about the presence of another user editing the same Yjs
   document, it establishes a [WebRTC](https://webrtc.org/) connection to a peer associated with that
   user. Signaling is accomplished by writing and reading documents in certain Firebase collections.  
   Once a connection is established, all Awareness state changes are transmitted via the WebRTC connection
   (not Firestore). Signaling messages are deleted from Firestore as soon as they are read.

The `FirestoreProvider` manages data at the following paths in Firestore:

- `{basePath}/yjs/history` : The consolidated history
- `{basePath}/yjs/history/updates/{blobId}`: A composite blob of update events
- `{basePath}/yjs/time`: A transient document used to compute the differece between time
    on the Firestore server and time on the client. For details, see 
    [How does FirebaseProvider know when a blob has exceeded its time-to-live?](#how-does-firestoreprovider-know-when-a-blob-has-exceeded-its-time-to-live)
- `{basePath}/yjs/aware/announce/{peerId}`: A transient document announcing the presence of a given user.
- `{basePath}/yjs/aware/signal/{to}/sig_messages/{msg_id}`: A transient signaling message sent to a particular peer.

## Frequently asked questions

### Why merge update events into a composite blob?
Google charges for each write operation. By merging update events into a composite
blob, the number of writes is reduced, and hence the operational costs are reduced.

### Don't composite blobs increase latency?
Yes. Because update events are merged into a blob and cached temporarily, other clients won't 
see those update events until the blob is written to Firestore. You can tune the latency
with the following configuration parameters:

- `maxUpdatesPerBlob`: The maximum number of update events allowed in a blob, set to 20 by default.
    You can decrease latency by setting this parameter to a lower value. Setting it to 1 will 
    cause the `FirestoreProvider` to emit every single update event immediately, at the penalty of
    increased cost due to more frequent writes.
- `maxUpdatePause`: The maximum amount of time in milliseconds that the user may pause in making 
    changes before a blob is emitted, set to 600 ms by default.  Setting this parameter to a smaller 
    value will reduce latency, but again, at the penalty of increased cost due to more frequent writes.
    Setting it to a higher value will increase latency and reduce cost.

### Where are composite blobs stored?
The `FirebaseProvider` writes each composite blob to Firestore at a path of the form
```
{basePath}/yjs/history/updates/{blobId}
```

Thus, for the examples from the [Usage](#usage) section, we would have:
```
/articles/{articleId}/yjs/history/updates/{blobId}
/decks/{deckId}/cards/{cardId}/yjs/history/updates/{blobId}
```

### Why merge blobs into a consolidated history?

The [Key Concepts](#key-concepts) section included the following observation:

> Periodically, the `FirestoreProvider` removes individual blobs from Firestore and
> merges them into a consolidated history that contains all the changes accumulated up to a given
> point in time. That history is stored in Firestore, and it grows over the lifetime of the 
> Yjs document.

This design helps to reduce operational costs, and it simplifies the overall solution.

When a `FirestoreProvider` is created, it must load the entire set of updates to the Yjs document.
It is more efficient to read a single, consolidated history plus a small number of recent update blobs 
than to read hundreds or even thousands of individual blobs.

By reducing the number of read operations, the overall cost of the solution is reduced.
Moreover, the number of bytes in a consolidated history is smaller than the sum of bytes 
in the individual blobs, so there are cost savings here as well.

### How long do individual blobs live in Firestore?
The lifetime of a blob in Firestore is controlled by the `blobTimeToLive` configuration parameter
which is set to 10 seconds by default.

### How does FirestoreProvider know when a blob has exceeded its time-to-live?
Each blob is stored in a Firestore document that includes a timestamp which records the date/time
when the blob was written to Firestore.

The FirestoreProvider uses a listener to watch all blob documents in Firestore. It maintains
an in-memory cache of those blob documents, and hence it can inspect the timestamps. The Firestore
provider compares the timestamp with the current time to determine if a given blob has exceeded its
time-to-live.

Each timestamp records the UTC time according to the Firestore server which has a guarantee on the
accuracy of its clock. But there is no guarantee that the clock on the local client is accurate.

Consequently, FirestoreProvider estimates the difference between the local clock and the server's
clock by executing a block of code like this snippet:

```javascript
const db = getFirestore(firebaseApp);
const timePath = basePath + "/yjs/time";
const timeRef = doc(db, timePath);

// Create a transient Firestore document that holds the current server time.
// Capture timestamps before and after the write operation, according to
// the client's local clock.

const before = Date.now();
await setDoc(timeRef, {now: serverTimestamp()});
const after = Date.now();

// Compute an estimate for the local time when the document was created in 
// Firestore. This is given by the midpoint between the `before` and `after` 
// timestamps.

const clientTime = Math.floor((before + after)/2);

// Get the server timestamp from the document that we just saved to Firestore.

const timeDoc = await getDoc(timeRef);
if (timeDoc.exists()) {
    // Compute the difference between the server and client time
    const serverNow = timeDoc.data().now as Timestamp;
    const serverTime = serverNow.seconds*1000 + 
        Math.floor(serverNow.nanoseconds/1000000);

    timeDelta = serverTime - clientTime;
}

// Cleanup by deleting the transient Firestore document.
await deleteDoc(timeRef);
```

In this snippet, `basePath` is the path passed to the `FirestoreProvider` constructor.
For example, the transient "time" document might be created at
```
/articles/{articleId}/yjs/time
```

The code snippet above runs only once during the lifetime of the application, no matter how many
`FirebaseProvider` instances are created. The `timeDelta` parameter is stored in a module variable
and made available to all `FirebaseProvider` instances.

### Where is the consolidated history for a given Yjs document stored?
The consolidated history for a given Yjs document is stored at a path of the form:
```
{basePath}/yjs/history
```

Thus, for the examples from the [Usage](#usage) section, we would have:
```
/articles/{articleId}/yjs/history
/decks/{deckId}/cards/{cardId}/yjs/history
```

# Custom Configuration
The `FirestoreProvider` constructor takes an optional configuration object with one or more of the
following parameters:

- `maxUpdatesPerBlob`: The maximum number of update events allowed in a blob, set to 20 by default.
    You can decrease latency by setting this parameter to a lower value. Setting it to 1 will 
    cause the `FirestoreProvider` to emit every single update event immediately, at the penalty of
    increased cost due to more frequent writes.
- `maxUpdatePause`: The maximum amount of time in milliseconds that the user may pause in making 
    changes before a blob is emitted, set to 600 ms by default.  Setting this parameter to a smaller 
    value will reduce latency, but again, at the penalty of increased cost due to more frequent writes.
    Setting it to a higher value will increase latency and reduce cost. For comparison, the average person
    types at the rate of one character every 300 ms.
- `blobTimeToLive`: The maximum amount of time in milliseconds that a blob of updates can live in Firestore
    before it is removed and merged into the consolidated history. By default, this parameter is set to
    10000 (i.e. 10 seconds).  As a best practice, applications should stick with this default.
- `disableAwareness`: A flag used to disable the Awareness feature, set to `false` by default.

Thus, one may create a `FirestoreProvider` with a custom configuration like this:
```javascript
const ydoc = new Y.Doc();
const basePath = ["articles", articleId];
const provider = new FirestoreProvider(firebaseApp, ydoc, basePath, {
    maxUpdatesPerBlob: 10,
    maxUpdatePause: 500,
    disableAwareness: true
});
```

# Licensing and Attribution

This module uses a customized version of the [y-webrtc](https://github.com/yjs/y-webrtc) 
library published by Kevin Jahns.

This module is licensed under the [MIT License](https://en.wikipedia.org/wiki/MIT_License). 
You are generally free to reuse or extend upon this code as you see fit. Just include copies of
- The [yjs-firestore-provider license](LICENSE)
- The [y-webrtc license](licenses/y-webrtc/LICENSE)
