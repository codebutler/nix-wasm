// blk-device.js — read-only virtio-blk device over the virtio_wasm transport.
// Serves the base-system squashfs image (an in-memory Uint8Array) to the guest
// as /dev/vdX; the guest mounts it -t squashfs as the /nix overlay lowerdir.
// Read-only by construction: VIRTIO_BLK_T_OUT (write) requests fail S_UNSUPP.
import { VirtioWasmDevice } from "./device.js";

const SECTOR = 512;
const VIRTIO_BLK_T_IN = 0; // read request type
const VIRTIO_BLK_S_OK = 0;
const VIRTIO_BLK_S_IOERR = 1;
const VIRTIO_BLK_S_UNSUPP = 2;
// virtio feature bits
const VIRTIO_BLK_F_RO = 5n; // device is read-only
const VIRTIO_F_VERSION_1 = 32n; // modern (v1) device

export class BlkDevice extends VirtioWasmDevice {
  /**
   * @param {ConstructorParameters<typeof VirtioWasmDevice>[0] & { image: Uint8Array }} opts
   */
  constructor(opts) {
    super(opts);
    this.image = opts.image;
    // capacity in 512-byte sectors, rounded down
    this.capacity = BigInt(Math.floor(this.image.length / SECTOR));
  }

  getFeatures() {
    return (1n << VIRTIO_F_VERSION_1) | (1n << VIRTIO_BLK_F_RO);
  }

  // virtio-blk config space: u64 capacity at offset 0 (little-endian, sectors).
  // The guest only reads offsets 0-7; fill the requested slice from that buffer.
  configRead(offset, bytes) {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, this.capacity, true);
    for (let i = 0; i < bytes.length; i++) {
      const src = offset + i;
      bytes[i] = src < buf.length ? buf[src] : 0;
    }
  }

  onNotify(q) {
    const ring = this.vring(q >>> 0);
    if (!ring) return;
    let serviced = 0;
    let chain;
    while ((chain = ring.next())) {
      this._service(ring, chain);
      serviced++;
    }
    if (serviced) this.raiseIrq();
  }

  // Service one virtio-blk request chain.
  //
  // virtio-blk descriptor chain layout (per spec §5.2.6):
  //   out[0]: struct virtio_blk_outhdr { le32 type; le32 reserved; le64 sector; }
  //   in[0..n-1]: data buffers (host writes for T_IN)
  //   in[n]: 1-byte status (host always writes)
  //
  // The Vring.next() API splits descriptors into out (host-readable, no WRITE
  // flag) and in (host-writable, WRITE flag).  For a read request:
  //   chain.out = [{ addr, len }]  ← the 16-byte outhdr
  //   chain.in  = [data..., status]  ← data buffer(s) + 1-byte status last
  _service(ring, chain) {
    // Parse the outhdr from the first OUT segment.
    if (!chain.out.length || !chain.in.length) {
      // Malformed chain: no header or no writable output.
      this.log("[blk] malformed descriptor chain — skipping");
      ring.pushUsed(chain.head, 0);
      return;
    }
    const hdrSeg = chain.out[0];
    const hdr = new DataView(this.memory.buffer, hdrSeg.addr, 16);
    const type = hdr.getUint32(0, true);
    const sector = hdr.getBigUint64(8, true);

    // The last IN segment is the 1-byte status; everything before is data.
    const statusSeg = chain.in[chain.in.length - 1];
    const dataSegs = chain.in.slice(0, chain.in.length - 1);

    let status = VIRTIO_BLK_S_OK;
    let written = 0;

    if (type !== VIRTIO_BLK_T_IN) {
      // This is a read-only device; reject writes and unsupported ops.
      status = VIRTIO_BLK_S_UNSUPP;
    } else {
      let pos = Number(sector) * SECTOR;
      for (const seg of dataSegs) {
        if (pos + seg.len > this.image.length) {
          status = VIRTIO_BLK_S_IOERR;
          break;
        }
        const dst = this.memView(seg.addr, seg.len);
        dst.set(this.image.subarray(pos, pos + seg.len));
        pos += seg.len;
        written += seg.len;
      }
    }

    // Write the status byte into the last IN segment.
    this.memView(statusSeg.addr, 1)[0] = status;
    written += 1; // count the status byte
    ring.pushUsed(chain.head, written);
  }
}
