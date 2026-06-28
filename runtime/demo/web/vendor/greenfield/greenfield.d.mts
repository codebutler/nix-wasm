// Type sibling for greenfield.mjs (see vendor/yjs/yjs.d.mts for the pattern).
//
// Hand-derived from @gfld/compositor's upstream `types/index.d.ts` +
// `types/UserShellApi.d.ts` (commit 5bf2e35), reduced to the surface pc's host
// module consumes. Keep in sync if the bundle is regenerated against new
// upstream types. The bundled `.mjs` itself is excluded from tsc (vendor/**),
// so this declaration is what `js/linux/wayland-compositor.js` typechecks
// against.

export interface CompositorClient {
  id: string;
}

export interface CompositorSurface {
  id: number;
  client: CompositorClient;
}

export interface UserShellApiEvents {
  clientCreated?: (applicationClient: CompositorClient) => void;
  clientDestroyed?: (applicationClient: CompositorClient) => void;
  surfaceCreated?: (compositorSurface: CompositorSurface) => void;
  surfaceDestroyed?: (compositorSurface: CompositorSurface) => void;
  surfaceTitleUpdated?: (compositorSurface: CompositorSurface, title: string) => void;
  surfaceAppIdUpdated?: (compositorSurface: CompositorSurface, appId: string) => void;
  surfaceActivationUpdated?: (compositorSurface: CompositorSurface, active: boolean) => void;
  surfaceContentUpdated?: (
    compositorSurface: CompositorSurface,
    content: { bitmap: ImageBitmap; width: number; height: number },
  ) => void;
  surfaceDecorationModeUpdated?: (
    compositorSurface: CompositorSurface,
    mode: "client" | "server",
  ) => void;
  surfaceMoveRequested?: (compositorSurface: CompositorSurface) => void;
  surfaceMaximizeRequested?: (compositorSurface: CompositorSurface, maximized: boolean) => void;
  surfaceMinimizeRequested?: (compositorSurface: CompositorSurface) => void;
  surfaceResizeRequested?: (compositorSurface: CompositorSurface, edges: number) => void;
  notify?: (variant: "warn" | "info" | "error", message: string) => void;
  sceneRefreshed?: (sceneId: string) => void;
}

export interface UserShellApiActions {
  initScene(canvasCreator: () => { canvas: HTMLCanvasElement; id: string }): void;
  refreshScene(): void;
  destroyScene(sceneId: string): void;
  closeClient(applicationClient: Pick<CompositorClient, "id">): void;
  activateSurface(compositorSurface: CompositorSurface): void;
  requestSurfaceClose(compositorSurface: CompositorSurface): void;
  pointerMotion(compositorSurface: CompositorSurface, x: number, y: number): void;
  pointerLeave(compositorSurface: CompositorSurface): void;
  pointerButton(compositorSurface: CompositorSurface, buttonCode: number, released: boolean): void;
  notifyKey(keyboardEvent: KeyboardEvent, pressed: boolean): void;
  configureSurfaceSize(compositorSurface: CompositorSurface, width: number, height: number): void;
}

export interface UserShellApi {
  events: UserShellApiEvents;
  actions: UserShellApiActions;
}

export interface CompositorGlobals {
  register(): void;
  unregister(): void;
}

// Low-level connection seam (Phase 2: feed a guest Wayland client's raw wire
// bytes through Greenfield without a transport). `display.createClient(id)`
// mints a Client whose `connection` is the byte duplex: inbound via
// `message({ buffer, fds })`, outbound via the `onFlush` callback.
export interface WireMessage {
  buffer: ArrayBuffer;
  // A marshalled fd is either an shm view (Uint8Array), a raw fd number, or — on
  // the server→client path — whatever object the client's `inputOutput.mkstempMmap`
  // returned as its `.fd` (e.g. the keymap-fd carrier the guest bridge installs).
  fds: Array<Uint8Array | number | object>;
  bufferOffset: number;
}
export interface CompositorConnection {
  message(incoming: { buffer: Uint32Array; fds: Array<Uint8Array | number> }): void;
  onFlush?: (outMessages: WireMessage[]) => void;
}
export interface CompositorClientLowLevel extends CompositorClient {
  connection: CompositorConnection;
  onClose?: () => Promise<void>;
  // Per-client facilities Greenfield reads during protocol handling. Notably
  // `userData.inputOutput.mkstempMmap(blob)` allocates server→client fds (the
  // wl_keyboard keymap fd). The guest bridge installs one before feeding bytes.
  userData?: { inputOutput?: unknown } & Record<string, unknown>;
}
export interface CompositorDisplay {
  createClient(clientId: string): CompositorClientLowLevel;
}

export interface CompositorSession {
  userShell: UserShellApi;
  globals: CompositorGlobals;
  display: CompositorDisplay;
}

export interface SessionConfig {
  id?: string;
  mode: "floating" | "experimental-fullscreen";
}

export interface AppContext {
  readonly state: "closed" | "open" | "connecting" | "terminated" | "error";
  readonly key?: string;
  readonly name?: string;
  onStateChange: (state: Exclude<AppContext["state"], "connecting">) => void;
  onError: (error: Error) => void;
  close(): void;
}

export interface AppLauncher {
  launch(url: URL, onChildAppContext?: (childAppContext: AppContext) => void): AppContext;
}

export declare function initWasm(): Promise<void>;
export declare function createCompositorSession(sessionConfig: SessionConfig): Promise<CompositorSession>;
export declare function createAppLauncher(
  session: CompositorSession,
  type: "web" | "remote",
): AppLauncher;
