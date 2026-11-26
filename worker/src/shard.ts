/**
 * Which replica owns a user's WhatsApp socket.
 *
 * `numReplicas: 1` was a hard ceiling: every customer's socket lived in one
 * Node process, because two workers both holding a socket for the same login
 * would knock each other offline — WhatsApp treats a second connection from
 * the same credentials as a replacement. Sharding lifts the ceiling by making
 * ownership explicit instead of accidental.
 *
 * The rules this has to satisfy are narrow and worth stating:
 *
 *   - every user is owned by exactly one replica, for any count
 *   - the answer depends only on the user id and the count, so two replicas
 *     reach it independently and always agree
 *   - it is stable across deploys and across versions of this file, so a
 *     rolling restart does not reshuffle who owns what
 *
 * A hash of the id satisfies all three. `Math.random`, the row's position in a
 * query, or anything involving the clock would satisfy none of them.
 */

import { createHash } from 'node:crypto';

export interface Shard {
  /** 0-based position of this replica. */
  index: number;
  /** How many replicas are running. 1 means this process owns everybody. */
  count: number;
}

export const SINGLE: Shard = { index: 0, count: 1 };

/**
 * A stable number for a user id.
 *
 * SHA-1 rather than a hand-rolled string hash: it is not a security boundary,
 * but it is a *compatibility* boundary. The distribution has to stay identical
 * across Node versions and across any future edit to this file, because
 * changing it moves every session to a different replica at once — so using
 * something standard and specified matters more than using something fast.
 */
export function hashUser(userId: string): number {
  return createHash('sha1').update(userId).digest().readUInt32BE(0);
}

/** True when this replica is the one responsible for the user. */
export function owns(shard: Shard, userId: string): boolean {
  if (shard.count <= 1) return true;
  return hashUser(userId) % shard.count === shard.index;
}

/**
 * Check a configured shard before the worker acts on it.
 *
 * A misconfiguration here is the one that causes the damage sharding exists to
 * prevent. REPLICA_COUNT lower than the number of running replicas means two
 * processes own the same users and fight over every socket; an index at or
 * above the count means a replica owns nobody and those customers silently
 * stop being served. Both fail the boot instead.
 */
export function assertShard(shard: Shard): Shard {
  if (!Number.isInteger(shard.count) || shard.count < 1) {
    throw new Error('REPLICA_COUNT must be a whole number of 1 or more');
  }
  if (!Number.isInteger(shard.index) || shard.index < 0) {
    throw new Error('REPLICA_INDEX must be a whole number of 0 or more');
  }
  if (shard.index >= shard.count) {
    throw new Error(
      `REPLICA_INDEX ${shard.index} is not valid with REPLICA_COUNT ${shard.count}: ` +
        `the index is 0-based, so the last replica is ${shard.count - 1}. ` +
        'A replica outside the range would own no customers at all.',
    );
  }
  return shard;
}

export const describeShard = (shard: Shard): string =>
  shard.count <= 1 ? 'single worker, owns every session' : `replica ${shard.index} of ${shard.count}`;
