# Static /etc/passwd + /etc/group for the wasm guest, derived from the module
# user/group model. Single-user guest: empty password field (no shadow) so getty
# autologin needs no credentials. Shells render as /bin/sh (busybox ash).
{ lib, pkgs, config }:
let
  usersList = lib.attrValues config.users.users;
  groupsList = lib.attrValues config.users.groups;
  # Resolve a user's primary gid. Fail LOUD on an undefined group: the upstream
  # `usersWithoutExistingGroup` assertion that normally catches this is DEAD in
  # our curated eval (assertions.nix only declares config.assertions; the module
  # that throws them — activation/top-level — is excluded), so without this throw
  # a typo'd group would silently map to gid 0 (root) in /etc/passwd.
  gidOf = u:
    let g = config.users.groups.${u.group}
      or (throw "passwd.nix: user '${u.name}' has undefined primary group '${u.group}'");
    in g.gid;
  passwdLine = u:
    "${u.name}::${toString u.uid}:${toString (gidOf u)}:" +
    "${u.description}:${u.home}:/bin/sh";
  groupLine = g:
    "${g.name}:x:${toString g.gid}:${lib.concatStringsSep "," (g.members or [])}";
  passwd = lib.concatMapStringsSep "\n" passwdLine
    (lib.filter (u: u.uid != null) usersList);
  group = lib.concatMapStringsSep "\n" groupLine
    (lib.filter (g: g.gid != null) groupsList);
in
{
  passwd = pkgs.writeText "passwd" (passwd + "\n");
  group = pkgs.writeText "group" (group + "\n");
}
