import { describe, expect, it } from 'vitest';
import { SILENT_MS, remoteLife } from '../src/net/live';
import type { Seat } from '../src/net/protocol';

const seat = (online = true): Seat => ({ id: 1, name: 'Beto', vehicle: 'popular', ready: true, host: false, online });
const base = { seat: seat(), byFlag: true, silentMs: 0, linkUp: true };

describe('remoteLife', () => {
  it('is live while the seat is online and snapshots come', () => {
    expect(remoteLife(base)).toBe('live');
    expect(remoteLife({ ...base, silentMs: SILENT_MS })).toBe('live');
  });
  it('is a ghost when the seat goes offline, snapshots stop or our link is down', () => {
    expect(remoteLife({ ...base, seat: seat(false) })).toBe('ghost');
    expect(remoteLife({ ...base, silentMs: SILENT_MS + 1 })).toBe('ghost');
    expect(remoteLife({ ...base, linkUp: false })).toBe('ghost');
  });
  it('ignores the offline flag for the AI (only its silence counts)', () => {
    expect(remoteLife({ ...base, seat: seat(false), byFlag: false })).toBe('live');
    expect(remoteLife({ ...base, seat: seat(false), byFlag: false, silentMs: SILENT_MS + 1 })).toBe('ghost');
  });
  it('is gone when the seat left the room, whatever else', () => {
    expect(remoteLife({ ...base, seat: undefined })).toBe('gone');
    expect(remoteLife({ ...base, seat: undefined, linkUp: false })).toBe('gone');
  });
});
