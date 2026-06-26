/*
 * gbm-shim.c — abort-stub libgbm for Sommelier on wasm32-nommu.
 *
 * Sommelier's ctx->gbm is always null on the wl_shm/virtwl path; every call
 * site is guarded. These symbols exist solely to satisfy the linker. Any
 * call at runtime is a bug and aborts loudly instead of silently misbehaving.
 */

#include <stdlib.h>
#include "gbm.h"

struct gbm_device *gbm_create_device(int fd)
{
    abort(); /* unreachable: ctx->gbm stays null; no /dev/dri on wasm guest */
}

int gbm_device_get_fd(struct gbm_device *gbm)
{
    abort(); /* unreachable */
}

struct gbm_bo *gbm_bo_import(struct gbm_device *gbm, uint32_t type,
                             void *buffer, uint32_t usage)
{
    abort(); /* unreachable: dmabuf path gated by ctx->gbm != null */
}

void *gbm_bo_map(struct gbm_bo *bo, uint32_t x, uint32_t y,
                 uint32_t width, uint32_t height, uint32_t flags,
                 uint32_t *stride, void **map_data)
{
    abort(); /* unreachable */
}

void gbm_bo_unmap(struct gbm_bo *bo, void *map_data)
{
    abort(); /* unreachable */
}

void gbm_bo_destroy(struct gbm_bo *bo)
{
    abort(); /* unreachable */
}
