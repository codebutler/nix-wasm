/*
 * Minimal gbm.h shim for Sommelier on wasm32-nommu.
 *
 * Sommelier links libgbm but NEVER calls it on the wl_shm/virtwl path:
 * ctx->gbm stays null and every gbm call site is guarded by that check.
 * We only need this header + libgbm.a to satisfy the linker. All symbols
 * abort() — they are provably unreachable at runtime.
 *
 * API is a strict subset of minigbm's gbm.h (chromiumos gbm, NOT mesa gbm).
 * Symbols: gbm_create_device, gbm_device_get_fd, gbm_bo_import,
 *           gbm_bo_map, gbm_bo_unmap, gbm_bo_destroy.
 */

#ifndef GBM_H_
#define GBM_H_

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct gbm_device;
struct gbm_bo;
struct gbm_import_fd_modifier_data;

/* GBM_BO_IMPORT_FD_MODIFIER — the only import type Sommelier uses. */
#define GBM_BO_IMPORT_FD_MODIFIER 0x5505

/* BO transfer flags (used as map flags). */
#define GBM_BO_TRANSFER_READ       (1 << 0)
#define GBM_BO_TRANSFER_WRITE      (1 << 1)
#define GBM_BO_TRANSFER_READ_WRITE (GBM_BO_TRANSFER_READ | GBM_BO_TRANSFER_WRITE)

/* Format codes (DRM fourcc subset). */
#define GBM_FORMAT_ARGB8888  0x34325241
#define GBM_FORMAT_XRGB8888  0x34325258

struct gbm_import_fd_modifier_data {
    uint32_t width;
    uint32_t height;
    uint32_t format;
    uint64_t modifier;
    int      fds[4];
    int      strides[4];
    int      offsets[4];
    int      num_fds;
};

/* Open a gbm device on the given DRM fd. Never reached: ctx->gbm is null. */
struct gbm_device *gbm_create_device(int fd);

/* Get the underlying DRM fd. Never reached. */
int gbm_device_get_fd(struct gbm_device *gbm);

/* Import a dma-buf as a gbm_bo. Never reached: dmabuf path is gated. */
struct gbm_bo *gbm_bo_import(struct gbm_device *gbm, uint32_t type,
                             void *buffer, uint32_t usage);

/* Map a bo for CPU access. Never reached. */
void *gbm_bo_map(struct gbm_bo *bo, uint32_t x, uint32_t y,
                 uint32_t width, uint32_t height, uint32_t flags,
                 uint32_t *stride, void **map_data);

/* Unmap a previously mapped bo. Never reached. */
void gbm_bo_unmap(struct gbm_bo *bo, void *map_data);

/* Destroy a gbm_bo. Never reached. */
void gbm_bo_destroy(struct gbm_bo *bo);

#ifdef __cplusplus
}
#endif

#endif /* GBM_H_ */
