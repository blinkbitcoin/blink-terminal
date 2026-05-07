{
  description = "Blink Terminal dev environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      overlays = [
        (self: super: {
          nodejs = super.nodejs_22;
          pnpm = super.pnpm.override {
            nodejs = super.nodejs_22;
          };
        })
      ];
      pkgs = import nixpkgs {inherit overlays system;};
      nativeBuildInputs = with pkgs; [
        nodejs
        pnpm
        vendir
        ytt
        jq
        shellcheck
        shfmt
        alejandra
      ];
    in
      with pkgs; {
        devShells.default = mkShell {
          inherit nativeBuildInputs;
          shellHook = ''
            # Workaround for nixpkgs xcrun warnings on Darwin
            # See: https://github.com/NixOS/nixpkgs/issues/376958
            unset DEVELOPER_DIR
          '';
        };

        formatter = alejandra;
      });
}
