// Root entrypoint for OpenCode's local directory plugin loader.
//
// When a plugin is configured by directory path, `Host.resolve` in
// @opencode/plugin/host probes `<dir>/server` then `<dir>/index` as absolute
// paths. Absolute-path resolution never consults `package.json#exports`, so the
// real implementation under `src/` is invisible without this shim.
// `package.json#exports` still serves consumers that import the package by name.
export { default } from "./src/index.js"
