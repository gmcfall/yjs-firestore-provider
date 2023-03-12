import { FirebaseApp } from "@firebase/app";
import { deleteDoc, doc, getDoc, getFirestore, serverTimestamp, setDoc, Timestamp } from "@firebase/firestore";

/** 
 * An estimate for the difference in milliseconds between the local clock 
 * and the server's clock 
 */
let delta: number | null = null;

/**
 * Get an approximation of the current server time.
 * @param firebaseApp The FirebaseApp
 * @param path The path to a document that can be used to get the server time
 * @returns An approximation of the current server time
 */
export async function currentTime(firebaseApp: FirebaseApp, path: string) {
    if (delta !== null) {
        return Date.now() + delta;
    }
    try {
        const db = getFirestore(firebaseApp);
        const ref = doc(db, path);
        const before = Date.now();
        await setDoc(ref, {now: serverTimestamp()});
        const after = Date.now();
        const avg = Math.floor((before + after)/2);
        const nowDoc = await getDoc(ref);
        if (nowDoc.exists()) {
            const serverNow = nowDoc.data().now as Timestamp;
            const serverUnixTime = serverNow.seconds*1000 + 
                Math.floor(serverNow.nanoseconds/1000000);
    
            delta = serverUnixTime - avg;
            await deleteDoc(ref);
            return Date.now() + delta;
        }
    } catch (error) {
        console.log("An error occurred while getting the current time", {error, path})
    }


    // In theory we should never get here, but just in case, fallback
    // to the client time.
    return Date.now();
}

/**
 * Convert a Firestore Timestamp into the number of milliseconds since the
 * Unix epoch in UTC time.
 * @param timestamp A Firestore Timestamp
 * @returns The number of milliseconds since the Unix epoch
 */
export function timeSinceEpoch(timestamp: Timestamp) {
    return  timestamp.seconds*1000 + Math.floor(timestamp.nanoseconds/1000000);
}