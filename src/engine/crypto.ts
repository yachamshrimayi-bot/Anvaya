import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// noble-ed25519 needs a synchronous SHA-512 for sign/verify (RFC 8032).
ed.hashes.sha512 = sha512;

const enc = new TextEncoder();

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * A node identity (robot or WMS access point). Keys are derived deterministically
 * from (fleet seed, node id) so every run is reproducible; in production they would
 * be provisioned into a secure element at commissioning time.
 */
export class Identity {
  readonly id: number;
  readonly name: string;
  private readonly sk: Uint8Array;
  readonly pk: Uint8Array;
  readonly pkHex: string;

  constructor(id: number, name: string, fleetSeed: number | string) {
    this.id = id;
    this.name = name;
    this.sk = sha512(enc.encode(`anvaya/${fleetSeed}/${name}`)).slice(0, 32);
    this.pk = ed.getPublicKey(this.sk);
    this.pkHex = toHex(this.pk);
  }

  sign(bytes: Uint8Array): Uint8Array {
    return ed.sign(bytes, this.sk);
  }
}

/** Public-key registry enrolled at commissioning. Every robot holds a copy. */
export class Registry {
  private keys = new Map<number, Uint8Array>();
  enroll(id: number, pk: Uint8Array): void {
    this.keys.set(id, pk);
  }
  get(id: number): Uint8Array | undefined {
    return this.keys.get(id);
  }
}

// Verification is a pure function of (public key, bytes, signature). In the twin,
// N robots receive the *same* broadcast, so identical triples are memoised to run
// the whole fleet on one laptop CPU. Any tampered byte produces a new key and is
// verified from scratch.
const verifyMemo = new Map<string, boolean>();
export const cryptoStats = { signs: 0, verifies: 0, memoHits: 0 };

export function verifySig(pk: Uint8Array, text: string, sig: Uint8Array): boolean {
  const key = `${toHex(sig)}|${toHex(pk).slice(0, 16)}|${text}`;
  const m = verifyMemo.get(key);
  if (m !== undefined) {
    cryptoStats.memoHits++;
    return m;
  }
  cryptoStats.verifies++;
  let ok = false;
  try {
    ok = ed.verify(sig, enc.encode(text), pk);
  } catch {
    ok = false;
  }
  if (verifyMemo.size > 20000) verifyMemo.clear();
  verifyMemo.set(key, ok);
  return ok;
}

export function signText(id: Identity, text: string): Uint8Array {
  cryptoStats.signs++;
  return id.sign(enc.encode(text));
}
