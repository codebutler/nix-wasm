// Forward xdg-activation-v1 between native guest Wayland clients and the
// parent compositor. Keep the token and target wl_surface scoped to the
// requesting Wayland client; the parent compositor decides focus policy.
#include "sommelier.h"  // NOLINT(build/include_directory)

#include "xdg-activation-v1-client-protocol.h"  // NOLINT(build/include_directory)
#include "xdg-activation-v1-server-protocol.h"  // NOLINT(build/include_directory)

struct sl_host_activation {
  struct wl_resource* resource;
  struct xdg_activation_v1* proxy;
};

struct sl_host_activation_token {
  struct wl_resource* resource;
  struct xdg_activation_token_v1* proxy;
  uint32_t serial = 0;
  uint32_t source_last_event_serial = 0;
  struct wl_seat* seat_proxy = nullptr;
  bool has_source = false;
  bool serial_forwarded = false;
};

static void sl_forward_activation_serial(sl_host_activation_token* host) {
  // Sommelier forwards parent serials unchanged to guest clients. Only pass
  // one back when this guest surface actually received it; a guessed serial
  // from another guest window must not mint a focus-worthy token.
  if (!host->serial_forwarded && host->has_source && host->seat_proxy &&
      host->serial != 0 && host->source_last_event_serial == host->serial) {
    xdg_activation_token_v1_set_serial(host->proxy, host->serial,
                                       host->seat_proxy);
    host->serial_forwarded = true;
  }
}

static void sl_activation_token_done(void* data,
                                     struct xdg_activation_token_v1* proxy,
                                     const char* token) {
  auto* host = static_cast<sl_host_activation_token*>(data);
  xdg_activation_token_v1_send_done(host->resource, token);
}

static const struct xdg_activation_token_v1_listener token_listener = {
    sl_activation_token_done};

static void sl_destroy_activation_token(struct wl_resource* resource) {
  auto* host = static_cast<sl_host_activation_token*>(
      wl_resource_get_user_data(resource));
  xdg_activation_token_v1_destroy(host->proxy);
  delete host;
}

static void sl_activation_token_destroy(struct wl_client* client,
                                        struct wl_resource* resource) {
  wl_resource_destroy(resource);
}

static void sl_activation_token_set_serial(struct wl_client* client,
                                           struct wl_resource* resource,
                                           uint32_t serial,
                                           struct wl_resource* seat_resource) {
  auto* host = static_cast<sl_host_activation_token*>(
      wl_resource_get_user_data(resource));
  auto* seat = static_cast<sl_host_seat*>(
      wl_resource_get_user_data(seat_resource));
  host->serial = serial;
  host->seat_proxy = seat->proxy;
  sl_forward_activation_serial(host);
}

static void sl_activation_token_set_app_id(struct wl_client* client,
                                           struct wl_resource* resource,
                                           const char* app_id) {
  auto* host = static_cast<sl_host_activation_token*>(
      wl_resource_get_user_data(resource));
  xdg_activation_token_v1_set_app_id(host->proxy, app_id);
}

static void sl_activation_token_set_surface(struct wl_client* client,
                                            struct wl_resource* resource,
                                            struct wl_resource* surface_resource) {
  auto* host = static_cast<sl_host_activation_token*>(
      wl_resource_get_user_data(resource));
  auto* surface = static_cast<sl_host_surface*>(
      wl_resource_get_user_data(surface_resource));
  xdg_activation_token_v1_set_surface(host->proxy, surface->proxy);
  host->has_source = true;
  host->source_last_event_serial = surface->last_event_serial;
  sl_forward_activation_serial(host);
}

static void sl_activation_token_commit(struct wl_client* client,
                                       struct wl_resource* resource) {
  auto* host = static_cast<sl_host_activation_token*>(
      wl_resource_get_user_data(resource));
  xdg_activation_token_v1_commit(host->proxy);
}

static const struct xdg_activation_token_v1_interface token_implementation = {
    sl_activation_token_set_serial, sl_activation_token_set_app_id,
    sl_activation_token_set_surface, sl_activation_token_commit,
    sl_activation_token_destroy};

static void sl_destroy_activation(struct wl_resource* resource) {
  auto* host = static_cast<sl_host_activation*>(
      wl_resource_get_user_data(resource));
  xdg_activation_v1_destroy(host->proxy);
  delete host;
}

static void sl_activation_destroy(struct wl_client* client,
                                  struct wl_resource* resource) {
  wl_resource_destroy(resource);
}

static void sl_activation_get_token(struct wl_client* client,
                                    struct wl_resource* resource,
                                    uint32_t id) {
  auto* activation = static_cast<sl_host_activation*>(
      wl_resource_get_user_data(resource));
  auto* token = new sl_host_activation_token();
  token->resource = wl_resource_create(client, &xdg_activation_token_v1_interface,
                                       1, id);
  token->proxy = xdg_activation_v1_get_activation_token(activation->proxy);
  xdg_activation_token_v1_add_listener(token->proxy, &token_listener, token);
  wl_resource_set_implementation(token->resource, &token_implementation, token,
                                 sl_destroy_activation_token);
}

static void sl_activation_activate(struct wl_client* client,
                                   struct wl_resource* resource,
                                   const char* token,
                                   struct wl_resource* surface_resource) {
  auto* activation = static_cast<sl_host_activation*>(
      wl_resource_get_user_data(resource));
  auto* surface = static_cast<sl_host_surface*>(
      wl_resource_get_user_data(surface_resource));
  xdg_activation_v1_activate(activation->proxy, token, surface->proxy);
}

static const struct xdg_activation_v1_interface activation_implementation = {
    sl_activation_destroy, sl_activation_get_token, sl_activation_activate};

static void sl_bind_activation(struct wl_client* client, void* data,
                               uint32_t version, uint32_t id) {
  auto* activation = static_cast<sl_xdg_activation*>(data);
  auto* host = new sl_host_activation();
  host->resource = wl_resource_create(client, &xdg_activation_v1_interface, 1, id);
  host->proxy = static_cast<xdg_activation_v1*>(wl_registry_bind(
      wl_display_get_registry(activation->ctx->display), activation->id,
      &xdg_activation_v1_interface, 1));
  wl_resource_set_implementation(host->resource, &activation_implementation,
                                 host, sl_destroy_activation);
}

struct sl_global* sl_xdg_activation_global_create(struct sl_context* ctx) {
  return sl_global_create(ctx, &xdg_activation_v1_interface, 1,
                          ctx->xdg_activation, sl_bind_activation);
}
