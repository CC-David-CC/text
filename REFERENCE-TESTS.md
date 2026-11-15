# Owned original reference tests

These1 original test files belong to text because their imported source modules match this repository’s exact captured blobs. Current implementation files and assertions are unchanged. Import and proven fixture/resource URL locators are ported to this repository; no cross-repository private source imports or compatibility path shims are added.

Mechanical source-test baseline `95351d1df75ff056b1a6cad146e07b4431b237ac`; merge `7cd0713d3d3c000d6f56a3e9f61046187fc3afb0`. Private phase44 preserves earlier paths, explicit copy boundaries and source-to-result commit/ref maps. The locator-normalized complete AST is unchanged, not just selected assertions.

Run `npm run test:reference`. This is Node unit/reference qualification of the retained domain modules, not browser/worker/kernel/renderer/storage/authentication/human-agent acceptance. Current app hosting/build and shared-operation integration gates remain separately open.

Captured baseline and current port: 5 pass, 0 fail, 0 cancelled, 0 skipped across 5 reported Node subtests. Top-level assertion-only files count as one reported Node subtest, not individual assertions.
