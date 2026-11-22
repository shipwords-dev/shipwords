import { memoryStore } from '../src/store';

/** Shared by everything in one test file. */
export const bucket = memoryStore();

export { memoryStore as memoryBucket };
