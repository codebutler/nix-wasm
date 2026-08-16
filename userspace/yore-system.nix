{ pkgs }:
pkgs.writeTextFile {
  name = "yore-system";
  executable = true;
  destination = "/bin/yore-system";
  text = builtins.readFile ./yore-system.sh;
}
