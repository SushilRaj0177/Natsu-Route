import { createReadStream } from 'node:fs';
import StreamArray from 'stream-json/streamers/StreamArray.js';

/**
 * Stream the records of a JSON array file one at a time. ODPT dumps reach
 * ~140 MB; parsing them whole needs over a gigabyte of heap, which small
 * build machines do not have.
 */
export async function* readArray<T>(path: string): AsyncGenerator<T> {
  const stream = createReadStream(path).pipe(StreamArray.withParser());
  for await (const item of stream as AsyncIterable<{ value: T }>) yield item.value;
}
