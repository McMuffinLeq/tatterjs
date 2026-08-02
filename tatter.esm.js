// tatter.esm.js
// ES module entry point for Tatter.js — for use with:
//   import Tatter from "https://cdn.jsdelivr.net/gh/McMuffinLeq/tatterjs@v1.0.5/tatter.esm.js";
//
// This just loads the existing UMD build (tatter.js) and re-exports it,
// so there is only one real implementation to maintain. Everyone else
// (plain <script> tags, Node/CommonJS, AMD) keeps using tatter.js as-is.

import "./tatter.js";

const Tatter = (typeof window !== "undefined" ? window.Tatter : globalThis.Tatter);

if (!Tatter) {
  throw new Error(
    "tatter.esm.js: Tatter global not found after loading tatter.js. " +
    "Make sure tatter.js is served from the same folder."
  );
}

export default Tatter;
