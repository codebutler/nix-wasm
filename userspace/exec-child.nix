# exec-child — the exec target for the MMU fork+exec+wait smoke (#131/#129).
# Raw static binary (the engine instruments it at load under the MMU kernel);
# a fork child execve()s it. See userspace/exec-child.c.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "exec-child";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./exec-child.c} -o exec-child
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 exec-child $out/bin/exec-child
    runHook postInstall
  '';
  meta.description = "exec target for the MMU fork+exec+wait smoke (#131/#129), wasm32";
}
