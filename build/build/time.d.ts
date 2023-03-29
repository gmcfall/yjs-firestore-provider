import { FirebaseApp } from "@firebase/app";
import { Timestamp } from "@firebase/firestore";
/**
 * Get an approximation of the current server time.
 * @param firebaseApp The FirebaseApp
 * @param path The path to a document that can be used to get the server time
 * @returns An approximation of the current server time
 */
export declare function currentTime(firebaseApp: FirebaseApp, path: string): Promise<number>;
/**
 * Convert a Firestore Timestamp into the number of milliseconds since the
 * Unix epoch in UTC time.
 * @param timestamp A Firestore Timestamp
 * @returns The number of milliseconds since the Unix epoch
 */
export declare function timeSinceEpoch(timestamp: Timestamp): number;
