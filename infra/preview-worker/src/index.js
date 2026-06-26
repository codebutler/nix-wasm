// nix-wasm PR-preview Worker. Serves the nix-wasm-previews R2 bucket:
//   pr-<N>/<path>      the PR's frontend bundle (runtime/ tree, rclone-synced)
//   cas/<hash>/<path>  content-addressed boot artifacts (vmlinux.wasm,
//                      initramfs.cpio.gz, base.squashfs), shared across PRs
//
// Every response is stamped COOP/COEP/CORP so the preview is cross-origin
// isolated (the wasm kernel needs SharedArrayBuffer) -- a bare R2 URL cannot do
// this. No union-mount (unlike pc): the bucket holds full objects, served
// directly. Binding: env.PREVIEWS (R2 bucket), configured in wrangler.toml.

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  gz: "application/gzip",
  // base.squashfs, *.cpio.gz payloads, etc.
  squashfs: "application/octet-stream",
};

function contentType(path) {
  const ext = path.split(".").pop().toLowerCase();
  return TYPES[ext] || "application/octet-stream";
}

function withHeaders(body, init, path, extra) {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
  if (path && !headers.has("Content-Type")) headers.set("Content-Type", contentType(path));
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/" || pathname === "") {
      return withHeaders(
        "nix-wasm PR previews are served at /pr-<number>/demo/web/\n",
        { status: 404 },
        "x.txt",
      );
    }

    const segs = pathname.replace(/^\/+/, "").split("/");
    const layer = segs[0];
    if (!/^pr-\d+$/.test(layer) && layer !== "cas") {
      return withHeaders("Not found\n", { status: 404 }, "x.txt");
    }

    // Redirect /pr-<N> -> /pr-<N>/ so relative asset paths resolve.
    if (/^pr-\d+$/.test(layer) && segs.length === 1) {
      return new Response(null, {
        status: 308,
        headers: { Location: `${url.origin}/${layer}/${url.search}`, ...ISOLATION_HEADERS },
      });
    }

    let key = segs.join("/");
    if (key.endsWith("/")) key += "index.html";

    let obj = await env.PREVIEWS.get(key);
    // Extension-less directory request -> redirect to trailing-slash URL so
    // relative imports (./main.js, ./vendor/…) resolve against the correct base.
    if (!obj && !key.split("/").pop().includes(".")) {
      const idx = `${key}/index.html`;
      const idxExists = await env.PREVIEWS.get(idx);
      if (idxExists) {
        return new Response(null, {
          status: 308,
          headers: { Location: `${url.origin}/${key}/${url.search}`, ...ISOLATION_HEADERS },
        });
      }
    }
    if (!obj) return withHeaders(`Not found: ${key}\n`, { status: 404 }, "x.txt");

    const cache =
      layer === "cas"
        ? "public, max-age=31536000, immutable"
        : key.endsWith(".html") || key.endsWith("preview.json")
          ? "no-store"
          : "public, max-age=300";

    return withHeaders(obj.body, { status: 200 }, key, {
      "Cache-Control": cache,
      ETag: obj.httpEtag,
    });
  },
};
