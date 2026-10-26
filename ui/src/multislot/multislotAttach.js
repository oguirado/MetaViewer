/**
 * Facade-to-registry pump for the MetaViewer AI multislot.
 *
 * Pure renderer module: no DOM, no framework. The kit terminal registry owns
 * the xterm hosts and the input lease; the MetaViewer terminal facade owns
 * the broker port. This module binds one to the other, mirroring the kit
 * `createSideTerminalModel` attach sequence and guards exactly:
 *
 * - `createSession` (pty, epoch 1) → `beginAttach` → `applyRestoreSnapshot`;
 * - output frames are sequence-checked before `writeOutputChunk`;
 * - a sequence gap or malformed frame fails that session (lease off, view
 *   detached) and reports through `onEvent` — never a raw throw out of a
 *   port listener, never invented bytes.
 *
 * The registry and facade are injected, so tests land doubles here and the
 * host passes the kit registry plus `createSideTerminalFacade`.
 *
 * @module multislot/multislotAttach
 */
import { leaseForInputMode } from './multislotInputGate.js';
import { validateCapsuleId } from '../../.kit/capsule-ui-kit/src/multislot/multislotIntents.js';

/** Attach epoch, mirroring the kit side-terminal model (`epoch: 1`). */
export const MULTISLOT_ATTACH_EPOCH = 1;

/** Initial session generation, mirroring the kit side-terminal model. */
export const MULTISLOT_ATTACH_GENERATION = 1;

/** Maximum restore-replay bytes of one attachment (kit model bound). */
export const MULTISLOT_MAX_REPLAY_BYTES = 131072;

/** Maximum output bytes of one frame (kit model bound). */
export const MULTISLOT_MAX_FRAME_BYTES = 65536;

/**
 * @typedef {object} MultislotAttachment
 * @property {string} session Broker session id.
 * @property {string} command Broker command that produced the session.
 * @property {number} [seq] Last delivered output sequence.
 * @property {number} [ackedSeq] Last acknowledged output sequence.
 * @property {number} [bytes] Cumulative output bytes.
 * @property {number[]} [replay] Restore-replay bytes.
 * @property {string} [title] Session title.
 * @property {string} [kind] Session kind.
 */

/**
 * Method-typed as `Function`: the kit registry carries narrower config
 * shapes that must stay assignable here, and doubles land here in tests.
 *
 * @typedef {object} MultislotRegistryLike
 * @property {Function} createSession
 * @property {Function} beginAttach
 * @property {Function} applyRestoreSnapshot
 * @property {Function} writeOutputChunk
 * @property {Function} setControlLease
 * @property {Function} [disposeSession]
 * @property {Function} [forgetSession]
 */

/**
 * @typedef {object} MultislotFacadeLike
 * @property {(receive: (frame: any) => void) => () => void} onData
 * @property {(receive: (event: any) => void) => () => void} onExit
 * @property {(request: { session: string }) => unknown} close
 * @property {(credit: { session: string, seq: number, bytes: number }) => unknown} [ack]
 */

/**
 * @typedef {object} MultislotPumpEvent
 * @property {'failed'|'exited'} type Terminal outcome for the session.
 * @property {string} sessionId Affected session id.
 */

/**
 * @param {unknown} value
 * @returns {value is number[]} True for a byte array.
 */
function isByteArray(value) {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
}

/**
 * Creates the pump binding one facade to one registry for one capsule slot.
 *
 * @param {{ facade: MultislotFacadeLike, registry: MultislotRegistryLike, capsuleId: string, getInputMode: () => unknown, onEvent?: (event: MultislotPumpEvent) => void }} options
 * @returns {{ attachSession: (attachment: MultislotAttachment) => string, closeSession: (sessionId: string) => boolean, syncLease: () => void, sessionIds: () => string[], dispose: () => void }}
 */
export function createMultislotPump({ facade, registry, capsuleId, getInputMode, onEvent }) {
  if (!facade || typeof facade.onData !== 'function' || typeof facade.onExit !== 'function') {
    throw new TypeError('createMultislotPump requires a facade with onData/onExit');
  }
  if (!registry || typeof registry.createSession !== 'function' || typeof registry.writeOutputChunk !== 'function') {
    throw new TypeError('createMultislotPump requires a registry with createSession/writeOutputChunk');
  }
  const checkedCapsule = validateCapsuleId(capsuleId);
  if (checkedCapsule.ok === false) throw new Error('Invalid terminal attachment');
  if (typeof getInputMode !== 'function') throw new TypeError('createMultislotPump requires getInputMode');

  /** @type {Map<string, { seq: number, bytes: number, live: boolean }>} */
  const sessions = new Map();
  let disposed = false;
  const notify = typeof onEvent === 'function' ? onEvent : () => {};

  /**
   * @param {string} sessionId
   */
  function leaseOff(sessionId) {
    try {
      registry.setControlLease({
        sessionId,
        epoch: MULTISLOT_ATTACH_EPOCH,
        hasControlLease: false,
      });
    } catch {
      // Lease-off is best-effort during teardown; the failed/exited state is authoritative.
    }
  }

  /** Remove both the registry view and its bookkeeping after any terminal outcome.
   * @param {string} id
   */
  function release(id) {
    sessions.delete(id);
    leaseOff(id);
    try { registry.disposeSession?.(id); } catch { /* Best-effort view release. */ }
    try { registry.forgetSession?.(id); } catch { /* Best-effort bookkeeping release. */ }
  }

  /**
   * @param {any} frame
   */
  function receive(frame) {
    if (disposed) return;
    const record = sessions.get(frame?.session);
    if (!record || record.live === false) return;
    try {
      if (
        !Number.isSafeInteger(frame.seq) ||
        frame.seq !== record.seq + 1 ||
        !Array.isArray(frame.bytes) ||
        frame.bytes.length > MULTISLOT_MAX_FRAME_BYTES ||
        !isByteArray(frame.bytes) ||
        frame.byteLength !== frame.bytes.length
      ) {
        throw new Error('Invalid terminal frame or sequence gap');
      }
      registry.writeOutputChunk({
        sessionId: frame.session,
        epoch: MULTISLOT_ATTACH_EPOCH,
        attachmentId: frame.session,
        startSeq: frame.seq - 1,
        endSeq: frame.seq,
        data: Uint8Array.from(frame.bytes),
      });
      record.seq = frame.seq;
      record.bytes += frame.bytes.length;
      // Registry acceptance is synchronous; the facade credit is cumulative bytes.
      facade.ack?.({ session: frame.session, seq: record.seq, bytes: record.bytes });
    } catch {
      record.live = false;
      release(frame.session);
      try {
        facade.close({ session: frame.session });
      } catch {
        // Detach is best-effort; the failed state is authoritative.
      }
      notify({ type: 'failed', sessionId: frame.session });
    }
  }

  /**
   * @param {any} event
   */
  function exit(event) {
    if (disposed) return;
    const record = sessions.get(event?.session);
    if (!record || record.live === false) return;
    record.live = false;
    release(event.session);
    notify({ type: 'exited', sessionId: event.session });
  }

  const offData = facade.onData(receive);
  const offExit = facade.onExit(exit);

  return {
    /**
     * Attaches one broker session to the registry. Mirrors the kit model
     * validation; malformed attachments throw `Invalid terminal attachment`.
     *
     * @param {MultislotAttachment} attachment Broker attachment record.
     * @returns {string} Attached session id.
     */
    attachSession(attachment) {
      const id = attachment?.session;
      const command = attachment?.command;
      const seq = attachment?.seq ?? 0;
      const bytes = attachment?.bytes ?? 0;
      const replay = attachment?.replay ?? [];
      if (
        disposed ||
        typeof id !== 'string' ||
        id.length === 0 ||
        sessions.has(id) ||
        typeof command !== 'string' ||
        command.length === 0 ||
        !Number.isSafeInteger(seq) ||
        seq < 0 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        !isByteArray(replay) ||
        replay.length > MULTISLOT_MAX_REPLAY_BYTES
      ) {
        throw new Error('Invalid terminal attachment');
      }
      sessions.set(id, { seq, bytes, live: true });
      try {
        const lease = leaseForInputMode(getInputMode());
        registry.createSession({
          sessionId: id,
          capsuleId: checkedCapsule.id,
          epoch: MULTISLOT_ATTACH_EPOCH,
          generation: MULTISLOT_ATTACH_GENERATION,
          mode: 'pty',
          hasControlLease: lease,
        });
        registry.beginAttach({ sessionId: id, epoch: MULTISLOT_ATTACH_EPOCH, attachmentId: id });
        registry.applyRestoreSnapshot({
          sessionId: id,
          epoch: MULTISLOT_ATTACH_EPOCH,
          attachmentId: id,
          snapshotCursorSeq: seq,
          snapshotData: Uint8Array.from(replay),
        });
        return id;
      } catch (error) {
        release(id);
        throw error;
      }
    },
    /**
     * Closes one attached session from an explicit operator action: the lease
     * goes off, the view detaches, and the registry forgets the session.
     * Unknown ids are a no-op returning false.
     *
     * @param {string} sessionId Attached session id.
     * @returns {boolean} True when a session was closed.
     */
    closeSession(sessionId) {
      const record = sessions.get(sessionId);
      if (!record) return false;
      sessions.delete(sessionId);
      record.live = false;
      leaseOff(sessionId);
      try {
        facade.close({ session: sessionId });
      } catch {
        // Detach is best-effort; removal from the pump is authoritative.
      }
      try {
        registry.disposeSession?.(sessionId);
      } catch {
        // View disposal is best-effort during close.
      }
      try {
        registry.forgetSession?.(sessionId);
      } catch {
        // View disposal is best-effort during close.
      }
      return true;
    },
    /** Reprojects the control lease from the live input mode. */
    syncLease() {
      if (disposed) return;
      const lease = leaseForInputMode(getInputMode());
      for (const [sessionId, record] of sessions) {
        if (record.live === false) continue;
        try {
          registry.setControlLease({
            sessionId,
            epoch: MULTISLOT_ATTACH_EPOCH,
            hasControlLease: lease,
          });
        } catch {
          release(sessionId);
          notify({ type: 'failed', sessionId });
        }
      }
    },
    /** @returns {string[]} Attached session ids in attach order. */
    sessionIds() {
      return [...sessions.keys()];
    },
    /** Unsubscribes, leases off, and best-effort detaches every session. */
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        offData();
      } catch {
        // Listener release is best-effort during teardown.
      }
      try {
        offExit();
      } catch {
        // Listener release is best-effort during teardown.
      }
      for (const [sessionId, record] of sessions) {
        record.live = false;
        leaseOff(sessionId);
        try {
          facade.close({ session: sessionId });
        } catch {
          // Detach is best-effort during teardown.
        }
        try {
          registry.disposeSession?.(sessionId);
        } catch {
          // View disposal is best-effort during teardown.
        }
        try {
          registry.forgetSession?.(sessionId);
        } catch {
          // View disposal is best-effort during teardown.
        }
      }
      sessions.clear();
    },
  };
}
