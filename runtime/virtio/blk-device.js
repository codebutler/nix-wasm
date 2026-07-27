// blk-device.js — virtio-blk over the virtio_wasm transport.
//
// Two roles (nix-wasm#177):
//   • Seed (readOnly:true, default): base.squashfs on /dev/vda — T_OUT → S_UNSUPP.
//   • State (readOnly:false): installed-system disk on /dev/vdb — T_IN/T_OUT +
//     dirty-sector journal (CBHD via blk-disk.js) for host saveDisk/apply-on-boot.
import { VirtioWasmDevice } from "./device.js";
import { BLK_SECTOR, markDirty } from "./blk-disk.js";

const VIRTIO_BLK_T_IN = 0; // read
const VIRTIO_BLK_T_OUT = 1; // write
const VIRTIO_BLK_T_FLUSH = 4; // flush (fsync) — no payload
const VIRTIO_BLK_S_OK = 0;
const VIRTIO_BLK_S_IOERR = 1;
const VIRTIO_BLK_S_UNSUPP = 2;
// virtio feature bits
const VIRTIO_BLK_F_RO = 5n; // device is read-only
const VIRTIO_F_VERSION_1 = 32n; // modern (v1) device

export class BlkDevice extends VirtioWasmDevice {
  /**
   * @param {ConstructorParameters<typeof VirtioWasmDevice>[0] & {
   *   image: Uint8Array,
   *   readOnly?: boolean,
   *   dirtyBitmap?: Uint8Array,
   *   onDirty?: () => void,
   * }} opts
   */
  constructor(opts) {
    super(opts);
    this.image = opts.image;
    this.readOnly = opts.readOnly !== false;
    this.dirtyBitmap = opts.dirtyBitmap || null;
    this.onDirty = opts.onDirty || null;
    // capacity in 512-byte sectors, rounded down
    this.capacity = BigInt(Math.floor(this.image.length / BLK_SECTOR));
  }

  getFeatures() {
    let f = 1n << VIRTIO_F_VERSION_1;
    if (this.readOnly) f |= 1n << VIRTIO_BLK_F_RO;
    return f;
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
  //   data:   T_IN → in segs; T_OUT → out segs after the header
  //   status: last IN segment, 1 byte
  _service(ring, chain) {
    if (!chain.out.length || !chain.in.length) {
      this.log("[blk] malformed descriptor chain — skipping");
      ring.pushUsed(chain.head, 0);
      return;
    }
    const hdrSeg = chain.out[0];
    const hdr = new DataView(this.memory.buffer, hdrSeg.addr, 16);
    const type = hdr.getUint32(0, true);
    const sector = Number(hdr.getBigUint64(8, true));

    const statusSeg = chain.in[chain.in.length - 1];
    let status = VIRTIO_BLK_S_OK;
    let written = 0;

    if (type === VIRTIO_BLK_T_IN) {
      const dataSegs = chain.in.slice(0, chain.in.length - 1);
      let pos = sector * BLK_SECTOR;
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
    } else if (type === VIRTIO_BLK_T_OUT) {
      if (this.readOnly) {
        status = VIRTIO_BLK_S_UNSUPP;
      } else {
        // Write data follows the outhdr in OUT segments.
        const dataSegs = chain.out.slice(1);
        let pos = sector * BLK_SECTOR;
        let bytes = 0;
        for (const seg of dataSegs) {
          if (pos + seg.len > this.image.length) {
            status = VIRTIO_BLK_S_IOERR;
            break;
          }
          const src = this.memView(seg.addr, seg.len);
          this.image.set(src, pos);
          pos += seg.len;
          bytes += seg.len;
        }
        if (status === VIRTIO_BLK_S_OK && bytes > 0) {
          const nSec = Math.ceil(bytes / BLK_SECTOR);
          if (this.dirtyBitmap) markDirty(this.dirtyBitmap, sector, nSec);
          this.onDirty?.();
        }
      }
    } else if (type === VIRTIO_BLK_T_FLUSH) {
      // Host persistence is journaled out-of-band (saveDisk); FLUSH is a no-op ack.
      if (this.readOnly) status = VIRTIO_BLK_S_UNSUPP;
    } else {
      status = VIRTIO_BLK_S_UNSUPP;
    }

    this.memView(statusSeg.addr, 1)[0] = status;
    written += 1;
    ring.pushUsed(chain.head, written);
  }
}
