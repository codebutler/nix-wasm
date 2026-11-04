// net-device.js — host model for the guest's stock virtio_net NIC over the
// `virtio_wasm` transport. GENERIC: knows nothing about tcpip.js or pc. It
// turns the TX/RX vrings into an ethernet-frame stream:
//   guest TX  -> strip virtio-net header -> frameSink(frame)
//   pushRx(frame) -> prepend zeroed header -> guest RX -> raiseIrq()
// The pc side (js/vnet/) connects frameSink/pushRx to a tcpip.js tap port.
import { VirtioWasmDevice } from "./device.ts";
import type { VirtioWasmDeviceOptions } from "./device.ts";
import type { VringChain } from "./vring.ts";

export const VIRTIO_NET_HDR_LEN = 12; // modern virtio_net header (no mrg_rxbuf)
const VIRTIO_NET_F_MAC = 1n << 5n;
const VIRTIO_NET_F_STATUS = 1n << 16n;
const RX = 0,
  TX = 1;

/** NetDevice constructor options: the base opts plus an optional MAC. */
export interface NetDeviceOptions extends VirtioWasmDeviceOptions {
  /** 6-byte MAC address (default 52:54:00:cb:00:02) */
  mac?: Uint8Array;
}

export class NetDevice extends VirtioWasmDevice {
  mac: Uint8Array;
  _linkUp: boolean;
  _sink: ((frame: Uint8Array) => void) | null;

  constructor(opts: NetDeviceOptions) {
    super(opts);
    this.mac = Uint8Array.from(opts.mac ?? [0x52, 0x54, 0x00, 0xcb, 0x00, 0x02]);
    this._linkUp = true;
    this._sink = null;
  }

  getFeatures(): bigint {
    return VIRTIO_NET_F_MAC | VIRTIO_NET_F_STATUS;
  }

  configRead(offset: number, bytes: Uint8Array): void {
    bytes.fill(0);
    // config space: [0..5] mac, [6..7] status (u16 LE)
    for (let i = 0; i < bytes.length; i++) {
      const o = offset + i;
      if (o < 6) bytes[i] = this.mac[o];
      else if (o === 6)
        bytes[i] = this._linkUp ? 1 : 0; // VIRTIO_NET_S_LINK_UP=1
      else bytes[i] = 0;
    }
  }

  setLinkUp(up: boolean): void {
    this._linkUp = !!up;
  }

  setFrameSink(fn: ((frame: Uint8Array) => void) | null): void {
    this._sink = fn;
  }

  onNotify(q: number): void {
    if (q !== TX) return; // RX is host-driven via pushRx
    const vr = this.vring(TX);
    if (!vr) return;
    let serviced = 0,
      chain: VringChain | null;
    while ((chain = vr.next())) {
      const buf = vr.readOut(chain);
      const frame =
        buf.length > VIRTIO_NET_HDR_LEN ? buf.subarray(VIRTIO_NET_HDR_LEN) : new Uint8Array(0);
      if (frame.length && this._sink) this._sink(Uint8Array.from(frame));
      vr.pushUsed(chain.head, 0); // TX buffers are read-only; used len = 0
      serviced++;
    }
    if (serviced) this.raiseIrq();
  }

  /** Deliver one inbound ethernet frame to the guest. Returns false if dropped. */
  pushRx(frame: Uint8Array): boolean {
    const vr = this.vring(RX);
    if (!vr) return false;
    const chain = vr.next();
    if (!chain) return false;
    if (vr.inCapacity(chain) < VIRTIO_NET_HDR_LEN + frame.length) {
      vr.pushUsed(chain.head, 0); // recycle; frame too big for this buffer
      return false;
    }
    const pkt = new Uint8Array(VIRTIO_NET_HDR_LEN + frame.length); // header zeroed
    pkt.set(frame, VIRTIO_NET_HDR_LEN);
    const written = vr.writeIn(chain, pkt);
    vr.pushUsed(chain.head, written);
    this.raiseIrq();
    return true;
  }
}
