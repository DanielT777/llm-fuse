declare module "fuse-native" {
  // Minimal shape — we only use mount/unmount and the handlers contract.
  // Full surface intentionally untyped: the package is optional and used
  // through a thin wrapper in adapter.ts / probe.ts.
  const _default: any;
  export default _default;
}
