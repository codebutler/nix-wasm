// echo-device.js — host side of the `virtio_wasm` echo self-test
// (Linux/Wasm, "pc" Wayland Phase 1; CONFIG_VIRTIO_WASM_ECHO).
//
// The guest's in-kernel echo driver (drivers/virtio/virtio_wasm.c) registers a
// 2-virtqueue device and sends one magic u32 down each queue, expecting the host
// to echo the BITWISE INVERSE back on the matching queue and raise the device
// irq. The inverse is a content-sensitive proof that the host read the guest's
// bytes AND the guest reads the host's reply — on BOTH queues (multi-vq proof).

import { VirtioWasmDevice } from "./device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";

export class EchoDevice extends VirtioWasmDevice {
  onNotify(q) {
    const vr = this.vring(q);
    if (!vr) {
      this.log(`[virtio-echo] notify for unknown queue ${q}`);
      return;
    }

    let serviced = 0;
    let chain;
    while ((chain = vr.next())) {
      const src = vr.readOut(chain);
      const inv = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i++) inv[i] = src[i] ^ 0xff;
      const written = vr.writeIn(chain, inv);
      vr.pushUsed(chain.head, written);
      serviced++;
      this.log(
        `[virtio-echo] q=${q} head=${chain.head} echoed ${written}B (~tx)`,
      );
    }

    if (serviced > 0) this.raiseIrq();
  }
}

/**
 * Back-compat factory used by 1a tests. Builds an EchoDevice and exposes the
 * old { setupQueue, notify } shape.
 */
export function makeEchoDevice({ memory, raiseInterrupt, dev = 1, irq = 9, onlineCpus, sharedQueues, log }) {
  const shared = sharedQueues || new SharedQueues(makeSharedQueues());
  const d = new EchoDevice({ dev, irq, memory, raiseInterrupt, onlineCpus, sharedQueues: shared, log });
  return {
    device: d,
    setupQueue: (q, desc, avail, used, num) => d.setupQueue(q, desc, avail, used, num),
    notify: (q) => d.onNotify(q),
  };
}
